// ---------------------------------------------------------------------
//  Modul A — reconciler stanu docelowego (rolling horizon).
//  Cel = desiredSpecs(): kazdy dzien okna x POLICY.slotsPerDay rezerwacji,
//  kazda w innej godzinie z przedzialu [TIME_FROM, TIME_TO].
//  Co cykl:
//    a) usuwa rekordy poza celem (przeszlosc / mniejszy SLOTS_PER_DAY / skipDates),
//    b) wybiera specy bez zywego holdu (brak rekordu albo unavailable/failed
//       po minieciu backoffu),
//    c) tworzy dla nich hold — max CREATE_BUDGET_PER_CYCLE na cykl; przy wyborze
//       godziny omija terminy juz zajete innymi rezerwacjami tego samego dnia.
// ---------------------------------------------------------------------

import {
  CREATE_BUDGET_PER_CYCLE,
  dateWindow,
  desiredSpecs,
  FAILED_RETRY_MS,
  HOLD_MS,
  MAX_ATTEMPTS,
  ReservationSpec,
  UNAVAILABLE_RETRY_MS,
} from './config.ts';
import { makeReservation, UnavailableError } from './flow.ts';
import {
  deleteRecord,
  listRecords,
  putRecord,
  ReservationRecord,
} from './store.ts';
import { notify } from './notify.ts';

export async function reconcile(page: any): Promise<void> {
  const specs = desiredSpecs();
  if (specs.length === 0) {
    console.error(
      '[reconcile] brak dat w oknie — sprawdz POLICY (weekdays/horizon/skipDates). Pomijam cykl.',
    );
    return;
  }
  const desiredIds = new Set(specs.map((s) => s.id));
  const records = await listRecords();
  const byId = new Map<string, ReservationRecord>(
    records.map((r) => [r.id, r]),
  );

  // a) sprzataj rekordy poza celem — przestajemy je utrzymywac, hold sam wygasa
  let dropped = 0;
  for (const rec of records) {
    if (!desiredIds.has(rec.id)) {
      await deleteRecord(rec.id);
      dropped++;
    }
  }
  if (dropped) console.log(`[reconcile] usunieto ${dropped} rekordow poza celem`);

  // zajete godziny per dzien (z zywych rekordow, ktore zostaja) — zeby nie
  // zaklepac dwoch rezerwacji tego samego dnia w tej samej godzinie
  const usedByDate = new Map<string, Set<string>>();
  for (const rec of records) {
    if (!desiredIds.has(rec.id) || !rec.bookedTime) continue;
    if (rec.status !== 'active' && rec.status !== 'refreshing') continue;
    if (!usedByDate.has(rec.spec.date)) usedByDate.set(rec.spec.date, new Set());
    usedByDate.get(rec.spec.date)!.add(rec.bookedTime);
  }

  // b) czego brakuje (specs sa rosnaco: data, potem slot)
  const now = Date.now();
  const todo: ReservationSpec[] = [];
  for (const spec of specs) {
    const rec = byId.get(spec.id);
    if (!rec) {
      todo.push(spec);
      continue;
    }
    if (rec.status === 'unavailable' || rec.status === 'failed') {
      if (!rec.nextAttemptAt || Date.parse(rec.nextAttemptAt) <= now) {
        todo.push(spec);
      }
    }
  }

  const held = records.filter(
    (r) =>
      desiredIds.has(r.id) &&
      (r.status === 'active' || r.status === 'refreshing'),
  ).length;

  if (todo.length === 0) {
    console.log(
      `[reconcile] okno ${dateWindow().length} dni, cel ${specs.length} rezerwacji, pokryte ${held}`,
    );
    return;
  }

  const batch = todo.slice(0, CREATE_BUDGET_PER_CYCLE);
  console.log(
    `[reconcile] cel ${specs.length}, trzymane ${held}, do zrobienia ${todo.length}, w tym cyklu ${batch.length}`,
  );

  for (const spec of batch) {
    if (!usedByDate.has(spec.date)) usedByDate.set(spec.date, new Set());
    const used = usedByDate.get(spec.date)!;
    const booked = await createOne(page, spec, byId.get(spec.id), now, [...used]);
    if (booked) used.add(booked);
  }
}

async function createOne(
  page: any,
  spec: ReservationSpec,
  prev: ReservationRecord | undefined,
  now: number,
  excludeTimes: string[],
): Promise<string | null> {
  const label = `${spec.date}#${spec.slot}`;
  try {
    const hold = await makeReservation(page, spec, { excludeTimes });
    await putRecord({
      id: spec.id,
      spec,
      bookedTime: hold.bookedTime,
      siteRef: hold.siteRef,
      summaryUrl: hold.summaryUrl,
      amount: hold.amount,
      createdAt: hold.createdAt,
      expiresAt: new Date(Date.parse(hold.createdAt) + HOLD_MS).toISOString(),
      status: 'active',
      attempts: 0,
      lastError: null,
      lastRefreshAt: null,
      nextAttemptAt: null,
    });
    console.log(
      `[reconcile] OK ${label}: ${hold.bookedTime}, do zaplaty ${hold.amount}`,
    );
    return hold.bookedTime;
  } catch (e) {
    const unavailable = e instanceof UnavailableError;
    const msg = e instanceof Error ? e.message : String(e);
    const attempts = unavailable ? 0 : (prev?.attempts ?? 0) + 1;
    const backoff = unavailable ? UNAVAILABLE_RETRY_MS : FAILED_RETRY_MS;
    await putRecord({
      id: spec.id,
      spec,
      bookedTime: prev?.bookedTime ?? null,
      siteRef: prev?.siteRef ?? null,
      summaryUrl: prev?.summaryUrl ?? null,
      amount: prev?.amount ?? null,
      createdAt: prev?.createdAt ?? null,
      expiresAt: null,
      status: unavailable ? 'unavailable' : 'failed',
      attempts,
      lastError: msg,
      lastRefreshAt: new Date().toISOString(),
      nextAttemptAt: new Date(now + backoff).toISOString(),
    });
    if (unavailable) {
      console.log(`[reconcile] ${label}: brak miejsc — ${msg}`);
    } else {
      console.error(`[reconcile] ${label}: blad — ${msg}`);
      if (attempts <= MAX_ATTEMPTS) {
        await notify(`Nie utworzono ${spec.id}, proba ${attempts}: ${msg}`);
      }
    }
    return null;
  }
}
