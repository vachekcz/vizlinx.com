# Vizlinx.com

**See how websites connect.**

Interaktivní mapa odkazů mezi weby. Návštěvník bez účtu zadá domény, nastaví rychlost každé z nich a spustí skenování na Cloudflare Workers, bez instalace rozšíření. Výsledky se průběžně ukládají na server. Oddálený pohled ukazuje domény jako clustery; přiblížení odhalí konkrétní zdrojové a cílové stránky.

## Stav

Grafické demo doplňuje **funkční serverový skener na `/scan`**: zadání webů, fronta Cloudflare Queues, průběžné ukládání do D1 a skutečné odkazy v současné mapě. Sken pokračuje i po zavření karty. Prochází statické veřejné HTML bez cookies a JavaScriptu, nejvýše **100 stránek na web**. [Aktuální kontrakt a ochranné limity](docs/tasks/server-scan-prototype.md).

Úvodní `/` zůstává grafickým demem. Pět ukázkových webů, jeden neprozkoumaný externí cíl a 53 směrových vazeb tvoří fiktivní ekosystém Studia Atlas. Doména `index.example` obsahuje 20 stránek; ostatní prozkoumané weby po šesti. Tato ukázka používá pouze lokální data.

**Živé demo:** [vizlinx.com](https://vizlinx.com), také [www.vizlinx.com](https://www.vizlinx.com). Záložní adresa: [vizlinx-com.pvpvpv.workers.dev](https://vizlinx-com.pvpvpv.workers.dev).

**Vzhled:** Signal pro denní režim, Midnight pro noční. Přepínač měsíce/slunce v hlavičce ukládá ruční volbu v prohlížeči; bez ní vzhled sleduje nastavení systému. [Denní demo](https://vizlinx.com/?theme=signal), [noční demo s 20 stránkami](https://vizlinx.com/?theme=midnight&detail=index). [Původních pět mockupů](https://vizlinx.com/palettes/) zůstává jako archiv návrhů.

**Vybrané spojnice: Hedvábí (Silk).** Výchozí mapa používá stejně tenké čáry pro 1–5 vazeb a postupně rostoucí svazky pro `5+`, `10+`, `25+`, `50+` a `100+`. [Ukázka silných vazeb](https://vizlinx.com/?density=scale) obsahuje 230 unikátních dvojic stránek, nejsilnější propojení má 120 vazeb. [Samostatná studie spojnic](https://vizlinx.com/connections/lab/) a [archiv osmi návrhů](https://vizlinx.com/connections/) zůstávají dostupné; výběr experimentálních stylů se zobrazí jen při otevření konkrétního návrhu z archivu.

Vizuální směr a základní ovládání byly potvrzené. Funkční prototyp z nich vychází; [aktuální rozsah a kontrakt](docs/tasks/server-scan-prototype.md) upřesňují širší [produktové zadání](docs/product-specification.md).

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

Pod ovládáním je stále vidět aktuální činnost, počet zpracovaných stránek a při běhu načítaná URL nebo čekání na další požadavek. **Průběh skenu** otevře uložený log: na počítači spodní panel, na mobilu přes celou obrazovku. Lze filtrovat web a chyby; při posunu do historie se automatické sledování zastaví. Log uchovává nejvýše 500 nejnovějších událostí po dobu platnosti mapy a obnovuje se při otevřeném panelu. Události starších skenů se zpětně nedoplňují.

Limit je pevně 100 stránek na origin včetně neúspěšných pokusů. Při dosažení se zobrazí výrazná hláška a výzva kontaktovat správce kvůli vyššímu limitu. Uživatelské API limit nezvýší. `ADMIN_EMAIL` ve Wrangler konfiguraci zapíná kontaktní tlačítko; prázdná hodnota ponechá textovou výzvu bez vymyšlené adresy. Denní nebo časový limit a zaplnění mapy mají vlastní důvod zastavení.

Skener respektuje robots.txt pro `VizlinxBot`, čte HTML do 2 MiB, neposílá cookies a nenásleduje přesměrování. Je potřeba zadat konečnou URL, včetně správného `www`. Externí cíle se zobrazí jako známé odkazy, ale neprocházejí se bez přidání originu. Mapa uchovává výsledky 30 dní od založení a patří anonymní relaci stejného prohlížeče. Samotné předání URL nezpřístupní mapu jiným lidem.

Stará data rozšíření zůstávají čitelná. Spuštění staré mapy přes web ji převede na serverový běh a zneplatní původní párování. Historický návod rozšíření je v [extension/README.md](extension/README.md).

## Ovládání dema

- Klik na doménu otevře detail; dvojklik nebo „Prozkoumat stránky“ rozbalí její stránky na stejné pozici. Okolní bubliny se podle potřeby odsunou a ruční posuny zůstanou zachované. Tažení domény mění její polohu, tažení pozadí posouvá celou mapu. Po zaměření domény klávesou Tab ji posouvají šipky (Shift zvětší krok). Přehled obnoví výchozí rozložení.
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
npm run test:extension
npm run test:prototype
npm run deploy:check
```

Playwright ověřuje desktop i mobil nad produkčním buildem; na macOS používá nainstalovaný Google Chrome, jinde Chromium. Testy pokrývají mapu a detail, zoom a posun, klávesnici, externí cíle, filtrovaný export, simulaci i živý datový adaptér a webové ovládání. `npm test` si build připraví a spustí vlastní preview server. `DEMO_BASE_URL` umožňuje ověřit nasazenou verzi.

`test:api` spouští skutečný Worker a D1 v Miniflare a ověřuje vlastnictví, párování, idempotenci, přidání webu, limity a retenci. `test:extension` používá skutečné rozšíření v izolovaném Chromiu a kontrolované weby bez CORS; testuje robots, intervaly, obnovu outboxu, metadata a odmítnuté cíle. `test:prototype` propojuje web bez rozšíření se skutečným Workerem, frontou a D1: ověřuje vytvoření mapy, přidání webu, pauzu, reload a zastavení na 100 stránkách. `test:crawler` prověřuje síťová pravidla, trvalou frontu, duplicity a ochranné limity. Testy rozšíření vyžadují předchozí build a volné porty 8897 a 8901; používají oddělené `build/extension-test`, nezasahují do osobního profilu Chrome ani lokálního prototypu na portu 8797.

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

## Dokumentace

- [Produktové zadání](docs/product-specification.md) — průchod uživatele, skenování, vizualizace a kritéria přijetí.
- [Technická specifikace](docs/technical-specification.md) — architektura, lokální skener, datový model, API a ověření.
- [Serverové skenování](docs/tasks/server-scan-prototype.md) — aktuální kontrakt a provozní omezení.
- [Původní lokální skenování](docs/decisions/browser-side-crawling.md) — historické rozhodnutí nahrazené serverovým během.
- [Názvy a domény](docs/naming.md) — výběr Vizlinx.com a historie nápadů.

Dokumentace produktu a technická rozhodnutí se udržují v tomto repozitáři.
