# 01 – Backend

> Cloudflare Worker v `worker/`: API pro mapy, fronta serverového skeneru a jeho síťová pravidla. Nasazení a bindingy viz [04](./04-deployment.md), schéma D1 viz [03](./03-database.md), klientská část viz [02](./02-frontend.md).

**Revidováno:** 2026-09-15 · **Platí pro:** aktuální kód v repozitáři

## Obsah

1. [Stack](#stack)
2. [Struktura](#struktura)
3. [API](#api)
4. [Fronta a průběh skenu](#fronta-a-průběh-skenu)
5. [Pravidla crawleru](#pravidla-crawleru)
6. [Limity](#limity)
7. [Invarianty](#invarianty)

---

## Stack

| Vrstva | Technologie | Kde |
|---|---|---|
| Runtime | Cloudflare Workers — `compatibility_date` 2026-09-11, flag `global_fetch_strictly_public`, `limits.cpu_ms` 5000 | `wrangler.jsonc` |
| Jazyk | TypeScript bez frameworku a routeru: jeden `fetch` handler s ručním matchováním cest | `worker/index.ts:209` |
| Úložiště | D1 přes raw SQL (`env.DB.prepare`, `env.DB.batch`) | [03](./03-database.md) |
| Fronta | Cloudflare Queues; producer i consumer žijí v tomtéž Workeru | `worker/index.ts:636` |
| HTML parser | `parse5` — sdílený s historickým rozšířením | `extension/extract.ts` |
| robots.txt | `robots-parser` | `worker/server-fetch.ts` |
| Statické soubory | Workers Static Assets; `/api/*` jde nejdřív do Workeru | `wrangler.jsonc` → `assets` |

Verze balíčků: `package.json`. Typy bindingů (`Env`) generuje `npm run typegen` do `worker-configuration.d.ts`, který se commituje.

---

## Struktura

```text
worker/
├── index.ts         # fetch handler: session cookie, kvóty, web API, runner API; queue handler
├── crawler.ts       # serverový sken: start, frontier, lease, tick fronty, limity, dokončení
├── server-fetch.ts  # veřejný fetch, robots.txt pro VizlinxBot, klasifikace odpovědi, redirecty
├── validation.ts    # ApiError a validace vstupů (sites, pageResult, readJson)
├── scan-log.ts      # atomický zápis a čtení logu skenu (max 500 událostí)
└── scan-history.ts  # control/summary, snapshoty běhů, historie, rescan
shared/
├── scan.ts          # KONTRAKT: API_PREFIX, SCAN_LIMITS, typy, normalizace URL — sdílí Worker, frontend i rozšíření
├── fetch-result.ts  # boundedText, emptyResult, fitResult (limity těla a velikosti výsledku)
└── extension.ts     # veřejný klíč a ID rozšíření (viz 02)
```

**Kde začít číst:** `handle` v `worker/index.ts:209` — vstup requestu; ne-API cesty jdou do `env.ASSETS`, zbytek podle prefixu na webové nebo runner endpointy. Serverový sken začíná v `startServerScan` (`worker/crawler.ts:128`) a pokračuje po jednom kroku v `tick` (`worker/crawler.ts:572`).

Sdílený kontrakt `shared/scan.ts` je zdroj pravdy pro tvary požadavků a odpovědí: `tsconfig.worker.json` ho kompiluje s Workerem, `tsconfig.app.json` a `extension/tsconfig.json` s klienty. Změna typu se tak projeví na všech třech stranách v jednom `tsc -b`.

---

## API

Prefix `/api/v1` (`API_PREFIX`). Odpovědi jsou holé JSON objekty, chyby `{ "error": string }` se stavem z `ApiError`; každá odpověď nese `Cache-Control: no-store` a `X-Content-Type-Options: nosniff` (`worker/index.ts:56`). Neznámá cesta pod `/api/` vrací 404.

**Webové endpointy** — identita je HttpOnly cookie `vizlinx_visitor` (`SameSite=Strict`, 30 dní). Každá mutace (ne-GET/HEAD) musí mít hlavičku `Origin` shodnou s originem requestu (`sameOrigin`, `worker/index.ts:67`) a tělo `application/json` (`readJson`, `worker/validation.ts:160`).

| Metoda a cesta | Účel | Handler |
|---|---|---|
| `GET /config` | `adminEmail`, `maxPagesPerSite` pro UI | `worker/index.ts:219` |
| `POST /session` | založí nebo prodlouží anonymní relaci | `worker/index.ts:225` |
| `POST /scans`, `GET /scans` | založení mapy (`{ sites }`), seznam vlastních map | `worker/index.ts:247` |
| `GET /scans/:id` | snapshot aktuálního běhu | `worker/index.ts:393` |
| `PATCH /scans/:id` | pauza / `waiting`, interval a pauza webů (`{ status?, sites?, runId? }`) | `worker/index.ts:395` |
| `POST /scans/:id/start` | spustí nebo obnoví serverový běh | `worker/index.ts:304` |
| `POST /scans/:id/rescan` | archivuje běh a založí nový (`{ runId }` povinné) | `worker/index.ts:310` |
| `POST /scans/:id/sites` | přidá origin (`{ site, runId? }`) | `worker/index.ts:316` |
| `GET /scans/:id/log` | log aktuálního běhu | `worker/index.ts:302` |
| `GET /scans/:id/runs[/:runId[/log]]` | historie běhů, archivní snapshot, archivní log | `worker/index.ts:284` |
| `POST /scans/:id/pairing-ticket` | ticket pro historické rozšíření (60 s) | `worker/index.ts:376` |

**Runner endpointy** (historické rozšíření, `Authorization: Bearer <token>`; serverově řízená mapa je odmítá 409):

| Metoda a cesta | Účel | Handler |
|---|---|---|
| `POST /runner/exchange` | výměna ticketu za token (24 h), ticket se atomicky spotřebuje | `worker/index.ts:491` |
| `GET /runner/scans/:id[/control]` | snapshot / řídicí stav | `worker/index.ts:515` |
| `POST /runner/scans/:id/progress` | heartbeat a stav | `worker/index.ts:525` |
| `PUT /runner/scans/:id/results` | idempotentní uložení `PageResult` | `worker/index.ts:542` |

Tvary (`ScanSite`, `ScanSnapshot`, `ScanControl`, `PageResult`, `ScanLogEvent`, …) jsou v `shared/scan.ts`, validace vstupů ve `worker/validation.ts`. `PageResult`, `ScanLogEvent` a `ScanActivity` mají volitelné `crawlMode: 'preview'` pro automatickou kontrolu externí cílové stránky. Chybějící příznak zachovává původní význam výsledků. Původ výsledku se při pozdějším přidání webu do běžného skenu nemění; uloží se také do historie. `PageResult.siteOrigin` označuje logického vlastníka stránky, pokud se liší od skutečného originu v `sourceUrl` po povoleném přesměrování. Doplnit ho může pouze serverový skener; validace výsledků historického rozšíření dál vyžaduje přesný origin a toto pole nepřebírá.

---

## Fronta a průběh skenu

Zpráva ve frontě je `{ scanId, generation, tick }` (`CrawlMessage`, `worker/crawler.ts:27`). Producer je binding `CRAWL_QUEUE`, consumer export `queue` ve `worker/index.ts:637`.

1. **Start** (`startServerScan`, `worker/crawler.ts:128`): ověří `CRAWLER_ENABLED`, generaci a limity; přepne mapu na `running` / `execution_mode = 'server'`, zruší tokeny rozšíření, zvýší `crawl_generation`, naplní `crawl_frontier` seedy a už známými URL z dřívějších výsledků, založí řádky `crawl_robots`, nastaví `crawl_ready = 1` a pošle první tick (`enqueueCurrent`, `worker/crawler.ts:103`). Selhání přípravy zapíše `status = 'error'` a událost `scan_error`.
2. **Tick** (`tick`, `worker/crawler.ts:572`): atomicky získá lease na 120 s pro přesnou trojici `(id, generation, tick)`; jinak buď přepošle aktuální tick, nebo zprávu zopakuje až po vypršení cizího lease. Pak udělá **nejvýše jeden síťový požadavek** — robots.txt originu (`fetching_robots`) nebo jednu stránku (`fetching_page`). Před požadavkem rezervuje globální bránu originu (`reserveOrigin`, `worker/crawler.ts:529`) a denní rozpočet (`reserveRequest`, `worker/crawler.ts:554`); když brána ještě není volná, jen naplánuje další tick se zpožděním.
3. **Checkpoint** (`checkpoint`, `worker/crawler.ts:377`): zvýší `crawl_tick`, uvolní lease, zapíše `activity_json` a pošle další zprávu s `delaySeconds`. Odeslání do fronty a zápis do D1 nejsou jedna transakce — duplicitní tick je neškodný díky kontrole generace, ticku a lease.
4. **Konec** (`finish`, `worker/crawler.ts:323`): bez kandidáta ve frontieru končí běh jako `completed`, `limited` (`page_limit`, `scan_storage_limit`, `time_limit`, `daily_limit`) nebo `paused` (zbývá jen práce pozastavených webů).

Výjimka v ticku → `message.retry({ delaySeconds: 120 })` (`worker/crawler.ts:819`); po vyčerpání `max_retries` jde zpráva do dead-letter queue (konfigurace fronty a runbook v [04](./04-deployment.md)). Vlastník může zaseknutý běh nakopnout `POST /start`: po 120 s bez heartbeatu obnoví aktuální tick bez resetu časového limitu (`worker/crawler.ts:182`).

Historické mapy z rozšíření (`execution_mode = 'extension'`) zůstávají čitelné; první `POST /start` je převede na serverový běh a zneplatní párování.

---

## Pravidla crawleru

- **Jen veřejné HTTP(S) originy na standardním portu.** `normalizeScanUrl` (`shared/scan.ts:128`) odmítá jiné protokoly, přihlašovací údaje v URL, explicitní port, IPv4/IPv6 literály, hostname bez tečky a koncovky `localhost`, `local`, `internal`, `test`, `invalid`, `example`, `home`, `lan`. `publicFetch` (`worker/server-fetch.ts:21`) navíc vyžaduje přesnou shodu originu se scope a používá pouze globální `fetch`; flag `global_fetch_strictly_public` brání obcházení přes vlastní zónu.
- **Identita požadavku** (`worker/server-fetch.ts:25`): `User-Agent: VizlinxBot/1.0 (+https://vizlinx.com)`, `Accept` jen HTML/XHTML/plain, timeout 20 s, `redirect: 'manual'`, bez cookies.
- **robots.txt pro `VizlinxBot`** (`fetchServerRobots`, `worker/server-fetch.ts`): 404/410 = povoleno. Přesměrování 301/302/303/307/308 může změnit cestu, HTTP/HTTPS nebo variantu www; nejvýše **5 navazujících přesměrování** (6 odpovědí) v rámci původního webu. Každý krok má vlastní tick, síťový rozpočet a bránu skutečně požadovaného originu. `policy_json.nextUrl` a `visitedUrls` uchovávají kurzor mezi ticky i při pauze. Smyčka, příliš dlouhý řetězec, jiná doména, nepodporovaný stav, timeout, ostatní ne-2xx nebo tělo nad 64 KiB zamítnou původní origin (fail closed). Získaná pravidla se vyhodnocují pro origin, jehož robots se kontroloval; přesměrování samotného robots nerozšiřuje frontu stránek. `Crawl-delay` prodlužuje interval také pro původní origin. Stránky zakázané načteným pravidlem dostanou `robots_denied`; selhání načtení pravidel (včetně nedokončeného přesměrování) dostane `robots_unavailable`. V obou případech se stránka nestahuje. Log robots zachová HTTP stav a případný důvod odmítnutí přesměrování; HTTP stav stránky zůstává `null`, protože požadavek na ni neproběhl. Starší uložené výsledky ani historický extension runner se nepřeklasifikují.
- **Přesměrování stránek** (`fetchServerPage`, `worker/server-fetch.ts`): 301/302/303/307/308 na stejný origin (`same_origin`) nebo HTTP/HTTPS a www variantu téhož hostu (`site_variant`) zařadí cíl jako další URL. Varianta se potvrzuje až pozorovaným redirectem; běžný odkaz na jiný origin sám nerozšíří plný scope. Povolený pár vzniká odstraněním právě jednoho úvodního `www.`; jiné subdomény a opakované `www.www.` mimo pár se neslučují. Každý cíl dostane vlastní robots kontrolu pro svůj skutečný origin, podléhá síťové bráně a spotřebovává společný limit vlastníka. Dedup URL zastaví smyčky. Ostatní domény (`external`), nepodporované stavy a neplatné veřejné cíle (`invalid`) se nenásledují. Výsledek 3xx má nadále `status: redirect_unresolved`; další postup určuje `redirect.kind`.
- **Výchozí protokol:** URL bez schématu dostane `https://`. Selhání HTTPS nezpůsobuje automatický pokus přes HTTP; změna protokolu vyžaduje skutečnou odpověď s přesměrováním nebo explicitně zadané HTTP.
- **Identita a rozpočet webu:** `crawl_frontier.origin` zůstává logickým vlastníkem i pro URL na potvrzeném aliasu; skutečný síťový origin je v `url`. Alias tak sdílí limit 100 stránek, interval a pauzu a v mapě patří stejné kouli. Dva originy výslovně zadané uživatelem zůstávají samostatné. Pokud redirect dodatečně připojí existující preview, jeho rezervované sloty i původní výsledky zůstanou zachovány; již uložené odkazy se rozvinou bez opakovaného stažení stránky. Případné předchozí HTTP 429 přenese pauzu také na nového vlastníka. Změna vlastníka je atomická s uloženým důkazem přesměrování a chráněná generací/lease.
- **Historie přesměrování:** každý skutečně zpracovaný krok stránky i robots zapisuje zdrojovou `url`, `redirect.targetUrl`, `httpStatus` a logického vlastníka `origin`. Zacyklený či příliš dlouhý robots řetězec uvádí `invalid.reason: redirect_loop | redirect_limit`. Archivace uchová celý JSON výsledků i událostí; nový běh má vlastní log. Starší `external` události se zpětně nepřeklasifikují. Platí stávající limit 500 událostí a viditelný příznak ořezu.

- **Obsah:** jen `text/html` / `application/xhtml+xml`, jinak `not_html`; tělo nad 2 MiB → `too_large`; síťová chyba nebo timeout → `network_error`; ne-2xx → `http_error`. Odkazy extrahuje `extractHtml` z `<a href>` / `<area href>` s ohledem na `<base href>`, bez spouštění skriptů (`extension/extract.ts:34`).
- **HTTP 429 stránky** při běžném skenu atomicky pozastaví daný origin v `sites_json` a zapíše `site_throttled`; ostatní weby pokračují, zrušení pauzy je na vlastníkovi. Při automatické kontrole externího cíle místo toho nastaví `crawl_robots.preview_throttled = 1`: další kontroly tohoto originu se přeskočí po celý aktuální průchod, i po obnovení. Výslovné přidání originu do běžného skenu umožní pokračovat podle pravidel běžného skenu. Odpovědi robots.txt dál podléhají samostatnému fail-closed pravidlu výše.
- **Přerušený pokus** (`state = 'attempted'` po pádu) se nestahuje znovu — slot se spotřebuje výsledkem `network_error` s vysvětlením (`worker/crawler.ts:675`).
- **Objevené URL běžného skenu** se pro origin ve scope přidávají deduplikované do frontieru velikosti `pagesPerSite + 1` na origin (`addFrontier`). Přímé externí HTML odkazy z těchto stránek zařazují omezenou kontrolu svých cílových URL (`previewFrontierStatements`), popsanou níže.

### Automatická kontrola externích cílových stránek

Odkaz z plně povoleného originu A na `B/produkt` zařadí přímo tuto URL, bez přidání B do `sites_json` a bez automatického načtení jeho homepage. Kontrola používá stejný veřejný fetch, robots, globální bránu originu a denní, časový i úložný rozpočet. Výchozí interval externího originu je 3 s, delší `Crawl-delay` jej prodlužuje.

Výsledkem je běžný `PageResult` s `crawlMode: 'preview'`, včetně všech extrahovaných odkazů do stávajících limitů. Odkaz zpět na libovolnou stránku A je důkaz pro hranu B → A; odkazy na jiné weby se také uchovají. **Žádný HTML odkaz z kontrolované externí stránky se automaticky nenásleduje**, ani interní odkaz B, další externí C nebo nová stránka povoleného A. Výjimkou jsou povolená přesměrování včetně HTTP/HTTPS a www varianty, jejichž každý krok spotřebovává stejný rozpočet kontrol původního vlastníka. Cíl na jiném výslovně skenovaném originu využije jeho běžný scope a rozpočet; cizí domény se přesměrováním do fronty nepřidávají.

Limit je **10 jedinečných URL na externí web (včetně potvrzených variant) a 100 celkem za průchod mapou**. Slot vzniká vložením URL do `crawl_frontier` s `is_preview = 1`; obsazené sloty se nevracejí při chybě, zákazu robots, dokončení ani přidání originu do běžného skenu. Jedna URL tedy spotřebuje nejvýše jeden slot bez ohledu na počet příchozích odkazů. Robots požadavky nespadají do limitu URL, ale spotřebovávají denní síťový rozpočet. Vyčerpání limitu kontrol neukončuje další běžný sken; zbývající cíle zůstanou neověřené.

Při obnovení se kandidáti z uložených výsledků před navázáním JSON parametru omezí na zbývající sloty podle frontieru. Agregovaný seznam odkazů velké mapy tak nepřekročí limit velikosti parametru D1; konečné kvóty dál atomicky hlídá SQL.

Obnovení přes `/start` zachová frontier i příznak omezení HTTP 429. Z uložených výsledků znovu doplní jen povolenou práci: HTML odkazy z dosud externích preview výsledků další sken nerozvíjejí. **Povýšení webu** používá existující `POST /scans/:id/sites` a následný `/start`; dosavadní výsledky a sloty zůstávají, uložené odkazy povýšeného webu už mohou pokračovat běžným skenem. Dřívější kontroly se započítají do jeho limitu 100 stránek a URL se znovu nestahují. `/rescan` založí nový průchod s prázdným frontierem a robots, tedy i novými kvótami kontrol; předchozí výsledky a log zůstanou v archivu.

---

## Limity

Hodnoty jsou konstanty v kódu; při jejich změně se aktualizuje tato tabulka, ne naopak.

| Omezení | Hodnota | Kde |
|---|---|---|
| Originy pro běžný sken (externí kontroly se nepočítají) | 3 | `SCAN_LIMITS.sites`, `shared/scan.ts` |
| Stránky běžného skenu na origin (včetně neúspěšných a dřívějších kontrol) | 100 | `SCAN_LIMITS.pagesPerSite` |
| Automaticky kontrolované externí URL na origin / průchod mapou | 10 / 100 | `SCAN_LIMITS.previewPagesPerSite`, `.previewPagesPerScan`; trvalé sloty ve frontieru |
| Běhů na mapu (historie) | 10 | `SCAN_LIMITS.runsPerMap` |
| Skupiny odkazů / objevené URL na stránku | 500 / 500 | `SCAN_LIMITS.linksPerPage`, `.discoveredPerPage` |
| HTML tělo / výsledek stránky / výsledky mapy | 2 MiB / 256 KiB / 4 MiB | `SCAN_LIMITS.htmlBytes`, `.resultBytes`; `MAX_SCAN_BYTES` ve `worker/crawler.ts:24` a `worker/index.ts:28` |
| Tělo robots.txt | 64 KiB | `worker/server-fetch.ts:64` |
| Délka URL / anchoru | 4096 / 512 znaků | `SCAN_LIMITS.urlLength`, `.anchorLength` |
| Interval mezi požadavky na origin | 1–60 s, brána sdílená napříč mapami | `SCAN_LIMITS.minIntervalMs`, `.maxIntervalMs`; tabulka `crawl_origin_gates` |
| Timeout požadavku | 20 s | `worker/server-fetch.ts:32` |
| Délka jednoho běhu | 15 min | `RUN_MS`, `worker/crawler.ts:21` |
| Lease ticku | 120 s | `LEASE_MS`, `worker/crawler.ts:22` |
| Globální denní síťový rozpočet (včetně robots) | 10 000 požadavků na UTC den | `DAILY_REQUESTS`, `worker/crawler.ts:23` |
| Denní kvóty na IP: relace / mapy / starty | 20 / 50 / 100 | `limitCreation`, `worker/index.ts:120` |
| Mapy na návštěvníka / globálně; návštěvníci globálně | 10 / 1 000; 10 000 | `worker/index.ts:259`, `worker/index.ts:236` |
| Retence mapy a relace | 30 dní od založení mapy | `RETENTION_MS`, `worker/index.ts:26` |
| Ticket párování / token rozšíření | 60 s / 24 h | `worker/index.ts:384`, `RUNNER_TTL_MS` `worker/index.ts:27` |
| Log skenu | 500 nejnovějších událostí | `MAX_EVENTS`, `worker/scan-log.ts:3` |
| `running` bez heartbeatu → `interrupted` | 20 min server / 90 s rozšíření | `control`, `worker/scan-history.ts:56` |
| JSON tělo requestu | 16 KiB (výsledky runneru 256 KiB) | `readJson`, `worker/validation.ts:162` |
| CPU na invocation; consumer fronty | 5 000 ms; batch 1, souběh 3, 3 retry po 30 s | `wrangler.jsonc` |

Zvýšení limitu stránek není v API — je to změna `SCAN_LIMITS.pagesPerSite` a deploy; UI si hodnotu čte z `GET /config`.

---

## Invarianty

Co se nesmí porušit a proč:

- **Znalost ID mapy není přístup.** Každý webový endpoint prochází `owned()` (`worker/index.ts:173`): řádek musí patřit hashi cookie a být mladší než 30 dní. Tokeny a cookies se v D1 ukládají jen jako SHA-256 hash, surová hodnota existuje pouze u klienta.
- **Generace a lease rozhodují o platnosti práce.** Každá změna z webu (`PATCH`, `/sites`, `/start`, `/rescan`) zvýší `crawl_generation` a zruší lease; každý zápis crawleru má podmínku `activeSql` (`worker/crawler.ts:46`), takže opožděná odpověď staré generace nic nezapíše. Nový kód, který z fronty zapisuje do `scans`, `page_results` nebo `crawl_*`, musí tuto podmínku převzít.
- **Jeden tick = nejvýše jeden síťový požadavek, žádný `waitUntil`.** HTTP handler nikdy neskenuje sám, pouze zařadí zprávu; `ctx` se ve Workeru vůbec nepoužívá. Dlouhý běh by narazil na `cpu_ms` a ztratil by se při restartu isolate.
- **Automatická kontrola externích cílů nerozšiřuje běžný scope.** HTML odkazy preview výsledku jsou evidence, nikoli další frontier. Limit 10/100 se vynucuje při rezervaci URL v SQL, jeho sloty přežijí obnovení i povýšení webu. Ochrana generací a lease platí také pro preview výsledky, navazující přesměrování a HTTP 429.
- **Idempotence v SQL, ne v JS.** `page_results` má PK `(scan_id, source_url)` a `INSERT … ON CONFLICT DO NOTHING`; stejný `result_hash` je OK, jiný obsah 409 (`worker/index.ts:611`). Limity počtu stránek, bajtů i denního rozpočtu se vynucují v podmínce téhož `INSERT` (`worker/crawler.ts:417`), takže je souběžné ticky nemohou překročit.
- **Log se zapisuje ve stejném batchi jako přechod stavu** s guardem `changes() = 1` (`scanLogStatements`, `worker/scan-log.ts:8`) — událost bez skutečně provedené změny se nezapíše. Do provozního `console.error` nepatří tokeny, těla requestů, URL ani extrahovaný obsah; vlastnický log skenu naopak obsahuje zpracované URL (`worker/index.ts:646`).
- **Rozpočty jsou globální, ne per mapa.** `crawl_origin_gates` a `crawl_daily_budget` sdílejí všechny mapy i návštěvníci; nový běh (`rescan`) dostane nové per-run limity, ale ne nový denní rozpočet (`worker/scan-history.ts:224`).
- **`CRAWLER_ENABLED !== 'true'` je vypínač:** start a rescan vrací 503, běžící tick dokončí jako `paused` (`worker/crawler.ts:133`, `worker/crawler.ts:621`). Provozní použití viz [04](./04-deployment.md).
- **Web může měnit jen interval, pauzu a stav.** Originy a seedy po založení nelze měnit ani odebrat (`worker/index.ts:422`); přidat origin lze pouze přes `/sites` do limitu tří a vždy s pozastavením běhu.
