# Konvence referenční dokumentace

Pravidla pro číslované referenční docs v `docs/` (`01-backend.md`,
`02-frontend.md`, …). Reference popisuje, **jak to je teď** — historie práce
(tasky, bugy) žije jinde a řídí se vlastními pravidly.

Zdroj: bundle `project-docs` v dev-template — změny pravidel dělej tam a šiř
sem, ne obráceně.

## Sloty

Čísla jsou pevná napříč projekty — „doc 04 je deployment" platí všude:

| Slot | Doc |
|---|---|
| 01 | backend |
| 02 | frontend |
| 03 | database |
| 04 | deployment |
| 05 | testing |
| 06 | known-issues |
| 07 | i18n *(rezervované — jen když projekt potřebuje)* |
| 08 | patterns *(rezervované)* |
| 09 | dependency-updates *(rezervované)* |
| 10 | local-setup *(rezervované)* |
| 11+ | projektové sloty |

Nepřečíslovává se. Když vrstva v projektu neexistuje, slot zůstává a soubor má
dvě věty s odkazem („Projekt nemá frontend; CLI rozhraní viz
[01](./01-backend.md).") — „viz 02" tak znamená všude totéž.

Číslované sloty jsou standardní vstupní vrstva. Hlubší kanonické dokumenty
(API reference, runbooky, legacy kontrakty) můžou žít vedle nich — slot pak
orientuje a odkazuje, neduplikuje.

## Hlavička dokumentu

Každý doc začíná:

```markdown
# NN – Název

> Jednou větou co doc pokrývá a co ne (s odkazem, kde je zbytek).

**Revidováno:** YYYY-MM-DD · **Platí pro:** main
```

`Revidováno` se aktualizuje při každé **věcné** změně (ne u typo) — je to
jediný signál, že doc ještě odpovídá kódu. Data vždy ISO `YYYY-MM-DD`.

## Pravidla

1. **Strop 300 řádků na dokument.** Přeteče → rozdělit do projektového slotu
   (11+), nebo škrtat citovaný kód. Dlouhý doc nikdo nereviduje, takže začne
   lhát jako celek. (Runbooky jsou procedury, ne reference — na `runbooks/`
   se strop nevztahuje.)

2. **Odkazuj, necituj.** Code fence jen když ilustruje *vzor*, ~20 řádků max,
   s cestou k souboru na prvním řádku. Jinak odkaz `app/services/foo.rb:42`.
   Nakopírovaný kód bit-rotuje — dokument pak popisuje kód, který neexistuje.

3. **Reference ≠ plán.** „Co uděláme" (roadmapa, nápady, TODO) sem nepatří —
   patří do projektové evidence práce podle AGENTS.md (Issues v hybridním
   workflow, `docs/tasks/` v lokálním). Reference popisuje jen současný stav.
   Technická reference, invarianty a závazná rozhodnutí zůstávají v repu
   a mění se ve stejném PR jako implementace; wiki na ně může odkazovat.

4. **Jeden fakt na jednom místě.** Deployment nepatří do 01, i když se
   backendu týká — odkaz na 04. Duplikát se při změně aktualizuje jen na
   jednom místě a druhý tiše lže.

5. **Jeden index.** `docs/README.md` je jediný seznam docs; `AGENTS.md` na něj
   odkazuje místo vlastní mapy. Dva seznamy se rozjedou.

6. **Odkazy s `./` a ověřené.** Relativní odkazy piš `./04-deployment.md`,
   názvy souborů lowercase. Zkopírovaný `scripts/check-doc-links.cjs` spouštěj
   z kořene repa (Node.js 22+):

   ```bash
   node scripts/check-doc-links.cjs
   ```

   Kontroluje relativní inline Markdown odkazy a obrázky v trackovaných
   `docs/**/*.md`, včetně holých cest a adresářových odkazů zakončených `/`.
   Obsah čte z pracovního stromu, cíle porovnává **proti Git indexu** — tím
   zachytí špatnou velikost písmen i na macOS. Nové soubory nejprve přidej
   pomocí `git add`. Ignoruje externí a absolutní URL, samostatné anchory,
   cíle v ostrých závorkách (`<...>`), fenced code blocks a inline code.
   Podporuje vyvážené závorky v cestách, URL encoding a volitelný titulek;
   mezery v cestách zapisuj jako `%20`. Referenční Markdown odkazy, HTML
   odkazy a existenci anchorů nekontroluje. Jde o lehkou kontrolu inline
   odkazů, bez plného Markdown parseru; vnořené code fences v blockquotech
   nebo složitě odsazených seznamech nejsou podporované.

   **Zamrzlé archivy vynech explicitně** opakováním `--exclude`. Každá
   hodnota označuje soubor nebo celý podstrom pod `docs/`, relativně ke
   kořeni repa, bez globů. Výjimka vynechá pouze zdrojové dokumenty;
   odkazy z živých docs do archivu se stále ověřují. Bez voleb se nic
   nevynechává. Stejný příkaz zapiš do projektového CI nebo package skriptu:

   ```bash
   node scripts/check-doc-links.cjs --exclude docs/done --exclude docs/superpowers
   ```

   Cesty uprav podle skutečného lifecycle projektu (např. `docs/tasks/done`).
   Neupravuj kvůli tomu parser. Nálezy jdou na stdout, souhrn a chyby na
   stderr; návratové kódy jsou 0 bez nálezů, 1 rozbité odkazy, 2 chyba
   spuštění. Další použití vypíše `--help`.

7. **Příkazy ověřuj spuštěním, fakta ber z normativního zdroje.** Dokumentovaný
   příkaz, který jsi nespustil, je hypotéza — psaním ani link checkem neprojde
   jen to, co je rozbité syntakticky. A když se dva zdroje v repu rozcházejí
   (komentář vs. normativní doc), je to nález: oprav kořen, ne jen svou kopii —
   jinak chybu převezme další čtenář.

   **U tvrzení o chování kódu je normativním zdrojem kód**, ne `AGENTS.md` ani
   jiný doc — ty popisují konvenci („používej TTL 24 h"), kód drží fakt
   (`ttl: 300`). Obojí může platit zároveň; splést je znamená napsat, že
   konvence je default, a poslat čtenáře do pasti.

   **Než rozpor přepíšeš, změř rozsah.** Kolik call-sites se toho reálně týká?
   Odpověď mění formulaci opravy: když všechna volání parametr předávají
   explicitně, správná věta není „default je jiný", ale „vždy ho předávej".
