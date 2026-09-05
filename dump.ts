// Podglad stanu KV:  deno task dump
import { listRecords } from './src/store.ts';

const recs = await listRecords();
const now = Date.now();
for (const r of recs) {
  const minLeft = Math.round((Date.parse(r.expiresAt) - now) / 60000);
  console.log(
    `${r.id.padEnd(28)} ${r.status.padEnd(10)} ${r.spec.date} ${r.bookedTime}` +
      `  wygasa za ${minLeft} min  proby=${r.attempts}` +
      (r.lastError ? `  ostatni blad: ${r.lastError}` : ''),
  );
}
console.log(`\nrazem: ${recs.length}`);
