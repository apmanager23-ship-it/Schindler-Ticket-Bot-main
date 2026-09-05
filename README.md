# Schindler Ticket Bot — utrzymywanie rezerwacji

Bot tworzący i **utrzymujący** rezerwacje biletów **grupowych** na wystawę stałą
w Fabryce Schindlera (`bilety.mhk.pl`). Rezerwacja (koszyk / podsumowanie bez
płatności) wygasa po ~5 h — bot okresowo tworzy ją od nowa na ten sam dzień
i godzinę, więc miejsca pozostają zablokowane.

Poprzednia wersja (scraper sprawdzający dostępność biletów) → [`scraper_old.ts`](scraper_old.ts).

## Architektura

| Plik | Rola |
| --- | --- |
| [`src/config.ts`](src/config.ts) | Zmienne środowiskowe, strojenie, **lista `SPECS`** (rezerwacje do utrzymania). |
| [`src/browser.ts`](src/browser.ts) | Uruchomienie Chromium, `ensureLoggedIn()` (loguje tylko gdy sesja padła). |
| [`src/flow.ts`](src/flow.ts) | Silnik: kalendarz → wybór terminu → bilety → **podsumowanie (STOP przed płatnością)**. `makeReservation(spec, { exactTime? })`. |
| [`src/store.ts`](src/store.ts) | Magazyn stanu w **Deno KV** — rekord `ReservationRecord` per rezerwacja. |
| [`src/reserve.ts`](src/reserve.ts) | **Moduł A** — `ensureCreated()`: tworzy hold dla każdej `SPEC` bez rekordu, zapisuje do KV. Idempotentny. |
| [`src/keep-alive.ts`](src/keep-alive.ts) | **Moduł B** — `runKeepAlive()`: dla rekordów blisko wygaśnięcia tworzy hold ponownie na tę samą godzinę (`exactTime`) i nadpisuje rekord. |
| [`src/notify.ts`](src/notify.ts) | Powiadomienia o błędach (na razie tylko konsola / stderr). |
| [`worker.ts`](worker.ts) | Długo żyjący proces: pętla co `CYCLE_MS` → login → Moduł A → Moduł B. |
| [`scraper.ts`](scraper.ts) | Jednorazowy runner testowy: jeden hold wg `TEST_SPEC`, wypisuje wynik. |

### Cykl życia rekordu

```
ensureCreated ──► status "active", expiresAt = createdAt + HOLD_MS (5 h)
        │
        ▼  (co 15 min worker sprawdza)
runKeepAlive: gdy do expiresAt < SAFETY_MS (45 min)
        │  status "refreshing" ──► makeReservation(spec, { exactTime })
        ├─ sukces ─► nowy createdAt / expiresAt, status "active", attempts = 0
        └─ błąd   ─► attempts++, notify(); po MAX_ATTEMPTS status "failed"
```

`id` rekordu = `ReservationSpec.id` i nie zmienia się między odświeżeniami — to
logicznie „ta sama” rezerwacja, tylko odnawiana. Odświeżenie **nie wymaga
anulowania** poprzedniego holdu (jedno konto = jeden aktywny koszyk).

Brak strony „moje rezerwacje” na koncie, więc `expiresAt` liczone jest jako
`createdAt + HOLD_MS`; `SAFETY_MS` (45 min) to bufor na czas przejścia bota,
ponowną próbę w kolejnym cyklu i ewentualne skrócenie holdu przez stronę.

## Konfiguracja (zmienne środowiskowe)

| Zmienna | Opis |
| --- | --- |
| `LOGIN` / `PASSWORD` | konto `bilety.mhk.pl` (wymagane) |
| `KV_PATH` | ścieżka pliku Deno KV. Lokalnie puste (domyślna lokalizacja Deno). **Na Railway: `/data/kv.sqlite` + Volume pod `/data`** |
| `DEBUG` | `true` → widoczny Chrome + slowMo |
| `HOLD_MS` / `SAFETY_MS` / `CYCLE_MS` / `MAX_ATTEMPTS` | opcjonalne strojenie (domyślne w `src/config.ts`) |

## Dodawanie / usuwanie dat

Rezerwacje do utrzymania: stała `SPECS` w [`src/config.ts`](src/config.ts).

**Dodać datę** — dopisać obiekt do tablicy i zredeployować:

```ts
{
  id: 'schindler-2026-10-15-1200',  // unikalny, STAŁY string — nigdy nie zmieniać
  date: '2026-10-15',
  timeFrom: '12:00',
  timeTo: '16:00',
  quantity: 20,
  withCertifiedGuide: true,
},
```

W kolejnym cyklu `ensureCreated()` widzi brak rekordu dla tego `id`, tworzy hold
i od tej pory Moduł B go utrzymuje. Istniejące rekordy nietknięte (klucz = `id`).

**Przestać utrzymywać** — Moduł B iteruje po KV, nie po `SPECS`, więc samo
usunięcie z tablicy nie wystarczy:

```bash
deno task forget schindler-2026-10-15-1200   # usuwa rekord z KV
# + usuń wpis z SPECS w src/config.ts
```

Nie zmieniać `id` istniejącego wpisu — worker potraktuje go jako nową
rezerwację (duplikat), a stary rekord będzie odświeżany bez końca (sierota).

## Uruchomienie lokalnie

```bash
deno task worker        # długo żyjący worker (Moduł A + B w pętli)
deno task reserve-test  # jednorazowy test jednego holdu (scraper.ts, TEST_SPEC)
deno task dump          # podgląd stanu KV (status / czas do wygaśnięcia / próby)
deno task forget <id>   # usuń rekord z KV
deno task check         # typecheck
```

Zrzuty ekranu i HTML **tylko przy błędach** lądują w `logs/`.

## Testowanie

1. **Typecheck:** `deno task check`.
2. **Smoke test parsowania (bez tworzenia holdu):** w `scraper.ts` ustaw
   `TEST_SPEC.quantity` absurdalnie wysoko (np. `9999`) → `makeReservation`
   rzuci błąd na sprawdzeniu dostępności, *zanim* dotknie koszyka. Weryfikuje
   nawigację po kalendarzu i odczyt terminów. `DEBUG=true` = widoczny Chrome.
3. **Pełny przepływ:** `TEST_SPEC` na odległy, mało obłożony termin i małe
   `quantity` (1–2), `DEBUG=true deno task reserve-test`. Utworzy realny ~5 h
   hold na ten mały termin (wygaśnie sam albo skasuj przez konto).
4. **Maszyna stanów Modułu B w kilka sekund** — skrócone timery:
   ```bash
   HOLD_MS=60000 SAFETY_MS=45000 CYCLE_MS=10000 DEBUG=true deno task worker
   ```
   z `SPECS` wskazującym jeden testowy termin: cykl 1 tworzy rekord, ~15 s
   później następuje odświeżenie (`exactTime`). Między cyklami `deno task dump`.
5. **Ścieżka błędu:** `SPEC` z datą z przeszłości → `notify()` na stderr,
   `attempts` rośnie, po `MAX_ATTEMPTS` status `failed` i koniec ponawiania.

## Deployment na Railway

- Start: `deno run --unstable-kv --allow-net --allow-read --allow-env --allow-write --allow-run --allow-sys worker.ts`
- Ustaw `LOGIN`, `PASSWORD`, `KV_PATH=/data/kv.sqlite` w zmiennych środowiskowych.
- **Podepnij Volume pod `/data`** — bez tego stan KV ginie przy każdym redeployu
  (po restarcie worker zrobiłby drugi komplet holdów obok wciąż żywych).
  Railway → serwis → Settings → Volumes → mount path `/data`.
- `restartPolicyType: ALWAYS` — worker ma żyć bez końca; Railway restartuje go
  po każdym wyjściu. Przejściowe błędy (strona nie odpowiada, błąd logowania)
  i tak nie wywalają procesu — łapie je pętla i ponawia w kolejnym cyklu.
- Jedna instancja serwisu (worker sam w sobie jest blokadą — nie skalować w poziomie).
