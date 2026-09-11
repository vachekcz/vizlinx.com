---
date: 2026-09-11
status: accepted
tags: [decision, architecture]
revisit_when: Pokud skenování z prohlížeče vyžaduje pro uživatele nepřijatelnou instalaci nebo nesplní požadované pokrytí webů.
---

# Skenování běží v prohlížeči návštěvníka

## Kontext

Pavel 2026-09-11 upřesnil, že návštěvník zadá domény bez účtu, nastaví jejich rychlost a procházení provede jeho počítač. Nalezené odkazy se průběžně ukládají na server Vizlinx pro vizualizaci.

## Rozhodnutí

HTTP požadavky na skenované weby provádí prohlížeč návštěvníka. Server Vizlinx ukládá výsledky a poskytuje data mapě; nepřebírá skenování při zavření browseru ani při blokaci cílového webu.

## Důvod

Pavlovým důvodem je omezení závislosti na společné serverové IP a její blokaci. Každý návštěvník používá vlastní připojení a může samostatně řídit rychlost pro jednotlivé domény. Blokace návštěvníkova připojení je stále možná.

## Alternativy a hranice

- Serverový crawler nebo proxy by změnily potvrzené umístění exekuce.
- Čistá webová stránka má omezení CORS a bez spolupráce cílového webu obecně nepřečte jeho HTML.
- Web s rozšířením je doporučený implementační návrh; jeho přijetí zatím není součástí tohoto rozhodnutí.
- Lokální aplikace je další možnost, pokud bude přijatelnější než rozšíření.

Uživatel nepotřebuje účet; návrh anonymní relace, doba uchování, stack a limity zůstávají implementačními a produktovými návrhy. Serverové uložení výsledků neznamená nepřetržitý serverový běh.

## Související

- [Produktové zadání](../product-specification.md)
- [Technická specifikace a podklady k omezením prohlížeče](../technical-specification.md)
