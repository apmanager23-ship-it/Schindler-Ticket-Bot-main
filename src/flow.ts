// ---------------------------------------------------------------------
//  Silnik rezerwacji: od kalendarza do ekranu podsumowania (bez platnosci).
//  Dojscie do podsumowania = utworzony "hold" waznny ~5 h.
// ---------------------------------------------------------------------

import { GROUP_URL, ReservationSpec } from './config.ts';
import { hideLoading, saveErrorArtifacts } from './browser.ts';

// Rzucane, gdy dnia/terminu po prostu nie da sie zarezerwowac (brak slotu,
// za malo wolnych miejsc) — w odroznieniu od bledu technicznego. Wolajacy
// mapuje to na status "unavailable" (lagodny backoff), nie "failed".
export class UnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnavailableError';
  }
}

export interface HoldResult {
  bookedTime: string; // faktycznie zaklepana godzina "HH:MM"
  summaryUrl: string;
  amount: string; // "Do zaplaty", np. "450,00 zl" albo "?"
  siteRef: string | null; // numer/identyfikator rezerwacji ze strony, jesli wykryty
  createdAt: string; // ISO — moment dojscia do podsumowania
}

// --- placeholdery danych uczestnikow ---
function participantFirstName(_i: number): string {
  return `Gosc`;
}
function participantLastName(i: number): string {
  return `Grupa ${i + 1}`;
}

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

async function setSpinner(input: any, value: number) {
  await input.click();
  await input.fill(String(value));
  await input.dispatchEvent('input');
  await input.dispatchEvent('change');
  await input.dispatchEvent('keyup');
  await input.evaluate((el: any) => el.blur());
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
      if (curYear === year && curMonth === month) return;
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
    await Promise.all([
      page.waitForLoadState('networkidle').catch(() => {}),
      next.click({ force: true }),
    ]);
    await hideLoading(page);
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

  await Promise.all([
    page.waitForLoadState('networkidle').catch(() => {}),
    btn.click({ force: true }),
  ]);
  await hideLoading(page);
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

    await Promise.all([
      page.waitForLoadState('networkidle').catch(() => {}),
      btn.click({ force: true }),
    ]);
    await hideLoading(page);
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

  await Promise.all([
    page.waitForLoadState('networkidle').catch(() => {}),
    page.click('#nienumerowane-submit'),
  ]);

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
}

// ---------------------------------------------------------------------
//  Koszyk -> podsumowanie (STOP przed "KUPUJE I PLACE")
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

async function reachSummary(
  page: any,
  bookedTime: string,
): Promise<{ summaryUrl: string; amount: string; siteRef: string | null }> {
  const tag = bookedTime.replace(':', '');
  await page.waitForSelector('#koszyk', { state: 'visible' }).catch(() => {});
  await hideLoading(page);

  await fillParticipants(page);
  await pickRequiredRadios(page);

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

  const amount =
    bodyText.match(/Do zap[łl]aty:\s*([\d\s.,]+z[łl])/i)?.[1]?.trim() ?? '?';

  let siteRef: string | null = null;
  try {
    const q = new URL(url).searchParams;
    siteRef = q.get('idr') ?? q.get('idrez') ?? q.get('id') ?? null;
  } catch (_) {
    // ignore
  }
  if (!siteRef) {
    siteRef =
      bodyText.match(
        /rezerwacj\w*\s*(?:nr|numer|id)?[:\s]+([A-Z0-9][A-Z0-9/-]{3,})/i,
      )?.[1] ?? null;
  }

  return { summaryUrl: url, amount, siteRef };
}

// ---------------------------------------------------------------------
//  Publiczne API silnika
// ---------------------------------------------------------------------

/**
 * Tworzy rezerwacje (hold) dla podanej specyfikacji i zatrzymuje sie na
 * ekranie podsumowania — NIE finalizuje platnosci.
 *
 * @param opts.exactTime  gdy podane, celuje dokladnie w te godzine i rzuca
 *                        blad, jesli nie ma juz w niej wolnych miejsc.
 *                        Uzywane przez modul utrzymujacy do odswiezania.
 */
export async function makeReservation(
  page: any,
  spec: ReservationSpec,
  opts: { exactTime?: string; excludeTimes?: string[] } = {},
): Promise<HoldResult> {
  await page.goto(GROUP_URL, { waitUntil: 'networkidle' });
  await hideLoading(page);
  await goToMonthContaining(page, spec.date);

  if (!(await openDay(page, spec.date))) {
    throw new UnavailableError(`Dzien ${spec.date} nie ma dostepnych terminow.`);
  }

  const slots = await collectSlots(page);
  const inRange = slots.filter((s) =>
    timeInRange(s.time, spec.timeFrom, spec.timeTo),
  );

  let chosen: Slot | undefined;
  if (opts.exactTime) {
    chosen = inRange.find((s) => s.time === opts.exactTime);
    if (!chosen) {
      throw new UnavailableError(
        `Termin ${opts.exactTime} zniknal z dnia ${spec.date} (dostepne: ${
          inRange.map((s) => s.time).join(', ') || 'brak'
        }).`,
      );
    }
    if (chosen.available < spec.quantity) {
      throw new UnavailableError(
        `Termin ${opts.exactTime} dnia ${spec.date}: wolnych ${chosen.available}, potrzeba ${spec.quantity}.`,
      );
    }
  } else {
    const exclude = new Set(opts.excludeTimes ?? []);
    chosen = inRange.find(
      (s) => s.available >= spec.quantity && !exclude.has(s.time),
    );
    if (!chosen) {
      throw new UnavailableError(
        `Brak wolnego terminu z >=${spec.quantity} miejscami w przedziale ${spec.timeFrom}-${spec.timeTo} dnia ${spec.date}` +
          (exclude.size ? ` (poza zajetymi: ${[...exclude].join(', ')})` : '') +
          '.',
      );
    }
  }

  await clickWybierzForTime(page, chosen.time);
  await selectTicketsAndSubmit(page, spec.quantity, spec.withCertifiedGuide);
  const summary = await reachSummary(page, chosen.time);

  return {
    bookedTime: chosen.time,
    createdAt: new Date().toISOString(),
    ...summary,
  };
}
