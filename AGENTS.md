# AGENTS.md

Kanonický zdroj instrukcí pro AI agenty v tomhle repu. `CLAUDE.md` je jen
pointer — instrukce se nepíšou dvakrát.

## Project

Vizlinx: interaktivní mapa odkazů mezi weby. Návštěvník bez účtu zadá až tři
weby, serverový skener na Cloudflare projde jejich veřejné HTML a mapa ukazuje
domény a stránky jako propojené clustery.

- **Stack:** TypeScript, React 19 + Vite (SPA), Cloudflare Worker + Queues + D1,
  statické assety z `dist/`, testy Playwright a `node --test`.
- **Produkce:** https://vizlinx.com (také `www.vizlinx.com`, záložní
  `vizlinx-com.pvpvpv.workers.dev`).
- **Business kontext:** [README.md](./README.md) a produktové zadání v
  [produktové zadání ve wiki](https://github.com/vachekcz/vizlinx.com/wiki/Produktove-zadani).

## Common commands

```bash
npm ci                 # závislosti; Node 24+ podle `engines` v package.json
npm run dev            # jen frontend (Vite, 127.0.0.1:5173), bez /api
npm run dev:full       # build + lokální D1 migrace + wrangler dev na 127.0.0.1:8797
npm run build          # tsc -b + vite build + build rozšíření
npm run format:check   # Prettier (single quotes); `npm run format` opraví
npm test               # Playwright v tests/; sám postaví a spustí preview na 4173
npm run test:api       # API testy proti workerd a lokální D1 (tests-api/)
npm run deploy:check   # build + wrangler deploy --dry-run
```

Skenovací API běží jen pod Wranglerem (`dev:api`, `dev:full`); samotný
`vite preview` cesty `/api/*` neobsluhuje. Podrobnosti a porty:
[docs/10-local-setup.md](./docs/10-local-setup.md).

## Environment & Secrets

Lokální vývoj ani testy nepotřebují žádný token; `dev:api` běží s
`--env-file=/dev/null`. Jediný secret je `CLOUDFLARE_API_TOKEN` pro deploy:
lokálně v `.env` podle `.env.example` (v Gitu ignorovaný), v CI jako GitHub
secret. Čerstvý worktree `.env` nemá. Veřejné proměnné Workeru
(`CRAWLER_ENABLED`, `ADMIN_EMAIL`) žijí ve `wrangler.jsonc`; přehled v
[docs/04-deployment.md](./docs/04-deployment.md).

## Architektura

Reference po vrstvách je v [docs/README.md](./docs/README.md): backend a
invarianty skeneru v 01, frontend v 02, D1 v 03, deploy v 04, testy v 05.
Technická fakta se sem neopisují; při změně chování uprav referenci ve stejném PR.

## Klíčové soubory

| Soubor                                    | Co v něm je                                                     |
| ----------------------------------------- | --------------------------------------------------------------- |
| `worker/index.ts`                         | vstup Workeru: API, zpracování fronty, servírování assetů       |
| `shared/scan.ts`                          | kontrakt API a datové typy sdílené webem, Workerem a rozšířením |
| `src/`                                    | React aplikace: grafické demo `/` a pracovní plocha `/scan`     |
| `migrations/`                             | číslované D1 migrace; aplikuje `db:local` / `db:remote`         |
| `wrangler.jsonc`                          | binding `DB`, fronty, assety, limity CPU, veřejné vars          |
| `.github/workflows/verify-and-deploy.yml` | CI: job `verify` na PR i push, job `deploy` na push do `main`   |
| `playwright.config.ts`                    | prohlížečové testy v `tests/` (desktop + mobil)                 |

## Databáze a migrace

Schéma je součet SQL souborů v `migrations/`. Změna schématu = nový číslovaný
soubor; existující migrace se nepřepisují, protože už běží v produkční D1.
Lokálně `npm run db:local`, v deployi běží `npm run db:remote` před
`wrangler deploy`. Tabulky, retence a pravidla: [docs/03-database.md](./docs/03-database.md).

## Konvence

- Kód, komentáře, commity a identifikátory anglicky; texty UI, README a `docs/` česky.
- Prettier (`singleQuote`, `trailingComma: all`) je jediný formátovací gate; ESLint v repu není.
- Typecheck běží uvnitř `npm run build` (`tsc -b` přes `tsconfig.app/node/worker`
  a `extension/tsconfig.json`).
- Kontrakt API měň v `shared/scan.ts` a ve stejném PR uprav referenci v `docs/`.

## Testování

Před PR musí projít `npm run format:check`, `npm run build`, `npm test`
a API testy (`test:api`, `test:crawler`, `test:scan-log`, `test:fetch-result`).
CI spouští totéž ve workflow `verify-and-deploy.yml` v jobu `verify`;
agregační gate „CI Passed“ zatím není. Co se čím testuje:
[docs/05-testing.md](./docs/05-testing.md).

<!-- documentation-workflow: github-hybrid -->

## Dokumentace a evidence práce

Technické reference a invarianty jsou v [docs/README.md](./docs/README.md),
schválené návrhy v `docs/decisions/`. Upravuj je ve stejném PR jako kód. Novější
schválený návrh nahrazuje starší pouze v dotčeném rozsahu. Skutečné současné
chování ověřuj v kódu, historický plán není runbook.

- Zadání, bugy, follow-upy a rozhodnutí: [Issues](https://github.com/vachekcz/vizlinx.com/issues).
- Produktový kontext a pracovní historie: [wiki](https://github.com/vachekcz/vizlinx.com/wiki).
- Každý dokument má jednu živou verzi. Wiki může odkazovat na referenci v repu,
  nemá držet její druhou editovanou kopii. Build a testy wiki nepotřebují.
- Před větší prací najdi související issue včetně uzavřených a přečti lokální
  referenci dané vrstvy s invarianty a související spec. `needs-triage` je nález
  k ověření; `idea` není závazek realizace. Malá jasná změna nepotřebuje nový spec.
- Pracovní plán patří do issue nebo wiki. Nevytvářej `docs/tasks/`, `docs/bugs/`
  ani `done/`. Staré `/finish-task` a plánovací skilly adaptuj na tento workflow;
  jejich výchozí cesty nesmějí obnovit lokální backlog.
- Historické implementační kontrakty jsou v archivu wiki
  ([mapa migrace](https://github.com/vachekcz/vizlinx.com/wiki/Migration-2026-09-13)); `docs/tasks/` už neexistuje
  a nevrací se. Nové úkoly patří do Issues.

### Dokončení

1. Splň celý rozsah a ověř projektové kontroly. Doplň trvalé technické know-how
   a případný schválený spec do stejného PR. Nezávislé follow-upy mají vlastní issues.
2. **Hotovo = otevřený PR**, po dokončení implementace a ověření; rozpracovaný
   draft nestačí. Použij `Related to #N`, ne `Closes`/`Fixes`.
3. Do issue zapiš výsledek, ověření, omezení a odkaz na PR; uzavři je a přidej
   `pr-open`. Částečně splněné zadání nech otevřené. Tracking uzavři až po splnění
   cíle a všech dětí. Issue bez PR uzavři po skutečném rozhodnutí/výsledku.
4. Při merge odstraň `pr-open`; při zavření bez merge issue znovu otevři a štítek
   odstraň. Chybějící původní kritérium z review znamená znovu otevřít issue.
5. Uživatelskou změnu zaznamenej do [History](https://github.com/vachekcz/vizlinx.com/wiki/History): datum,
   PR, co vzniklo a omezení. Piš ověřenou událost, netvrď neověřený merge/deploy.
   Interní refaktory a tooling do feature logu nepatří.

Pokud nové zadání nemá issue, nevyráběj zpětně archivní task doc. Technická
reference a případný záznam uživatelské změny platí i tak. Zavřené issue není
potvrzení merge nebo nasazení — to se ověřuje z PR a běhu nasazení.
