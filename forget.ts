// Usun pojedynczy rekord (+ dane gosci) z KV:  deno task forget <id>
// Uwaga: jesli data nadal miesci sie w oknie POLICY, worker odtworzy rekord
// w kolejnym przebiegu. Do trwalego wylaczenia zawez okno / SKIP_DATES.
import { deleteGuests, deleteRecord, getRecord } from './src/store.ts';

const id = Deno.args[0];
if (!id) {
  console.error('uzycie: deno task forget <id>');
  Deno.exit(1);
}

const rec = await getRecord(id);
if (!rec) {
  console.error(`brak rekordu "${id}" w KV`);
  Deno.exit(1);
}

await deleteRecord(id);
await deleteGuests(id);
console.log(`usunieto rekord + gosci "${id}" (${rec.spec.date} ${rec.bookedTime}).`);
