import { chromium } from 'npm:playwright';

const DEBUG = Deno.env.get('DEBUG') === 'true';
const DRY_RUN = Deno.env.get('DRY_RUN') === 'true';
const LOGIN = Deno.env.get('LOGIN') ?? '';
const PASSWORD = Deno.env.get('PASSWORD') ?? '';

const GROUP_URL =
  'https://bilety.mhk.pl/rezerwacja/termin.html?idl=1&idg=0&idw=2&d=3';
const LOGIN_URL = 'https://bilety.mhk.pl/uzytkownik/login.html';

interface ReservationParams {
  date: string; // YYYY-MM-DD
  timeFrom: string; // "HH:MM", wlacznie
  timeTo: string; // "HH:MM", wlacznie
  quantity: number; // liczba biletow grupowych na termin
  maxSlots: number; // ile terminow z przedzialu zarezerwowac
  withCertifiedGuide: boolean;
}

const TEST_RESERVATION: ReservationParams = {
  date: '2026-09-20',
  timeFrom: '10:00',
  timeTo: '14:00',
  quantity: 15,
  maxSlots: 1,
  withCertifiedGuide: true,
};

// --- placeholdery danych uczestnikow ---
function participantFirstName(_i: number): string {
  return `Gosc`;
}
function participantLastName(i: number): string {
  return `Grupa ${i + 1}`;
}

// ---------------------------------------------------------------------
//  Pomocnicze
// ---------------------------------------------------------------------

const PL_MONTHS: Record<string, number> = {
  styczen: 1,
  luty: 2,
  marzec: 3,
  kwiecien: 4,
  maj: 5,
  czerwiec: 6,
  lipiec: 7,
  sierpien: 8,
  wrzesien: 9,
  pazdziernik: 10,
  listopad: 11,
  grudzien: 12,
};

function normalizePl(s: string): string {
  return s
    .toLowerCase()
    .replaceAll('ą', 'a')
    .replaceAll('ć', 'c')
    .replaceAll('ę', 'e')
    .replaceAll('ł', 'l')
    .replaceAll('ń', 'n')
    .replaceAll('ó', 'o')
    .replaceAll('ś', 's')
    .replaceAll('ż', 'z')
    .replaceAll('ź', 'z')
    .trim();
}

function timeInRange(t: string, from: string, to: string): boolean {
  return t >= from && t <= to;
}

async function hideLoading(page: any) {
  await page.waitForSelector('#loading', { state: 'hidden' }).catch(() => {});
}

// Zrzut ekranu + HTML do logs/ — wywolywane tylko przy bledach.
async function saveErrorArtifacts(page: any, tag: string) {
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

async function setSpinner(input: any, value: number) {
  await input.click();
  await input.fill(String(value));
  await input.dispatchEvent('input');
  await input.dispatchEvent('change');
  await input.dispatchEvent('keyup');
  await input.evaluate((el: any) => el.blur());
}

// ---------------------------------------------------------------------
//  Logowanie
// ---------------------------------------------------------------------

async function login(page: any) {
  await page.goto(LOGIN_URL, { waitUntil: 'networkidle' });

  await page.fill('#login-email', LOGIN);
  await page.fill('#login-haslo', PASSWORD);

  await Promise.all([
    page.waitForLoadState('networkidle').catch(() => {}),
    page.click('#login-submit'),
  ]);

  if (page.url().includes('login.html')) {
    const err = await page
      .$$eval('.invalid-feedback, .alert-danger, .alert-warning', (els: any[]) =>
        els.map((e) => (e.textContent || '').trim()).filter(Boolean).join(' | '),
      )
      .catch(() => '');
    if (await page.$('#login-submit')) {
      throw new Error(`Logowanie nie powiodlo sie${err ? ` (${err})` : ''}.`);
    }
  }
}

// ---------------------------------------------------------------------
//  Nawigacja po kalendarzu
// ---------------------------------------------------------------------

async function goToMonthContaining(page: any, dateStr: string) {
  const [year, month] = dateStr.split('-').map(Number);

  for (let attempt = 0; attempt < 12; attempt++) {
    await hideLoading(page);
    await page.waitForSelector('.kalendarz-terminow', { state: 'visible' });

    const label = await page
      .$('.cal-nazwa-miesiaca')
      .then((el: any) => (el ? el.innerText() : ''));
    const m = normalizePl(label || '').match(/([a-z]+)\s+(\d{4})/);

    if (m) {
      const curMonth = PL_MONTHS[m[1]];
      const curYear = Number(m[2]);
      if (curYear === year && curMonth === month) {
        return;
      }
      if (curYear > year || (curYear === year && curMonth > month)) {
        throw new Error(
          `Kalendarz jest juz przy ${label.trim()}, a szukamy ${dateStr}.`,
        );
      }
    }

    const next = await page.$('a.month-switch.next-month');
    if (!next) {
      throw new Error(
        `Nie moge dojsc do miesiaca ${year}-${String(month).padStart(2, '0')} — brak przycisku "nastepny miesiac".`,
      );
    }
    await next.click({ force: true });
    await hideLoading(page);
    await page.waitForLoadState('networkidle');
  }

  throw new Error(`Nie znaleziono miesiaca dla daty ${dateStr} w 12 krokach.`);
}

async function openDay(page: any, dateStr: string): Promise<boolean> {
  const btn = await page.$(
    `button.kalendarz-terminow-dzien[data-day="${dateStr}"]`,
  );
  if (!btn) throw new Error(`Brak przycisku dnia ${dateStr} w kalendarzu.`);

  const classes = (await btn.getAttribute('class')) || '';
  if (
    !classes.includes('dzien-z-terminami') &&
    !classes.includes('dzien-bez-terminow')
  ) {
    return false;
  }

  await btn.click({ force: true });
  await hideLoading(page);
  await page.waitForLoadState('networkidle');
  return true;
}

interface Slot {
  time: string;
  available: number;
}

async function collectSlots(page: any): Promise<Slot[]> {
  const cards = await page.$$('div.card.card-border-left');
  const slots: Slot[] = [];

  for (const card of cards) {
    const textEl = await card.$('p.card-text.text-muted');
    if (!textEl) continue;
    const timeMatch = (await textEl.innerText()).trim().match(/(\d{2}:\d{2})\s*$/);
    if (!timeMatch) continue;
    const time = timeMatch[1];

    const availLink = await card.$('a.js-wybierz-termin-btn');
    if (availLink) {
      const cnt = (await availLink.innerText()).trim().match(/(\d+)\s*woln/i);
      slots.push({ time, available: cnt ? parseInt(cnt[1]) : 1 });
    } else {
      slots.push({ time, available: 0 });
    }
  }

  return slots;
}

async function clickWybierzForTime(page: any, time: string) {
  const cards = await page.$$('div.card.card-border-left');
  for (const card of cards) {
    const textEl = await card.$('p.card-text.text-muted');
    if (!textEl) continue;
    if (!(await textEl.innerText()).trim().match(new RegExp(`${time}\\s*$`))) {
      continue;
    }

    const btn = await card.$('a.js-wybierz-termin-btn');
    if (!btn) throw new Error(`Termin ${time} nie ma juz przycisku WYBIERZ.`);

    await btn.click({ force: true });
    await hideLoading(page);
    await page.waitForLoadState('networkidle');
    return;
  }
  throw new Error(`Nie znaleziono karty terminu ${time}.`);
}

// ---------------------------------------------------------------------
//  Wybor biletow (nienumerowane.html)
// ---------------------------------------------------------------------

async function selectTicketsAndSubmit(
  page: any,
  quantity: number,
  withCertifiedGuide: boolean,
) {
  await page.waitForSelector('#nienumerowane', { state: 'visible' });

  const rows = await page.$$('#nienumerowane tr.price-list-position-row');
  if (!rows.length) throw new Error('Brak wierszy z rodzajami biletow.');

  let mainRowSet = false;
  let guideRowSet = false;

  for (const row of rows) {
    const priceUnit = Number((await row.getAttribute('data-price_unit')) || '0');
    const label = ((await row
      .$eval('label', (e: any) => e.textContent || '')
      .catch(() => '')) as string).trim();
    const labelNorm = normalizePl(label);
    const input = await row.$('input.ilosc-biletow-nienumerowanych');
    if (!input) continue;

    if (!mainRowSet && priceUnit > 0 && !labelNorm.includes('szkolny')) {
      await setSpinner(input, quantity);
      mainRowSet = true;
      continue;
    }

    if (
      withCertifiedGuide &&
      !guideRowSet &&
      (labelNorm.includes('certyfikat') ||
        labelNorm.includes('przewodnik zewnetrzny'))
    ) {
      await setSpinner(input, 1);
      guideRowSet = true;
    }
  }

  if (!mainRowSet) {
    throw new Error('Nie udalo sie ustawic ilosci dla biletu grupowego.');
  }

  await page.click('#nienumerowane-submit');

  const modal = await page.$('#notice-modal');
  if (modal && (await modal.isVisible())) {
    const msg = (
      await page
        .$eval('#notice-modal .modal-body', (e: any) => e.textContent || '')
        .catch(() => '')
    ).trim();
    await saveErrorArtifacts(page, 'modal-walidacji');
    throw new Error(`Walidacja formularza biletow: ${msg || '(nieznany komunikat)'}`);
  }

  await hideLoading(page);
  await page.waitForLoadState('networkidle');
}

// ---------------------------------------------------------------------
//  Koszyk -> podsumowanie -> KUPUJE I PLACE
// ---------------------------------------------------------------------

async function fillParticipants(page: any) {
  const imie = await page.$$('#koszyk input[name^="koszyk-uczestnik-imie-"]');
  const nazwisko = await page.$$(
    '#koszyk input[name^="koszyk-uczestnik-nazwisko-"]',
  );
  for (let i = 0; i < imie.length; i++) {
    await imie[i].fill(participantFirstName(i));
    if (nazwisko[i]) await nazwisko[i].fill(participantLastName(i));
  }
}

async function pickRequiredRadios(page: any) {
  for (const name of ['koszyk-transakcja_rodzaj', 'koszyk-sposob_dostawy_radio']) {
    const radios = await page.$$(`#koszyk input[name="${name}"]`);
    if (!radios.length) continue;

    let chosen = radios[0];
    for (const r of radios) {
      if (!(await r.isDisabled().catch(() => false))) {
        chosen = r;
        break;
      }
    }
    await chosen
      .check({ force: true })
      .catch(() => chosen.click({ force: true }).catch(() => {}));
    await chosen.dispatchEvent('change').catch(() => {});
  }
}

async function finalizeReservation(page: any, slot: Slot) {
  const tag = slot.time.replace(':', '');
  await page.waitForSelector('#koszyk', { state: 'visible' }).catch(() => {});
  await hideLoading(page);

  await fillParticipants(page);
  await pickRequiredRadios(page);

  if (DRY_RUN) {
    return { time: slot.time, status: 'dry-run', url: page.url() };
  }

  await Promise.all([
    page.waitForLoadState('networkidle').catch(() => {}),
    page.click('#koszyk-submit'),
  ]);
  await hideLoading(page);

  const modal = await page.$('#notice-modal');
  if (modal && (await modal.isVisible())) {
    const msg = (
      await page
        .$eval('#notice-modal .modal-body', (e: any) => e.textContent || '')
        .catch(() => '')
    ).trim();
    await saveErrorArtifacts(page, `koszyk_modal_${tag}`);
    throw new Error(`Koszyk — walidacja: ${msg || '(nieznany komunikat)'}`);
  }

  const url = page.url();
  const bodyText = ((await page.textContent('body')) || '').replace(/\s+/g, ' ');
  const kupBtn = await page.$('#form_rezerwacja-submit-kup');
  const onSummary =
    !!kupBtn || /kupuj[eę] i p[łl]ac[eę]|do zap[łl]aty/i.test(bodyText);

  if (!onSummary) {
    const bad = await page
      .$$eval('.is-invalid', (els: any[]) => els.length)
      .catch(() => 0);
    await saveErrorArtifacts(page, `koszyk_niewyslany_${tag}`);
    throw new Error(
      `Koszyk nie przeszedl do podsumowania (adres ${url}, ${bad} pol niepoprawnych).`,
    );
  }

  const doZaplaty =
    bodyText.match(/Do zap[łl]aty:\s*([\d\s.,]+z[łl])/i)?.[1]?.trim() ?? '?';

  if (DRY_RUN) {
    return { time: slot.time, status: 'awaiting-payment', url, amount: doZaplaty };
  }

  await Promise.all([
    page.waitForLoadState('networkidle').catch(() => {}),
    page.click('#form_rezerwacja-submit-kup'),
  ]);

  return {
    time: slot.time,
    status: 'order-submitted',
    summaryUrl: url,
    afterUrl: page.url(),
    amount: doZaplaty,
  };
}

// ---------------------------------------------------------------------
//  Glowna funkcja rezerwacji
// ---------------------------------------------------------------------

async function makeReservation(page: any, params: ReservationParams) {
  const { date, timeFrom, timeTo, quantity, maxSlots, withCertifiedGuide } =
    params;

  await page.goto(GROUP_URL, { waitUntil: 'networkidle' });
  await hideLoading(page);
  await goToMonthContaining(page, date);

  if (!(await openDay(page, date))) {
    throw new Error(`Dzien ${date} nie ma dostepnych terminow.`);
  }

  const slots = await collectSlots(page);

  const candidates = slots
    .filter((s) => timeInRange(s.time, timeFrom, timeTo) && s.available >= quantity)
    .slice(0, maxSlots);

  if (!candidates.length) {
    throw new Error(
      `Brak terminow z >=${quantity} miejscami w przedziale ${timeFrom}-${timeTo} dnia ${date}.`,
    );
  }

  const results: unknown[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const slot = candidates[i];

    if (i > 0) {
      await page.goto(GROUP_URL, { waitUntil: 'networkidle' });
      await hideLoading(page);
      await goToMonthContaining(page, date);
      await openDay(page, date);
    }

    await clickWybierzForTime(page, slot.time);
    await selectTicketsAndSubmit(page, quantity, withCertifiedGuide);
    const outcome = await finalizeReservation(page, slot);
    results.push(outcome);
  }

  return results;
}

// ---------------------------------------------------------------------
//  main
// ---------------------------------------------------------------------

async function main() {
  if (!LOGIN || !PASSWORD) {
    console.error(
      '❌ Brak danych logowania — ustaw zmienne srodowiskowe LOGIN i PASSWORD (np. w .env).',
    );
    Deno.exitCode = 1;
    return;
  }

  const browser = await chromium.launch({
    headless: !DEBUG,
    ...(DEBUG && { slowMo: 400 }),
  });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await login(page);
    const results = await makeReservation(page, TEST_RESERVATION);
    console.log(JSON.stringify(results, null, 2));
  } catch (e) {
    console.error('\n❌ Blad rezerwacji:', e instanceof Error ? e.message : e);
    await saveErrorArtifacts(page, 'blad').catch(() => {});
    Deno.exitCode = 1;
  } finally {
    if (DEBUG) {
      await page.waitForTimeout(15000);
    }
    await browser.close();
  }
}

if (import.meta.main) {
  main().catch((e) => console.error(e));
}
