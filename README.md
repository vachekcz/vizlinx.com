# Vizlinx.com

**See how websites connect.**

Interaktivní mapa odkazů mezi weby. Návštěvník bez účtu zadá domény, nastaví rychlost každé z nich a spustí skenování ze svého prohlížeče. Výsledky se průběžně ukládají na server. Oddálený pohled ukazuje domény jako clustery; přiblížení odhalí konkrétní zdrojové a cílové stránky.

## Stav

První interaktivní grafické demo v Reactu a TypeScriptu. Pět ukázkových webů, jeden neprozkoumaný externí cíl a 53 směrových vazeb tvoří fiktivní ekosystém Studia Atlas. Doména `index.example` obsahuje 20 stránek; ostatní prozkoumané weby po šesti. Demo používá pouze lokální data; neprovádí skenování a výsledky neukládá na server.

**Živé demo:** [vizlinx.com](https://vizlinx.com), také [www.vizlinx.com](https://www.vizlinx.com). Záložní adresa: [vizlinx-com.pvpvpv.workers.dev](https://vizlinx-com.pvpvpv.workers.dev).

**Vzhled:** Signal pro denní režim, Midnight pro noční. Přepínač měsíce/slunce v hlavičce ukládá ruční volbu v prohlížeči; bez ní vzhled sleduje nastavení systému. [Denní demo](https://vizlinx.com/?theme=signal), [noční demo s 20 stránkami](https://vizlinx.com/?theme=midnight&detail=index). [Původních pět mockupů](https://vizlinx.com/palettes/) zůstává jako archiv návrhů.

**Vybrané spojnice: Hedvábí (Silk).** Výchozí mapa používá stejně tenké čáry pro 1–5 vazeb a postupně rostoucí svazky pro `5+`, `10+`, `25+`, `50+` a `100+`. [Ukázka silných vazeb](https://vizlinx.com/?density=scale) obsahuje 230 unikátních dvojic stránek, nejsilnější propojení má 120 vazeb. [Samostatná studie spojnic](https://vizlinx.com/connections/lab/) a [archiv osmi návrhů](https://vizlinx.com/connections/) zůstávají dostupné; výběr experimentálních stylů se zobrazí jen při otevření konkrétního návrhu z archivu.

**První milník je grafické demo:** interaktivní mapa s ukázkovými daty, na které doladíme vzhled, rozložení a ovládání. Z tohoto základu pak vyjde funkční aplikace. Skener, rozšíření a backend následují až po doladění dema. Rozsah a kritéria jsou v [produktovém zadání](docs/product-specification.md#první-milník-grafické-demo).

## Spuštění

Node.js 22.12+ (doporučená vývojová verze 24), npm.

```sh
npm ci
npm run dev
```

Lokální demo: http://127.0.0.1:5173. Pro lokální prohlížení není potřeba `.env`.

## Ovládání dema

- Klik na doménu otevře detail; dvojklik nebo „Prozkoumat stránky“ rozbalí její stránky. Tažení domény mění její polohu, tažení pozadí posouvá celou mapu. Po zaměření domény klávesou Tab ji posouvají šipky (Shift zvětší krok). Přehled obnoví výchozí rozložení.
- Klik na číslo nebo čáru propojení zobrazí směrové vazby. Výběr konkrétní vazby odhalí zdrojovou i cílovou URL a metadata.
- Mapa podporuje tažení, zoom kolečkem a tlačítky, automatické zobrazení stránek při přiblížení a návrat do přehledu. Uzly a vazby lze vybrat i klávesnicí.
- „Ukázka: 20 stránek“ otevře zvětšený cluster `index.example`. Karty jsou rozmístěné podle počtu stránek a velikosti obrazovky. Pohled ukazuje vazby této domény; výběr stránky zvýrazní její spojnice a ostatní ztlumí. „Přehled“ obnoví celou mapu.
- „Další odkazované weby“ zobrazí neprozkoumaný externí cíl; výchozí pohled obsahuje 51 vazeb mezi pěti zadanými weby.
- „Přehrát demo“ simuluje postupné objevování vazeb. Globální pauza, pauza webu v desktopovém seznamu a interval v detailu domény ovládají pouze tuto simulaci. Počet prozkoumaných stránek je pevná vlastnost ukázkové sady.
- Tabulka nabízí hledání, filtr `nofollow` a CSV export odpovídající viditelným filtrům. Obnovení stránky vrátí výchozí stav.

Malou pevnou mapu vykresluje SVG. Grafická knihovna ani výkon pro velké skutečné skeny tím nejsou definitivně rozhodnuté. Vzhled a ovládání čekají na produktové doladění.

## Ověření

```sh
npm run format:check
npm run build
npx playwright install chromium
npm test
npm run deploy:check
```

Playwright ověřuje desktop i mobil nad produkčním buildem; na macOS používá nainstalovaný Google Chrome, jinde Chromium. Testy pokrývají mapu a detail, zoom a posun, klávesnici, externí cíle, filtrovaný export a simulaci. `npm test` si build připraví a spustí vlastní preview server. `DEMO_BASE_URL` umožňuje stejnými testy ověřit nasazenou verzi.

## Cloudflare deploy

Hosting: Workers Static Assets, Worker `vizlinx-com` (název Workeru nepovoluje tečku). Konfigurace v [wrangler.jsonc](wrangler.jsonc) směruje `vizlinx.com` a `www.vizlinx.com` na stejný statický build. Demonstrační web má zakázanou indexaci přes `X-Robots-Tag`.

Do ignorovaného `.env` patří `CLOUDFLARE_API_TOKEN` podle [.env.example](.env.example). Token musí umožňovat nasazení Workers a správu jejich vlastních domén pro cílový účet a zónu. Klíč se používá pouze pro nasazení; není součástí aplikace ani assets. Skutečný `.env` udržujte v hlavním projektovém adresáři, mimo dočasné worktrees.

```sh
npm run deploy
```

GitHub Actions kontroluje PR a po změně `main` nasadí ověřený build. Vyžaduje repository secret `CLOUDFLARE_API_TOKEN`; PR buildy tento secret nepoužívají. První ruční nasazení umožňuje prohlížet demo před sloučením PR. Další merge na `main` nasadí příslušný ověřený commit.

Podklady: [Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/get-started/), [vlastní domény](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/).

## Dokumentace

- [Produktové zadání](docs/product-specification.md) — průchod uživatele, skenování, vizualizace a kritéria přijetí.
- [Technická specifikace](docs/technical-specification.md) — architektura, lokální skener, datový model, API a ověření.
- [Lokální skenování](docs/decisions/browser-side-crawling.md) — potvrzené umístění exekuce a důvody.
- [Názvy a domény](docs/naming.md) — výběr Vizlinx.com a historie nápadů.

Dokumentace produktu a technická rozhodnutí se udržují v tomto repozitáři.
