# Technická dokumentace

Referenční popis toho, jak Vizlinx.com dnes funguje — číslované sloty podle společných pravidel, vedle nich původní specifikace a implementační kontrakty.

Pravidla psaní: [CONVENTIONS.md](./CONVENTIONS.md).

## Reference

| Doc | Obsah |
|---|---|
| [01 – Backend](./01-backend.md) | Cloudflare Worker, API `/api/v1`, fronta a průběh skenu, pravidla crawleru, limity, invarianty |
| [02 – Frontend](./02-frontend.md) | React SPA: build, struktura `src/`, routing a stav, theming, rozšíření jako artefakt buildu |
| [03 – Databáze](./03-database.md) | D1 `vizlinx-scans`: migrace, tabulky, vztahy, indexy, retence |
| [04 – Deployment](./04-deployment.md) | Workers + Queues + D1 + Static Assets, domény, vars a token, CI deploy, runbook |
| [05 – Testing](./05-testing.md) | Playwright, `node:test` + Miniflare, E2E skripty, jak spustit, gates v CI |
| [06 – Známé problémy](./06-known-issues.md) | trvalé pasti stacku a jejich obcházení |
| [10 – Lokální setup](./10-local-setup.md) | Node 24, env soubory, lokální D1, porty, worktrees, hooks |

## Další dokumenty v repu

- [technical-specification.md](./technical-specification.md) — původní technický návrh s lokálním skenerem v rozšíření; umístění exekuce nahradil serverový sken (viz poznámka v jeho hlavičce), zbytek platí jako širší návrh.
- [scan-benchmark.md](./scan-benchmark.md) — lokální benchmark HTML skeneru (`npm run benchmark:scan`) a kapacitní model Workers.
- [decisions/browser-side-crawling.md](./decisions/browser-side-crawling.md) — rozhodnutí o skenování v prohlížeči, nahrazené 2026-09-12.

<!-- documentation-workflow: github-hybrid -->

## Schválená rozhodnutí

| Dokument | Stav |
|---|---|
| [Výraznější šipky v grafu](./decisions/graph-arrowheads.md) | schváleno 2026-09-13; varianta 1, plný hrot s kontrastním obrysem |
| [Skenování běží v prohlížeči návštěvníka](./decisions/browser-side-crawling.md) | superseded; nahrazeno serverovým skenerem, viz [01 – Backend](./01-backend.md) |

Novější schválený návrh nahrazuje starší jen v dotčeném rozsahu. Aktuální chování
popisují reference; historický plán není návod pro provoz.

## Mimo repo

[Issues](https://github.com/vachekcz/vizlinx.com/issues) drží zadání, bugy a rozhodnutí.
[Wiki](https://github.com/vachekcz/vizlinx.com/wiki) drží produktový kontext a historii: [produktové zadání](https://github.com/vachekcz/vizlinx.com/wiki/Produktove-zadani),
[názvy a domény](https://github.com/vachekcz/vizlinx.com/wiki/Naming), [historii uživatelských změn](https://github.com/vachekcz/vizlinx.com/wiki/History) a archiv historických
implementačních kontraktů podle [mapy migrace 2026-09-13](https://github.com/vachekcz/vizlinx.com/wiki/Migration-2026-09-13)
(serverový skener, historie skenů, prototyp s rozšířením). Technická fakta se tam podruhé
neudržují; při rozporu s kódem platí kód a sloty výše. Testovací vstupy zůstávají v repu.
