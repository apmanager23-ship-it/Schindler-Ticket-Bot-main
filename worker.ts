// ---------------------------------------------------------------------
//  Dlugo zyjacy worker.
//  Przebieg: login -> reconcile() (odtworz wygasle / dopelnij okno).
//  Sen jest DYNAMICZNY: worker budzi sie na najblizsze wygasniecie rekordu
//  (a nie co sztywne N minut), w granicach [MIN_SLEEP_MS, MAX_SLEEP_MS].
//  Jeden proces = brak potrzeby zewnetrznej blokady.
// ---------------------------------------------------------------------

import { LOGIN, MAX_SLEEP_MS, MIN_SLEEP_MS, PASSWORD } from './src/config.ts';
import { ensureLoggedIn, launch } from './src/browser.ts';
import { reconcile } from './src/reserve.ts';
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

const clamp = (ms: number) =>
  Math.max(MIN_SLEEP_MS, Math.min(MAX_SLEEP_MS, ms));

console.log('[worker] start');

while (!stopping) {
  const t0 = Date.now();
  let sleep = MIN_SLEEP_MS;

  try {
    await ensureLoggedIn(page);
    const { moreWork, nextWakeAt } = await reconcile(page);
    sleep = moreWork
      ? MIN_SLEEP_MS
      : nextWakeAt
      ? clamp(nextWakeAt - Date.now())
      : MAX_SLEEP_MS;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[worker] przebieg przerwany bledem:', msg);
    await notify(`worker: ${msg}`);
    sleep = MIN_SLEEP_MS;
  }

  sleep = clamp(sleep);
  console.log(
    `[worker] przebieg ${Math.round((Date.now() - t0) / 1000)} s, sen ${Math.round(sleep / 1000)} s`,
  );
  await new Promise((r) => setTimeout(r, sleep));
}
