// ---------------------------------------------------------------------
//  Konfiguracja wspolna dla wszystkich modulow
// ---------------------------------------------------------------------

export const DEBUG = Deno.env.get('DEBUG') === 'true';
export const LOGIN = Deno.env.get('LOGIN') ?? '';
export const PASSWORD = Deno.env.get('PASSWORD') ?? '';

// Plik Deno KV (SQLite) — tworzony sam, razem z katalogiem (patrz store.ts).
// Lokalnie: domyslnie ./.data/kv.sqlite (gitignorowane).
// Na Railway: KV_PATH=/data/kv.sqlite + podepnij Volume pod /data.
export const KV_PATH = Deno.env.get('KV_PATH') || './.data/kv.sqlite';

export const GROUP_URL =
  'https://bilety.mhk.pl/rezerwacja/termin.html?idl=1&idg=0&idw=2&d=3';
export const LOGIN_URL = 'https://bilety.mhk.pl/uzytkownik/login.html';

// --- strojenie utrzymywania rezerwacji ---
// Deklarowany czas zycia rezerwacji (wygasa po ~5 h). Przyblizenie — patrz GRACE.
export const HOLD_MS = Number(Deno.env.get('HOLD_MS') ?? 5 * 60 * 60_000);
// Ile odczekac PO wyliczonym wygasnieciu, zanim probowac odtworzyc. Nie da sie
// trzymac dwoch nakladajacych sie holdow na to samo miejsce, wiec czekamy az
// stary wygasnie; serwer potrzebuje chwili na zwolnienie slotu, a HOLD_MS to
// przyblizenie.
export const RECREATE_GRACE_MS = Number(
  Deno.env.get('RECREATE_GRACE_MS') ?? 60_000,
);
// Dynamiczny sen workera: budzi sie na najblizsze wygasniecie, w tych granicach.
export const MIN_SLEEP_MS = Number(Deno.env.get('MIN_SLEEP_MS') ?? 60_000);
export const MAX_SLEEP_MS = Number(
  Deno.env.get('MAX_SLEEP_MS') ?? Deno.env.get('CYCLE_MS') ?? 15 * 60_000,
);
// Po tylu nieudanych probach (blad techniczny) z rzedu -> status "failed".
export const MAX_ATTEMPTS = Number(Deno.env.get('MAX_ATTEMPTS') ?? 5);

// --- reconciler ---
// Ile rezerwacji odtwarzac / tworzyc na jeden przebieg.
export const CREATE_BUDGET_PER_CYCLE = Number(Deno.env.get('CREATE_BUDGET') ?? 5);
// Backoff: dzien bez wolnych miejsc (sprzedane) — rzadkie ponawianie.
export const UNAVAILABLE_RETRY_MS = Number(
  Deno.env.get('UNAVAILABLE_RETRY_MS') ?? 12 * 60 * 60_000,
);
// Backoff: nasz wygasly hold, ktorego nie udalo sie od razu odzyskac (ktos wszedl
// w luke) — czeste ponawianie, zeby wrocic po miejsca.
export const LOST_RETRY_MS = Number(Deno.env.get('LOST_RETRY_MS') ?? 5 * 60_000);
// Backoff: blad techniczny.
export const FAILED_RETRY_MS = Number(
  Deno.env.get('FAILED_RETRY_MS') ?? 60 * 60_000,
);
// Ile po polnocy (Warsaw) przebiegi maja specjalna kolejnosc: najpierw nowe
// rezerwacje, poczawszy od NAJPOZNIEJSZEJ daty w oknie (nowy dzien wlasnie sie
// otworzyl — wyscig z innymi kupujacymi).
export const MIDNIGHT_WINDOW_MS = Number(
  Deno.env.get('MIDNIGHT_WINDOW_MS') ?? 5 * 60_000,
);

// ---------------------------------------------------------------------
//  Polityka: opisuje jak ma wygladac pokrycie DOWOLNEGO dnia z okna.
//  Konkretne daty/sloty nie sa nigdzie trzymane — liczy je desiredSpecs().
// ---------------------------------------------------------------------

export interface ReservationPolicy {
  leadDays: number; // od dzis + tyle (grupowe wymagaja wyprzedzenia)
  horizonDays: number; // do dzis + tyle (koniec okna)
  weekdays: number[]; // 0=niedziela .. 6=sobota — ktore dni obejmowac
  skipDates: string[]; // "YYYY-MM-DD" — swieta / dni zamkniecia
  slotsPerDay: number; // ile osobnych rezerwacji na dobe (rozne godziny)
  timeFrom: string; // "HH:MM" wlacznie — dolna granica okna godzinowego
  timeTo: string; // "HH:MM" wlacznie — gorna granica
  quantity: number; // biletow grupowych na jedna rezerwacje
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
  slotsPerDay: Math.max(1, Number(Deno.env.get('SLOTS_PER_DAY') ?? 1)),
  timeFrom: Deno.env.get('TIME_FROM') ?? '10:00',
  timeTo: Deno.env.get('TIME_TO') ?? '14:00',
  quantity: Number(Deno.env.get('QUANTITY') ?? 15),
  withCertifiedGuide: (Deno.env.get('WITH_GUIDE') ?? 'true') === 'true',
};

// Konkretna specyfikacja jednej rezerwacji — data + indeks slotu w obrebie dnia.
export interface ReservationSpec {
  id: string; // "schindler-YYYY-MM-DD#N" — deterministyczne
  date: string; // "YYYY-MM-DD"
  slot: number; // 0-based indeks rezerwacji w obrebie dnia
  timeFrom: string;
  timeTo: string;
  quantity: number;
  withCertifiedGuide: boolean;
}

export function specForDate(date: string, slot = 0): ReservationSpec {
  return {
    id: `schindler-${date}#${slot}`,
    date,
    slot,
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

// Polnoc lokalna (Europe/Warsaw) danego dnia jako epoch ms.
// Offset liczony z poludnia UTC, zeby ominac przejscia DST (w Polsce zmiana
// o 03:00, nie o polnocy).
function warsawMidnightMs(dateStr: string): number {
  const hourAtNoonUtc = Number(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Warsaw',
      hour: '2-digit',
      hour12: false,
    }).format(new Date(`${dateStr}T12:00:00Z`)),
  );
  const offsetH = hourAtNoonUtc - 12; // +1 (CET) lub +2 (CEST)
  return Date.parse(`${dateStr}T00:00:00Z`) - offsetH * 3_600_000;
}

// Najblizsza polnoc (Warsaw) — worker celuje dokladnie w ten moment, bo
// wtedy pojawiaja sie sloty na kolejny dzien okna.
export function nextMidnightWarsawMs(): number {
  return warsawMidnightMs(addDays(todayInWarsaw(), 1));
}

// Ile ms minelo od ostatniej polnocy (Warsaw).
export function msSinceMidnightWarsaw(): number {
  return Date.now() - warsawMidnightMs(todayInWarsaw());
}

// Daty w oknie [dzis+leadDays, dzis+horizonDays] po filtrach — rosnaco.
export function dateWindow(today: string = todayInWarsaw()): string[] {
  const out: string[] = [];
  for (let i = POLICY.leadDays; i <= POLICY.horizonDays; i++) {
    const d = addDays(today, i);
    if (!POLICY.weekdays.includes(weekday(d))) continue;
    if (POLICY.skipDates.includes(d)) continue;
    out.push(d);
  }
  return out;
}

// Wszystkie rezerwacje, ktore POWINNY istniec: kazdy dzien okna x slotsPerDay.
// Rosnaco: najpierw po dacie, potem po indeksie slotu.
export function desiredSpecs(today: string = todayInWarsaw()): ReservationSpec[] {
  const out: ReservationSpec[] = [];
  for (const date of dateWindow(today)) {
    for (let n = 0; n < POLICY.slotsPerDay; n++) out.push(specForDate(date, n));
  }
  return out;
}
