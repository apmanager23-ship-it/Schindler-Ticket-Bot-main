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
// Po tylu nieudanych probach z rzedu rekord ida w stan "failed".
export const MAX_ATTEMPTS = Number(Deno.env.get('MAX_ATTEMPTS') ?? 5);

export interface ReservationSpec {
  id: string; // stabilny klucz logiczny rezerwacji (nie zmienia sie miedzy odswiezeniami)
  date: string; // "YYYY-MM-DD"
  timeFrom: string; // "HH:MM" wlacznie
  timeTo: string; // "HH:MM" wlacznie
  quantity: number; // liczba biletow grupowych na termin
  withCertifiedGuide: boolean;
}

// Lista rezerwacji do utrzymania. Na razie dwie; kolejne dokladac tutaj.
export const SPECS: ReservationSpec[] = [
  {
    id: 'schindler-2026-09-20-1000',
    date: '2026-09-20',
    timeFrom: '10:00',
    timeTo: '14:00',
    quantity: 15,
    withCertifiedGuide: true,
  },
  {
    id: 'schindler-2026-09-21-1000',
    date: '2026-09-21',
    timeFrom: '10:00',
    timeTo: '14:00',
    quantity: 15,
    withCertifiedGuide: true,
  },
];
