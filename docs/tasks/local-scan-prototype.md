# První funkční prototyp

Schváleno Pavlem 2026-09-12: po grafickém demu ověřit lokální skener a přivést skutečné odkazy do současné mapy. Rozšíření pro Chrome je přijato pro tento prototyp; veřejná distribuce a další prohlížeče následují až po ověření.

## Stav

Implementováno a lokálně ověřeno: skutečný web → spárované rozšíření → kontrolované HTML weby → Worker/D1 → živá mapa a návrat po reloadu. Samostatné testy ověřují vlastnictví, obnovu relace, kvóty, idempotenci, robots, intervaly, chyby i outbox po ztraceném potvrzení uploadu.

**Nasazení čeká na Cloudflare oprávnění:** projektový token úspěšně identifikuje účet, ale D1 list/create vrací Authentication error 10000. Je třeba přidat `Account → D1 → Edit`, vytvořit `vizlinx-scans`, nahradit nulové `database_id`, regenerovat typy a aplikovat obě migrace. Totéž oprávnění musí mít GitHub repository secret pro deploy po merge. Do té doby PR zůstává draft; aktuální produkční demo se nemění.

## Rozsah a kontrakt

Rozsah: nejvýše 3 přesné veřejné originy, 50 stránek na origin, statické HTML, interval a pauza po originu. Chrome rozšíření načítá HTML bez cookies a následování přesměrování; API na Cloudflare pouze ukládá strukturované výsledky do D1. Anonymní cookie vlastní mapu, jednorázový ticket páruje rozšíření, token je omezen na sken. Fronta/outbox se ukládají lokálně, opakované doručení výsledku nepřidává hrany. První prototyp sdružuje mapu podle přesných hostů; PSL slučování subdomén není součástí této etapy.

Kontrakt v `shared/scan.ts`. Všechny JSON odpovědi vracejí přímo daný objekt (bez obálky). Chyby `{error: string}`.

- `POST /api/v1/session` → `{ok:true}` + HttpOnly cookie.
- `POST /api/v1/scans` body `{sites: ScanSite[]}` → `ScanSnapshot`.
- `GET /api/v1/scans` → `ScanSummary[]` (vlastní).
- `GET /api/v1/scans/:id` → `ScanSnapshot` (vlastní).
- `PATCH /api/v1/scans/:id` body `{status?: 'paused'|'waiting', sites?: ScanSite[]}` → `ScanControl`; originy a seedy jsou po založení neměnné, mění se interval, maxPages a paused.
- `POST /api/v1/scans/:id/pairing-ticket` → `{ticket:string}`; platí 60s, jen jednou.
- `POST /api/v1/runner/exchange` body `{ticket:string}` → `RunnerSession`; token platí 24h a nové spárování ruší starý token.
- `GET /api/v1/runner/scans/:id` → `ScanSnapshot` (Bearer token).
- `GET /api/v1/runner/scans/:id/control` → `ScanControl` (Bearer).
- `PUT /api/v1/runner/scans/:id/results` body `PageResult` → `{ok:true}`; identita `(scanId,sourceUrl)`, opakované identické doručení je idempotentní, odlišný obsah vrací 409.
- `POST /api/v1/runner/scans/:id/progress` body `{status:ScanStatus}` → `{ok:true}`; heartbeat aktualizuje updatedAt, stale running scan se při čtení označí interrupted.

Webové mutace vyžadují stejný Origin a JSON. Runner používá Bearer token; API nemá veřejné CORS pro cizí webové stránky. Rozšíření se páruje pouze z vizlinx.com (localhost jen v dev sestavení). Bridge zprávy `{type:'vizlinx:ping'}` a `{type:'vizlinx:pair',ticket:string}` → `{ok:true}`; server origin je odvozen z ověřeného sender.origin, nikdy z libovolného payloadu. Service worker rozšíření otevře runner.html; runtime permissions si uživatel potvrzuje kliknutím v této kartě.

Build vytváří produkční ZIP rozšíření `/downloads/vizlinx-extension.zip`; stabilní veřejný klíč a ID jsou v `shared/extension.ts`. Lokální dev sestavení je oddělené a páruje se pouze s localhost/127.0.0.1 na portu 8797. Browser testy používají skutečný extension origin proti kontrolovaným HTML fixture serverům bez CORS. `test:api` ověřuje izolaci návštěvníků a opakovaný upload v workerd/D1; `test:prototype` propojuje stejné API se skutečným UI a rozšířením.

Scheduler provádí jeden požadavek současně a udržuje intervaly originů i mezi mapami. Robots používá wildcard `*`, HTML 429 zastaví daný origin do ručního obnovení; síťové/HTTP chyby se uloží jako neúspěšný výsledek bez automatických retry. Neprovádí chunkování ani aktualizace dřívějšího výsledku; pro nový pokus je potřeba nová mapa. Mapa ukládá data 30 dní od založení, platná anonymní relace se obnovuje při vstupu a založení mapy. Ztracenou nebo již expirovanou identitu nelze obnovit pouhou znalostí URL.

Veřejné nekontrolované skenování, DNS rebinding záruky, JS rendering a publikace do Chrome Web Store nejsou touto etapou ověřené.
