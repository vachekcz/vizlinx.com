---
type: note
created: 2026-09-10
last_updated: 2026-09-12
---

# Vizlinx.com — produktové zadání

Zadání pro [Vizlinx.com](../README.md), rozpracované z Pavlova původního nápadu a upřesnění 2026-09-11. Implementační návrh je v [technické specifikaci](technical-specification.md).

## Produkt jednou větou

Uživatel zadá několik webů a uvidí interaktivní mapu toho, ze které konkrétní stránky jednoho webu vede odkaz na kterou stránku druhého. Weby prochází jeho počítač, výsledky se průběžně ukládají na server Vizlinx.

## Potvrzené požadavky

- **Vstup bez účtu:** návštěvník nepotřebuje registraci ani e-mail; zadá domény a může zahájit skenování.
- **Lokální exekuce:** požadavky na skenované weby odcházejí z jeho prohlížeče a připojení. Server Vizlinx neskenuje cílové weby.
- **Rychlost po doménách:** každá zadaná doména má vlastní nastavení rychlosti.
- **Odkazy po stránkách:** pro každou prozkoumanou stránku zaznamenat, kam z ní vedou odkazy.
- **Serverová data:** výsledky ukládat na server, aby šly načítat do vizualizace i po skončení skenu.
- **Domény jako clustery:** oddálený pohled ukazuje weby a vazby mezi nimi; přiblížení odhalí konkrétní propojené stránky.
- **Jméno:** Vizlinx.com, doména koupena Pavlem 2026-09-11.

Důvod lokálního skenování: požadavky všech návštěvníků se nesoustřeďují na jednu serverovou IP. Není to záruka proti blokaci; cílový web může omezit i návštěvníkovo připojení.

## První milník: grafické demo

Pavel 2026-09-11 určil pořadí práce: nejprve vytvořit a doladit grafické demo, potom na jeho základě implementovat funkce produktu. Cílem je ověřit vizuální podobu a srozumitelnost mapy přímo v prohlížeči.

Demo používá pevná ukázková data a lokální stav. Nevyžaduje backend, účet, rozšíření ani skutečné skenování. Je viditelně označené jako demo; případný průběh skenu je simulovaný. Následující požadavky na skenování a ukládání popisují až funkční produkt.

Rozsah dema:

- Hlavní obrazovka s dominantní mapou, seznamem domén vlevo a detailem výběru vpravo.
- Vizuální styl: typografie, barvy domén, směrové spojnice, stavy výběru a čitelnost popisků.
- Ukázková síť několika domén s konkrétními stránkami a odkazy; zahrnuje obousměrné vazby i neprozkoumaný externí cíl.
- Posun a zoom mapy, rozbalení domén na stránky, výběr domény či propojení a návrat do přehledu.
- Náhled ovládání skenu a jeho stavů, který pomůže doladit rozložení budoucí aplikace.

Demo je připravené k navazující implementaci, když:

1. Lze ho spustit v prohlížeči a projít od přehledu domén ke konkrétní zdrojové a cílové URL pouze na ukázkových datech.
2. Je zřejmý směr vazeb, příslušnost stránek k doménám a rozdíl mezi vybraným a nevybraným prvkem.
3. Mapa, seznam i detail ukazují vzájemně konzistentní data a při interakci zůstávají čitelné.
4. Pavel potvrdí vizuální směr a základní ovládání; z nich vyjdou další etapy. Demo samo nepotvrzuje proveditelnost skeneru ani výkon na velkých datech.

## Technická podmínka a navržené řešení

Běžná webová stránka nemůže číst HTML libovolného cizího webu bez jeho CORS povolení. Navržená realizace je **web Vizlinx + malé rozšíření do prohlížeče**, které po povolení vybraných domén provádí skenování lokálně. Podklady a alternativy jsou v [technické specifikaci](technical-specification.md#proveditelnost-v-prohlížeči).

Pavel 2026-09-12 odsouhlasil rozšíření pro Chrome v prvním funkčním prototypu. Veřejná distribuce a přijatelnost instalace pro širší publikum zůstávají otevřené. Čistý web bez instalace by vyžadoval omezení na weby s povoleným CORS nebo jinou změnu zadání.

### Aktuální funkční prototyp

Navazuje na schválený Signal/Midnight, spojnice Silk a rozbalování domén na jejich současné pozici. Na `/scan` lze založit anonymní mapu a spárovat ručně instalované rozšíření. Skener načítá statické HTML z počítače návštěvníka, průběžně ukládá výsledky a současná mapa z nich zobrazuje skutečné vazby.

Pro tento milník platí menší rozsah než níže navržené MVP: 3 přesné originy, 50 stránek na origin (výchozí 20), interval 1–60 sekund, jeden aktivní skener a jeden síťový požadavek současně. Mapa se uchovává 30 dní od založení; přístup závisí také na platné anonymní relaci. Cluster odpovídá přesnému originu, bez slučování subdomén přes PSL. Přesměrování se nenásledují. Mapa omezuje počet externích clusterů a karet, úplná uložená data zůstávají v tabulce a CSV. Konkrétní kontrakt a hranice jsou v [task dokumentu](tasks/local-scan-prototype.md).

Následující širší návrhy (větší limity, sdílení, změna rozsahu existující mapy a pokročilejší scheduler) nejsou tvrzením o hotové implementaci prototypu.

## Průchod uživatele

1. **Otevře Vizlinx.com.** Vidí vstup pro seznam domén a ukázkovou mapu. Registrace se nezobrazuje.
2. **Vloží weby.** Jedna URL či doména na řádek. Aplikace odstraní duplicity a ukáže, které konkrétní hosty bude procházet.
3. **Nastaví rychlost.** Každý web má vlastní interval, limit stránek a ovládání pauzy. Všechny hodnoty mají rozumný výchozí stav.
4. **Spustí sken.** Pokud chybí rozšíření, aplikace vysvětlí jeho účel a zachová rozepsané domény během instalace. Rozšíření si vyžádá přístup ke zvoleným hostům.
5. **Potvrdí lokální běh.** Před prvním požadavkem vidí „Skenování používá vaše připojení. Nalezené odkazy se ukládají do vaší mapy na Vizlinx.“
6. **Sleduje mapu.** Výsledky přibývají během skenování. U jednotlivých webů vidí počet zpracovaných a čekajících stránek, rychlost a chyby.
7. **Zkoumá vazby.** Přiblíží cluster, vybere dvě domény nebo rozklikne spojnici. Dostane konkrétní zdrojové a cílové URL.
8. **Přeruší nebo dokončí běh.** Mapu lze prohlížet i po zastavení. Ve stejném prohlížeči lze znovu otevřít uložený projekt a navázat na nedokončenou frontu.

Návrh pro MVP: skener běží ve vlastní otevřené kartě rozšíření. Uživatel vidí, že tato karta musí zůstat otevřená. Zavření karty nebo prohlížeče běh přeruší; uspaný počítač není běžící skener.

## Co znamená web, stránka a odkaz

- **Web / cluster:** výchozí skupina podle registrovatelné domény, například `firma.cz`. Subdomény se mohou vizuálně sdružovat, ale oprávnění k jejich skenování se povolují jednotlivě. Více zákaznických webů na sdíleném hostingu nesmí splynout do jednoho clusteru.
- **Skenovaný rozsah:** konkrétní schválené hosty. Zadání `firma.cz` automaticky nepovolí všechny její subdomény.
- **Stránka:** konkrétní HTTP(S) URL. Uzel může být pouze známým cílem odkazu, i když jeho obsah zatím nikdo nenačetl.
- **Odkaz:** směrová vazba ze zdrojové stránky na cílovou URL. A → B neznamená B → A.
- **Interní odkaz:** vede uvnitř stejného clusteru; pomáhá objevovat stránky. Do fronty se zařadí jen při shodě se schváleným rozsahem.
- **Externí odkaz:** vede do jiného clusteru. Uloží se i tehdy, když cílovou doménu uživatel nezadal.

Příklad:

```text
firma.cz/partneri → partner.com/integrace
magazin.cz/clanky/recenze → firma.cz/produkt
firma.cz/blog/clanek → dalsi-web.cz/zdroj
```

Pokud uživatel zadal jen první tři weby, odkaz na `dalsi-web.cz` se také uloží. Tento web se ale nezačne sám skenovat. Uživatel ho může později přidat a povolit.

## Obrazovka skenování

Vlevo seznam webů a ovládání, uprostřed mapa, vpravo detail vybraného webu, stránky nebo propojení.

U každé domény:

- Stav: čeká na povolení, skenuje, pozastaveno, čeká po omezení, přerušeno, dokončeno nebo dosažen limit.
- Interval mezi požadavky a možnost ho za běhu změnit.
- Počet prozkoumaných stránek, čekajících URL a chyb.
- Počet unikátních externích vazeb a cílových domén.
- Samostatná pauza / pokračování.

Globálně: pauza všech webů, pokračování, stav spojení se serverem a počet dosud neuložených výsledků. Nezobrazovat procento dokončení celého webu, pokud celkový počet stránek není známý.

### Navržené výchozí hodnoty MVP

Jde o produktové návrhy k ověření, nikoli o Pavlem zadané limity.

| Nastavení | Návrh |
| --- | --- |
| Počet zadaných domén | Nejvýše 10 na sken |
| Limit stránek | 500 na doménu |
| Interval | 3 sekundy mezi začátky požadavků na doménu |
| Nastavitelný interval | 1–60 sekund |
| Souběh | Nejvýše 1 požadavek na doménu, 3 celkem |
| Uložení anonymní mapy | 30 dní od posledního použití |

Limit se týká skutečného procházení, nikoli pouze vykreslení mapy. Crawlerové pasti nebo rozsáhlé filtry nesmějí vytvořit nekonečný sken.

## Vizualizace

### Přehled domén

Každá vybraná doména tvoří označený cluster. Spojnice mají směr. Jejich síla vyjadřuje počet unikátních dvojic zdrojová a cílová stránka v daném směru.

Výchozí mapa ukazuje vazby mezi zadanými doménami. Přepínač „Další odkazované weby“ zobrazí i objevené cílové domény; ty jsou odlišené jako neprozkoumané. U velkého počtu cílů zůstává úplný seznam v tabulce a mapa jasně uvádí, kolik prvků skrývá.

### Přiblížení na stránky

Přiblížením nebo kliknutím se rozbalí stránky zapojené do zobrazených vazeb mezi clustery. Doména zůstává rozpoznatelným obalem. Interní stránky bez těchto vazeb nejsou ve výchozím pohledu vykreslené.

Lze rozbalit dvě domény současně a ostatní potlačit. Pozice clusterů mají zůstávat stabilní při příchodu nových výsledků, aby mapa uživateli neujížděla.

### Detail propojení

Klik na spojnici ukáže:

- Zdrojovou a cílovou URL, text odkazu a atributy `rel`.
- Počet výskytů na stránce a orientační umístění: obsah, navigace, patička nebo nezjištěno.
- Čas zjištění a stav načtení zdrojové stránky.
- Zda je cílová stránka prozkoumaná, nebo pouze známá z odkazu.

Opakované odkazy se dají seskupit podle cíle, textu a umístění. Výsledky musí zachovat jednotlivé zdrojové stránky. Jeden odkaz v patičce 300 různých stránek je 300 dvojic stránek, ne jedna.

### Tabulka a export

Vyhledávání podle domény, URL a textu odkazu; filtry směru, `nofollow`, umístění a prozkoumanosti. CSV obsahuje zdrojovou i cílovou URL, text, atributy, počet výskytů a čas zjištění. Export musí odpovídat zvoleným filtrům.

## Úplnost a hranice výsledků

- **Statické HTML v MVP:** první verze čte odkazy obsažené v HTML odpovědi. Odkazy vytvořené až JavaScriptem nemusí najít; tato informace je viditelná u skenu.
- **Omezený rozsah:** „odkaz nenalezen“ znamená nenalezen v prozkoumaných stránkách, ne důkaz jeho neexistence.
- **Cíle mimo rozsah:** ukládá se cílová URL, její dostupnost se bez povoleného skenování neověřuje.
- **Respektování omezení:** při blokaci, CAPTCHA nebo přihlašovací stránce se zobrazí problém. Crawler nezkouší obcházet přístupové překážky.
- **Přerušený běh:** dosud uložené výsledky zůstávají použitelné. „Dokončeno“ znamená vyčerpanou známou frontu v daném rozsahu a limitech, ne prozkoumání celého internetu.

## Bez účtu, s návratem k výsledkům

Návrh: anonymní relace v prohlížeči vlastní své mapy. Návštěvník se ve stejném prohlížeči vrátí k uloženým výsledkům bez přihlášení. Samotná znalost URL mapy nedává ostatním lidem přístup.

Při smazání dat prohlížeče může přístup zaniknout; serverové uložení samo o sobě neobnovuje anonymní identitu. Před uplynutím doby uchování má uživatel možnost exportu. Přenesení mapy do účtu a sdílení s dalšími lidmi jsou rozšíření, nikoli podmínka prvního použití.

## Kritéria přijetí první funkční verze

1. Na kontrolních webech A, B a C se známými odkazy vzniknou správné směrové vazby mezi konkrétními stránkami.
2. Logy kontrolních webů potvrdí, že požadavky přicházejí z testovacího počítače a backend na ně žádné požadavky neposílá.
3. Změna rychlosti A ovlivní další požadavky na A; B pokračuje podle vlastního nastavení.
4. Odkaz na nezadané D se uloží a lze ho zobrazit, aniž by skener na D poslal požadavek.
5. Po pauze, zavření skenovací karty nebo ztrátě spojení nevznikají duplicitní hrany; po návratu lze pokračovat.
6. Opakované odeslání stejného výsledku nezmění počty vazeb.
7. Z neprozkoumané cílové URL se nestane „úspěšně načtená stránka“ pouhým nalezením odkazu.
8. Uživatel bez registrace dokončí celý průchod; jiná anonymní relace nemůže číst ani měnit jeho mapu.
9. Zoom ukáže stránky uvnitř domén a detail konkrétní vazby, přičemž větší výsledek zůstane dohledatelný v tabulce.
10. Blokace, limit, pouze statické HTML a dosud neuložené výsledky jsou rozlišitelné ve stavu skenu.

## Otevřené produktové otázky

- Jak distribuovat rozšíření a je jeho instalace přijatelná pro širší publikum? Pro prototyp je potvrzená.
- Stačí první verze pro desktopový Chrome a Edge? Mobil může zatím sloužit k prohlížení výsledků.
- Je hlavní případ kontrola vlastních webů, nebo průzkum cizích webů a konkurence?
- Stačí statické HTML, nebo je podpora webů s odkazy vytvořenými JavaScriptem podmínkou uvedení?
- Jsou navržené počty domén, limity stránek a doba uchování přiměřené?
- Je před uvedením nutné sdílení výsledků nebo obnova přístupu po ztrátě anonymní relace?

## Pozdější rozšíření

Porovnání opakovaných skenů, účet s převzetím anonymních map, sdílení pouze ke čtení, řízené vykreslení JavaScriptu a hledání skupin silně propojených domén.

Názvy a domény → [historie výběru názvu](naming.md).
