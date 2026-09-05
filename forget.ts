// Przestan utrzymywac rezerwacje:  deno task forget <id>
// Usuwa rekord z KV. Pamietaj tez usunac wpis z SPECS w src/config.ts,
// inaczej worker utworzy rezerwacje na nowo w kolejnym cyklu.
import { deleteRecord, getRecord } from './src/store.ts';

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
console.log(`usunieto rekord "${id}" (${rec.spec.date} ${rec.bookedTime}).`);
console.log('usun teraz tez wpis z SPECS w src/config.ts.');
