// ---------------------------------------------------------------------
//  Renderowanie stanu KV do tekstu.
//  Uzywane przez `deno task dump` oraz (testowo) przez workera do wyslania
//  zrzutu na Telegram — patrz DEBUG_DUMP_NOTIFY w worker.ts.
// ---------------------------------------------------------------------

import { dateWindow, desiredSpecs } from './config.ts';
import { listRecords, ReservationStatus } from './store.ts';

// Etykiety statusow po polsku (wartosc w KV zostaje ang. — bez migracji).
export const STATUS_PL: Record<ReservationStatus, string> = {
  active: 'aktywna',
  refreshing: 'odtwarzanie',
  unavailable: 'brak miejsc',
  failed: 'blad',
};

export async function renderDump(): Promise<string> {
  const recs = (await listRecords()).sort(
    (a, b) =>
      a.spec.date.localeCompare(b.spec.date) || a.spec.slot - b.spec.slot,
  );
  const now = Date.now();
  const lines: string[] = [];

  const count: Record<ReservationStatus, number> = {
    active: 0,
    refreshing: 0,
    unavailable: 0,
    failed: 0,
  };

  for (const r of recs) {
    count[r.status]++;
    const exp = r.expiresAt
      ? `${Math.round((Date.parse(r.expiresAt) - now) / 60000)} min`
      : '—';
    lines.push(
      `${r.spec.date} ${(r.bookedTime ?? '--:--')}  #${r.spec.slot}  ` +
        `${STATUS_PL[r.status].padEnd(12)} ${(r.siteRef ?? '—').padEnd(14)} ` +
        `wygasa: ${exp.padStart(8)}  proby=${r.attempts}` +
        (r.lastError ? `  (${r.lastError.slice(0, 60)})` : ''),
    );
  }

  let held = 0;
  let overdue = 0;
  for (const r of recs) {
    if (r.status !== 'active' && r.status !== 'refreshing') continue;
    if (r.expiresAt && Date.parse(r.expiresAt) > now) held++;
    else overdue++;
  }

  const nextExp = recs
    .filter(
      (r) =>
        r.status === 'active' && r.expiresAt && Date.parse(r.expiresAt) > now,
    )
    .map((r) => Date.parse(r.expiresAt as string) - now)
    .sort((a, b) => a - b)[0];

  lines.push(
    `\nokno ${dateWindow().length} dni | cel ${desiredSpecs().length} | aktywne ${held} | ` +
      `przeterminowane ${overdue} | brak miejsc ${count.unavailable} | bledy ${count.failed}` +
      (nextExp !== undefined
        ? ` | najblizsze wygasniecie za ${Math.round(nextExp / 60000)} min`
        : ''),
  );

  return lines.join('\n');
}
