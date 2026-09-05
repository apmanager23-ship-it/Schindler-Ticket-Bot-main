// ---------------------------------------------------------------------
//  Konfiguracja wspolna dla wszystkich modulow
// ---------------------------------------------------------------------

export const DEBUG = Deno.env.get('DEBUG') === 'true';
export const LOGIN = Deno.env.get('LOGIN') ?? '';
export const PASSWORD = Deno.env.get('PASSWORD') ?? '';

// Gdzie Deno KV trzyma stan rezerwacji.
// Lokalnie: puste => domyslna lokalizacja Deno (per-skrypt, trwala).
// Na Railway: ustaw KV_PATH=/data/kv.sqlite i podepnij Volume pod /data.
export const KV_PATH = Deno.env.get('KV_PATH') ?? '';

export const GROUP_URL =
  'https://bilety.mhk.pl/rezerwacja/termin.html?idl=1&idg=0&idw=2&d=3';
export const LOGIN_URL = 'https://bilety.mhk.pl/uzytkownik/login.html';

// --- strojenie utrzymywania rezerwacji ---
// Deklarowany czas zycia rezerwacji na stronie (rezerwacja wygasa po 5 h).
export const HOLD_MS = Number(Deno.env.get('HOLD_MS') ?? 5 * 60 * 60_000);
// Odswiez rezerwacje, gdy do wygasniecia zostalo mniej niz tyle.
export const SAFETY_MS = Number(Deno.env.get('SAFETY_MS') ?? 45 * 60_000);
// Co ile worker robi pelny przebieg (musi byc wyraznie < SAFETY_MS).
export const CYCLE_MS = Number(Deno.env.get('CYCLE_MS') ?? 15 * 60_000);
// Po tylu nieudanych probach odswiezenia z rzedu rekord idzie w stan "failed".
export const MAX_ATTEMPTS = Number(Deno.env.get('MAX_ATTEMPTS') ?? 5);

// --- reconciler (rolling horizon) ---
// Ile nowych holdow probowac utworzyc w jednym cyklu (reszta czeka na kolejny).
export const CREATE_BUDGET_PER_CYCLE = Number(Deno.env.get('CREATE_BUDGET') ?? 5);
// Backoff dla dnia bez wolnych miejsc (dostepnosc bywa sie otwiera).
export const UNAVAILABLE_RETRY_MS = Number(
  Deno.env.get('UNAVAILABLE_RETRY_MS') ?? 12 * 60 * 60_000,
);
// Backoff dla bledu technicznego przy tworzeniu.
export const FAILED_RETRY_MS = Number(
  Deno.env.get('FAILED_RETRY_MS') ?? 60 * 60_000,
);

// ---------------------------------------------------------------------
//  Polityka: opisuje jak ma wygladac rezerwacja na DOWOLNY dzien z okna.
//  Konkretne daty nie sa nigdzie trzymane — liczy je desiredDates() co cykl.
// ---------------------------------------------------------------------

export interface ReservationPolicy {
  leadDays: number; // od dzis + tyle (grupowe wymagaja wyprzedzenia)
  horizonDays: number; // do dzis + tyle (koniec okna)
  weekdays: number[]; // 0=niedziela .. 6=sobota — ktore dni obejmowac
  skipDates: string[]; // "YYYY-MM-DD" — swieta / dni zamkniecia
  timeFrom: string; // "HH:MM" wlacznie
  timeTo: string; // "HH:MM" wlacznie
  quantity: number; // biletow grupowych na termin
  withCertifiedGuide: boolean;
}

export const POLICY: ReservationPolicy = {
  leadDays: Number(Deno.env.get('LEAD_DAYS') ?? 2),
  horizonDays: Number(Deno.env.get('HORIZON_DAYS') ?? 21),
  weekdays: (Deno.env.get('WEEKDAYS') ?? '0,1,2,3,4,5,6')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6),
  skipDates: (Deno.env.get('SKIP_DATES') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  timeFrom: Deno.env.get('TIME_FROM') ?? '10:00',
  timeTo: Deno.env.get('TIME_TO') ?? '14:00',
  quantity: Number(Deno.env.get('QUANTITY') ?? 15),
  withCertifiedGuide: (Deno.env.get('WITH_GUIDE') ?? 'true') === 'true',
};

// Konkretna specyfikacja dla jednej daty — wynika w calosci z POLICY.
export interface ReservationSpec {
  id: string; // "schindler-YYYY-MM-DD" — deterministyczne z daty
  date: string; // "YYYY-MM-DD"
  timeFrom: string;
  timeTo: string;
  quantity: number;
  withCertifiedGuide: boolean;
}

export function specForDate(date: string): ReservationSpec {
  return {
    id: `schindler-${date}`,
    date,
    timeFrom: POLICY.timeFrom,
    timeTo: POLICY.timeTo,
    quantity: POLICY.quantity,
    withCertifiedGuide: POLICY.withCertifiedGuide,
  };
}

// ---------------------------------------------------------------------
//  Kalendarz (strefa Europe/Warsaw — muzeum jest w Krakowie)
// ---------------------------------------------------------------------

export function todayInWarsaw(): string {
  // en-CA => "YYYY-MM-DD"
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Warsaw' });
}

export function addDays(dateStr: string, n: number): string {
  const d = new Date(`${dateStr}T12:00:00Z`); // poludnie UTC => brak potkniec na DST
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function weekday(dateStr: string): number {
  return new Date(`${dateStr}T12:00:00Z`).getUTCDay();
}

// Zbior dat, ktore POWINNY miec zarezerwowany termin — rosnaco.
export function desiredDates(today: string = todayInWarsaw()): string[] {
  const out: string[] = [];
  for (let i = POLICY.leadDays; i <= POLICY.horizonDays; i++) {
    const d = addDays(today, i);
    if (!POLICY.weekdays.includes(weekday(d))) continue;
    if (POLICY.skipDates.includes(d)) continue;
    out.push(d);
  }
  return out;
}
