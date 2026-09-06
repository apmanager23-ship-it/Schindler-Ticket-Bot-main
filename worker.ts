// ---------------------------------------------------------------------
//  Dlugo zyjacy worker.
//  Przebieg: launch przegladarki -> login -> reconcile() -> ZAMKNIECIE
//  przegladarki -> dynamiczny sen do najblizszego wygasniecia rekordu,
//  w granicach [MIN_SLEEP_MS, MAX_SLEEP_MS].
//  Przegladarka NIE zyje podczas snu — w spoczynku zostaje tylko Deno
//  (~50 MB), zamiast ~200-400 MB cieplego Chromium.
//  Jeden proces = brak potrzeby zewnetrznej blokady.
// ---------------------------------------------------------------------

import {
  LOGIN,
  MAX_SLEEP_MS,
  MIN_SLEEP_MS,
  nextMidnightWarsawMs,
  PASSWORD,
} from './src/config.ts';
import { ensureLoggedIn, launch } from './src/browser.ts';
import { reconcile } from './src/reserve.ts';
import { notify, notifyRaw } from './src/notify.ts';
import { renderDump } from './src/report.ts';
import { startWeb } from './src/web.ts';

if (!LOGIN || !PASSWORD) {
  console.error('❌ Brak LOGIN / PASSWORD w zmiennych srodowiskowych.');
  Deno.exit(1);
}

// panel web (nieblokujacy) — dziala rownolegle z petla ponizej
startWeb();

// TYLKO DO TESTOW: po kazdym przebiegu wysyla pelny zrzut bazy na Telegram.
// Wylaczenie: usun DEBUG_DUMP_NOTIFY albo ustaw na cokolwiek != "true".
const DEBUG_DUMP_NOTIFY = Deno.env.get('DEBUG_DUMP_NOTIFY') === 'true';

let stopping = false;
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  try {
    Deno.addSignalListener(sig, () => {
      stopping = true;
      console.log('[worker] sygnal — koncze po biezacym przebiegu...');
    });
  } catch (_) {
    // SIGTERM nieobslugiwany na Windows — pomijamy
  }
}

const clamp = (ms: number) =>
  Math.max(MIN_SLEEP_MS, Math.min(MAX_SLEEP_MS, ms));

// Sen przerywalny sygnalem (przegladarka juz zamknieta).
async function sleep(ms: number) {
  const step = 1000;
  for (let waited = 0; waited < ms && !stopping; waited += step) {
    await new Promise((r) => setTimeout(r, Math.min(step, ms - waited)));
  }
}

console.log('[worker] start');

while (!stopping) {
  const t0 = Date.now();
  let ms = MIN_SLEEP_MS;
  let session: Awaited<ReturnType<typeof launch>> | undefined;

  try {
    session = await launch();
    await ensureLoggedIn(session.page);
    const { moreWork, nextWakeAt } = await reconcile(session.page);

    if (moreWork) {
      ms = MIN_SLEEP_MS;
    } else {
      // Najblizsza polnoc (Warsaw) to zawsze punkt przebudzenia — wtedy
      // pojawiaja sie sloty na kolejny dzien okna. Jesli inny cel wypadlby
      // tuz po polnocy, i tak trafiamy dokladnie w 00:00.
      const midnight = nextMidnightWarsawMs();
      const target = nextWakeAt === null
        ? midnight
        : Math.min(nextWakeAt, midnight);
      const raw = Math.max(0, target - Date.now());
      // przy celu = polnoc nie stosujemy dolnego progu MIN_SLEEP
      ms = target === midnight
        ? Math.min(MAX_SLEEP_MS, raw)
        : clamp(raw);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[worker] przebieg przerwany bledem:', msg);
    await notify(`worker: ${msg}`);
    ms = MIN_SLEEP_MS;
  } finally {
    if (session) await session.browser.close().catch(() => {});
  }

  if (stopping) break;

  // TYLKO DO TESTOW — zrzut bazy na Telegram po przebiegu
  if (DEBUG_DUMP_NOTIFY) {
    try {
      const snapshot = await renderDump();
      console.log(`[DEBUG dump]\n${snapshot}`);
      await notifyRaw(`🧪 [TEST] dump bazy po przebiegu\n\n${snapshot}`);
    } catch (e) {
      console.error('[worker] DEBUG_DUMP_NOTIFY:', e);
    }
  }

  ms = Math.min(MAX_SLEEP_MS, Math.max(0, ms));
  console.log(
    `[worker] przebieg ${Math.round((Date.now() - t0) / 1000)} s, sen ${Math.round(ms / 1000)} s`,
  );
  await sleep(ms);
}

console.log('[worker] zatrzymany');
Deno.exit(0);
