// Podglad stanu KV:  deno task dump
import { desiredDates } from './src/config.ts';
import { listRecords, ReservationStatus } from './src/store.ts';

const desired = desiredDates();
const recs = (await listRecords()).sort((a, b) =>
  a.spec.date.localeCompare(b.spec.date)
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
    `${r.spec.date}  ${r.status.padEnd(11)} ${(r.bookedTime ?? '--:--')}  ` +
      `wygasa: ${exp.padStart(8)}  proby=${r.attempts}` +
      (r.lastError ? `  (${r.lastError.slice(0, 70)})` : ''),
  );
}

const held = count.active + count.refreshing;
const nextExp = recs
  .filter((r) => r.expiresAt)
  .map((r) => Date.parse(r.expiresAt as string) - now)
  .sort((a, b) => a - b)[0];

console.log(
  `\ndesired ${desired.length} | held ${held} | unavailable ${count.unavailable} | failed ${count.failed}` +
    (nextExp !== undefined
      ? ` | najblizsze wygasniecie za ${Math.round(nextExp / 60000)} min`
      : ''),
);
