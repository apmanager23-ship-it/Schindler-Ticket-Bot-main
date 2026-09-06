# Schindler Ticket Bot — utrzymywanie rezerwacji

Bot tworzący i **utrzymujący** rezerwacje biletów **grupowych** na wystawę stałą
w Fabryce Schindlera (`bilety.mhk.pl`). Kliknięcie „KUPUJĘ I PŁACĘ" tworzy
**zamówienie nieopłacone** (bez realizacji płatności), które blokuje miejsca
i wygasa po ~5 h — bot po wygaśnięciu tworzy je od nowa na ten sam dzień
i godzinę.

Zakres utrzymywany to **przesuwne okno**: każdy dzień z `[dziś+LEAD_DAYS,
dziś+HORIZON_DAYS]` ma mieć `SLOTS_PER_DAY` trzymanych rezerwacji, każdą w innej
godzinie z przedziału `[TIME_FROM, TIME_TO]`, każdą po `QUANTITY` biletów. Okno
przesuwa się codziennie o północy (strefa `Europe/Warsaw`), więc nowy dzień na
końcu okna dochodzi automatycznie.

**Nie da się trzymać dwóch nakładających się holdów na to samo miejsce** — więc
rezerwacji nie odświeża się z wyprzedzeniem. Rekord z żywym holdem jest
nietykalny; dopiero po jego wygaśnięciu (`+ RECREATE_GRACE_MS`) bot tworzy go od
nowa na ten sam termin, biorąc **najwcześniej wygasłe pierwsze**. Między
wygaśnięciem a odtworzeniem jest luka (dziesiątki sekund), w której miejsca są
wolne — worker minimalizuje ją, budząc się dokładnie na moment wygaśnięcia.

Poprzednia wersja (scraper sprawdzający dostępność biletów) → [`scraper_old.ts`](scraper_old.ts).

## Architektura

| Plik | Rola |
| --- | --- |
| [`src/config.ts`](src/config.ts) | Zmienne środowiskowe, strojenie, **`POLICY`** (reguła) + `desiredSpecs()` (generator: dni okna × `SLOTS_PER_DAY`, strefa Warsaw). |
| [`src/browser.ts`](src/browser.ts) | Uruchomienie Chromium, `ensureLoggedIn()` (loguje tylko gdy sesja padła). |
| [`src/flow.ts`](src/flow.ts) | Silnik: kalendarz → wybór terminu → bilety → koszyk → **klik „KUPUJĘ I PŁACĘ"** (zamówienie nieopłacone = hold ~5 h), stop przed wyborem/realizacją płatności. `makeReservation(spec, { exactTime?, excludeTimes? })`. Rzuca `UnavailableError`, gdy terminu nie da się zaklepać. |
| [`src/store.ts`](src/store.ts) | Magazyn stanu w **Deno KV** — `ReservationRecord` per `data#slot`. Status: `active` / `refreshing` / `unavailable` / `failed`. |
| [`src/reserve.ts`](src/reserve.ts) | **`reconcile()`** — jedyna operacja utrzymywania. Kasuje rekordy poza celem, buduje listę „do zrobienia" wg pilności, odtwarza max `CREATE_BUDGET` na przebieg. Zwraca `{ moreWork, nextWakeAt }`. |
| [`src/notify.ts`](src/notify.ts) | Powiadomienia o błędach / utracie miejsc — zawsze stderr, dodatkowo Telegram gdy ustawione `TELEGRAM_TOKEN` + `TELEGRAM_CHAT_ID`. |
| [`worker.ts`](worker.ts) | Długo żyjący proces: co przebieg `launch` Chromium → login → `reconcile()` → `close` Chromium → **dynamiczny sen** do najbliższego wygaśnięcia (`[MIN_SLEEP_MS, MAX_SLEEP_MS]`). Przeglądarka nie żyje w spoczynku (~50 MB zamiast ~200–400 MB). |
| [`scraper.ts`](scraper.ts) | Jednorazowy runner testowy: jeden hold wg `TEST_SPEC`, wypisuje wynik. |

### Priorytety w `reconcile()` (worklist)

| Tier | Pozycja | Sortowanie w obrębie tier |
| --- | --- | --- |
| 0 | rekord `active` **wygasły** (`expiresAt + GRACE ≤ teraz`) lub `refreshing` (przerwany w połowie) | rosnąco po `expiresAt` — **najwcześniej wygasłe pierwsze** |
| 1 | brak rekordu (nowy dzień okna) | rosnąco po dacie |
| 2 | `unavailable` / `failed` po minięciu `nextAttemptAt` | rosnąco po `nextAttemptAt` |

Rekord `active` z `expiresAt` w przyszłości **nie trafia na listę** — czekamy.

### Cykl życia rekordu

```
reconcile bierze pozycję z worklist (tier 0/1/2), do budżetu CREATE_BUDGET
    │  makeReservation(spec, { exactTime: godzina rekordu | excludeTimes: zajęte tego dnia })
    ├─ sukces           ─► active, expiresAt = createdAt + HOLD_MS
    ├─ UnavailableError ─► unavailable
    │                        • był to nasz żywy hold (luka) → retry za LOST_RETRY_MS (5 min) + notify
    │                        • nowy dzień, sprzedane        → retry za UNAVAILABLE_RETRY_MS (12 h)
    └─ inny błąd        ─► failed, attempts++, retry za FAILED_RETRY_MS (1 h); notify do MAX_ATTEMPTS
        │
        ▼  (data wypadła z okna)
deleteRecord — przestajemy utrzymywać, hold sam wygasa (bez anulowania)
```

`id` rekordu = `schindler-YYYY-MM-DD#N` (data + indeks slotu) — brak ręcznego
zarządzania identyfikatorami. Odtworzenie **nie wymaga anulowania** — stary hold
już wygasł. Brak strony „moje rezerwacje”, więc `expiresAt = createdAt + HOLD_MS`
(przybliżenie); `RECREATE_GRACE_MS` daje serwerowi czas na zwolnienie slotu.

## Konfiguracja (zmienne środowiskowe)

| Zmienna | Opis |
| --- | --- |
| `LOGIN` / `PASSWORD` | konto `bilety.mhk.pl` (wymagane) |
| `KV_PATH` | plik Deno KV (SQLite; katalog tworzony sam). Domyślnie `./.data/kv.sqlite`. **Na Railway: `/data/kv.sqlite` + Volume pod `/data`** |
| `DEBUG` | `true` → widoczny Chrome + slowMo (na serwerze nie ustawiać) |
| `TELEGRAM_TOKEN` / `TELEGRAM_CHAT_ID` | powiadomienia o błędach na Telegram (opcjonalne) |
| `DEBUG_DUMP_NOTIFY` | **tylko testy** — `true` = zrzut bazy na Telegram po każdym przebiegu; usuń, aby wyłączyć |
| `LEAD_DAYS` / `HORIZON_DAYS` | okno: od dziś+`LEAD` do dziś+`HORIZON` (domyślnie 2 / 21) |
| `WEEKDAYS` | które dni tygodnia, `0`=niedz .. `6`=sob (domyślnie wszystkie) |
| `SKIP_DATES` | lista `YYYY-MM-DD` po przecinku — dni zamknięcia / święta |
| `SLOTS_PER_DAY` | ile osobnych rezerwacji na dobę, w różnych godzinach (domyślnie 1) |
| `TIME_FROM` / `TIME_TO` | okno godzinowe, z którego wybierane są terminy |
| `QUANTITY` / `WITH_GUIDE` | biletów na jedną rezerwację / bilet przewodnika |
| `CREATE_BUDGET` | ile rezerwacji odtwarzać/tworzyć na przebieg (domyślnie 5) |
| `HOLD_MS` | zakładany czas życia holdu (domyślnie 5 h) |
| `RECREATE_GRACE_MS` | ile odczekać po wygaśnięciu przed odtworzeniem (domyślnie 60 s) |
| `MIN_SLEEP_MS` / `MAX_SLEEP_MS` | granice dynamicznego snu workera (60 s / 15 min) |
| `LOST_RETRY_MS` / `UNAVAILABLE_RETRY_MS` / `FAILED_RETRY_MS` | backoff: stracone w luce / sprzedane / błąd (5 min / 12 h / 1 h) |
| `MAX_ATTEMPTS` | po tylu błędach technicznych z rzędu → `failed` |

Pełna lista z domyślnymi → [`.env.example`](.env.example) i [`src/config.ts`](src/config.ts).

## Zmiana zakresu

Nie ma listy dat do edycji — wszystko wynika z `POLICY`. Zmienne środowiskowe,
bez redeployu kodu:

- więcej dni: `HORIZON_DAYS=30`
- więcej rezerwacji dziennie: `SLOTS_PER_DAY=3` (wymaga ≥3 różnych terminów
  z `QUANTITY` miejscami w oknie `TIME_FROM–TIME_TO`; brakujące → `unavailable`)

W kolejnym cyklu `reconcile()` widzi nowe pozycje bez rekordu i je dokłada — po
`CREATE_BUDGET` na cykl. Zwężenie okna / mniejszy `SLOTS_PER_DAY` / `SKIP_DATES`
→ `reconcile()` kasuje rekordy, które wypadły, i przestaje je utrzymywać.

**Zaczynaj od małego `HORIZON_DAYS` (14–30)** i poszerzaj, gdy działa stabilnie —
90 dni × `QUANTITY` biletów w trwałych, nieopłaconych holdach to duże, stałe
obciążenie systemu muzeum i realne ryzyko blokady konta.

## Uruchomienie lokalnie

```bash
deno task worker        # długo żyjący worker (reconcile + dynamiczny sen)
deno task reserve-test  # jednorazowy test jednego holdu (scraper.ts, TEST_SPEC)
deno task dump          # podgląd stanu KV + linia zbiorcza
deno task forget <id>   # usuń pojedynczy rekord z KV (id = schindler-YYYY-MM-DD#N)
deno task check         # typecheck
```

Zrzuty ekranu i HTML **tylko przy błędach** lądują w `logs/`.

## Testowanie

1. **Typecheck:** `deno task check`.
2. **Generator dat (bez sieci):**
   ```bash
   deno eval "import {desiredSpecs} from './src/config.ts'; console.log(desiredSpecs().map(s=>s.id))"
   ```
   Sprawdź długość okna, filtr `WEEKDAYS`/`SKIP_DATES`, granicę doby.
3. **Smoke test parsowania (bez tworzenia holdu):** w `scraper.ts` ustaw
   `TEST_SPEC.quantity = 9999` → `makeReservation` rzuci `UnavailableError`
   *zanim* dotknie koszyka. Weryfikuje nawigację po kalendarzu i odczyt terminów.
4. **Pełny przepływ:** `TEST_SPEC` na odległy, mało obłożony termin, `quantity`
   1–2, `DEBUG=true deno task reserve-test`. Utworzy realny ~5 h hold (wygaśnie sam).
5. **Reconciler + odtwarzanie w kilka minut** — małe okno i skrócone timery:
   ```bash
   HORIZON_DAYS=4 CREATE_BUDGET=2 HOLD_MS=180000 RECREATE_GRACE_MS=10000 \
   MIN_SLEEP_MS=15000 MAX_SLEEP_MS=60000 DEBUG=true deno task worker
   ```
   Przebieg 1–2 tworzą holdy (po 2), po ~3 min pierwsze wygasają → worker budzi
   się i odtwarza je z `exactTime`, najwcześniej wygasłe pierwsze. Między
   przebiegami `deno task dump` — linia `held N | przeterminowane N | ...`.
6. **Ścieżki błędu:** `SKIP_DATES` obejmujące jutro → rekord kasowany; termin
   bez miejsc → status `unavailable` + backoff, brak spamu `notify()`.

## Deployment na Railway

- Start: `deno run --unstable-kv --allow-net --allow-read --allow-env --allow-write --allow-run --allow-sys worker.ts`
- Ustaw `LOGIN`, `PASSWORD`, `KV_PATH=/data/kv.sqlite` (+ ew. `HORIZON_DAYS`, `WEEKDAYS`, `SKIP_DATES`).
- **Podepnij Volume pod `/data`** — bez tego stan KV ginie przy każdym redeployu
  (po restarcie worker zrobiłby drugi komplet holdów obok wciąż żywych).
  Volume dodaje się z kanwy projektu (prawy klik / `Cmd+K` → Volume), nie z Settings.
- `restartPolicyType: ALWAYS` — worker ma żyć bez końca; Railway restartuje go
  po każdym wyjściu. Przejściowe błędy nie wywalają procesu — łapie je pętla.
- **Cron Schedule w Settings → Deploy zostaw puste** — worker to demon z własną
  pętlą, nie zadanie cykliczne.
- Jedna instancja serwisu (worker sam w sobie jest blokadą — nie skalować w poziomie).
