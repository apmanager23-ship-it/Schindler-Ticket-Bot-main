// ---------------------------------------------------------------------
//  Modul A — reconciler stanu docelowego (rolling horizon).
//  Co cykl:
//    a) usuwa rekordy poza oknem (przeszlosc / zmiana polityki),
//    b) wybiera daty bez zywego holdu (brak rekordu albo unavailable/failed
//       po minieciu backoffu),
//    c) tworzy dla nich hold — max CREATE_BUDGET_PER_CYCLE na cykl,
//       najwczesniejsze daty pierwsze.
//  "Dopisywanie kolejnego dnia" wynika samo: jutro dzis+horizon to nowa data
//  bez rekordu -> trafia do (b).
// ---------------------------------------------------------------------

import {
  CREATE_BUDGET_PER_CYCLE,
  desiredDates,
  FAILED_RETRY_MS,
  HOLD_MS,
  MAX_ATTEMPTS,
  specForDate,
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
  const desired = desiredDates();
  if (desired.length === 0) {
    console.error(
      '[reconcile] desiredDates() puste — sprawdz POLICY (weekdays/horizon/skipDates). Pomijam cykl.',
    );
    return;
  }
  const desiredSet = new Set(desired);
  const records = await listRecords();
  const byId = new Map<string, ReservationRecord>(
    records.map((r) => [r.id, r]),
  );

  // a) sprzataj rekordy poza oknem — przestajemy je utrzymywac, hold sam wygasa
  let dropped = 0;
  for (const rec of records) {
    if (!desiredSet.has(rec.spec.date)) {
      await deleteRecord(rec.id);
      dropped++;
    }
  }
  if (dropped) console.log(`[reconcile] usunieto ${dropped} rekordow poza oknem`);

  // b) daty wymagajace utworzenia / ponowienia (desired jest rosnaco po dacie)
  const now = Date.now();
  const todo: string[] = [];
  for (const date of desired) {
    const rec = byId.get(`schindler-${date}`);
    if (!rec) {
      todo.push(date);
      continue;
    }
    if (rec.status === 'unavailable' || rec.status === 'failed') {
      if (!rec.nextAttemptAt || Date.parse(rec.nextAttemptAt) <= now) {
        todo.push(date);
      }
    }
  }

  const held = records.filter(
    (r) => r.status === 'active' || r.status === 'refreshing',
  ).length;
  if (todo.length) {
    const batch = todo.slice(0, CREATE_BUDGET_PER_CYCLE);
    console.log(
      `[reconcile] okno ${desired.length} dni, trzymane ${held}, do zrobienia ${todo.length}, w tym cyklu ${batch.length}`,
    );
    for (const date of batch) {
      await createOne(page, date, byId.get(`schindler-${date}`), now);
    }
  } else {
    console.log(`[reconcile] okno ${desired.length} dni, wszystko pokryte (${held})`);
  }
}

async function createOne(
  page: any,
  date: string,
  prev: ReservationRecord | undefined,
  now: number,
): Promise<void> {
  const spec = specForDate(date);
  try {
    const hold = await makeReservation(page, spec);
    const rec: ReservationRecord = {
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
    };
    await putRecord(rec);
    console.log(
      `[reconcile] OK ${date}: ${hold.bookedTime}, do zaplaty ${hold.amount}`,
    );
  } catch (e) {
    const unavailable = e instanceof UnavailableError;
    const msg = e instanceof Error ? e.message : String(e);
    const attempts = unavailable ? 0 : (prev?.attempts ?? 0) + 1;
    const backoff = unavailable ? UNAVAILABLE_RETRY_MS : FAILED_RETRY_MS;
    const rec: ReservationRecord = {
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
    };
    await putRecord(rec);
    if (unavailable) {
      console.log(`[reconcile] ${date}: brak miejsc — ${msg}`);
    } else {
      console.error(`[reconcile] ${date}: blad — ${msg}`);
      if (attempts <= MAX_ATTEMPTS) {
        await notify(`Nie utworzono rezerwacji ${date}, proba ${attempts}: ${msg}`);
      }
    }
  }
}
