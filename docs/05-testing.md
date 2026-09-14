# 05 – Testing

> Co se čím testuje, jak to spustit lokálně a které gates běží v CI. Definice pipeline je `.github/workflows/verify-and-deploy.yml`; její deploy část viz [04](./04-deployment.md).

**Revidováno:** 2026-09-14 · **Platí pro:** aktuální kód v repozitáři

## Obsah

1. [Stack](#stack)
2. [Jak spustit](#jak-spustit)
3. [Co se čím testuje](#co-se-čím-testuje)
4. [Konvence a testovací data](#konvence-a-testovací-data)
5. [Gates v CI](#gates-v-ci)

---

## Stack

| Úroveň | Nástroj | Kde |
|---|---|---|
| UI / E2E frontendu | Playwright (`@playwright/test`), projekty `desktop` a `mobile` | `tests/*.spec.ts`, `playwright.config.ts` |
| API a crawler (integrace) | `node:test` + Miniflare (workerd, D1, Queues) nad Worker bundlem z esbuildu | `tests-api/*.test.mjs` |
| Kompletní E2E (UI + Worker + Queue + D1) | skript s Playwright Chromium a Miniflare | `scripts/test-prototype.mjs` |
| Historické rozšíření | skript se skutečným rozšířením v izolovaném Chromiu | `scripts/test-extension.mjs`, `scripts/build-test-extension.mjs` |
| Unit | `node:test` | `scripts/benchmark-scan.test.mjs` |
| Typy | `tsc -b` (součást `npm run build`) | `tsconfig*.json`, `extension/tsconfig.json` |
| Formát | Prettier (`singleQuote`, `trailingComma: all`) | `.prettierrc.json`; `.prettierignore` vynechává `docs/`, `README.md`, `worker-configuration.d.ts` |
| Lint | žádný (ESLint v repu není) | |

Žádný formální cíl pokrytí; měřítkem je, že každé chování má regresní test na nejnižší vrstvě, která ho umí ověřit.

---

## Jak spustit

Z kořene repa po `npm ci` (Node 24, viz [10](./10-local-setup.md)):

```bash
npm run format:check            # Prettier; oprava: npm run format
npm run build                   # tsc -b + vite build + build rozšíření — nutné před test:extension a test:prototype
npm run test:benchmark          # unit, bez sítě
npm run test:fetch-result       # boundedText, fitResult, fetchServerRobots/Page nad in-memory Response
npm run test:scan-log           # scanLogStatements / readScanLog v Miniflare D1
npm run test:crawler            # startServerScan / consumeCrawlBatch: frontier, limity, redirecty (~1 min)
npm run test:api                # web + runner API a historie běhů (scans + scan-history)
npm test                        # Playwright desktop + mobile; sám spustí build a preview na 4173
npm test -- tests/demo.spec.ts  # jeden soubor; --grep "název" jeden test; --project=desktop jeden viewport
npm run test:extension          # skutečné rozšíření, porty 8897 a 8901
npm run test:prototype          # UI + Worker + Queue + D1, port 8897
npm run deploy:check            # build + wrangler deploy --dry-run, bez tokenu
```

- **Playwright** (`playwright.config.ts`): `webServer` = `npm run build && npm run preview -- --port 4173 --strictPort`; mimo CI se znovu použije už běžící server na 4173. S `DEMO_BASE_URL=https://…` se webServer nespouští a testy jedou proti nasazené verzi (mocky API přes `page.route` fungují i tam). Na macOS `channel: 'chrome'`, tedy nainstalovaný Google Chrome; jinde Playwright Chromium (`npx playwright install chromium`). Viewporty 1600×1000 a Pixel 7; v CI `retries: 1`, `workers: 2`, `forbidOnly`. Trace a screenshot jen při selhání do `test-results/`.
- **`test:api`** je `node scripts/test-api.mjs`, který importuje `tests-api/scans.test.mjs` a `tests-api/scan-history.test.mjs`; ostatní sady jsou přímo `node --test tests-api/<soubor>`. Jeden test: `node --test --test-name-pattern="<část názvu>" tests-api/crawler.test.mjs`.
- **`test:extension`** a **`test:prototype`** sdílejí port 8897 — spouštěj postupně. Potřebují `build/extension/manifest.json`, resp. `dist/`, tedy předchozí `npm run build`. Vývojový server na 8797 neruší.
- `npm run benchmark:scan` není test, ale ruční měřicí nástroj (`docs/scan-benchmark.md`).

---

## Co se čím testuje

**Playwright (`tests/`)** — UI nad produkčním buildem, **nikdy proti skutečnému Workeru**: API skeneru mockuje `page.route` (`tests/scan-workspace.spec.ts`, `tests/scan-dataset.spec.ts`).

| Soubor | Pokrývá |
|---|---|
| `demo.spec.ts` | demo `/`, archivy `/palettes/` a `/connections/`, 20-stránkový detail, ovládání, klávesnice, CSV |
| `review-graph.spec.ts`, `expansion-position.spec.ts` | rozložení mapy, stabilita pozic při rozbalení, žádné překryvy (helper `graph-spacing.ts`) |
| `review-data.spec.ts` | export CSV odpovídá inspektoru a filtrům |
| `connection-variants.spec.ts`, `fine-connections.spec.ts` | styly spojnic a `/connections/lab` |
| `scan-dataset.spec.ts` | adaptér `scanToDataset` a vykreslení živých dat; pokrytí přímo odkazovaných externích cílů, zpětné vazby, neověřené cíle, přesměrování a povýšení webu |
| `scan-workspace.spec.ts` | celý `/scan`: relace, založení, pauza, přidání webu, limity, log, historie běhů, chybové stavy; viditelnost částečných kontrol a zpětných vazeb, preview aktivita a log, „Prozkoumat web“ se zachováním výsledků a pozice, chyby přidání/startu, limit tří webů a archiv pouze ke čtení |

**`node:test` + Miniflare (`tests-api/`)** — každý soubor si esbuildem sbalí potřebnou část Workeru (`stdin` s importem `./worker/...`), založí čistou D1, aplikuje `migrations/*.sql` a odchozí `fetch` směruje do in-process fixture (`outboundService`), takže nic nejde do sítě.

| Soubor | Pokrývá |
|---|---|
| `scans.test.mjs` | web + runner API: vlastnictví a izolace návštěvníků, relace a retence, kvóty, párování, idempotentní upload, přidání webu, kontrola `Origin` |
| `scan-history.test.mjs` | `runs`, `rescan`, archivace v jedné transakci, zastaralé `runId`, kapacita historie, sdílené rozpočty; zachování preview výsledků v archivu a reset kvót i HTTP 429 pro nový průchod |
| `crawler.test.mjs` | `startServerScan` / `consumeCrawlBatch`: frontier, robots, brány originů, denní rozpočet, limity stránek, bajtů a času, lease a duplicitní zprávy, redirecty, pozdní odpovědi po pauze; automatické externí kontroly bez rozvíjení HTML odkazů, kvóty 10/100, HTTP 429, obnova velké mapy bez příliš velkého D1 parametru a povýšení webu bez opakovaného stažení |
| `scan-log.test.mjs` | atomický zápis logu, dedup klíčů, ořez na 500, kaskáda při smazání mapy |
| `fetch-result.test.mjs` | streamový limit těla, ořez výsledku na 256 KiB, klasifikace robots a HTTP odpovědí |

**Skripty (`scripts/`)** — `test-prototype.mjs` propojí skutečný `dist/` a Worker bundle (s posunem času jen v harnessu) v Miniflare s headless Chromiem: založení mapy, log, přidání webu, pauza uprostřed requestu, přesně 100 stažení, redirecty, rescan s historií. Externí kontrolu ověřuje přes A → B/deep → A: před přidáním B už mapa ukazuje oba směry; po povýšení B zůstávají původní výsledky a B/deep se znovu nestahuje. Archivní scénář zahrnuje i preview výsledek. `test-extension.mjs` chrání historický extension runner (permissions, robots, intervaly, outbox, limity). `benchmark-scan.test.mjs` testuje frontu a výpočty benchmarku bez sítě.

**Pravidlo úrovní:** chování Workeru a SQL → `tests-api/`; chování UI pro daný stav API → Playwright s mockem; průchod celým stackem → jeden scénář ve `scripts/test-prototype.mjs`, ne nový Playwright test proti Workeru.

---

## Konvence a testovací data

- **Data si zakládá test sám** přes API nebo přímé `db.prepare` na Miniflare D1; žádné sdílené fixtures ani seedy. Miniflare instance je per soubor (`before` / `after`), stav mezi testy se čistí v `afterEach`.
- **Migrace v testech** = soubory rozdělené na `;` — středník v řetězci by test rozbil ([03](./03-database.md)).
- **Čas a fronta** se zrychlují jen v test bundlu (posun `Date.now` mezi doručeními, ignorované `delaySeconds` — `scripts/test-prototype.mjs:113`); produkční kód se nemění.
- **Playwright asserce** používají role a české texty UI (`getByRole('button', { name: 'Spustit sken', exact: true })`); změna textu tlačítka je zároveň změna testu. Na stav se čeká přes `expect(...).toBeVisible()` nebo `expect.poll`, žádné pevné čekání.
- **Síť:** Playwright testy mockují `/api/v1/**`; `test-prototype` navíc přes `context.route('**/*')` odmítne cokoli mimo `127.0.0.1:8897`; fixtures v `tests-api` assertují, že Worker nevolá nečekaný origin. Test, který sáhne na internet, je chyba.
- Výstupy (`test-results/`, `playwright-report/`, `build/`, `dist/`) jsou v `.gitignore`.

---

## Gates v CI

Workflow `.github/workflows/verify-and-deploy.yml`, job **`verify`** (`ubuntu-latest`, Node 24, `npm ci`); spouští se na `pull_request`, `push` do `main` a ručně. Kroky v tomto pořadí, každý blokuje job:

| Krok | Příkaz |
|---|---|
| formát | `npm run format:check` |
| unit | `npm run test:benchmark` |
| prohlížeč | `npx playwright install --with-deps chromium` |
| UI | `npm test` |
| API | `npm run test:api`, `npm run test:crawler`, `npm run test:scan-log`, `npm run test:fetch-result` |
| E2E | `npm run test:extension`, `npm run test:prototype` |
| build a typy | `npm run build` |
| konfigurace | `npx wrangler deploy --dry-run` |

Artefakty: `browser-test-results` (`test-results/`, vždy) a `site` (`dist/`), který přebírá job `deploy` ([04](./04-deployment.md)).

- **Agregační gate „CI Passed“ zatím není** — všechno je jeden job, takže případná branch protection musí vyžadovat check `verify` (její nastavení není v repu ověřitelné).
- **Lokálně žádný pre-push hook** ([10](./10-local-setup.md)); před pushem spusť alespoň `npm run format:check`, `npm run build` a sadu, které se změna týká.
- `npm test` v CI staví `dist/` přes `webServer` a krok `npm run build` ho staví znovu — dvojí build je známý a přijatý ([06](./06-known-issues.md)).
