// ---------------------------------------------------------------------
//  Modul B — utrzymywanie zywych rezerwacji.
//  Dla rekordu blisko wygasniecia tworzy hold jeszcze raz na ten sam dzien
//  i te sama godzine (exactTime), po czym nadpisuje rekord w KV.
//  Rekordy w stanie unavailable/failed nalezą do reconcile'a, nie tutaj.
// ---------------------------------------------------------------------

import {
  FAILED_RETRY_MS,
  HOLD_MS,
  MAX_ATTEMPTS,
  SAFETY_MS,
  UNAVAILABLE_RETRY_MS,
} from './config.ts';
import { makeReservation, UnavailableError } from './flow.ts';
import { listRecords, putRecord } from './store.ts';
import { notify } from './notify.ts';

export async function runKeepAlive(page: any): Promise<void> {
  const now = Date.now();

  for (const rec of await listRecords()) {
    if (rec.status !== 'active' && rec.status !== 'refreshing') continue;

    const msLeft = rec.expiresAt ? Date.parse(rec.expiresAt) - now : -Infinity;
    // "refreshing" = poprzedni przebieg przerwany w polowie -> ponawiamy.
    const needsRefresh = rec.status === 'refreshing' || msLeft <= SAFETY_MS;
    if (!needsRefresh) continue;

    console.log(
      `[keep-alive] odswiezam ${rec.id} (${rec.spec.date} ${rec.bookedTime}, zostalo ${Math.round(msLeft / 60000)} min)`,
    );
    await putRecord({ ...rec, status: 'refreshing' });

    try {
      const hold = await makeReservation(
        page,
        rec.spec,
        rec.bookedTime ? { exactTime: rec.bookedTime } : {},
      );
      const expiresAt = new Date(
        Date.parse(hold.createdAt) + HOLD_MS,
      ).toISOString();
      await putRecord({
        ...rec,
        bookedTime: hold.bookedTime,
        siteRef: hold.siteRef,
        summaryUrl: hold.summaryUrl,
        orderUrl: hold.orderUrl,
        amount: hold.amount,
        createdAt: hold.createdAt,
        expiresAt,
        status: 'active',
        attempts: 0,
        lastError: null,
        lastRefreshAt: new Date().toISOString(),
        nextAttemptAt: null,
      });
      console.log(`[keep-alive] OK ${rec.id}: ${hold.bookedTime}, wygasa ${expiresAt}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);

      if (e instanceof UnavailableError) {
        // termin przestal byc dostepny — oddajemy rekord reconcile'owi
        await putRecord({
          ...rec,
          expiresAt: null,
          status: 'unavailable',
          lastError: msg,
          lastRefreshAt: new Date().toISOString(),
          nextAttemptAt: new Date(now + UNAVAILABLE_RETRY_MS).toISOString(),
        });
        console.log(`[keep-alive] ${rec.id}: ${msg} — przekazane do reconcile`);
        continue;
      }

      const attempts = rec.attempts + 1;
      const capped = attempts >= MAX_ATTEMPTS;
      await putRecord({
        ...rec,
        status: capped ? 'failed' : 'active',
        attempts,
        lastError: msg,
        lastRefreshAt: new Date().toISOString(),
        nextAttemptAt: capped
          ? new Date(now + FAILED_RETRY_MS).toISOString()
          : null,
      });
      await notify(
        `Nie odswiezono ${rec.id} (${rec.spec.date} ${rec.bookedTime}), proba ${attempts}/${MAX_ATTEMPTS}: ${msg}`,
      );
    }
  }
}
