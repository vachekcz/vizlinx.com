# Vizlinx.com

**See how websites connect.**

Interaktivní mapa odkazů mezi weby. Návštěvník bez účtu zadá domény, nastaví rychlost každé z nich a spustí skenování ze svého prohlížeče. Výsledky se průběžně ukládají na server. Oddálený pohled ukazuje domény jako clustery; přiblížení odhalí konkrétní zdrojové a cílové stránky.

## Stav

Koncepční fáze. Doména `vizlinx.com` je koupená; tento repozitář zatím obsahuje zadání a technický návrh. Návrh počítá s webem a rozšířením do prohlížeče kvůli CORS. Technické detaily označené jako návrh vyžadují ověření prototypem.

**První milník je grafické demo:** interaktivní mapa s ukázkovými daty, na které doladíme vzhled, rozložení a ovládání. Z tohoto základu pak vyjde funkční aplikace. Skener, rozšíření a backend následují až po doladění dema. Rozsah a kritéria jsou v [produktovém zadání](docs/product-specification.md#první-milník-grafické-demo).

## Dokumentace

- [Produktové zadání](docs/product-specification.md) — průchod uživatele, skenování, vizualizace a kritéria přijetí.
- [Technická specifikace](docs/technical-specification.md) — architektura, lokální skener, datový model, API a ověření.
- [Lokální skenování](docs/decisions/browser-side-crawling.md) — potvrzené umístění exekuce a důvody.
- [Názvy a domény](docs/naming.md) — výběr Vizlinx.com a historie nápadů.

Dokumentace produktu a technická rozhodnutí se udržují v tomto repozitáři.
