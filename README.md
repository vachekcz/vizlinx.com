# Vizlinx.com

**See how websites connect.**

Interaktivní mapa odkazů mezi weby. Návštěvník bez účtu zadá domény, nastaví rychlost každé z nich a spustí skenování na Cloudflare Workers, bez instalace rozšíření. Výsledky se průběžně ukládají na server. Oddálený pohled ukazuje domény jako clustery; přiblížení odhalí konkrétní zdrojové a cílové stránky.

**Produkce:** [vizlinx.com](https://vizlinx.com/)

## Stav

Grafické demo doplňuje **funkční serverový skener na `/scan`**: zadání webů, fronta Cloudflare Queues, průběžné ukládání do D1 a skutečné odkazy v současné mapě. Sken pokračuje i po zavření karty. Prochází statické veřejné HTML bez cookies a JavaScriptu, nejvýše **1 000 stránek na vybraný web**. U přímo odkazovaných externích webů automaticky kontroluje cílové stránky, aby mohl odhalit také odkazy zpět, bez spuštění běžného skenu těchto webů. [Aktuální kontrakt a ochranné limity](docs/01-backend.md).

Úvodní `/` zůstává grafickým demem. Pět ukázkových webů, jeden neprozkoumaný externí cíl a 53 směrových vazeb tvoří fiktivní ekosystém Studia Atlas. Doména `index.example` obsahuje 20 stránek; ostatní prozkoumané weby po šesti. Tato ukázka používá pouze lokální data.

**Živé demo:** [vizlinx.com](https://vizlinx.com), také [www.vizlinx.com](https://www.vizlinx.com). Záložní adresa: [vizlinx-com.pvpvpv.workers.dev](https://vizlinx-com.pvpvpv.workers.dev).

**UI galerie:** [vachekcz.github.io/vizlinx.com](https://vachekcz.github.io/vizlinx.com/) — noční screenshoty všech stavů aplikace na desktopu i mobilu, generuje workflow Nightly Screenshots.

**UX studie:** po spuštění `npm run dev` otevřete `/ux`. Galerie nabízí tři kompletní interaktivní návrhy: pracovní plochu (`/ux/1`), mapu s plovoucím ovládáním (`/ux/2`) a analytický přehled (`/ux/3`). Zachovávají Signal/Midnight, ukazují i založení mapy, výsledky, detail, log a historii. Jde o ukázková data bez skutečného skenování; současná aplikace se nemění. [Rozsah a implementace studií](docs/02-frontend.md#routing-a-stav).

**Vzhled:** Signal pro denní režim, Midnight pro noční. Přepínač měsíce/slunce v hlavičce ukládá ruční volbu v prohlížeči; bez ní vzhled sleduje nastavení systému. [Denní demo](https://vizlinx.com/?theme=signal), [noční demo s 20 stránkami](https://vizlinx.com/?theme=midnight&detail=index). [Původních pět mockupů](https://vizlinx.com/palettes/) zůstává jako archiv návrhů.

**Vybrané spojnice: Hedvábí (Silk).** Směr ukazuje větší plný hrot v barvě zdroje s kontrastním obrysem; stejný hrot mají i vazby mezi rozbalenými stránkami. Výchozí mapa používá stejně tenké čáry pro 1–5 vazeb a postupně rostoucí svazky pro `5+`, `10+`, `25+`, `50+` a `100+`. [Ukázka silných vazeb](https://vizlinx.com/?density=scale) obsahuje 230 unikátních dvojic stránek, nejsilnější propojení má 120 vazeb. [Samostatná studie spojnic](https://vizlinx.com/connections/lab/) a [archiv osmi návrhů](https://vizlinx.com/connections/) zůstávají dostupné; výběr experimentálních stylů se zobrazí jen při otevření konkrétního návrhu z archivu.

Vizuální směr a základní ovládání byly potvrzené. Funkční prototyp z nich vychází; [aktuální rozsah a kontrakt](docs/01-backend.md) upřesňují širší [produktové zadání](https://github.com/vachekcz/vizlinx.com/wiki/Produktove-zadani).

## Spuštění

Node.js 24+, npm.

```sh
npm ci
npm run dev
```

Lokální demo: http://127.0.0.1:5173. Pro lokální prohlížení není potřeba `.env`.

### Funkční skener lokálně

```sh
npm run dev:full
```

Příkaz sestaví aplikaci, aplikuje lokální migrace a spustí `dev:api`. Jednotlivé kroky lze spustit také přes `npm run build`, `npm run db:local` a `npm run dev:api`.

Otevřete http://127.0.0.1:8797/scan. Wrangler spustí Worker i frontu lokálně a použije lokální D1; pro tento režim není potřeba Cloudflare token ani rozšíření. Veřejné weby se stahují přes připojení vašeho počítače. Produkční mapy se nemění. Po změně frontendu zopakujte build; samostatný Vite (`npm run dev`) poskytuje frontend, nikoli skenovací API.

Zadejte 1–3 přesné veřejné originy. Po založení mapy se sken spustí automaticky. Web umožňuje měnit interval požadavků, pozastavit celý sken nebo jednotlivý origin a přidat další web až do limitu tří. Přidání webu zachová ID, výsledky a ruční pozice bublin; běh pozastaví a pokračování se spouští přímo tlačítkem ve webu.

Odkaz z `A.cz/clanek` na `B.cz/produkt` automaticky zařadí ke kontrole přímo `B.cz/produkt`. Pokud jeho veřejné HTML obsahuje odkaz na kteroukoli stránku A, mapa zobrazí také směr B → A. Kontrola uloží i ostatní nalezené odkazy, ale žádný z nich dál nenavštěvuje. Má samostatný limit **10 cílových URL na externí web včetně potvrzených variant a 100 na průchod mapou**, včetně neúspěšných kontrol a kroků přesměrování; nedoplňuje automaticky domovskou stránku. Tyto weby nezabírají jedno ze tří míst pro běžný sken.

Úspěšně zkontrolovaný externí web má stav **„Částečně prozkoumáno“**. Detail uvádí, kolik známých přímo odkazovaných cílových URL bylo ověřeno, a nalezené zpětné vazby. Chyba nebo blokace není důkazem chybějícího odkazu; ani úspěšná kontrola všech známých cílů neznamená prozkoumání celého webu. **„Prozkoumat web“** přidá origin mezi vybrané weby a rovnou spustí běžný sken, pokud zbývá místo do limitu tří. Zachová výsledky a polohu bubliny, již kontrolované stránky znovu nestahuje a započítá je do limitu 1 000 stránek daného webu. Historický průchod zůstává pouze ke čtení.

Pod ovládáním je stále vidět aktuální činnost, počet zpracovaných stránek a při běhu načítaná URL nebo čekání na další požadavek. **Průběh skenu** otevře uložený log: na počítači spodní panel, na mobilu přes celou obrazovku. Lze filtrovat web a chyby; při posunu do historie se automatické sledování zastaví. Log uchovává nejvýše 500 nejnovějších událostí po dobu platnosti mapy a obnovuje se při otevřeném panelu. Události starších skenů se zpětně nedoplňují.

**Skenovat znovu** v horní liště spustí nový průchod stejné sestavy webů se stejnými intervaly a nastavením pauz. Adresa mapy zůstane stejná, předchozí výsledky a log se uloží do historie a nové výsledky přibývají živě od začátku. **Historie skenů** vedle ovládání přepíná průchody podle data a stavu. Starší průchod je pouze ke čtení; tlačítko vrátí zobrazení k aktuálnímu skenu. Pozastavený aktuální průchod lze dokončit přes „Pokračovat ve skenování“, bez zakládání dalšího. Mapa uchovává až 10 průchodů včetně aktuálního, všechny do 30 dní od založení mapy. Vyčerpání kapacity historie nic nemaže a vyžaduje kontaktovat správce. Podrobnosti jsou v [návrhu historie skenů](docs/01-backend.md).

**Ruční rozšíření mapy:** u dosud nenačtené nalezené URL lze kliknout na ▶ „Proskenovat“. Akce načte konkrétní stránku a přidá její odkazy do stejného grafu, i když už jsou zadané tři weby. Další nalezené cíle lze otevírat stejným způsobem; automatické procházení z ručně zvolené stránky se nespouští. V detailu webu lze vyhledat všechny známé URL včetně těch, které se už nevejdou do náhledu grafu.

Limit běžného skenu je pevně 1 000 stránek na web včetně potvrzených HTTP/HTTPS/www variant a neúspěšných pokusů. Při dosažení se zobrazí výrazná hláška a výzva kontaktovat správce kvůli vyššímu limitu. Uživatelské API limit nezvýší. `ADMIN_EMAIL` ve Wrangler konfiguraci zapíná kontaktní tlačítko; prázdná hodnota ponechá textovou výzvu bez vymyšlené adresy. Denní nebo časový limit a zaplnění mapy mají vlastní důvod zastavení.

Skener respektuje robots.txt pro `VizlinxBot`, čte HTML do 2 MiB a neposílá cookies. Bez protokolu doplní HTTPS; při chybě HTTPS automaticky nezkouší HTTP. Při běžném skenu a automatické kontrole externího cíle přesměrování stránky na jinou cestu, HTTP/HTTPS nebo variantu s www / bez www automaticky zařadí do fronty. U ručního skenu uloží cíl přesměrování pro další kliknutí na ▶. Potvrzené varianty patří stejnému webu v mapě a sdílejí limit i ovládání. Každý krok podléhá rychlosti, robots a příslušnému limitu URL; již známá stránka se znovu nestahuje. Přesměrovaný robots.txt dovolí nejvýše pět navazujících přechodů, se samostatnou kontrolou každého kroku a ochranou proti smyčce. Jiné domény, ostatní subdomény a nestandardní porty se přesměrováním nenásledují. V průběhu skenu i jeho archivní historii zůstává původní URL, cílová URL a HTTP stav každého kroku. Podrobnosti pravidel jsou v [referenci backendu](docs/01-backend.md#pravidla-crawleru).

Automatické kontroly externích cílů sdílejí časový, denní i úložný rozpočet s běžným skenem; jejich povolená přesměrování spotřebovávají stejný rozpočet 10/100 URL. Mapa uchovává výsledky 30 dní od založení a patří anonymní relaci stejného prohlížeče. Samotné předání URL nezpřístupní mapu jiným lidem.

Při běžném skenu HTTP 429 pozastaví další požadavky na dotčený web a zaznamená důvod do průběhu skenu. Ostatní weby pokračují. Až omezení pomine, web lze znovu povolit v jeho detailu a případně obnovit celý sken. Samotné změny intervalu nebo pauzy jednotlivého webu nespotřebovávají denní kvótu startů.

U automaticky kontrolovaného externího webu HTTP 429 zastaví jeho další kontroly po zbytek průchodu, včetně pozastavení a obnovení mapy. Nový průchod nebo výslovné přidání webu do běžného skenu umožní další práci. Chyby i označení částečných kontrol zůstávají uložené ve výsledcích a historii.

Stará data rozšíření zůstávají čitelná. Spuštění staré mapy přes web ji převede na serverový běh a zneplatní původní párování. Historický návod rozšíření je v [extension/README.md](extension/README.md).

### Galerie screenshotů

Workflow [Nightly Screenshots](.github/workflows/nightly-screenshots.yml) každou noc projede aplikaci Playwrightem, vyfotí pojmenované stavy na desktopu i mobilu a publikuje je jako galerii na [vachekcz.github.io/vizlinx.com](https://vachekcz.github.io/vizlinx.com/). Běh se přeskočí, když se od posledního úspěšného běhu nezměnil kód. Lokálně:

```sh
npm run screenshots:tour      # build, lokální D1 a wrangler dev na portu 8798, tour z tests/tour/
npm run screenshots:gallery   # screenshots-output/index.html
```

Tour běží nad `wrangler dev`, aby fungoval i `/scan`; žádný skutečný sken nespouští. Hlavní `npm test` adresář `tests/tour/` ignoruje.

## Ovládání dema

- Klik na doménu otevře detail; dvojklik nebo „Prozkoumat stránky“ rozbalí její stránky na stejné pozici. Okolní bubliny se podle potřeby odsunou a ruční posuny zůstanou zachované. Tažení domény mění její polohu, tažení pozadí posouvá celou mapu. Po zaměření domény klávesou Tab ji posouvají šipky (Shift zvětší krok). Přehled obnoví výchozí rozložení.
- Ikona ↗ u domény nebo URL otevře web v nové kartě. Je dostupná v bublinách, seznamu webů, detailech, tabulce i průběhu skenu včetně chyb a přesměrování. Kliknutí na název dál vybírá detail v mapě.
- Klik na číslo nebo čáru propojení zobrazí směrové vazby. Výběr konkrétní vazby odhalí zdrojovou i cílovou URL a metadata.
- Mapa podporuje tažení, zoom kolečkem a tlačítky, automatické zobrazení stránek při přiblížení a návrat do přehledu. Uzly a vazby lze vybrat i klávesnicí.
- „Ukázka: 20 stránek“ otevře zvětšený cluster `index.example` na jeho současné pozici a zachová zoom i posun pohledu. Karty jsou rozmístěné podle počtu stránek a velikosti obrazovky. Pohled ukazuje vazby této domény; výběr stránky zvýrazní její spojnice a ostatní ztlumí. „Přehled“ obnoví celou mapu.
- „Další odkazované weby“ zobrazí neprozkoumaný externí cíl; výchozí pohled obsahuje 51 vazeb mezi pěti zadanými weby.
- „Přehrát demo“ simuluje postupné objevování vazeb. Globální pauza, pauza webu v desktopovém seznamu a interval v detailu domény ovládají pouze tuto simulaci. Počet prozkoumaných stránek je pevná vlastnost ukázkové sady.
- Tabulka nabízí hledání, filtr `nofollow` a CSV export odpovídající viditelným filtrům. Obnovení stránky vrátí výchozí stav.

Mapu vykresluje SVG. Stejný graf slouží omezenému funkčnímu prototypu; výkon pro velké skeny tím není ověřený.

## Ověření

Pro odhad serverového skenování je připravený [lokální benchmark a kapacitní model](docs/scan-benchmark.md). `npm run benchmark:scan` změří současný HTML skener na kontrolovaných stránkách. Nejde o měření účtovaného CPU času Cloudflare ani o serverový skener dostupný ve webové aplikaci.

```sh
npm run format:check
npm run build
npx playwright install chromium
npm test
npm run test:api
npm run test:crawler
npm run test:scan-log
npm run test:fetch-result
npm run test:extension
npm run test:prototype
npm run deploy:check
```

Playwright ověřuje desktop i mobil nad produkčním buildem; na macOS používá nainstalovaný Google Chrome, jinde Chromium. Testy pokrývají mapu a detail, zoom a posun, klávesnici, externí cíle, filtrovaný export, simulaci i živý datový adaptér a webové ovládání. `npm test` si build připraví a spustí vlastní preview server. `DEMO_BASE_URL` umožňuje ověřit nasazenou verzi.

`test:api` spouští skutečný Worker a D1 v Miniflare a ověřuje vlastnictví, párování, idempotenci, přidání webu, limity a retenci. `test:extension` používá skutečné rozšíření v izolovaném Chromiu a kontrolované weby bez CORS; testuje robots, intervaly, obnovu outboxu, metadata a odmítnuté cíle. `test:prototype` propojuje web bez rozšíření se skutečným Workerem, frontou a D1: ověřuje vytvoření mapy, přidání webu, pauzu, reload a zastavení na 1 000 stránkách. `test:crawler` prověřuje síťová pravidla, trvalou frontu, duplicity a ochranné limity. Testy rozšíření vyžadují předchozí build a volné porty 8897 a 8901; používají oddělené `build/extension-test`, nezasahují do osobního profilu Chrome ani lokálního prototypu na portu 8797.

## Cloudflare deploy

Hosting: Workers Static Assets a API Worker `vizlinx-com` (název Workeru nepovoluje tečku), databáze D1 `vizlinx-scans`. Konfigurace v [wrangler.jsonc](wrangler.jsonc) směruje `vizlinx.com` a `www.vizlinx.com` na stejnou aplikaci. API pod `/api/v1` přijímá ovládání mapy; fronta `vizlinx-com-crawl` stahuje povolené weby v malých úlohách a do D1 ukládá pouze strukturované výsledky. Web má zakázanou indexaci přes `X-Robots-Tag`.

Do ignorovaného `.env` patří `CLOUDFLARE_API_TOKEN` podle [.env.example](.env.example). Token musí umožňovat nasazení Workers, **Account → D1 → Edit**, **Account → Queues → Edit** a správu vlastních domén pro cílový účet a zónu. Klíč se používá pouze pro nasazení; není součástí aplikace ani assets. Skutečný `.env` udržujte v hlavním projektovém adresáři, mimo dočasné worktrees.

Produkční databáze `vizlinx-scans` je vytvořená v regionu WEUR a její `database_id` je v konfiguraci. Prototyp běží na [vizlinx.com/scan](https://vizlinx.com/scan). `npm run deploy` připraví web i ZIP rozšíření, aplikuje vzdálené migrace a teprve potom nasadí Worker.

`preview_database_id` zachovává původní nulové ID lokální databáze, aby připojení produkce nezměnilo lokální mapy. Příkazy `dev:api` a `db:local` používají tuto lokální identitu; `db:remote` a deploy používají skutečné produkční `database_id`. Nulové preview ID není vzdálená databáze pro `--preview` či `dev --remote`. Po změně konfigurace regenerujte typy příkazem `npm run typegen`.

```sh
npm run deploy
```

GitHub Actions kontroluje PR a po změně `main` aplikuje D1 migrace a nasadí ověřený build. Vyžaduje repository secret `CLOUDFLARE_API_TOKEN` se stejnými D1 a Queues oprávněními; PR buildy tento secret nepoužívají. Ruční nasazení umožňuje prohlížet změnu před sloučením PR. Další merge na `main` nasadí příslušný ověřený commit.

Podklady: [Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/get-started/), [vlastní domény](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/).

## Dokumentace a práce

- [Technická dokumentace](docs/README.md) — reference po vrstvách (backend, frontend, D1, deploy, testy) a schválená rozhodnutí, verzované s kódem.
- [Technická specifikace](docs/technical-specification.md) — původní architektonický návrh, datový model a ověření.
- [Původní lokální skenování](docs/decisions/browser-side-crawling.md) — historické rozhodnutí nahrazené serverovým během.
- [Úkoly a bugy](https://github.com/vachekcz/vizlinx.com/issues) — zadání a stav práce.
- [Wiki](https://github.com/vachekcz/vizlinx.com/wiki) — [produktové zadání](https://github.com/vachekcz/vizlinx.com/wiki/Produktove-zadani), [historie změn](https://github.com/vachekcz/vizlinx.com/wiki/History), názvy a domény a archiv podkladů.
- [Pravidla práce](AGENTS.md) — konvence a dokončení úkolů.

Technickou referenci a příslušné rozhodnutí měň ve stejném PR jako kód. Pro běžný vývoj, build a testy není potřeba klon wiki.
