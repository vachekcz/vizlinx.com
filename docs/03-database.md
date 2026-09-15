# 03 – Databáze

> Schéma D1 `vizlinx-scans`: migrace, tabulky, vztahy, indexy a retence. Provoz (binding, `db:remote` při deployi) viz [04](./04-deployment.md); kdo do tabulek zapisuje a s jakými podmínkami viz [01](./01-backend.md).

**Revidováno:** 2026-09-15 · **Platí pro:** aktuální kód v repozitáři

## Obsah

1. [Stack](#stack)
2. [Migrace](#migrace)
3. [Přehled schématu](#přehled-schématu)
4. [Vztahy a chování](#vztahy-a-chování)
5. [Indexy a constrainty](#indexy-a-constrainty)
6. [Retence a úklid](#retence-a-úklid)

---

## Stack

| | |
|---|---|
| Engine | Cloudflare D1 (SQLite) |
| Binding | `DB` (`wrangler.jsonc` → `d1_databases`), databáze `vizlinx-scans`, `migrations_dir: migrations` |
| Lokální identita | `preview_database_id` je nulové UUID — `dev:api` a `db:local` drží lokální data v `.wrangler/state`; produkční `database_id` používá jen `db:remote` a deploy |
| Přístup | raw SQL: `env.DB.prepare(sql).bind(...)`, vícekrokové změny přes `env.DB.batch([...])` (atomické) — žádný ORM ani query builder |
| Zdroj pravdy schématu | `migrations/*.sql`; repo nemá schema dump, typy řádků jsou ručně psané (`ScanRow` ve `worker/scan-history.ts:18` a `worker/crawler.ts:28`) |
| Seedy | žádné; testy si data zakládají přes API |

---

## Migrace

Soubory `migrations/NNNN_nazev.sql`, číslované postupně. Zatím jen aditivní změny (`CREATE TABLE`, `ALTER TABLE … ADD COLUMN`):

| Migrace | Co přidává |
|---|---|
| `0001_scans.sql` | `visitors`, `scans`, `page_results`; indexy `scans_owner_created`, `results_scan_origin` |
| `0002_creation_quotas.sql` | `creation_quotas` a indexy na expiraci (`creation_quotas_expiry`, `visitors_expiry`, `scans_created`) |
| `0003_server_crawler.sql` | sloupce serverového skenu ve `scans` (`execution_mode`, `limit_reason`, `crawl_generation`, `crawl_started_at`, `crawl_lease_token`, `crawl_lease_until`, `crawl_tick`, `crawl_enqueued_tick`); tabulky `crawl_frontier`, `crawl_robots`, `crawl_origin_gates`, `crawl_daily_budget` |
| `0004_crawl_ready.sql` | `scans.crawl_ready` — tick se smí zařadit až po naplnění frontieru |
| `0005_scan_log.sql` | `scans.activity_json`, `scans.scan_log_truncated`; tabulka `scan_events` |
| `0006_scan_history.sql` | `scans.run_id`, `run_number`, `run_created_at` (backfill z `id` a `created_at`); archiv `scan_runs`, `scan_run_pages`, `scan_run_events` |
| `0007_landing_page_previews.sql` | `crawl_frontier.is_preview` a `crawl_robots.preview_throttled` (oba `NOT NULL DEFAULT 0`); index `crawl_frontier_preview` pro kvóty automatických kontrol externích URL |

- **Lokálně:** `npm run db:local` (`wrangler d1 migrations apply DB --local`), součást `npm run dev:full`. Vypíše tabulku neaplikovaných migrací; bez TTY je aplikuje bez dotazu.
- **Produkce:** `npm run db:remote` (`--remote`, potřebuje `CLOUDFLARE_API_TOKEN`) běží **před** `wrangler deploy` — v `npm run deploy` i v CI jobu `deploy` ([04](./04-deployment.md)). Nový Worker tedy startuje nad hotovým schématem; naopak starý Worker musí mezitím přežít nové schéma, proto jen aditivní změny.
- **Testy** neaplikují migrace přes wrangler: čtou `migrations/*.sql`, řadí podle názvu a **dělí soubor na `;`** (`tests-api/*.test.mjs`, `scripts/test-prototype.mjs:161`). Migrace proto nesmí mít středník uvnitř řetězce ani vícepříkazové tělo triggeru — wrangler by ji přijal, testy ne ([06](./06-known-issues.md)).
- Stav aplikovaných migrací drží wrangler v tabulce `d1_migrations` (spravuje ji sám).

---

## Přehled schématu

| Tabulka | Účel | Co není vidět z názvů sloupců |
|---|---|---|
| `visitors` | anonymní relace | `token_hash` je SHA-256 cookie, nikdy surový token; `expires_at` se prodlužuje při `POST /session` a při založení mapy |
| `scans` | mapa = sestava až 3 originů běžného skenu a její **aktuální běh** | `sites_json` je `ScanSite[]` jako text a SQL do něj sahá přes `json_each` / `json_extract` (`worker/index.ts:564`); automaticky kontrolované externí originy se do něj nepřidávají; `status` je `ScanStatus`; `execution_mode` `extension` / `server`; `ticket_hash` a `runner_hash` jen pro historické rozšíření; `crawl_*` je checkpoint fronty; `activity_json` poslední fáze pro UI |
| `page_results` | jeden strukturovaný `PageResult` na URL aktuálního běhu | `result_json` celý výsledek včetně volitelného `crawlMode: 'preview'`, `result_hash` pro idempotenci, `result_bytes` pro společný limit 4 MiB na mapu, `source_origin` pro limity stránek |
| `crawl_frontier` | fronta URL aktuálního běhu | `state` `pending` → `attempted` → `done`; `attempted` po pádu znamená „slot spotřebován, nestahovat znovu“; `is_preview = 1` rezervuje trvalý slot do kvóty 10 URL na externí origin / 100 na průchod |
| `crawl_robots` | robots.txt per (mapa, origin), také pro externí kontroly | `policy_json` = `StoredRobots` (`body`, `denied`, `delayMs`, případně `httpStatus`, `redirect`); během řetězce také `nextUrl`, `visitedUrls`; `state` `pending` / `attempted` / `done`; `preview_throttled = 1` po HTTP 429 stránky blokuje další automatické kontroly originu v tomto průchodu |
| `crawl_origin_gates` | **globální** brána originu | `next_allowed_at` sdílejí všechny mapy a návštěvníci; klíč je origin, ne mapa |
| `crawl_daily_budget` | **globální** denní počítadlo požadavků | `day` = `floor(now / 86 400 000)`, tedy UTC den |
| `creation_quotas` | kvóty na IP a den | `bucket_hash` = hash `kind:day:ip`; limit druhu se porovnává v SQL |
| `scan_events` | log aktuálního běhu | `event_key` dedupuje (`page:<url>`, `robots:<origin>`, `start:<gen>`, …); `event_json` = `ScanLogEvent` bez `id` |
| `scan_runs` | archivované běhy mapy | kopie metadat `scans` v okamžiku `rescan` včetně `page_count` a `scan_log_truncated` |
| `scan_run_pages`, `scan_run_events` | archivované výsledky a log | řádek na stránku / událost, ne jeden velký JSON |

---

## Vztahy a chování

- **Kaskády:** `visitors` → `scans` → (`page_results`, `crawl_frontier`, `crawl_robots`, `scan_events`, `scan_runs` → `scan_run_pages`, `scan_run_events`), vše `ON DELETE CASCADE`. Smazání relace tedy smaže i archiv; `cleanupExpired` toho využívá a maže jen kořeny.
- **Aktuální běh vs. archiv:** `scans` drží jen aktuální běh. `rescan` (`worker/scan-history.ts:216`) v jednom `batch` zkopíruje metadata do `scan_runs`, výsledky do `scan_run_pages`, události do `scan_run_events`, smaže živé `page_results`, `scan_events`, `crawl_frontier`, `crawl_robots` a přepíše `run_id`, `run_number`, generaci a checkpointy. Čtení snapshotu i logu bere živý i archivní zdroj v jednom `batch` (`readRunSnapshot`, `worker/scan-history.ts:98`), takže souběžná archivace nevrátí půl stavu.
- **Historické mapy z rozšíření** mají `run_id = id` a `run_number = 1` z backfillu v `0006`; nic se nepřesouvalo.
- **`sites_json` jsou zároveň data i pravidlo:** `maxPages`, `paused` a `intervalMs` v něm čte crawler i SQL kvóty. Serverový běh nastaví všem vybraným webům `maxPages = 100`; HTTP 429 při běžném skenu přepíše `paused: true` daného webu podmíněným `UPDATE` (`worker/crawler.ts`).
- **Síťový origin a vlastník:** `crawl_frontier.origin` určuje logického vlastníka rozpočtu/pauzy, skutečný síťový origin zůstává v `url`. Povolené HTTP/HTTPS/www redirecty mohou více originů připojit k jednomu vlastníkovi. `page_results.source_origin` zůstává skutečný origin; JSON výsledku navíc obsahuje `siteOrigin`, pokud se vlastník liší. Serverový počet výsledků na vlastníka používá join s frontierem. Pozdější připojení staršího preview přesune frontier, zachová JSON výsledků i `is_preview` a přenese případné HTTP 429. Brány a robots se dál klíčují skutečným síťovým originem; řádek robots původního preview vlastníka také drží jeho throttle. Archiv si vztah originů odvodí z `siteOrigin` a uložených redirectů. Nová migrace není potřeba.
- **Preview slot není aktuální režim originu:** `crawl_frontier.is_preview` se při povýšení webu do běžného skenu nemaže ani nenuluje. Počet všech těchto řádků, včetně `pending`, neúspěšných i `done`, vynucuje kvótu 10/100 při vložení dalších URL. Běžný sken povýšeného originu započítává stávající výsledky do vlastního limitu 100 stránek. Jeho aktuální oprávnění určuje `sites_json`, proto může pokračovat i přes starší `preview_throttled`.
- **Obnovení a historie preview:** `/start` ponechá frontier a robots včetně slotů a omezení HTTP 429. `/rescan` je odstraní s ostatním živým stavem, takže nový průchod dostane nové kvóty automatických kontrol. Archivace kopíruje celé `result_json` a `event_json`; `crawlMode` se zachová bez nových sloupců v archivních tabulkách. Pozdější povýšení webu nepřepisuje původ dříve uložených výsledků.
- **Stav `interrupted` v DB neexistuje** — dopočítává se při čtení z `heartbeat_at` (`control`, `worker/scan-history.ts:50`).
- **Retence se vynucuje při čtení**, ne jen úklidem: každý dotaz na mapu má `created_at > now − 30 d` (`owned`, `worker/index.ts:177`), takže expirovaná data jsou nedostupná, i když ještě fyzicky existují.

---

## Indexy a constrainty

Jen to, na čem stojí chování:

- `page_results` PK `(scan_id, source_url)` — identita stránky v běhu a základ idempotence (`INSERT … ON CONFLICT DO NOTHING`).
- `scan_events` `UNIQUE (scan_id, event_key)` — opakovaný tick nezaloží duplicitní událost; `AUTOINCREMENT id` dává pořadí i ořez na 500.
- `scan_runs` `UNIQUE (scan_id, run_number)` — dva souběžné `rescan` nemohou založit dva běhy se stejným číslem.
- `scans.ticket_hash` a `scans.runner_hash` `UNIQUE` — ticket i token lze vyměnit jen jednou.
- `crawl_frontier` PK `(scan_id, url)` + index `crawl_frontier_site (scan_id, origin, state)` — dedup URL a výběr kandidáta per origin.
- `crawl_frontier_preview (scan_id, is_preview, origin)` — počty rezervovaných preview URL v celém průchodu i pro jednotlivé originy; slot se rezervuje stejným podmíněným `INSERT`, který ověřuje generaci a případný lease.
- `results_scan_origin (scan_id, source_origin)` — počet stránek na přesný origin pro historický runner; server započítává potvrzené aliasy přes vlastníka ve frontieru.
- `scans_owner_created (owner_hash, created_at)` — seznam map vlastníka; `scans_created`, `visitors_expiry`, `creation_quotas_expiry` — úklid podle času.
- **Bez FK na `crawl_origin_gates` a `crawl_daily_budget`** — jsou globální a přežívají mapy; uklízí je crawler při startu (`worker/crawler.ts:238`).
- **D1 limit 100 vázaných parametrů na dotaz** — hromadné vklady jdou přes `json_each(?)` s jedním JSON parametrem (`addFrontier`, `worker/crawler.ts:87`), ne přes stovky placeholderů. Platí i pro nové dotazy.

---

## Retence a úklid

- Mapa i relace žijí **30 dní od založení mapy** (`RETENTION_MS`, `worker/index.ts:26`); `rescan` dobu neprodlužuje.
- Fyzický úklid nemá cron. `cleanupExpired` (`worker/index.ts:72`) běží při `POST /session` a `POST /scans` a maže po malých dávkách: 2 expirované mapy, 50 relací bez map, 100 vypršelých kvót. Malé dávky drží request rychlý; úplnost zajišťuje retence při čtení.
- Crawler při každém startu smaže brány originů starší než den (max 100) a rozpočty starší než včera (`worker/crawler.ts:237`).
- Log se ořezává při vložení nad 500 událostí a nastaví `scan_log_truncated = 1` (`worker/scan-log.ts:26`); archiv běhu si příznak nese s sebou.
- Lokální data: `.wrangler/state/v3/d1/` (gitignored). Smazání adresáře `.wrangler/` = čistá lokální DB, poté znovu `npm run db:local`.
