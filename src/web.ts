// ---------------------------------------------------------------------
//  Prosty panel web serwowany z tego samego procesu co worker.
//  Zakladki: "dump" (stan KV, auto-odswiezanie) + "inne" (pusta).
//  Deno.serve jest nieblokujace — petla workera dziala dalej.
//  UI_TOKEN (opcjonalny) -> wtedy wymagane ?token=... albo naglowek Bearer.
// ---------------------------------------------------------------------

import { renderDump } from './report.ts';

const TOKEN = Deno.env.get('UI_TOKEN') ?? '';
const QS = TOKEN ? `&token=${encodeURIComponent(TOKEN)}` : '';

const esc = (s: string) =>
  s.replace(
    /[&<>]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] as string,
  );

function shell(tab: string, inner: string): string {
  const link = (id: string, label: string) =>
    `<a class="${tab === id ? 'on' : ''}" href="?tab=${id}${QS}">${label}</a>`;
  return `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
${tab === 'dump' ? '<meta http-equiv="refresh" content="30">' : ''}
<title>Schindler bot</title>
<style>
  :root{color-scheme:light dark}
  body{margin:0;font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
  nav{display:flex;gap:.25rem;padding:.5rem;border-bottom:1px solid #8886;position:sticky;top:0;background:Canvas}
  nav a{padding:.35rem .8rem;text-decoration:none;border-radius:.4rem;color:inherit}
  nav a.on{background:#8883;font-weight:600}
  main{padding:1rem;overflow:auto}
  pre{margin:0;white-space:pre}
</style>
<nav>${link('dump', 'dump')}${link('inne', 'inne')}</nav>
<main>${inner}</main>`;
}

export function startWeb() {
  const port = Number(Deno.env.get('PORT') ?? 8080);

  Deno.serve(
    {
      port,
      hostname: '0.0.0.0',
      onListen: ({ port }) => console.log(`[web] nasluch na :${port}`),
    },
    async (req) => {
      const url = new URL(req.url);

      if (TOKEN) {
        const given = url.searchParams.get('token') ??
          req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
        if (given !== TOKEN) return new Response('forbidden', { status: 403 });
      }

      if (url.pathname === '/dump.txt') {
        return new Response(await renderDump(), {
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        });
      }

      const tab = url.searchParams.get('tab') === 'inne' ? 'inne' : 'dump';
      const inner = tab === 'dump'
        ? `<pre>${esc(await renderDump())}</pre>`
        : `<p style="opacity:.6">(pusto — do uzupelnienia)</p>`;

      return new Response(shell(tab, inner), {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    },
  );
}
