# Serverový skener na Cloudflare

Schváleno Pavlem 12. 9. 2026: nahradit instalaci rozšíření skenováním na Workers, prozatím nejvýše 100 stránek na web. Po dosažení limitu musí být výrazně vidět důvod a výzva kontaktovat správce. Lokální vývoj musí fungovat bez produkčního tokenu.

## Architektura a kontrakt

Web → API Worker → Cloudflare Queue `vizlinx-com-crawl` → HTML/robots cílového webu → D1 → průběžně obnovovaná mapa. Jeden úkol zpracuje nejvýše jeden nový síťový požadavek. Celý sken neběží v `waitUntil` HTTP požadavku. Výsledky a fronta jsou trvalé; zavření karty jej nezastaví.

Přesné veřejné HTTP(S) originy, standardní porty, bez přihlašovacích údajů, cookies, privátních IP literálů, automatických přesměrování a JavaScript renderingu. HTTP běží přes veřejný Workers `fetch`, bez privátních síťových bindingů, s `global_fetch_strictly_public`, aby vlastní zóna neobcházela veřejnou ochranu. Robots platí pro `VizlinxBot`. Chybějící robots (404/410) povolí sken; nedostupná nebo nečitelná politika jej nepovolí. Skener neobchází CAPTCHA ani blokace serverových IP.

- `GET /api/v1/config` → `{adminEmail: string|null, maxPagesPerSite:100}`.
- `POST /api/v1/scans/:id/start` s vlastnickou cookie, stejným Origin a JSON `{}` → `ScanSnapshot`. Spustí nebo obnoví serverový běh; zneplatní tokeny rozšíření a nastaví maxPages na 100.
- Stávající session, create/list/get scan, PATCH a přidání originu zůstávají. Web po vytvoření mapy volá start automaticky. PATCH a přidání originu zneplatní rozpracovanou generaci úloh.
- `limitReason` v control/snapshot je volitelně `page_limit`, `scan_storage_limit`, `time_limit` nebo `daily_limit`. Web vysvětlí skutečný důvod a zachová mapu i export výsledků.
- Historické mapy a párování zůstávají kompatibilní do převodu mapy na server. Serverově spravovaná mapa odmítne nové párování i zápisy rozšíření.

Zvýšení nad 100 není dostupné ve veřejném API ani přes změnu pole formuláře. V první etapě jde o změnu správce v konfiguraci/kódu, nikoli novou administraci. `ADMIN_EMAIL` je veřejná kontaktní adresa ve Wrangler vars; prázdná hodnota znamená pouze textovou výzvu.

## Ochrana spotřeby

| Omezení | Hodnota |
| --- | --- |
| Weby v mapě | 3 přesné originy |
| Stránky na origin | 100 včetně neúspěšných či přerušených pokusů |
| Souběžné Queue consumers | 3, velikost dávky 1 |
| Začátky požadavků na origin | Nejméně 1 s od sebe, sdílené napříč mapami; respektuje delší interval/robots |
| Globální denní síťový rozpočet | 10 000 požadavků včetně robots, reset UTC |
| Běh skenu | Nejvýše 15 minut na běh |
| Timeout požadavku | 20 sekund |
| CPU na Worker invocation | 5 000 ms |
| HTML | 2 MiB na stránku |
| Výsledek stránky / celé mapy | 256 KiB / 4 MiB |
| Skupiny odkazů / objevené URL na stránku | 500 / 500 |
| Počet startů a pokračování na IP | 100 za UTC den |
| Mapy na návštěvníka / globálně | 10 / 1 000 |
| Retence map | 30 dní od založení |

Limity se uplatňují na serveru. Stav úlohy obsahuje generaci, pořadí a časově omezený lease. Duplicitní zpráva nesmí vytvořit druhý výsledek ani obejít limit. Pokus rezervovaný před pádem se automaticky nestahuje znovu; slot zůstává spotřebovaný a při obnově získá výsledek chyby. Úlohy respektují pozdější pauzu nebo změnu scope přes podmínky při zápisech do D1.

`CRAWLER_ENABLED=false` je provozní vypínač: nové starty odmítne, zpracovávané úlohy zastaví při nejbližší kontrole. Samotné notifikace nejsou finanční limit ani okamžitá brzda. Omezení skeneru neomezují účet jiných aplikací ani veškeré příchozí HTTP požadavky.

## Lokální vývoj a ověření

```sh
npm ci
npm run dev:full
```

http://127.0.0.1:8797/scan poskytne celou aplikaci v lokálním Wrangleru: Worker, Queue consumer i D1. Při skenu veřejných URL odchází provoz z vývojářova počítače. Bez `--remote` se nepracuje s produkční D1. Původní `preview_database_id` zůstává zachovaný pro stávající lokální mapy.

Testy používají izolovanou D1 a kontrolované HTTP odpovědi. `test:crawler` ověřuje limity, obnovu a síťová pravidla; `test:prototype` propojuje skutečný Worker/Queue/D1 s Chromiem bez rozšíření. Testovací zrychlení hodin a fronty je pouze v harnessu, nikoliv produkční konfiguraci. Původní `test:extension` dále chrání kompatibilitu historického prototypu.

## Nasazení a upozornění

Queue se jednorázově vytvoří příkazem `npx wrangler queues create vizlinx-com-crawl --message-retention-period-secs 86400`; v tomto účtu už existuje. Migrace `0003_server_crawler.sql` a `0004_crawl_ready.sql` rozšiřují stávající D1 bez mazání map. `npm run deploy` sestaví aplikaci, aplikuje migrace a nasadí producenta i consumera. Token potřebuje Workers Scripts Edit, D1 Edit a Queues Edit.

Na účtu bylo ověřeno aktivní `Billing Budget Alert` s prahem 5 USD a jedním e-mailovým příjemcem. Tato existující politika platí pro účtovanou spotřebu napříč účtem, nikoli výhradně pro Vizlinx. Pokus vytvořit dřívější upozornění při 0,01 USD pro stejného existujícího příjemce skončil 403: současný token dovoluje čtení politik, ale chybí mu Notifications Write. Nic se nezměnilo. Dřívější upozornění lze nastavit v dashboardu přes Billing → Billable Usage nebo po doplnění oprávnění tokenu. [Cloudflare Budget alerts](https://developers.cloudflare.com/billing/manage/budget-alerts/) potvrzuje, že upozornění samo spotřebu nezastaví.

## Hranice první verze

Výsledek HTML skenu nemusí obsahovat odkazy vytvářené JavaScriptem. Přesměrování vyžaduje zadat konečnou URL. Robots a antibot ochrana mohou zablokovat celý web. Pro více stránek, JS rendering nebo větší veřejný provoz je potřeba další rozhodnutí správce a měření skutečné spotřeby; dřívější CPU cenové scénáře nejsou cenou celého skenu.

## Ověřeno 12. 9. 2026

- UI: 105 úspěšných testů a jeden dříve vynechaný mobilní scénář; API: 25; crawler: 14; benchmark: 5.
- Kompletní E2E bez rozšíření: HTML → Queue → D1 → graf/tabulka, přidání webu, pauza a reload. Fixture se 101 stránkami skončí přesně po 100 staženích, s trvalým upozorněním a zachovanými výsledky.
- Historické rozšíření prošlo vlastní sadou ověřující permissions, robots, limity a obnovu outboxu.
- Lokální Wrangler na portu 8797 dokončil reálný sken galerie Vizlinx: 11 URL, 6 úspěšných HTML výsledků. Migrace zachovaly stávající lokální databázi.
- Produkční Worker `vizlinx-com`, verze `eb08d864-490f-4bd4-a8ca-e439a3c97df8`, dokončil stejný sken: 11 URL, 6 HTML výsledků a 15 odkazových skupin. Čtení mapy bez vlastnické cookie vrací 401. Skutečný D1 binding byl po nasazení ověřen přes API jako `vizlinx-scans`, nikoli lokální nulové ID.
- Formátování, TypeScript/build i Wrangler dry-run prošly. První provozní test potvrzuje funkčnost, nikoli cenu rozsáhlých nebo souběžných skenů.
