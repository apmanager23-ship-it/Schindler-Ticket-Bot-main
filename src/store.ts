// ---------------------------------------------------------------------
//  Magazyn stanu rezerwacji (Deno KV).
//  Klucz: ["res", <ReservationSpec.id>]  ->  ReservationRecord
// ---------------------------------------------------------------------

import { KV_PATH, ReservationSpec } from './config.ts';

export type ReservationStatus =
  | 'active' // mamy zywy hold, expiresAt w przyszlosci
  | 'refreshing' // trwa odswiezanie (guard przed nakladaniem)
  | 'unavailable' // dzien bez wolnego terminu — ponowic po nextAttemptAt
  | 'failed'; // blad techniczny — ponowic po nextAttemptAt

export interface ReservationRecord {
  id: string; // = ReservationSpec.id, stabilny przez caly cykl zycia
  spec: ReservationSpec;
  bookedTime: string | null; // utrzymywana godzina "HH:MM"; null gdy nigdy nie zaklepano
  siteRef: string | null; // numer zamowienia ze strony
  summaryUrl: string | null; // adres podsumowania
  orderUrl: string | null; // adres po "KUPUJE I PLACE" (zamowienie nieoplacone)
  amount: string | null; // ostatnie "Do zaplaty"
  createdAt: string | null; // ISO — ostatni udany hold; null jesli nigdy
  expiresAt: string | null; // ISO — createdAt + HOLD_MS; null gdy brak zywego holdu
  status: ReservationStatus;
  attempts: number; // nieudane proby z rzedu (blad techniczny)
  lastError: string | null;
  lastRefreshAt: string | null; // ISO — ostatnia proba (udana lub nie)
  nextAttemptAt: string | null; // ISO — nie probuj wczesniej (backoff unavailable/failed)
}

// Dane gosci przypisane do rezerwacji (panel web -> pozniej platna rezerwacja).
// Osobno od ReservationRecord, bo reconcile() nadpisuje caly rekord.
export interface GuestSet {
  names: { first: string; last: string }[];
  updatedAt: string; // ISO
}

const PREFIX = ['res'] as const;
const GPREFIX = ['guests'] as const;

function openKv(): Promise<Deno.Kv> {
  // upewnij sie, ze katalog na plik istnieje (./.data/, /data/, ...)
  const dir = KV_PATH.replace(/[/\\][^/\\]*$/, '');
  if (dir && dir !== KV_PATH) {
    try {
      Deno.mkdirSync(dir, { recursive: true });
    } catch (_) {
      // ignore
    }
  }
  return Deno.openKv(KV_PATH);
}

let kvPromise: Promise<Deno.Kv> | null = null;
function kv(): Promise<Deno.Kv> {
  if (!kvPromise) {
    kvPromise = openKv().catch((e) => {
      // nie cache'uj nieudanego otwarcia — pozwol sprobowac w kolejnym cyklu
      kvPromise = null;
      throw e;
    });
  }
  return kvPromise;
}

export async function getRecord(id: string): Promise<ReservationRecord | null> {
  const res = await (await kv()).get<ReservationRecord>([...PREFIX, id]);
  return res.value;
}

export async function putRecord(rec: ReservationRecord): Promise<void> {
  await (await kv()).set([...PREFIX, rec.id], rec);
}

export async function listRecords(): Promise<ReservationRecord[]> {
  const out: ReservationRecord[] = [];
  for await (
    const entry of (await kv()).list<ReservationRecord>({ prefix: [...PREFIX] })
  ) {
    out.push(entry.value);
  }
  return out;
}

export async function deleteRecord(id: string): Promise<void> {
  await (await kv()).delete([...PREFIX, id]);
}

// --- goscie ---

export async function getGuests(id: string): Promise<GuestSet | null> {
  const res = await (await kv()).get<GuestSet>([...GPREFIX, id]);
  return res.value;
}

export async function putGuests(id: string, g: GuestSet): Promise<void> {
  await (await kv()).set([...GPREFIX, id], g);
}

export async function deleteGuests(id: string): Promise<void> {
  await (await kv()).delete([...GPREFIX, id]);
}
