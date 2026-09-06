// ---------------------------------------------------------------------
//  Reconciler — jedyna operacja utrzymywania rezerwacji.
//  Cel = desiredSpecs(): kazdy dzien okna x SLOTS_PER_DAY rezerwacji.
//
//  Kluczowe ograniczenie: nie da sie trzymac dwoch nakladajacych sie holdow
//  na to samo miejsce. Rekordu, ktorego hold jeszcze zyje (expiresAt w
//  przyszlosci), NIE ruszamy. Odtwarzamy dopiero po wygasnieciu.
//
//  Co przebieg:
//    a) kasuje rekordy poza celem (okno sie przesunelo / mniejszy SLOTS_PER_DAY),
//    b) buduje liste "do zrobienia" = pozycje BEZ zywego holdu, wg pilnosci:
//         tier 0: rekord wygasly (expiresAt + grace juz minal) lub "refreshing"
//                 — sort rosnaco po expiresAt (najwczesniej wygasle pierwsze),
//         tier 1: brak rekordu (nowy dzien okna) — sort po dacie,
//         tier 2: unavailable / failed po backoffie,
//    c) odtwarza max CREATE_BUDGET_PER_CYCLE, dla istniejacych z exactTime.
//  Zwraca, czy zostalo wiecej roboty i kiedy najblizej cos bedzie do zrobienia
//  (worker uzywa tego do dynamicznego snu).
// ---------------------------------------------------------------------

import {
  CREATE_BUDGET_PER_CYCLE,
  dateWindow,
  desiredSpecs,
  FAILED_RETRY_MS,
  HOLD_MS,
  LOST_RETRY_MS,
  MAX_ATTEMPTS,
  RECREATE_GRACE_MS,
  ReservationSpec,
  UNAVAILABLE_RETRY_MS,
} from './config.ts';
import { makeReservation, UnavailableError } from './flow.ts';
import {
  deleteGuests,
  deleteRecord,
  listRecords,
  putRecord,
  ReservationRecord,
} from './store.ts';
import { notify } from './notify.ts';

export interface ReconcileResult {
  moreWork: boolean; // bylo wiecej do zrobienia niz budzet
  nextWakeAt: number | null; // epoch ms — najblizszy moment, gdy cos bedzie do zrobienia
}

interface Task {
  spec: ReservationSpec;
  rec?: ReservationRecord;
  tier: 0 | 1 | 2;
  key: number; // sort w obrebie tier (ms)
}

export async function reconcile(page: any): Promise<ReconcileResult> {
  const specs = desiredSpecs();
  if (specs.length === 0) {
    console.error(
      '[reconcile] brak dat w oknie — sprawdz POLICY (weekdays/horizon/skipDates). Pomijam.',
    );
    return { moreWork: false, nextWakeAt: null };
  }
  const desiredIds = new Set(specs.map((s) => s.id));
  const records = await listRecords();
  const byId = new Map<string, ReservationRecord>(
    records.map((r) => [r.id, r]),
  );

  // a) sprzataj rekordy poza celem — hold sam wygasa, nie anulujemy
  let dropped = 0;
  for (const rec of records) {
    if (!desiredIds.has(rec.id)) {
      await deleteRecord(rec.id);
      await deleteGuests(rec.id);
      dropped++;
    }
  }
  if (dropped) console.log(`[reconcile] usunieto ${dropped} rekordow poza celem`);

  const now = Date.now();

  // zajete godziny per dzien (wszystkie rekordy celu z bookedTime — exactTime
  // pinuje slot danego rekordu, wiec sasiadom trzeba go omijac)
  const usedByDate = new Map<string, Set<string>>();
  for (const rec of records) {
    if (!desiredIds.has(rec.id) || !rec.bookedTime) continue;
    if (!usedByDate.has(rec.spec.date)) usedByDate.set(rec.spec.date, new Set());
    usedByDate.get(rec.spec.date)!.add(rec.bookedTime);
  }

  // b) lista do zrobienia + najblizszy moment kolejnej roboty
  const tasks: Task[] = [];
  let nextWakeAt: number | null = null;
  const note = (t: number) => {
    if (t > now && (nextWakeAt === null || t < nextWakeAt)) nextWakeAt = t;
  };

  for (const spec of specs) {
    const rec = byId.get(spec.id);

    if (!rec) {
      tasks.push({ spec, tier: 1, key: Date.parse(spec.date) });
      continue;
    }

    if (rec.status === 'refreshing') {
      tasks.push({
        spec,
        rec,
        tier: 0,
        key: rec.expiresAt ? Date.parse(rec.expiresAt) : 0,
      });
      continue;
    }

    if (rec.status === 'active') {
      const exp = rec.expiresAt ? Date.parse(rec.expiresAt) : now;
      if (exp + RECREATE_GRACE_MS <= now) {
        tasks.push({ spec, rec, tier: 0, key: exp });
      } else {
        note(exp + RECREATE_GRACE_MS);
      }
      continue;
    }

    // unavailable / failed
    const at = rec.nextAttemptAt ? Date.parse(rec.nextAttemptAt) : now;
    if (at <= now) tasks.push({ spec, rec, tier: 2, key: at });
    else note(at);
  }

  tasks.sort((a, b) => a.tier - b.tier || a.key - b.key);

  const held = records.filter(
    (r) =>
      desiredIds.has(r.id) &&
      r.status === 'active' &&
      r.expiresAt &&
      Date.parse(r.expiresAt) > now,
  ).length;

  if (tasks.length === 0) {
    console.log(
      `[reconcile] okno ${dateWindow().length} dni, cel ${specs.length}, trzymane ${held} — nic pilnego`,
    );
    return { moreWork: false, nextWakeAt };
  }

  const batch = tasks.slice(0, CREATE_BUDGET_PER_CYCLE);
  console.log(
    `[reconcile] cel ${specs.length}, trzymane ${held}, do zrobienia ${tasks.length}, teraz ${batch.length}`,
  );

  for (const task of batch) {
    if (!usedByDate.has(task.spec.date)) {
      usedByDate.set(task.spec.date, new Set());
    }
    const used = usedByDate.get(task.spec.date)!;
    const booked = await recreateOne(page, task, now, used);
    if (booked) used.add(booked);
  }

  return { moreWork: tasks.length > batch.length, nextWakeAt };
}

async function recreateOne(
  page: any,
  task: Task,
  now: number,
  usedTimes: Set<string>,
): Promise<string | null> {
  const { spec, rec } = task;
  const label = `${spec.date}#${spec.slot}`;
  const wasHeld = !!rec &&
    (rec.status === 'active' || rec.status === 'refreshing');

  // Istniejacy rekord: celuj w jego godzine (exactTime). Nowy: wybierz wolna,
  // omijajac godziny zajete przez rodzenstwo tego samego dnia.
  const opts = rec?.bookedTime
    ? { exactTime: rec.bookedTime }
    : { excludeTimes: [...usedTimes] };

  if (rec) await putRecord({ ...rec, status: 'refreshing' });

  try {
    const hold = await makeReservation(page, spec, opts);
    await putRecord({
      id: spec.id,
      spec,
      bookedTime: hold.bookedTime,
      siteRef: hold.siteRef,
      summaryUrl: hold.summaryUrl,
      orderUrl: hold.orderUrl,
      amount: hold.amount,
      createdAt: hold.createdAt,
      expiresAt: new Date(Date.parse(hold.createdAt) + HOLD_MS).toISOString(),
      status: 'active',
      attempts: 0,
      lastError: null,
      lastRefreshAt: new Date().toISOString(),
      nextAttemptAt: null,
    });
    console.log(
      `[reconcile] OK ${label}: ${hold.bookedTime}, do zaplaty ${hold.amount}`,
    );
    return hold.bookedTime;
  } catch (e) {
    const unavailable = e instanceof UnavailableError;
    const msg = e instanceof Error ? e.message : String(e);
    const attempts = unavailable ? 0 : (rec?.attempts ?? 0) + 1;
    const backoff = !unavailable
      ? FAILED_RETRY_MS
      : wasHeld
      ? LOST_RETRY_MS // nasze miejsce — probuj czesto je odzyskac
      : UNAVAILABLE_RETRY_MS; // nowy dzien, sprzedane — rzadko

    await putRecord({
      id: spec.id,
      spec,
      bookedTime: rec?.bookedTime ?? null,
      siteRef: rec?.siteRef ?? null,
      summaryUrl: rec?.summaryUrl ?? null,
      orderUrl: rec?.orderUrl ?? null,
      amount: rec?.amount ?? null,
      createdAt: rec?.createdAt ?? null,
      expiresAt: null,
      status: unavailable ? 'unavailable' : 'failed',
      attempts,
      lastError: msg,
      lastRefreshAt: new Date().toISOString(),
      nextAttemptAt: new Date(now + backoff).toISOString(),
    });

    if (unavailable) {
      console.log(
        `[reconcile] ${label}: brak miejsc${wasHeld ? ' (stracone w luce)' : ''} — ${msg}`,
      );
      if (wasHeld) await notify(`Stracono miejsca ${spec.id}: ${msg}`);
    } else {
      console.error(`[reconcile] ${label}: blad — ${msg}`);
      if (attempts <= MAX_ATTEMPTS) {
        await notify(`Nie odtworzono ${spec.id}, proba ${attempts}: ${msg}`);
      }
    }
    return null;
  }
}
