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
- [product-specification.md](./product-specification.md) — produktové zadání: průchod uživatele, vizualizace, kritéria přijetí; požadavek lokální exekuce byl nahrazen.
- [naming.md](./naming.md) — výběr názvu a domény Vizlinx.com, historie brainstormingu.
- [scan-benchmark.md](./scan-benchmark.md) — lokální benchmark HTML skeneru (`npm run benchmark:scan`) a kapacitní model Workers.
- [decisions/browser-side-crawling.md](./decisions/browser-side-crawling.md) — rozhodnutí o skenování v prohlížeči, nahrazené 2026-09-12.
- Historické implementační kontrakty, zatím ponechané v repu: [tasks/local-scan-prototype.md](./tasks/local-scan-prototype.md) (prototyp s rozšířením), [tasks/server-scan-prototype.md](./tasks/server-scan-prototype.md) (serverový skener, limity, provozní ověření), [tasks/scan-history.md](./tasks/scan-history.md) (historie a opakované skenování). Při rozporu s kódem platí kód a sloty výše.

<!-- GITHUB-WORKFLOW-SECTION -->
