// ---------------------------------------------------------------------
//  Powiadomienia o bledach — wolane przy nieudanym odtworzeniu rezerwacji,
//  utracie miejsc w luce i awarii cyklu workera.
//  Zawsze stderr; dodatkowo Telegram, gdy ustawione TELEGRAM_TOKEN +
//  TELEGRAM_CHAT_ID. Nieudane powiadomienie nigdy nie przerywa workera.
// ---------------------------------------------------------------------

const TOKEN = Deno.env.get('TELEGRAM_TOKEN') ?? '';
const CHAT_ID = Deno.env.get('TELEGRAM_CHAT_ID') ?? '';

async function sendTelegram(text: string, silent = false): Promise<void> {
  if (!TOKEN || !CHAT_ID) return;
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${TOKEN}/sendMessage`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: CHAT_ID,
          text: text.slice(0, 4000),
          disable_notification: silent,
        }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!res.ok) {
      console.error(
        `[notify] Telegram HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`,
      );
    }
  } catch (e) {
    console.error('[notify] Telegram wysylka nie powiodla sie:', e);
  }
}

export async function notify(msg: string): Promise<void> {
  console.error(`[notify] ${msg}`);
  await sendTelegram(`Schindler bot: ${msg}`);
}

// Surowy tekst na Telegram, dzielony na kawalki < limitu, bez brzeczyka.
// TYLKO do testowego zrzutu bazy (worker.ts / DEBUG_DUMP_NOTIFY).
export async function notifyRaw(text: string): Promise<void> {
  if (!TOKEN || !CHAT_ID) return;
  for (let i = 0; i < text.length; i += 3900) {
    await sendTelegram(text.slice(i, i + 3900), true);
  }
}
