# Lokální skener pro Chrome

Prototyp načítá statické HTML z počítače uživatele. Ukládá strukturované odkazy do mapy Vizlinx. Nespouští JavaScript cílového webu, nenačítá jeho obrázky ani další zdroje a neposílá jeho cookies. Přesměrování nenásleduje; konečný host musí uživatel přidat jako samostatný origin.

## Instalace prototypu

1. Stáhněte a rozbalte [produkční ZIP](https://vizlinx.com/downloads/vizlinx-extension.zip).
2. V Chrome otevřete `chrome://extensions`, zapněte **Režim pro vývojáře** a klikněte na **Načíst rozbalené**. Vyberte složku s `manifest.json`.
3. Na [vizlinx.com/scan](https://vizlinx.com/scan) založte mapu a klikněte na připojení rozšíření.
4. V kartě skeneru klikněte na **Povolit domény a spustit** a potvrďte přístup k vybraným hostům. Po dobu skenu ponechte kartu otevřenou.

Rozšíření není publikované v Chrome Web Store. Pro aktualizaci rozbalte nové sestavení a na stránce rozšíření klikněte na načtení znovu. Nepoužíváme vzdálený kód ani automatickou instalaci do profilu uživatele.

Fronta i právě odesílaný výsledek zůstávají v lokálním úložišti rozšíření. Po zavření karty ji otevřete ikonou rozšíření a klikněte na pokračování. Při výslovném pozastavení nejdříve obnovte sken v mapě. Opakované odeslání stejného výsledku je idempotentní. V jednu chvíli může běžet jedna karta skeneru; intervaly hostů zůstávají zachované i mezi různými mapami. Párovací oprávnění vyprší po 24 hodinách; nové párování ze stejné mapy obnoví spojení. Odinstalace smaže lokální frontu; opětovné párování ji obnoví ze strukturovaných výsledků na serveru.

## Rozsah a omezení

Nejvýše 3 přesné veřejné HTTP(S) originy na standardním portu, nejvýše 50 stránek na origin, dokument do 2 MB a interval alespoň 1 sekunda. Cizí nalezené cíle jsou viditelné v mapě, ale skener je nestahuje. `robots.txt` respektuje Disallow a Crawl-delay pro `*`, protože fetch používá User-Agent prohlížeče; chybějící soubor (4xx kromě 429) umožňuje sken, nedostupnost/5xx/429/přesměrování jej uzavřou. HTTP 429 na stránce zastaví další požadavky do daného originu; po dokončení ostatních originů sken zůstane pozastavený. Limity odkazů a velikosti výsledku jsou označené jako zkrácení. Nejde o DNS firewall: veřejné jméno může změnit IP adresu; ochrana před DNS rebindingem není tímto prototypem zaručena.

## Vývoj a ověření

`node scripts/build-extension.mjs` vytvoří produkční `build/extension`, ZIP do `dist/downloads` a samostatnou `build/extension-dev`. Pouze vývojové sestavení přijímá párování z `http://127.0.0.1:8797` a `http://localhost:8797`. Chrome match patterns neumějí omezit port oprávnění; service worker port a přesný origin vždy kontroluje. Produkční bridge přijímá pouze `https://vizlinx.com` a `https://www.vizlinx.com`.

Pro lokální test načtěte `build/extension-dev`; v Chrome se jmenuje **Vizlinx Local Scanner (development)**. Pokud jste nainstalovali produkční ZIP, nejdříve odeberte původní rozšíření, načtěte vývojovou složku a obnovte lokální stránku. Mapa uložená na webu tím nezanikne. Lokální instalační panel záměrně nenabízí produkční ZIP. Samotné otevření ikony rozšíření mapu nespáruje: v její webové stránce klikněte na **Otevřít skenovací kartu**.

`node scripts/test-extension.mjs` používá skutečné rozšíření v izolovaném profilu Chromium dodaného Playwrightem a kontrolované HTTP fixtures bez CORS. Neinstaluje rozšíření do osobního profilu. Fixtures potřebují volný lokální porty 8797 a 8801; Chromium mapuje pouze testovací veřejná jména na loopback a port fixture serveru.
