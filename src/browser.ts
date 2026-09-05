// ---------------------------------------------------------------------
//  Przegladarka + sesja (login). Wspoldzielone przez wszystkie moduly.
// ---------------------------------------------------------------------

import { chromium } from 'npm:playwright';
import { DEBUG, LOGIN, LOGIN_URL, PASSWORD } from './config.ts';

export async function launch() {
  const browser = await chromium.launch({
    headless: !DEBUG,
    // flagi dla kontenera (Railway/Docker): mniej RAM + stabilnosc.
    // --disable-dev-shm-usage praktycznie obowiazkowe (male /dev/shm -> crashe).
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-zygote',
    ],
    ...(DEBUG && { slowMo: 400 }),
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  return { browser, context, page };
}

export async function hideLoading(page: any) {
  await page.waitForSelector('#loading', { state: 'hidden' }).catch(() => {});
}

async function isLoggedIn(page: any): Promise<boolean> {
  return await page
    .$$eval('a', (as: any[]) =>
      as.some((a) => /wyloguj/i.test(a.textContent || '')),
    )
    .catch(() => false);
}

// Loguje tylko, jesli sesja nie jest juz aktywna. Wolane na starcie kazdego cyklu.
export async function ensureLoggedIn(page: any) {
  await page.goto(LOGIN_URL, { waitUntil: 'networkidle' });
  if (await isLoggedIn(page)) return;

  await page.fill('#login-email', LOGIN);
  await page.fill('#login-haslo', PASSWORD);
  await Promise.all([
    page.waitForLoadState('networkidle').catch(() => {}),
    page.click('#login-submit'),
  ]);

  if (page.url().includes('login.html') && (await page.$('#login-submit'))) {
    const err = await page
      .$$eval('.invalid-feedback, .alert-danger, .alert-warning', (els: any[]) =>
        els.map((e) => (e.textContent || '').trim()).filter(Boolean).join(' | '),
      )
      .catch(() => '');
    throw new Error(`Logowanie nie powiodlo sie${err ? ` (${err})` : ''}.`);
  }
}

// Zrzut ekranu + HTML do logs/ — wywolywane tylko przy bledach.
export async function saveErrorArtifacts(page: any, tag: string) {
  try {
    await Deno.mkdir('logs', { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const base = `logs/${ts}_${tag}`;
    await page.screenshot({ path: `${base}.png`, fullPage: true }).catch(() => {});
    await Deno.writeTextFile(`${base}.html`, await page.content()).catch(() => {});
    console.error(`   (zapisano ${base}.png / .html)`);
  } catch (_) {
    // ignore
  }
}
