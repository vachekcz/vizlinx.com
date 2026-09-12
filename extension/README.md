# Lokální skener pro Chrome

Prototyp načítá statické HTML z počítače uživatele. Ukládá strukturované odkazy do mapy Vizlinx. Nespouští JavaScript cílového webu, nenačítá jeho obrázky ani další zdroje a neposílá jeho cookies. Přesměrování nenásleduje; konečný host musí uživatel přidat jako samostatný origin.

## Instalace prototypu

1. Stáhněte a rozbalte [produkční ZIP](https://vizlinx.com/downloads/vizlinx-extension.zip).
2. V Chrome otevřete `chrome://extensions`, zapněte **Režim pro vývojáře** a klikněte na **Načíst rozbalené**. Vyberte složku s `manifest.json`.
3. Na [vizlinx.com/scan](https://vizlinx.com/scan) založte mapu a klikněte na připojení rozšíření.
4. V kartě skeneru klikněte na **Povolit domény a spustit** a potvrďte přístup k vybraným hostům. Po dobu skenu ponechte kartu otevřenou.

Rozšíření není publikované v Chrome Web Store. Pro aktualizaci rozbalte nové sestavení a na stránce rozšíření klikněte na načtení znovu. Nepoužíváme vzdálený kód ani automatickou instalaci do profilu uživatele.

Přidávání webů vyžaduje aktuální rozšíření s párovacím protokolem 2. Pokud web vyzve k aktualizaci, otevřete `chrome://extensions` a u rozšíření klikněte na **Načíst znovu**. Při instalaci ze ZIPu předtím nahraďte soubory novým sestavením. Potom na webu znovu ověřte připojení.

Fronta i právě odesílaný výsledek zůstávají v lokálním úložišti rozšíření. Po zavření karty ji otevřete ikonou rozšíření a klikněte na pokračování. Při výslovném pozastavení nejdříve obnovte sken v mapě. Opakované odeslání stejného výsledku je idempotentní. V jednu chvíli může běžet jedna karta skeneru; intervaly hostů zůstávají zachované i mezi různými mapami. Párovací oprávnění vyprší po 24 hodinách; nové párování ze stejné mapy obnoví spojení. Odinstalace smaže lokální frontu; opětovné párování ji obnoví ze strukturovaných výsledků na serveru.

## Přidání webu do existující mapy

V mapě klikněte na **Přidat web**, vyplňte **Nový web** a potvrďte **Přidat do mapy**. Mapa může obsahovat nejvýše tři schválené originy. Přidání zachová dosavadní výsledky a pozastaví sken, aby se změněný rozsah znovu potvrdil.

Klikněte na **Pokračovat v rozšíření**. Nová karta zobrazí celý aktuální seznam domén; teprve tlačítkem **Povolit domény a spustit** povolíte jejich načítání. Platí to i pro host, ke kterému už Chrome udělil oprávnění v jiné mapě. Skener doplní frontu o nový seed a dříve nalezené odkazy do přidaného webu. Hotové stránky znovu nenačítá. Rozpracovaný výsledek převezme z uložené fronty i při změně spojení během načítání.

Pokud připojení čeká na jinou aktivní mapu, nejdříve pozastavte její skenovací kartu a připojení zopakujte.

## Rozsah a omezení

Nejvýše 3 přesné veřejné HTTP(S) originy na standardním portu, nejvýše 50 stránek na origin, dokument do 2 MB a interval alespoň 1 sekunda. Cizí nalezené cíle jsou viditelné v mapě, ale skener je nestahuje. `robots.txt` respektuje Disallow a Crawl-delay pro `*`, protože fetch používá User-Agent prohlížeče; chybějící soubor (4xx kromě 429) umožňuje sken, nedostupnost/5xx/429/přesměrování jej uzavřou. HTTP 429 na stránce zastaví další požadavky do daného originu; po dokončení ostatních originů sken zůstane pozastavený. Limity odkazů a velikosti výsledku jsou označené jako zkrácení. Nejde o DNS firewall: veřejné jméno může změnit IP adresu; ochrana před DNS rebindingem není tímto prototypem zaručena.

## Vývoj a ověření

`node scripts/build-extension.mjs` vytvoří produkční `build/extension`, ZIP do `dist/downloads` a samostatnou `build/extension-dev`. Pouze vývojové sestavení přijímá párování z `http://127.0.0.1:8797` a `http://localhost:8797`. Chrome match patterns neumějí omezit port oprávnění; service worker port a přesný origin vždy kontroluje. Produkční bridge přijímá pouze `https://vizlinx.com` a `https://www.vizlinx.com`.

Pro lokální test načtěte `build/extension-dev`; v Chrome se jmenuje **Vizlinx Local Scanner (development)**. Pokud jste nainstalovali produkční ZIP, nejdříve odeberte původní rozšíření, načtěte vývojovou složku a obnovte lokální stránku. Mapa uložená na webu tím nezanikne. Lokální instalační panel záměrně nenabízí produkční ZIP. Samotné otevření ikony rozšíření mapu nespáruje: v její webové stránce klikněte na **Otevřít skenovací kartu**.

Po `npm run build` spusťte postupně `node scripts/test-extension.mjs` a `node scripts/test-prototype.mjs`. Používají skutečné rozšíření v izolovaném profilu Chromium dodaného Playwrightem a kontrolované HTTP fixtures bez CORS. Druhý test propojí skutečné UI, Worker a D1 a ověří také přidání webu, uložený výsledek během nového párování a obnovení mapy.

Testy si připraví vlastní `build/extension-test`, jehož lokální bridge přijímá pouze port **8897**. Fixture server používá **8901** a Chromium mapuje testovací veřejná jména na jeho loopback adresu. Oba porty musejí být volné; testy spouštějte postupně. Běžného vývojového serveru na 8797 ani osobního profilu Chrome se nedotýkají. Produkční a běžné vývojové sestavení testovací port nepovolují.
