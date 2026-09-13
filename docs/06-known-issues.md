# 06 – Známé problémy

> Trvalé pasti prostředí a stacku a jejich obcházení. Není to bug tracker — otevřené chyby patří do GitHub Issues; produktová omezení skeneru popisuje [archiv serverového prototypu ve wiki](https://github.com/vachekcz/vizlinx.com/wiki/Archive-tasks-server-scan-prototype).

**Revidováno:** 2026-09-13 · **Platí pro:** main

---

## `/scan` na `npm run dev` ani `npm run preview` nefunguje

- **Symptom:** na http://127.0.0.1:5173/scan (nebo 4173) hlásí UI chybu relace či „Mapa není dostupná“; `GET /api/v1/config` vrací `200` s HTML `index.html` místo JSON.
- **Příčina:** API je Cloudflare Worker (`worker/index.ts`); Vite ho nespouští a `vite.config.ts` nemá žádný proxy, takže `/api/*` padá do SPA fallbacku Vite.
- **Řešení:** `npm run dev:full` (build + migrace + `wrangler dev`), nebo `npm run build && npm run dev:api` → http://127.0.0.1:8797/scan, kde `/api/v1/config` vrací JSON. `dev:api` servíruje `dist/`, po změně frontendu je nutný nový `npm run build` (HMR není). Demo `/` a `/connections/lab` fungují i na 5173.
- **Stav:** záměr — jeden Worker se statickými assety bez dev proxy. Kandidát na zlepšení je Vite proxy `/api` → 8797, zatím nikdo nepotřeboval.

## CI staví `dist/` dvakrát

- **Symptom:** v jobu `verify` proběhne `tsc -b && vite build && build:extension` dvakrát (v kroku `npm test` a v kroku `npm run build`); lokálně `npm test && npm run deploy:check` třikrát.
- **Příčina:** `playwright.config.ts` má `webServer.command: 'npm run build && npm run preview …'`, aby testy nikdy neběžely nad zastaralým `dist/`; workflow pak staví znovu pro artefakt `site`.
- **Řešení / workaround:** žádný nutný — výstup je deterministický a build trvá řádově 15 s. Lokálně mimo CI Playwright znovu použije už běžící preview (`reuseExistingServer`).
- **Stav:** přijato.

## Odkazy generované JavaScriptem skener nevidí

- **Symptom:** SPA web skončí s jednou načtenou stránkou a nulou objevených URL; `docs/scan-benchmark.md` to zaznamenal na samotném vizlinx.com.
- **Příčina:** Worker parsuje jen HTML odpověď (`parse5` v `extension/extract.ts`), neprovádí skripty ani nenačítá podzdroje (`worker/server-fetch.ts`).
- **Řešení / workaround:** v aplikaci žádný. Pomůže jen web, který má odkazy v HTML (SSR, prerender). Jeden origin má jeden seed, další URL nelze doplnit ručně.
- **Stav:** hranice první verze; JS rendering by vyžadoval rozhodnutí správce a měření spotřeby.

## robots.txt zavře celý web i při dočasné chybě

- **Symptom:** v logu `robots_checked` s varováním a všechny stránky originu `robots_denied` bez jediného požadavku na stránku, přestože web v prohlížeči funguje.
- **Příčina:** `fetchServerRobots` (`worker/server-fetch.ts:50`) povoluje jen 2xx s čitelným tělem do 64 KiB a 404/410; 429, 5xx, redirect (i `http → https` nebo na `www`), timeout či nadlimitní tělo = *fail closed*. Politika se ukládá per běh do `crawl_robots`, do konce běhu se neopakuje.
- **Řešení / workaround:** zadat origin ve tvaru, který robots.txt vrací bez redirectu (typicky `https://www.…`); po opravě na straně webu „Skenovat znovu“ — nový běh načte robots znovu. Antibot nebo CAPTCHA před robots.txt zablokuje web stejně.
- **Stav:** záměrně konzervativní; změna by byla ve `fetchServerRobots`.

## HTTP 429 pozastaví origin, dokud ho vlastník nepovolí

- **Symptom:** web má v seznamu pauzu, log událost `site_throttled`; ostatní weby pokračují a sken skončí `paused`, i když vlastník klikne „Pokračovat“.
- **Příčina:** `storeResult` po 429 přepíše `paused: true` daného webu v `sites_json` (`worker/crawler.ts:463`); `POST /start` pauzu jednotlivého webu nemění.
- **Řešení:** povolit web v jeho detailu (PATCH `sites`), teprve pak „Pokračovat ve skenování“. Delší interval pomůže až pro další požadavky.
- **Stav:** záměr — server neodhaduje, kdy limit cílového webu pominul.

## Mapa „není dostupná“ po přechodu mezi hosty nebo smazání cookies

- **Symptom:** mapa založená na http://localhost:8797 není vidět na http://127.0.0.1:8797 (a naopak); po vyčištění dat prohlížeče jsou všechny mapy pryč; na produkci se liší `vizlinx.com` a `www.vizlinx.com`.
- **Příčina:** identita je host-only cookie `vizlinx_visitor` (`HttpOnly; SameSite=Strict`, bez `Domain`, `worker/index.ts:140`) a server ukládá jen její hash; jiný host = jiný návštěvník, ztracená cookie = ztracený přístup. Znalost URL mapy přístup nedává (záměr).
- **Řešení / workaround:** používat jeden host konzistentně (testy i `dev:api` pracují se `127.0.0.1`); obnova přístupu neexistuje.
- **Stav:** produktové rozhodnutí; účet a sdílení jsou budoucí rozšíření.

## `deploy:check` ukazuje u D1 nulové ID

- **Symptom:** `wrangler deploy --dry-run` vypíše `env.DB (00000000-0000-0000-0000-000000000000)`.
- **Příčina:** `wrangler.jsonc` má `preview_database_id` nastavené na nulové UUID, aby lokální `dev:api` a `db:local` držely původní lokální databázi; dry-run tento preview identifikátor zobrazuje.
- **Řešení:** nic neměnit. Skutečný deploy binduje `database_id` = `vizlinx-scans` (ověřeno přes Cloudflare API po nasazení, `[archiv serverového prototypu ve wiki](https://github.com/vachekcz/vizlinx.com/wiki/Archive-tasks-server-scan-prototype):81`). Přepsání `preview_database_id` na produkční ID by lokální mapy „ztratilo“ a `db:local` by začal od prázdné DB.
- **Stav:** trvalá vlastnost konfigurace, komentář přímo ve `wrangler.jsonc`.

## Testy dělí migrace na středníku

- **Symptom:** nová migrace projde `wrangler d1 migrations apply`, ale `test:api`, `test:crawler` nebo `test:prototype` padnou na SQL syntax error.
- **Příčina:** test harness čte `migrations/*.sql` a spouští `migration.split(';')` po příkazech (`tests-api/*.test.mjs`, `scripts/test-prototype.mjs:165`); středník v řetězci, komentáři nebo těle triggeru rozdělí příkaz uprostřed.
- **Řešení:** psát migrace jako sled jednoduchých příkazů bez středníků uvnitř; hodnoty se `;` vkládat z kódu, ne z migrace.
- **Stav:** omezení harnessu, přijato.

## `test:extension` a `test:prototype` nelze spouštět souběžně

- **Symptom:** `EADDRINUSE` na 8897 (nebo 8901), případně test čeká na cizí server.
- **Příčina:** pevné porty ve `scripts/build-test-extension.mjs:5` (8897, 8901) a `scripts/test-prototype.mjs:9` (8897); testovací rozšíření důvěřuje jen `http://127.0.0.1:8897`, takže port nelze změnit parametrem.
- **Řešení:** spouštět postupně (CI to tak dělá); zapomenutý fixture server najde `lsof -i :8897`. Vývojový `dev:api` na 8797 nekoliduje.
- **Stav:** přijato.
