// ---------------------------------------------------------------------
//  Magazyn stanu rezerwacji (Deno KV).
//  Klucz: ["res", <ReservationSpec.id>]  ->  ReservationRecord
// ---------------------------------------------------------------------

import { KV_PATH, ReservationSpec } from './config.ts';

export interface ReservationRecord {
  id: string; // = ReservationSpec.id, stabilny przez caly cykl zycia
  spec: ReservationSpec;
  bookedTime: string; // faktycznie utrzymywana godzina "HH:MM"
  siteRef: string | null; // identyfikator rezerwacji ze strony, jesli wykryty
  summaryUrl: string;
  amount: string; // ostatnie "Do zaplaty"
  createdAt: string; // ISO — ostatnie udane utworzenie/odswiezenie holdu
  expiresAt: string; // ISO — createdAt + HOLD_MS
  status: 'active' | 'refreshing' | 'failed';
  attempts: number; // nieudane proby odswiezenia z rzedu
  lastError: string | null;
  lastRefreshAt: string | null; // ISO — ostatnia proba odswiezenia (udana lub nie)
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
