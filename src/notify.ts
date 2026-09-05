// ---------------------------------------------------------------------
//  Powiadomienia o bledach — wolane tylko przy nieudanym utworzeniu /
//  odswiezeniu rezerwacji. Na razie tylko konsola (stderr).
// ---------------------------------------------------------------------

// deno-lint-ignore require-await
export async function notify(msg: string): Promise<void> {
  console.error(`[notify] ${msg}`);
}
