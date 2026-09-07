// ---------------------------------------------------------------------
//  Prosty panel web serwowany z tego samego procesu co worker.
//  Zakladki:
//    dump    — stan KV, auto-odswiezanie 30 s
//    goscie  — "Przypisanie gosci": wybor rezerwacji + GUEST_MIN..GUEST_MAX
//              par imie/nazwisko (niezalezne od QUANTITY), zapis do KV
//              (["guests", <id>]).
//  Deno.serve jest nieblokujace — petla workera dziala dalej.
//  UI_TOKEN (opcjonalny) -> wymagane ?token=... albo naglowek Bearer,
//  dotyczy tez zapisu (POST).
// ---------------------------------------------------------------------

import { renderDump } from './report.ts';
import {
  getGuests,
  getRecord,
  listRecords,
  putGuests,
} from './store.ts';

const TOKEN = Deno.env.get('UI_TOKEN') ?? '';
const QS = TOKEN ? `&token=${encodeURIComponent(TOKEN)}` : '';

// Lista gosci do faktycznej (platnej) rezerwacji — niezalezna od QUANTITY.
const GUEST_MIN = Number(Deno.env.get('GUESTS_MIN') ?? 15);
const GUEST_MAX = Number(Deno.env.get('GUESTS_MAX') ?? 25);

const esc = (s: string) =>
  s.replace(
    /[&<>"]/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string,
  );

const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

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
  label{display:block;margin-bottom:.6rem}
  select,input,button{font:inherit}
  select{padding:.25rem}
  table{border-collapse:collapse;margin:.5rem 0}
  th,td{padding:.15rem .4rem;text-align:left}
  td input{padding:.2rem .35rem;width:12rem}
  .btns{display:flex;gap:.5rem;align-items:center;margin-top:.6rem}
  button{padding:.35rem .9rem;cursor:pointer;border-radius:.4rem}
  #msg{opacity:.75}
  .hint{opacity:.6;margin:.3rem 0}
  details.bulk{margin:.4rem 0}
  details.bulk summary{cursor:pointer}
  textarea{font:inherit;width:100%;max-width:32rem;margin:.4rem 0;display:block}
</style>
<nav>${link('dump', 'dump')}${link('goscie', 'Przypisanie gości')}</nav>
<main>${inner}</main>`;
}

async function guestPage(): Promise<string> {
  // tylko faktycznie zarezerwowane (aktywny hold) — do reszty nie ma czego przypisywac
  const recs = (await listRecords())
    .filter((r) => r.status === 'active')
    .sort(
      (a, b) =>
        a.spec.date.localeCompare(b.spec.date) || a.spec.slot - b.spec.slot,
    );

  if (recs.length === 0) {
    return `<p>Brak aktywnych rezerwacji — nie ma do czego przypisać gości.</p>`;
  }

  const opts = recs
    .map((r) => {
      const t = r.bookedTime ?? '--:--';
      const nr = r.siteRef ?? '(brak nr)';
      return `<option value="${esc(r.id)}">${r.spec.date} ${t} — ${esc(nr)}</option>`;
    })
    .join('');

  const rows = Array.from({ length: GUEST_MAX }, (_, i) =>
    `<tr class="g-row"${i >= GUEST_MIN ? ' hidden' : ''}><td>${i + 1}</td>` +
    `<td><input class="g-first" autocomplete="off"></td>` +
    `<td><input class="g-last" autocomplete="off"></td></tr>`
  ).join('');

  const script = `
var MIN = ${GUEST_MIN}, MAX = ${GUEST_MAX};
var TOKEN = ${JSON.stringify(TOKEN)};
var sel = document.getElementById('res');
var form = document.getElementById('gform');
var msg = document.getElementById('msg');
var firsts = [].slice.call(document.querySelectorAll('.g-first'));
var lasts = [].slice.call(document.querySelectorAll('.g-last'));
var rowsEls = [].slice.call(document.querySelectorAll('.g-row'));
var vis = MIN;

function api(params){
  var u = new URL('/api/guests', location.origin);
  if (params) for (var k in params) u.searchParams.set(k, params[k]);
  if (TOKEN) u.searchParams.set('token', TOKEN);
  return u.toString();
}
function showRows(n){
  vis = Math.max(MIN, Math.min(MAX, n));
  for (var i=0;i<MAX;i++) rowsEls[i].hidden = i >= vis;
}
function setRows(names){
  for (var i=0;i<MAX;i++){
    firsts[i].value = (names[i] && names[i].first) || '';
    lasts[i].value = (names[i] && names[i].last) || '';
  }
  showRows(names.length);
}
// Zbiera kompletne pary (oba pola). bad = numer wiersza z jednym polem.
function collect(){
  var out = [], bad = 0;
  for (var i=0;i<MAX;i++){
    var f = firsts[i].value.trim(), l = lasts[i].value.trim();
    if (!f && !l) continue;
    if (!f || !l){ bad = i+1; break; }
    out.push({first:f, last:l});
  }
  return { out: out, bad: bad };
}

// Parsuje blok z Excela: wiersze przez \\n, kolumny przez \\t.
// Jedna kolumna ("Jan Kowalski") -> podzial na pierwszej spacji.
function parseBlock(text){
  var lines = text.replace(/\\r/g,'').split('\\n');
  var out = [];
  for (var i=0;i<lines.length;i++){
    if (!lines[i].trim()) continue;
    var cells = lines[i].split('\\t');
    if (cells.length === 1){
      var m = cells[0].trim().match(/^(\\S+)\\s+(.+)$/);
      cells = m ? [m[1], m[2]] : [cells[0].trim(), ''];
    }
    out.push({ first:(cells[0]||'').trim(), last:(cells[1]||'').trim() });
  }
  return out;
}
// Wpisuje pary od wiersza r0; c0=1 => start w kolumnie nazwiska.
function distribute(pairs, r0, c0){
  var n = 0;
  for (var k=0; k<pairs.length && (r0+k)<MAX; k++){
    var r = r0 + k;
    if (c0 === 1){
      lasts[r].value = pairs[k].first || pairs[k].last;
    } else {
      firsts[r].value = pairs[k].first;
      if (pairs[k].last) lasts[r].value = pairs[k].last;
    }
    n++;
  }
  if (r0 + n > vis) showRows(r0 + n);
  return n;
}
function onPaste(e){
  var cb = e.clipboardData || window.clipboardData;
  var txt = cb ? cb.getData('text') : '';
  if (!/[\\t\\n]/.test(txt)) return; // pojedyncza wartosc -> normalne wklejenie
  e.preventDefault();
  var col = e.target.classList.contains('g-last') ? 1 : 0;
  var arr = col === 1 ? lasts : firsts;
  var row = arr.indexOf(e.target);
  if (row < 0) row = 0;
  var n = distribute(parseBlock(txt), row, col);
  msg.textContent = 'wklejono ' + n + ' wierszy';
}
for (var pi=0; pi<firsts.length; pi++){
  firsts[pi].addEventListener('paste', onPaste);
  lasts[pi].addEventListener('paste', onPaste);
}
document.getElementById('spread').addEventListener('click', function(){
  var pairs = parseBlock(document.getElementById('bulk').value);
  if (!pairs.length){ msg.textContent = 'pole puste'; return; }
  msg.textContent = 'rozlozono ' + distribute(pairs, 0, 0) + ' wierszy';
});
document.getElementById('addrow').addEventListener('click', function(){ showRows(vis+1); });
document.getElementById('delrow').addEventListener('click', function(){
  if (vis <= MIN) return;
  firsts[vis-1].value = ''; lasts[vis-1].value = '';
  showRows(vis-1);
});

sel.addEventListener('change', function(){
  msg.textContent = '';
  if (!sel.value){ form.hidden = true; return; }
  form.hidden = false;
  fetch(api({id: sel.value})).then(function(r){return r.json();})
    .then(function(d){ setRows(d.names || []); })
    .catch(function(){ msg.textContent = 'blad wczytywania'; });
});
document.getElementById('save').addEventListener('click', function(){
  var c = collect();
  if (c.bad){ alert('Wiersz ' + c.bad + ': uzupelnij imie i nazwisko.'); return; }
  if (c.out.length < MIN || c.out.length > MAX){
    alert('Podaj od ' + MIN + ' do ' + MAX + ' kompletnych par (masz ' + c.out.length + ').');
    return;
  }
  var opt = sel.options[sel.selectedIndex].textContent;
  if (!confirm('Zapisac ' + c.out.length + ' gosci dla: ' + opt + ' ?')) return;
  fetch(api(), {method:'POST', headers:{'content-type':'application/json'},
    body: JSON.stringify({id: sel.value, names: c.out})})
    .then(function(r){ return r.json().then(function(d){ return {ok:r.ok, d:d}; }); })
    .then(function(x){ msg.textContent = x.ok ? 'zapisano' : ('blad: ' + (x.d.error||'')); })
    .catch(function(){ msg.textContent = 'blad zapisu'; });
});
document.getElementById('clear').addEventListener('click', function(){
  if (!confirm('Wyczyscic formularz? Niezapisane dane przepadna.')) return;
  setRows([]);
  document.getElementById('bulk').value = '';
  msg.textContent = 'wyczyszczono — pamietaj zapisac';
});
`;

  return `<label>Rezerwacja:
  <select id="res"><option value="">— wybierz —</option>${opts}</select>
</label>
<form id="gform" hidden>
  <details class="bulk">
    <summary>Wklej z Excela (imię&nbsp;⭾&nbsp;nazwisko, po jednym na wiersz)</summary>
    <textarea id="bulk" rows="6" placeholder="Jan&#9;Kowalski&#10;Anna&#9;Nowak"></textarea>
    <button type="button" id="spread">Rozłóż</button>
  </details>
  <p class="hint">Albo kliknij pierwszą komórkę i wklej cały blok (Ctrl+V). Wymagane ${GUEST_MIN}–${GUEST_MAX} osób.</p>
  <table><thead><tr><th>#</th><th>Imię</th><th>Nazwisko</th></tr></thead>
  <tbody>${rows}</tbody></table>
  <div class="btns">
    <button type="button" id="addrow">+ wiersz</button>
    <button type="button" id="delrow">− wiersz</button>
  </div>
  <div class="btns">
    <button type="button" id="save">Zapisz</button>
    <button type="button" id="clear">Wyczyść</button>
    <span id="msg"></span>
  </div>
</form>
<script>${script}</script>`;
}

async function handleGuestsApi(req: Request): Promise<Response> {
  if (req.method === 'GET') {
    const id = new URL(req.url).searchParams.get('id') ?? '';
    const g = await getGuests(id);
    return json({ names: g?.names ?? [] });
  }
  if (req.method === 'POST') {
    let body: { id?: unknown; names?: unknown };
    try {
      body = await req.json();
    } catch {
      return json({ error: 'zly JSON' }, 400);
    }
    const id = String(body?.id ?? '');
    const rec = await getRecord(id);
    if (!rec) return json({ error: 'nieznana rezerwacja' }, 400);
    if (rec.status !== 'active') {
      return json({ error: 'rezerwacja nieaktywna' }, 400);
    }
    const raw = Array.isArray(body?.names) ? body.names : [];
    const names = raw
      .map((n) => ({
        first: String((n as { first?: unknown })?.first ?? '').trim().slice(0, 100),
        last: String((n as { last?: unknown })?.last ?? '').trim().slice(0, 100),
      }))
      .filter((n) => n.first || n.last);
    if (
      names.length < GUEST_MIN ||
      names.length > GUEST_MAX ||
      names.some((n) => !n.first || !n.last)
    ) {
      return json(
        { error: `wymagane ${GUEST_MIN}–${GUEST_MAX} kompletnych par` },
        400,
      );
    }
    await putGuests(id, { names, updatedAt: new Date().toISOString() });
    return json({ ok: true });
  }
  return new Response('metoda', { status: 405 });
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
        if (given !== TOKEN) return new Response('brak dostepu', { status: 403 });
      }

      if (url.pathname === '/api/guests') return handleGuestsApi(req);

      if (url.pathname === '/dump.txt') {
        return new Response(await renderDump(), {
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        });
      }

      const tab = url.searchParams.get('tab') === 'goscie' ? 'goscie' : 'dump';
      const inner = tab === 'goscie'
        ? await guestPage()
        : `<pre>${esc(await renderDump())}</pre>`;

      return new Response(shell(tab, inner), {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    },
  );
}
