# 04 – Deployment

> Jak se Worker `vizlinx-com` dostává na Cloudflare a jak se provozuje: bindingy, domény, proměnné, CI deploy a runbook. CI gates viz [05](./05-testing.md), schéma a migrace viz [03](./03-database.md), lokální běh viz [10](./10-local-setup.md).

**Revidováno:** 2026-09-13 · **Platí pro:** main

## Obsah

1. [Production stack](#production-stack)
2. [Prostředí a domény](#prostředí-a-domény)
3. [Proměnné a secrets](#proměnné-a-secrets)
4. [Deploy](#deploy)
5. [Fronta a background práce](#fronta-a-background-práce)
6. [Runbook](#runbook)

---

## Production stack

Vše deklaruje `wrangler.jsonc` (Worker `vizlinx-com` — tečka v názvu Workeru není povolená).

| Vrstva | Nastavení | Účel |
|---|---|---|
| Worker | `main: worker/index.ts`, `compatibility_date` 2026-09-11, `compatibility_flags: ["global_fetch_strictly_public"]`, `limits.cpu_ms: 5000` | API a consumer fronty; flag brání fetchi do vlastní zóny mimo veřejný internet |
| Static Assets | `assets.directory: ./dist`, binding `ASSETS`, `run_worker_first: ["/api/*"]`, `not_found_handling: single-page-application` | frontend z `dist/`; `/api/*` jde vždy do Workeru, ostatní neznámé cesty dostanou `index.html` |
| D1 | binding `DB` → `vizlinx-scans` (`database_id` v konfiguraci), `preview_database_id` nulové UUID, `migrations_dir: migrations` | data map ([03](./03-database.md)) |
| Queues | producer `CRAWL_QUEUE` → `vizlinx-com-crawl`; consumer `max_batch_size 1`, `max_batch_timeout 0`, `max_concurrency 3`, `max_retries 3`, `retry_delay 30`, `dead_letter_queue: vizlinx-com-crawl-dead-letter` | ticky serverového skenu ([01](./01-backend.md)) |
| Observability | `logs.enabled`, `head_sampling_rate 1`; `traces` `head_sampling_rate 0.01` | Workers Logs a traces v dashboardu |
| Runtime v CI | Node 24 (`actions/setup-node@v7`, `node-version: 24`), wrangler z `devDependencies` | |

`account_id` je v konfiguraci, wrangler tedy nepotřebuje interaktivní volbu účtu.

---

## Prostředí a domény

| Prostředí | URL | Zdroj | Deploy |
|---|---|---|---|
| production | https://vizlinx.com, https://www.vizlinx.com (`routes` s `custom_domain: true`) | `main` | automaticky po push do `main` (CI) nebo ručně `npm run deploy` |
| production (záloha) | `*.workers.dev` subdoména účtu (`workers_dev: true`; adresa je v `README.md`) | totéž nasazení | — |
| lokální | http://127.0.0.1:8797 (`npm run dev:api`) | pracovní strom | — |

Staging ani preview URL nejsou (`preview_urls: false`); PR se ověřují testy a `wrangler deploy --dry-run`, ne nasazením. Obě domény míří na tentýž Worker a `www` se nepřesměrovává — API i cookie fungují na obou, ale cookie je per host: mapa založená na `www` není vidět na apexu ([06](./06-known-issues.md)).

---

## Proměnné a secrets

**Kde hodnoty žijí:** vars ve `wrangler.jsonc` (verzované; mění se PR a deployem). Jediný secret je token pro CLI — v GitHubu jako *repository secret* `CLOUDFLARE_API_TOKEN`, lokálně v ignorovaném `.env` (šablona `.env.example`). Kód Workeru žádný secret nečte; `CLOUDFLARE_API_TOKEN` není binding a do runtime se nedostane.

| Proměnná | Typ | Hodnota | Co dělá |
|---|---|---|---|
| `CRAWLER_ENABLED` | var | `"true"` | provozní vypínač skeneru: jiná hodnota než `"true"` → `POST /start` a `/rescan` vrací 503, běžící tick skončí jako `paused` (`worker/crawler.ts:133`, `worker/crawler.ts:621`, `worker/scan-history.ts:217`); čtení map funguje dál |
| `ADMIN_EMAIL` | var | `""` | veřejný kontakt vracený z `GET /api/v1/config`; UI z něj dělá tlačítko při dosažení limitu, prázdný řetězec = jen textová výzva (`worker/index.ts:221`) |
| `CLOUDFLARE_API_TOKEN` | secret pro CLI | — | jen pro `npm run db:remote` a `wrangler deploy`. Oprávnění podle `.env.example`: Workers Scripts Edit, D1 Edit, Queues Edit a správa vlastních domén zóny `vizlinx.com`. Skutečný rozsah tokenu není v repu ověřitelný; `docs/tasks/server-scan-prototype.md` uvádí jen první tři |

Po změně `vars` nebo bindingů spusť `npm run typegen` a commitni `worker-configuration.d.ts` — `Env` je z něj typovaný (`CRAWLER_ENABLED: "true"` je literal type, proto kód porovnává na `'true'`).

Lokální `dev:api` a `typegen` běží s `--env-file=/dev/null`: wrangler by jinak načetl `.env` s deploy tokenem do dev procesu, který ho nepotřebuje.

---

## Deploy

**Automaticky (CI):** workflow `.github/workflows/verify-and-deploy.yml`.

1. Job `verify` běží na `pull_request`, `push` do `main` a `workflow_dispatch`: testy a formát ([05](./05-testing.md)), `npm run build`, `npx wrangler deploy --dry-run` (bez tokenu); nahraje artefakty `browser-test-results` (`test-results/`, i při selhání, 7 dní) a `site` (`dist/`, povinný).
2. Job `deploy` běží jen pro `refs/heads/main` mimo `pull_request` a má `needs: verify`: `npm ci`, stáhne artefakt `site` do `dist/`, `npm run db:remote`, `npx wrangler deploy` — obojí s `CLOUDFLARE_API_TOKEN`. Nasazuje se **přesně ten build, který prošel testy**, ne nový.
3. `concurrency: vizlinx-${{ github.ref }}` bez `cancel-in-progress` — dva pushe do `main` se nasadí postupně, ne přes sebe. `permissions: contents: read`.

**Ručně:** `npm run deploy` = `npm run build && npm run db:remote && wrangler deploy` (token z `.env`, wrangler ho načte sám). Před tím `npm run deploy:check` = `npm run build && wrangler deploy --dry-run` — funguje bez tokenu, vypíše bindingy a velikost uploadu. Pozor: dry-run u `env.DB` vypisuje nulové `preview_database_id`; skutečný deploy binduje `vizlinx-scans` (ověřeno přes Cloudflare API po nasazení 2026-09-12, `docs/tasks/server-scan-prototype.md:81`, nikoli v tomto repu).

**Ověření po deployi:** `curl -s https://vizlinx.com/api/v1/config` vrací `{"adminEmail":…,"maxPagesPerSite":100}`; `curl -sI https://vizlinx.com/` má `x-robots-tag: noindex, nofollow` z `public/_headers`. Verzi a ID nasazení ukazuje Cloudflare dashboard → Workers & Pages → `vizlinx-com` → Deployments (příkazy `wrangler deployments` / `wrangler rollback` nebyly pro tuto dokumentaci spuštěny).

**Rollback:** repo nemá skript. Migrace jsou aditivní ([03](./03-database.md)), takže revert commitu na `main` (projde `verify` i `deploy`) je bezpečná cesta; okamžitý návrat na předchozí verzi Workeru umožňuje dashboard.

**První nasazení do nového účtu** vyžaduje předem existující fronty `vizlinx-com-crawl` a `vizlinx-com-crawl-dead-letter` a D1 databázi; příkazy `wrangler queues create …` jsou zapsané v `docs/tasks/server-scan-prototype.md:65`, tady nebyly spouštěny.

---

## Fronta a background práce

- Jediný background mechanismus je **consumer fronty ve stejném Workeru** (`export default { queue }`, `worker/index.ts:636`). Žádné cron `triggers` ani Durable Objects; úklid dat se veze na HTTP požadavcích ([03](./03-database.md)).
- Consumer zpracuje 1 zprávu na invocation, až 3 souběžně (různé mapy, nebo opožděné duplicity — ty vyřeší lease). Neúspěch → `retry` po 120 s z kódu; po vyčerpání `max_retries: 3` zpráva končí ve `vizlinx-com-crawl-dead-letter`, která nemá consumer (retence 86 400 s podle `docs/tasks/server-scan-prototype.md:65`; nastavení fronty není v repu).
- **Jak ověřit, že žije:** Cloudflare dashboard → Queues → `vizlinx-com-crawl` (backlog, consumer, počet zpráv v DLQ) a Workers Logs. V logu hledej JSON zprávy `"Server crawl checkpoint failed"` (`worker/crawler.ts:816`) a `"Scan API request failed"` (`worker/index.ts:647`) — jiné `console.*` výstupy Worker nemá a záměrně neloguje URL ani tokeny.
- Živá mapa má ve snapshotu `activity` s fází a `nextRequestAt`; `running` bez heartbeatu 20 min se v API hlásí jako `interrupted` ([01](./01-backend.md)).

---

## Runbook

- **Vypnout skener (kill switch):** ve `wrangler.jsonc` nastav `"CRAWLER_ENABLED": "false"`, merge do `main` (nebo `npm run deploy`). Nové starty dostanou 503, běžící ticky se při nejbližší kontrole zastaví jako `paused`; čtení map a frontend fungují. Změna v dashboardu se přepíše dalším deployem, proto ji dělej v repu.
- **Zpráva v DLQ:** prohlédni payload `{ scanId, generation, tick }` v dashboardu; nezměněný payload lze vrátit do `vizlinx-com-crawl` — zastaralou práci odmítne kontrola generace, ticku a lease (`worker/crawler.ts:583`). Alternativně vlastník mapy klikne „Pokračovat ve skenování“ (`POST /start`), které po 120 s bez heartbeatu obnoví aktuální tick (`worker/crawler.ts:182`).
- **Vyčerpaný denní rozpočet** (`limitReason: daily_limit`): resetuje se s UTC dnem sám; trvalé zvýšení = `DAILY_REQUESTS` ve `worker/crawler.ts:23` a deploy.
- **Uživatel chce víc než 100 stránek:** není v API; `SCAN_LIMITS.pagesPerSite` ve `shared/scan.ts` a deploy, UI si hodnotu čte z `/config`.
- **Origin pozastavený po HTTP 429** (`site_throttled` v logu): vlastník ho znovu povolí v detailu webu a obnoví sken; server pauzu sám nezruší.
- **Náklady:** Workers CPU se účtuje per invocation, `cpu_ms: 5000` je strop jednoho ticku. Na účtu má být Billing Budget Alert 5 USD (`docs/tasks/server-scan-prototype.md:69`; nastavení dashboardu, v repu neověřitelné) — upozornění provoz nezastaví, zastaví ho jen `CRAWLER_ENABLED`.
- Trvalé pasti a jejich obcházení → [06 – Známé problémy](./06-known-issues.md).
