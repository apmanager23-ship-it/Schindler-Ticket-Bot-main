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

const PREFIX = ['res'] as const;

let kvPromise: Promise<Deno.Kv> | null = null;
function kv(): Promise<Deno.Kv> {
  if (!kvPromise) {
    kvPromise = (KV_PATH ? Deno.openKv(KV_PATH) : Deno.openKv()).catch((e) => {
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
