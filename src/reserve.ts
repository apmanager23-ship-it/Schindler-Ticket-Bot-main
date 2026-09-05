// ---------------------------------------------------------------------
//  Modul A — tworzenie pierwszej rezerwacji i zapis stanu do KV.
//  Idempotentny: pomija specyfikacje, ktore juz maja rekord.
// ---------------------------------------------------------------------

import { HOLD_MS, SPECS } from './config.ts';
import { makeReservation } from './flow.ts';
import { getRecord, putRecord, ReservationRecord } from './store.ts';
import { notify } from './notify.ts';

export async function ensureCreated(page: any): Promise<void> {
  for (const spec of SPECS) {
    if (await getRecord(spec.id)) continue;

    console.log(
      `[reserve] tworze rezerwacje ${spec.id} (${spec.date} ${spec.timeFrom}-${spec.timeTo}, ${spec.quantity} bil.)`,
    );
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
      };
      await putRecord(rec);
      console.log(
        `[reserve] OK ${spec.id}: ${hold.bookedTime}, do zaplaty ${hold.amount}, wygasa ${rec.expiresAt}`,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await notify(`Nie udalo sie utworzyc rezerwacji ${spec.id}: ${msg}`);
    }
  }
}
