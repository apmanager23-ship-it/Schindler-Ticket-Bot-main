// ---------------------------------------------------------------------
//  Modul B — utrzymywanie rezerwacji.
//  Dla kazdego rekordu blisko wygasniecia tworzy hold jeszcze raz na ten
//  sam dzien i te sama godzine, po czym nadpisuje rekord w KV.
// ---------------------------------------------------------------------

import { HOLD_MS, MAX_ATTEMPTS, SAFETY_MS } from './config.ts';
import { makeReservation } from './flow.ts';
import { listRecords, putRecord } from './store.ts';
import { notify } from './notify.ts';

export async function runKeepAlive(page: any): Promise<void> {
  const now = Date.now();

  for (const rec of await listRecords()) {
    const msLeft = Date.parse(rec.expiresAt) - now;

    // "refreshing" = poprzedni przebieg przerwany w polowie -> ponawiamy.
    const needsRefresh =
      rec.status === 'refreshing' ||
      (rec.status === 'active' && msLeft <= SAFETY_MS);
    if (!needsRefresh) continue;

    console.log(
      `[keep-alive] odswiezam ${rec.id} (${rec.spec.date} ${rec.bookedTime}, zostalo ${Math.round(msLeft / 60000)} min)`,
    );
    await putRecord({ ...rec, status: 'refreshing' });

    try {
      const hold = await makeReservation(page, rec.spec, {
        exactTime: rec.bookedTime,
      });
      await putRecord({
        ...rec,
        bookedTime: hold.bookedTime,
        siteRef: hold.siteRef,
        summaryUrl: hold.summaryUrl,
        amount: hold.amount,
        createdAt: hold.createdAt,
        expiresAt: new Date(Date.parse(hold.createdAt) + HOLD_MS).toISOString(),
        status: 'active',
        attempts: 0,
        lastError: null,
        lastRefreshAt: new Date().toISOString(),
      });
      console.log(
        `[keep-alive] OK ${rec.id}: ${hold.bookedTime}, wygasa ${
          new Date(Date.parse(hold.createdAt) + HOLD_MS).toISOString()
        }`,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const attempts = rec.attempts + 1;
      await putRecord({
        ...rec,
        status: attempts >= MAX_ATTEMPTS ? 'failed' : 'active',
        attempts,
        lastError: msg,
        lastRefreshAt: new Date().toISOString(),
      });
      await notify(
        `Nie odswiezono ${rec.id} (${rec.spec.date} ${rec.bookedTime}), proba ${attempts}/${MAX_ATTEMPTS}: ${msg}`,
      );
    }
  }
}
