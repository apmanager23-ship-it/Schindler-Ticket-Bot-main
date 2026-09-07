// ---------------------------------------------------------------------
//  Jednorazowy runner do testow: tworzy JEDEN hold wg TEST_SPEC i wypisuje
//  wynik. NIE finalizuje platnosci. Utrzymywaniem rezerwacji zajmuje sie
//  worker.ts (Modul A + Modul B).
// ---------------------------------------------------------------------

import { LOGIN, PASSWORD, ReservationSpec } from './src/config.ts';
import { ensureLoggedIn, launch, saveErrorArtifacts } from './src/browser.ts';
import { makeReservation } from './src/flow.ts';

const TEST_SPEC: ReservationSpec = {
  id: 'test',
  date: '2026-10-31',
  slot: 2,
  preferredTimes: [],
  timeFrom: '10:00',
  timeTo: '18:00',
  quantity: 15, // maly na czas testu — realnie zablokuje tyle miejsc na ~5 h
  withCertifiedGuide: true,
};

async function main() {
  if (!LOGIN || !PASSWORD) {
    console.error(
      '❌ Brak danych logowania — ustaw zmienne srodowiskowe LOGIN i PASSWORD (np. w .env).',
    );
    Deno.exitCode = 1;
    return;
  }

  const { browser, page } = await launch();
  try {
    await ensureLoggedIn(page);
    const hold = await makeReservation(page, TEST_SPEC);
    console.log(JSON.stringify(hold, null, 2));
  } catch (e) {
    console.error('\n❌ Blad rezerwacji:', e instanceof Error ? e.message : e);
    await saveErrorArtifacts(page, 'blad').catch(() => {});
    Deno.exitCode = 1;
  } finally {
    await browser.close();
  }
}

if (import.meta.main) {
  main().catch((e) => console.error(e));
}
