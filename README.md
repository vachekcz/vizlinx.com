# Vizlinx.com

**See how websites connect.**

Interaktivní mapa odkazů mezi weby. Návštěvník bez účtu zadá domény, nastaví rychlost každé z nich a spustí skenování ze svého prohlížeče. Výsledky se průběžně ukládají na server. Oddálený pohled ukazuje domény jako clustery; přiblížení odhalí konkrétní zdrojové a cílové stránky.

## Stav

Grafické demo doplňuje **první funkční prototyp na `/scan`**: zadání webů, skener v rozšíření pro Chrome, průběžné ukládání do Cloudflare D1 a skutečné odkazy v současné mapě. Prototyp je určený k ověření vlastních a kontrolovaných webů; rozšíření se zatím instaluje ručně.

Úvodní `/` zůstává grafickým demem. Pět ukázkových webů, jeden neprozkoumaný externí cíl a 53 směrových vazeb tvoří fiktivní ekosystém Studia Atlas. Doména `index.example` obsahuje 20 stránek; ostatní prozkoumané weby po šesti. Tato ukázka používá pouze lokální data.

**Živé demo:** [vizlinx.com](https://vizlinx.com), také [www.vizlinx.com](https://www.vizlinx.com). Záložní adresa: [vizlinx-com.pvpvpv.workers.dev](https://vizlinx-com.pvpvpv.workers.dev).

**Vzhled:** Signal pro denní režim, Midnight pro noční. Přepínač měsíce/slunce v hlavičce ukládá ruční volbu v prohlížeči; bez ní vzhled sleduje nastavení systému. [Denní demo](https://vizlinx.com/?theme=signal), [noční demo s 20 stránkami](https://vizlinx.com/?theme=midnight&detail=index). [Původních pět mockupů](https://vizlinx.com/palettes/) zůstává jako archiv návrhů.

**Vybrané spojnice: Hedvábí (Silk).** Výchozí mapa používá stejně tenké čáry pro 1–5 vazeb a postupně rostoucí svazky pro `5+`, `10+`, `25+`, `50+` a `100+`. [Ukázka silných vazeb](https://vizlinx.com/?density=scale) obsahuje 230 unikátních dvojic stránek, nejsilnější propojení má 120 vazeb. [Samostatná studie spojnic](https://vizlinx.com/connections/lab/) a [archiv osmi návrhů](https://vizlinx.com/connections/) zůstávají dostupné; výběr experimentálních stylů se zobrazí jen při otevření konkrétního návrhu z archivu.

Vizuální směr a základní ovládání byly potvrzené. Funkční prototyp z nich vychází; [aktuální rozsah a kontrakt](docs/tasks/local-scan-prototype.md) upřesňují širší [produktové zadání](docs/product-specification.md).

## Spuštění

Node.js 24+, npm.

```sh
npm ci
npm run dev
```

Lokální demo: http://127.0.0.1:5173. Pro lokální prohlížení není potřeba `.env`.

### Funkční prototyp lokálně

```sh
npm run build
npm run db:local
npm run dev:api
```

Otevřete http://127.0.0.1:8797/scan. V `chrome://extensions` zapněte režim pro vývojáře a načtěte složku `build/extension-dev`. Vývojové sestavení má povolený lokální bridge; produkční ZIP je určený pro vizlinx.com. Pro lokální D1 a Worker není potřeba produkční token. Vite samotný poskytuje pouze frontend, nikoli API.

Zadejte 1–3 přesné veřejné originy. Po vytvoření mapy otevřete skenovací kartu a kliknutím povolte vybrané weby. Karta musí zůstat otevřená. Výsledky průběžně přibývají do mapy; ovládání webu umožňuje změnit interval, pauzu a limit stránek. Po zavření lze kartu znovu otevřít přes ikonu rozšíření, případně ji znovu spárovat z mapy. [Podrobný návod rozšíření](extension/README.md).

Při dosažení limitu stránek lze v detailu webu zvýšit limit až na 50 a pokračovat přes rozšíření. Odmítnutý výsledek zůstává uložený v rozšíření i po zavření karty; znovu se odešle až po zvýšení limitu, bez opakovaného načítání stránky. Vyčerpaná úložná kapacita mapy vyžaduje novou mapu.

Do existující mapy lze přes **Přidat web** doplnit další origin až do celkového limitu tří. Zůstávají stejné ID mapy, uložené výsledky i ručně posunuté bubliny. Přidání pozastaví sken a zneplatní staré párování; následně zvolte **Pokračovat v rozšíření** a v kartě skeneru potvrďte přístup. Fronta využije nový seed i dříve nalezené odkazy na přidaný web, již dokončené stránky znovu neprochází. Po aktualizaci kódu načtěte rozšíření znovu v `chrome://extensions`; web upozorní na nekompatibilní starší verzi.

Prototyp prochází nejvýše 50 stránek na origin (výchozí 20), čte statické HTML do 2 MiB, bez cookies a následování přesměrování. Cíle mimo schválené originy uloží jako známé odkazy, ale nenavštíví. Mapa ukazuje nejvýše 10 externích clusterů a 60 karet v jednom clusteru; tabulka a CSV obsahují všechny uložené vazby. Mapy se uchovávají nejvýše 30 dní od založení a patří anonymní relaci stejného prohlížeče. Samotné předání URL mapy nezpřístupní data dalším lidem.

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
npm run test:extension
npm run test:prototype
npm run deploy:check
```

Playwright ověřuje desktop i mobil nad produkčním buildem; na macOS používá nainstalovaný Google Chrome, jinde Chromium. Testy pokrývají mapu a detail, zoom a posun, klávesnici, externí cíle, filtrovaný export, simulaci i živý datový adaptér a webové ovládání. `npm test` si build připraví a spustí vlastní preview server. `DEMO_BASE_URL` umožňuje ověřit nasazenou verzi.

`test:api` spouští skutečný Worker a D1 v Miniflare a ověřuje vlastnictví, párování, idempotenci, přidání webu, limity a retenci. `test:extension` používá skutečné rozšíření v izolovaném Chromiu a kontrolované weby bez CORS; testuje robots, intervaly, obnovu outboxu, metadata a odmítnuté cíle. `test:prototype` propojuje web, rozšíření a skutečné API/D1 do jednoho průchodu včetně přidání domény a pokračování. Testy rozšíření vyžadují předchozí build a volné porty 8897 a 8901; používají oddělené `build/extension-test`, nezasahují do osobního profilu Chrome ani lokálního prototypu na portu 8797.

## Cloudflare deploy

Hosting: Workers Static Assets a API Worker `vizlinx-com` (název Workeru nepovoluje tečku), databáze D1 `vizlinx-scans`. Konfigurace v [wrangler.jsonc](wrangler.jsonc) směruje `vizlinx.com` a `www.vizlinx.com` na stejnou aplikaci. API pod `/api/v1` ukládá pouze strukturované výsledky; server nestahuje skenované weby. Web má zakázanou indexaci přes `X-Robots-Tag`.

Do ignorovaného `.env` patří `CLOUDFLARE_API_TOKEN` podle [.env.example](.env.example). Token musí umožňovat nasazení Workers, **Account → D1 → Edit** a správu vlastních domén pro cílový účet a zónu. Klíč se používá pouze pro nasazení; není součástí aplikace ani assets. Skutečný `.env` udržujte v hlavním projektovém adresáři, mimo dočasné worktrees.

Produkční databáze `vizlinx-scans` je vytvořená v regionu WEUR a její `database_id` je v konfiguraci. Prototyp běží na [vizlinx.com/scan](https://vizlinx.com/scan). `npm run deploy` připraví web i ZIP rozšíření, aplikuje vzdálené migrace a teprve potom nasadí Worker.

`preview_database_id` zachovává původní nulové ID lokální databáze, aby připojení produkce nezměnilo lokální mapy. Příkazy `dev:api` a `db:local` používají tuto lokální identitu; `db:remote` a deploy používají skutečné produkční `database_id`. Nulové preview ID není vzdálená databáze pro `--preview` či `dev --remote`. Po změně konfigurace regenerujte typy příkazem `npm run typegen`.

```sh
npm run deploy
```

GitHub Actions kontroluje PR a po změně `main` aplikuje D1 migrace a nasadí ověřený build. Vyžaduje repository secret `CLOUDFLARE_API_TOKEN` se stejnými D1 oprávněními; PR buildy tento secret nepoužívají. Ruční nasazení umožňuje prohlížet změnu před sloučením PR. Další merge na `main` nasadí příslušný ověřený commit.

Podklady: [Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/get-started/), [vlastní domény](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/).

## Dokumentace

- [Produktové zadání](docs/product-specification.md) — průchod uživatele, skenování, vizualizace a kritéria přijetí.
- [Technická specifikace](docs/technical-specification.md) — architektura, lokální skener, datový model, API a ověření.
- [Lokální skenování](docs/decisions/browser-side-crawling.md) — potvrzené umístění exekuce a důvody.
- [Názvy a domény](docs/naming.md) — výběr Vizlinx.com a historie nápadů.

Dokumentace produktu a technická rozhodnutí se udržují v tomto repozitáři.
