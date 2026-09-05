// ---------------------------------------------------------------------
//  Dlugo zyjacy worker: co CYCLE_MS
//    1. upewnia sie, ze jest zalogowany,
//    2. tworzy brakujace rezerwacje (Modul A),
//    3. odswieza te blisko wygasniecia (Modul B).
//  Jeden proces = brak potrzeby zewnetrznej blokady.
// ---------------------------------------------------------------------

import { CYCLE_MS, LOGIN, PASSWORD } from './src/config.ts';
import { ensureLoggedIn, launch } from './src/browser.ts';
import { ensureCreated } from './src/reserve.ts';
import { runKeepAlive } from './src/keep-alive.ts';
import { notify } from './src/notify.ts';

if (!LOGIN || !PASSWORD) {
  console.error('❌ Brak LOGIN / PASSWORD w zmiennych srodowiskowych.');
  Deno.exit(1);
}

const { browser, page } = await launch();

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  console.log('[worker] zamykam przegladarke...');
  await browser.close().catch(() => {});
  Deno.exit(0);
}
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  try {
    Deno.addSignalListener(sig, shutdown);
  } catch (_) {
    // SIGTERM nieobslugiwany na Windows — pomijamy
  }
}

console.log(
  `[worker] start — cykl co ${Math.round(CYCLE_MS / 60000)} min`,
);

while (!stopping) {
  const t0 = Date.now();
  try {
    await ensureLoggedIn(page);
    await ensureCreated(page);
    await runKeepAlive(page);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[worker] cykl przerwany bledem:', msg);
    await notify(`worker: cykl przerwany: ${msg}`);
  }

  const elapsed = Date.now() - t0;
  const wait = Math.max(0, CYCLE_MS - elapsed);
  console.log(
    `[worker] cykl zajal ${Math.round(elapsed / 1000)} s, spie ${Math.round(wait / 1000)} s`,
  );
  await new Promise((r) => setTimeout(r, wait));
}
