# Schindler Ticket Bot — utrzymywanie rezerwacji

Bot tworzący i **utrzymujący** rezerwacje biletów **grupowych** na wystawę stałą
w Fabryce Schindlera (`bilety.mhk.pl`). Rezerwacja (koszyk / podsumowanie bez
płatności) wygasa po ~5 h — bot okresowo tworzy ją od nowa na ten sam dzień
i godzinę, więc miejsca pozostają zablokowane.

Zakres utrzymywany to **przesuwne okno**: każdy dzień z `[dziś+LEAD_DAYS,
dziś+HORIZON_DAYS]` ma mieć trzymany hold. Okno przesuwa się codziennie o północy
(strefa `Europe/Warsaw`), więc nowy dzień na końcu okna dochodzi automatycznie.

Poprzednia wersja (scraper sprawdzający dostępność biletów) → [`scraper_old.ts`](scraper_old.ts).

## Architektura

| Plik | Rola |
| --- | --- |
| [`src/config.ts`](src/config.ts) | Zmienne środowiskowe, strojenie, **`POLICY`** (reguła) + `desiredDates()` (generator dat okna, strefa Warsaw). |
| [`src/browser.ts`](src/browser.ts) | Uruchomienie Chromium, `ensureLoggedIn()` (loguje tylko gdy sesja padła). |
| [`src/flow.ts`](src/flow.ts) | Silnik: kalendarz → wybór terminu → bilety → **podsumowanie (STOP przed płatnością)**. `makeReservation(spec, { exactTime? })`. Rzuca `UnavailableError`, gdy dnia/terminu nie da się zarezerwować. |
| [`src/store.ts`](src/store.ts) | Magazyn stanu w **Deno KV** — `ReservationRecord` per data. Status: `active` / `refreshing` / `unavailable` / `failed`. |
| [`src/reserve.ts`](src/reserve.ts) | **Moduł A** — `reconcile()`: liczy `desiredDates()`, kasuje rekordy poza oknem, tworzy brakujące holdy (max `CREATE_BUDGET` na cykl, najwcześniejsze pierwsze). |
| [`src/keep-alive.ts`](src/keep-alive.ts) | **Moduł B** — `runKeepAlive()`: dla `active`/`refreshing` blisko wygaśnięcia tworzy hold ponownie na tę samą godzinę (`exactTime`). |
| [`src/notify.ts`](src/notify.ts) | Powiadomienia o błędach technicznych (na razie tylko stderr). |
| [`worker.ts`](worker.ts) | Długo żyjący proces: pętla co `CYCLE_MS` → login → **`runKeepAlive` → `reconcile`**. |
| [`scraper.ts`](scraper.ts) | Jednorazowy runner testowy: jeden hold wg `TEST_SPEC`, wypisuje wynik. |

### Podział odpowiedzialności wg statusu

| Status | Znaczenie | Kto obsługuje |
| --- | --- | --- |
| `active` | żywy hold, `expiresAt` w przyszłości | Moduł B (odświeża przy `< SAFETY_MS`) |
| `refreshing` | trwa odświeżanie (guard przed nakładaniem) | Moduł B (dokańcza / ponawia) |
| `unavailable` | dzień bez wolnego terminu | Moduł A (ponów po `UNAVAILABLE_RETRY_MS`, domyślnie 12 h) |
| `failed` | błąd techniczny | Moduł A (ponów po `FAILED_RETRY_MS`, domyślnie 1 h) |

Moduł B, gdy odświeżenie rzuci `UnavailableError`, przestawia rekord na
`unavailable` i oddaje go Modułowi A. Moduł A po `MAX_ATTEMPTS` nieudanych
próbach `failed` przestaje słać `notify()` (ale nadal cicho ponawia).

### Cykl życia rekordu

```
reconcile: data z okna bez rekordu
    │  makeReservation(specForDate(data))
    ├─ sukces          ─► active, expiresAt = createdAt + HOLD_MS (5 h)
    ├─ UnavailableError ─► unavailable, nextAttemptAt = now + 12 h
    └─ inny błąd        ─► failed, attempts++, nextAttemptAt = now + 1 h
        │
        ▼  (co CYCLE_MS, gdy active i do expiresAt < SAFETY_MS)
runKeepAlive: refreshing ─► makeReservation(spec, { exactTime })
    ├─ sukces          ─► active, nowy createdAt / expiresAt
    ├─ UnavailableError ─► unavailable (→ Moduł A)
    └─ inny błąd        ─► attempts++; po MAX_ATTEMPTS → failed
        │
        ▼  (reconcile, gdy data wypadnie z okna)
deleteRecord — przestajemy utrzymywać, hold sam wygasa (bez anulowania)
```

`id` rekordu = `schindler-YYYY-MM-DD` (deterministyczne z daty) — brak ręcznego
zarządzania identyfikatorami. Odświeżenie **nie wymaga anulowania** poprzedniego
holdu (jedno konto = jeden aktywny koszyk).

Brak strony „moje rezerwacje” na koncie, więc `expiresAt = createdAt + HOLD_MS`;
`SAFETY_MS` (45 min) to bufor na czas przejścia bota, ponowną próbę w kolejnym
cyklu i ewentualne skrócenie holdu przez stronę.

## Konfiguracja (zmienne środowiskowe)

| Zmienna | Opis |
| --- | --- |
| `LOGIN` / `PASSWORD` | konto `bilety.mhk.pl` (wymagane) |
| `KV_PATH` | ścieżka pliku Deno KV. Lokalnie puste. **Na Railway: `/data/kv.sqlite` + Volume pod `/data`** |
| `DEBUG` | `true` → widoczny Chrome + slowMo (na serwerze nie ustawiać) |
| `LEAD_DAYS` / `HORIZON_DAYS` | okno: od dziś+`LEAD` do dziś+`HORIZON` (domyślnie 2 / 21) |
| `WEEKDAYS` | które dni tygodnia, `0`=niedz .. `6`=sob (domyślnie wszystkie) |
| `SKIP_DATES` | lista `YYYY-MM-DD` po przecinku — dni zamknięcia / święta |
| `TIME_FROM` / `TIME_TO` / `QUANTITY` / `WITH_GUIDE` | parametry pojedynczej rezerwacji |
| `CREATE_BUDGET` | ile nowych holdów na cykl (domyślnie 5) |
| `HOLD_MS` / `SAFETY_MS` / `CYCLE_MS` / `MAX_ATTEMPTS` | strojenie utrzymywania |
| `UNAVAILABLE_RETRY_MS` / `FAILED_RETRY_MS` | backoff ponawiania w Module A |

Pełna lista z domyślnymi → [`.env.example`](.env.example) i [`src/config.ts`](src/config.ts).

## Zmiana zakresu

Nie ma listy dat do edycji — wszystko wynika z `POLICY`. Żeby objąć więcej dni:
`HORIZON_DAYS=30` (zmienna środowiskowa, bez redeployu kodu). W kolejnym cyklu
`reconcile()` widzi nowe daty bez rekordu i je dokłada — po `CREATE_BUDGET` na
cykl. Zwężenie okna / dodanie `SKIP_DATES` → `reconcile()` skasuje rekordy, które
wypadły, i przestanie je utrzymywać.

**Zaczynaj od małego `HORIZON_DAYS` (14–30)** i poszerzaj, gdy działa stabilnie —
90 dni × `QUANTITY` biletów w trwałych, nieopłaconych holdach to duże, stałe
obciążenie systemu muzeum i realne ryzyko blokady konta.

## Uruchomienie lokalnie

```bash
deno task worker        # długo żyjący worker (Moduł B + A w pętli)
deno task reserve-test  # jednorazowy test jednego holdu (scraper.ts, TEST_SPEC)
deno task dump          # podgląd stanu KV + linia zbiorcza
deno task forget <id>   # usuń pojedynczy rekord z KV (id = schindler-YYYY-MM-DD)
deno task check         # typecheck
```

Zrzuty ekranu i HTML **tylko przy błędach** lądują w `logs/`.

## Testowanie

1. **Typecheck:** `deno task check`.
2. **Generator dat (bez sieci):**
   ```bash
   deno eval "import {desiredDates} from './src/config.ts'; console.log(desiredDates())"
   ```
   Sprawdź długość okna, filtr `WEEKDAYS`/`SKIP_DATES`, granicę doby.
3. **Smoke test parsowania (bez tworzenia holdu):** w `scraper.ts` ustaw
   `TEST_SPEC.quantity = 9999` → `makeReservation` rzuci `UnavailableError`
   *zanim* dotknie koszyka. Weryfikuje nawigację po kalendarzu i odczyt terminów.
4. **Pełny przepływ:** `TEST_SPEC` na odległy, mało obłożony termin, `quantity`
   1–2, `DEBUG=true deno task reserve-test`. Utworzy realny ~5 h hold (wygaśnie sam).
5. **Reconciler + Moduł B w kilka minut** — małe okno i skrócone timery:
   ```bash
   HORIZON_DAYS=4 CREATE_BUDGET=2 HOLD_MS=120000 SAFETY_MS=90000 \
   CYCLE_MS=20000 DEBUG=true deno task worker
   ```
   Cykl 1–2 tworzą holdy (po 2/cykl), potem widać odświeżanie przy `exactTime`.
   Między cyklami `deno task dump` — linia `desired N | held N | ...`.
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
