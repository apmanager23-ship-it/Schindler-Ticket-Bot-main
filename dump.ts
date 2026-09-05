// Podglad stanu KV:  deno task dump
import { dateWindow, desiredSpecs } from './src/config.ts';
import { listRecords, ReservationStatus } from './src/store.ts';

const recs = (await listRecords()).sort(
  (a, b) =>
    a.spec.date.localeCompare(b.spec.date) || a.spec.slot - b.spec.slot,
);
const now = Date.now();

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
  console.log(
    `${r.spec.date}#${r.spec.slot}  ${r.status.padEnd(11)} ${(r.bookedTime ?? '--:--')}  ` +
      `wygasa: ${exp.padStart(8)}  proby=${r.attempts}` +
      (r.lastError ? `  (${r.lastError.slice(0, 70)})` : ''),
  );
}

let held = 0; // active z holdem w przyszlosci
let overdue = 0; // active/refreshing wygasle — czekaja na odtworzenie
for (const r of recs) {
  if (r.status !== 'active' && r.status !== 'refreshing') continue;
  if (r.expiresAt && Date.parse(r.expiresAt) > now) held++;
  else overdue++;
}

const nextExp = recs
  .filter((r) => r.status === 'active' && r.expiresAt && Date.parse(r.expiresAt) > now)
  .map((r) => Date.parse(r.expiresAt as string) - now)
  .sort((a, b) => a - b)[0];

console.log(
  `\nokno ${dateWindow().length} dni | cel ${desiredSpecs().length} | held ${held} | ` +
    `przeterminowane ${overdue} | unavailable ${count.unavailable} | failed ${count.failed}` +
    (nextExp !== undefined
      ? ` | najblizsze wygasniecie za ${Math.round(nextExp / 60000)} min`
      : ''),
);
