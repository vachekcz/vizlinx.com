# Serverový skener na Cloudflare

Schváleno Pavlem 12. 9. 2026: nahradit instalaci rozšíření skenováním na Workers, prozatím nejvýše 100 stránek na web. Po dosažení limitu musí být výrazně vidět důvod a výzva kontaktovat správce. Lokální vývoj musí fungovat bez produkčního tokenu.

## Architektura a kontrakt

Web → API Worker → Cloudflare Queue `vizlinx-com-crawl` → HTML/robots cílového webu → D1 → průběžně obnovovaná mapa. Jeden úkol zpracuje nejvýše jeden nový síťový požadavek. Celý sken neběží v `waitUntil` HTTP požadavku. Výsledky a fronta jsou trvalé; zavření karty jej nezastaví.

Přesné veřejné HTTP(S) originy, standardní porty, bez přihlašovacích údajů, cookies, privátních IP literálů a JavaScript renderingu. HTTP běží přes veřejný Workers `fetch` s manuálním zpracováním přesměrování, bez privátních síťových bindingů, s `global_fetch_strictly_public`, aby vlastní zóna neobcházela veřejnou ochranu. Robots platí pro `VizlinxBot`. Chybějící robots (404/410) povolí sken; nedostupná nebo nečitelná politika jej nepovolí. Skener neobchází CAPTCHA ani blokace serverových IP.

Přesměrování stránek 301/302/303/307/308 na přesně stejný origin zařadí cílovou URL do fronty, včetně relativních cest. Každý hop je samostatný požadavek započtený do limitu, s kontrolou robots a odstupu. Deduplicita fronty zastavuje cykly; řetězec nových URL zastaví celkový limit 100. HTML a relativní odkazy se zpracovávají pod skutečnou cílovou URL. Jiný origin (také změna protokolu, portu nebo subdomény) se nepřidává ani nestahuje, i kdyby již patřil do scope. Cíl je pouze metadata `redirect: {kind, targetUrl?}` výsledku a logu, nikoli HTML odkaz v grafu. Neplatné/nevhodné cíle se nenásledují; URL s přihlašovacími údaji se do metadat nepřenáší. Přesměrování samotného robots.txt nadále nepovolí načítání politiky.

Historické výsledky 302 bez uloženého cíle se zpětně nedoplňují; pro jejich ověření je potřeba nová mapa. Výsledek přesměrování si kvůli kompatibilitě ponechává status `redirect_unresolved`, konkrétní zacházení určuje `redirect.kind` (`same_origin`, `external`, `invalid`). Dokončená fronta bez úspěšného HTML se v rozhraní označí „Sken skončil bez načtených stránek“.

- `GET /api/v1/config` → `{adminEmail: string|null, maxPagesPerSite:100}`.
- `GET /api/v1/scans/:id/log` s vlastnickou cookie → `{events, truncated}`. Nejvýše 500 nejnovějších událostí v pořadí zápisu, se stejnou retencí a přístupem jako mapa. Událost obsahuje čas, typ, závažnost a případně origin, URL, stav stránky, HTTP status, počet odkazů nebo důvod limitu. Syrové výjimky, HTML ani provozní log Workeru se neposílají do webu.
- Snapshot obsahuje volitelné `activity`: fázi, čas aktualizace, případně origin, URL a nejbližší čas dalšího požadavku. Rozhraní obnovuje stav po 3 s; odpočet je čekání na povolený termín, nikoli záruka přesného spuštění ve frontě. Běh, pauza i konečný stav jsou viditelné se zavřeným logem. Výpadek aktualizací nesmí tvrdit, že je běh aktuálně ověřený.
- `POST /api/v1/scans/:id/start` s vlastnickou cookie, stejným Origin a JSON `{}` → `ScanSnapshot`. Spustí nebo obnoví serverový běh; zneplatní tokeny rozšíření a nastaví maxPages na 100.
- Stávající session, create/list/get scan, PATCH a přidání originu zůstávají. Web po vytvoření mapy volá start automaticky. PATCH a přidání originu zneplatní rozpracovanou generaci úloh.
- `limitReason` v control/snapshot je volitelně `page_limit`, `scan_storage_limit`, `time_limit` nebo `daily_limit`. Web vysvětlí skutečný důvod a zachová mapu i export výsledků.
- Historické mapy a párování zůstávají kompatibilní do převodu mapy na server. Serverově spravovaná mapa odmítne nové párování i zápisy rozšíření.

Zvýšení nad 100 není dostupné ve veřejném API ani přes změnu pole formuláře. V první etapě jde o změnu správce v konfiguraci/kódu, nikoli novou administraci. `ADMIN_EMAIL` je veřejná kontaktní adresa ve Wrangler vars; prázdná hodnota znamená pouze textovou výzvu.

## Ochrana spotřeby

HTTP 429 na stránce uloží chybový výsledek a atomicky pozastaví daný origin. Další originy pokračují; nevyřízené URL zůstávají uložené. Obnovení celého skenu samo pauzu originu nezruší: vlastník jej nejprve povolí v detailu webu. Událost `site_throttled` vysvětlí důvod v logu. Pozdní odpověď po změně generace nesmí pozastavit origin v novém běhu.

Limit startů se účtuje při explicitním POST `/start` nebo PATCH se stavem `waiting`, nikoli při běžné změně intervalu či pauzy originu. Změny nastavení současně neposouvají začátek probíhajícího časového limitu. Robots má samostatný limit 64 KiB vynucený při čtení streamu i přes `Content-Length`; zkracování velkého výsledku počítá UTF-8/JSON bajty průběžně v lineárním čase.

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

Consumer používá dead-letter queue `vizlinx-com-crawl-dead-letter` pro zprávy, které vyčerpaly tři opakování. Je vytvořená s retencí 86 400 sekund, bez automatického consumera: poskytuje čas na diagnostiku a ruční obnovu, není trvalým archivem ani automatickou opravou. Správce může zprávu prohlédnout v Cloudflare Queues a vrátit nezměněný payload do hlavní fronty; generace/checkpoint odmítnou zastaralou práci. Nepoužitý producer binding není potřeba, přesměrování zajišťuje `dead_letter_queue` v konfiguraci consumera. [Dokumentace Cloudflare](https://developers.cloudflare.com/queues/configuration/dead-letter-queues/) popisuje směrování po vyčerpání retry limitu. Pro nový účet je potřeba tuto frontu vytvořit před deployem: `npx wrangler queues create vizlinx-com-crawl-dead-letter --message-retention-period-secs 86400`.

Queue se jednorázově vytvoří příkazem `npx wrangler queues create vizlinx-com-crawl --message-retention-period-secs 86400`; v tomto účtu už existuje. Migrace `0003_server_crawler.sql`, `0004_crawl_ready.sql` a `0005_scan_log.sql` rozšiřují stávající D1 bez mazání map. Log a aktivita vznikají od nasazení nové verze; historie starších výsledků se nedoplňuje. `npm run deploy` sestaví aplikaci, aplikuje migrace a nasadí producenta i consumera. Token potřebuje Workers Scripts Edit, D1 Edit a Queues Edit.

Na účtu bylo ověřeno aktivní `Billing Budget Alert` s prahem 5 USD a jedním e-mailovým příjemcem. Tato existující politika platí pro účtovanou spotřebu napříč účtem, nikoli výhradně pro Vizlinx. Pokus vytvořit dřívější upozornění při 0,01 USD pro stejného existujícího příjemce skončil 403: současný token dovoluje čtení politik, ale chybí mu Notifications Write. Nic se nezměnilo. Dřívější upozornění lze nastavit v dashboardu přes Billing → Billable Usage nebo po doplnění oprávnění tokenu. [Cloudflare Budget alerts](https://developers.cloudflare.com/billing/manage/budget-alerts/) potvrzuje, že upozornění samo spotřebu nezastaví.

## Hranice první verze

Výsledek HTML skenu nemusí obsahovat odkazy vytvářené JavaScriptem. Přesměrování na jiný origin vyžaduje zadat cílový web samostatně. Robots a antibot ochrana mohou zablokovat celý web. Pro více stránek, JS rendering nebo větší veřejný provoz je potřeba další rozhodnutí správce a měření skutečné spotřeby; dřívější CPU cenové scénáře nejsou cenou celého skenu.

## Ověřeno 12. 9. 2026

- UI: 105 úspěšných testů a jeden dříve vynechaný mobilní scénář; API: 25; crawler: 14; benchmark: 5.
- Kompletní E2E bez rozšíření: HTML → Queue → D1 → graf/tabulka, přidání webu, pauza a reload. Fixture se 101 stránkami skončí přesně po 100 staženích, s trvalým upozorněním a zachovanými výsledky.
- Historické rozšíření prošlo vlastní sadou ověřující permissions, robots, limity a obnovu outboxu.
- Lokální Wrangler na portu 8797 dokončil reálný sken galerie Vizlinx: 11 URL, 6 úspěšných HTML výsledků. Migrace zachovaly stávající lokální databázi.
- Produkční Worker `vizlinx-com`, verze `eb08d864-490f-4bd4-a8ca-e439a3c97df8`, dokončil stejný sken: 11 URL, 6 HTML výsledků a 15 odkazových skupin. Čtení mapy bez vlastnické cookie vrací 401. Skutečný D1 binding byl po nasazení ověřen přes API jako `vizlinx-scans`, nikoli lokální nulové ID.
- Formátování, TypeScript/build i Wrangler dry-run prošly. První provozní test potvrzuje funkčnost, nikoli cenu rozsáhlých nebo souběžných skenů.

## Průběh skenu – 13. 9. 2026

Stálý indikátor ukazuje načítání robots nebo stránky, čekání na frontu/interval, počet zpracovaných stránek a konečný stav. Tlačítko „Průběh skenu“ otevře spodní panel na desktopu a celoobrazovkový dialog na mobilu. Log podporuje filtr originu, jen chyby, zastavení automatického posunu při čtení historie a opětovné sledování. Po zavření dialogu se log nedotazuje; zůstává běžné obnovování snapshotu. Události se zapisují atomicky se změnou stavu nebo uložením výsledku, pod stejnou ochranou generace a lease.

- API: 27 testů, crawler: 16, uložení logu: 4. Ověřena izolace návštěvníků, retence, limit 500 událostí, duplicity, smazání s mapou a pozdní robots/page odpovědi po pauze.
- UI: 113 úspěšných testů a jeden existující vynechaný mobilní scénář. Nové scénáře pokrývají stálý indikátor, odpočet, filtry, ovládání klávesnicí, automatický posun, chyby spojení a pomalý požadavek logu při současném obnovování mapy. Kompletní E2E ověřil skutečný log z Workeru, zachování historie po reloadu, načítanou URL, pauzu i původní limit 100 stránek.
- Lokální skutečný sken: 11 stránek, 14 uložených událostí, konečný stav `completed`. Opakované načtení vrátí stejný log a požadavek bez vlastnické cookie dostane 401.
- Migrace `0005_scan_log.sql` aplikována lokálně i do produkční D1 bez mazání stávajících map.
- Produkční verze `af8e6f4a-bfea-4b82-93d9-652b64cac2ef` dokončila reálný sken galerie: 11 stránek a 14 událostí (start, robots, výsledky a dokončení). Ověřeno opakované načtení totožné historie, konečná aktivita `completed`, 401 bez vlastnické cookie a načtení aktuálních frontendových assets.

## Opravy po review – 13. 9. 2026

Review doplnilo pauzu originu po HTTP 429, oddělilo kvótu startů od běžných změn nastavení, zpřísnilo streamový limit robots a odstranilo kvadratické zkracování velkých výsledků. API test kontroluje celý Queue payload i zpoždění. Starší skeny z rozšíření neukládají serverovou fázi `queued`; jejich progress odstraňuje případnou historickou aktivitu. Úklid logu navazuje jen na skutečně vloženou událost, trim se provede pouze při překročení 500 záznamů.

Produkční konfigurace fronty byla ověřena přes Cloudflare API: consumer skutečně směruje vyčerpané retry do `vizlinx-com-crawl-dead-letter`, která má retenci 86 400 sekund a žádný automatický consumer. Testy čtení streamu a velikosti výsledku: 9; API po doplnění regresí: 29; crawler: 18; log: 4. Počet API scénářů zahrnuje parametrizovanou smyčku `rotate/append/expire`, proto jej nelze odvodit prostým počítáním výskytů `test(`. Dřívější počty 25 a 27 popisují předchozí ověřené verze.

## Přesměrování – ověřeno 13. 9. 2026

- API: 29 testů, crawler: 23, zpracování odpovědí: 10, rozhraní skenu: 46 na desktopu a mobilu. Regrese pokrývají řetězce, smyčky, robots, interval, limit 100 URL, externí cíle po restartu i pozdní přesměrování po pauze. Prošel kompletní E2E s Workerem, Queue a D1 včetně přesměrování, formátování, TypeScript/build a Wrangler dry-run.
- Produkční verze `b8c15ec3-de29-4832-8415-c9089465a7a0` následovala `https://www.flowii.com/` (302) na `/sk/` (200 HTML): výsledek obsahoval 132 odkazových skupin a 78 objevených URL. Cíl přesměrování byl ověřen v uloženém logu. Samostatný diagnostický sken byl poté pozastaven.
