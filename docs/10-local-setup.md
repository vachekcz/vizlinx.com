# 10 – Lokální setup

> Rozjetí vývoje na vlastním stroji: Node, závislosti, env soubory, lokální D1, porty, worktrees. Produkční proměnné a deploy viz [04](./04-deployment.md), testy viz [05](./05-testing.md).

**Revidováno:** 2026-09-13 · **Platí pro:** main

## Obsah

1. [Quick start](#quick-start)
2. [Env soubory](#env-soubory)
3. [Lokální D1 a porty](#lokální-d1-a-porty)
4. [Worktrees a hooks](#worktrees-a-hooks)

---

## Quick start

```bash
node --version      # >= 24 (package.json engines); repo nemá .nvmrc ani .node-version — verzi přepni ručně (např. nvm use 24)
npm ci              # žádný postinstall projektu, jen nativní binárky esbuild a workerd
npm run dev         # jen frontend (demo /, /connections/lab) na http://127.0.0.1:5173 s HMR
npm run dev:full    # build + lokální migrace + wrangler dev → celá aplikace na http://127.0.0.1:8797/scan
```

Ověřeno spuštěním 2026-09-13 (Node v24.19.0, npm 12.0.2): `npm ci` do 10 s, `npm run build` ~13 s; `wrangler dev` odpovídá na `/api/v1/config` JSONem, na `/scan` HTML a na `/downloads/vizlinx-extension.zip` archivem.

- `npm run dev:full` = `npm run build && npm run db:local && npm run dev:api`. Jednotlivě: `npm run build` (nutné po každé změně frontendu — wrangler servíruje `dist/`, ne zdroje), `npm run db:local`, `npm run dev:api` (= `wrangler dev --port 8797 --env-file=/dev/null`).
- Na 8797 běží Worker, consumer fronty i D1 lokálně ve workerd; sken veřejných webů odchází z tvého počítače, produkční data se nedotýkají (bez `--remote`).
- Pro lokální vývoj **není potřeba žádný Cloudflare token ani `.env`**.
- Node 24 je nutný i proto, že skripty importují `.ts` přímo (`scripts/build-extension.mjs:5` → `shared/extension.ts`) a spoléhají na nativní type stripping.
- Po změně `wrangler.jsonc` (bindingy, vars): `npm run typegen` a commit `worker-configuration.d.ts`.

---

## Env soubory

| Soubor | Obsah | Odkud |
|---|---|---|
| `.env.example` | šablona; jediný klíč `CLOUDFLARE_API_TOKEN=` s komentářem o oprávněních | v gitu |
| `.env` | skutečný deploy token; `.gitignore` ignoruje `.env` i `.env.*` kromě `.env.example` | ručně z `.env.example`; hodnota z Cloudflare dashboardu (API Tokens) |

- Token potřebují jen `npm run deploy` a `npm run db:remote` (wrangler načte `.env` sám). `dev:api` a `typegen` mají `--env-file=/dev/null`, takže token do lokálního dev procesu nikdy nevstoupí.
- Drž `.env` v hlavním checkoutu, ne ve worktree (níže); rozsah tokenu a kde žije v CI → [04](./04-deployment.md).
- Runtime proměnné Workeru (`CRAWLER_ENABLED`, `ADMIN_EMAIL`) nejsou v `.env`, ale ve `wrangler.jsonc` → `vars`; lokálně platí tytéž hodnoty.

---

## Lokální D1 a porty

- Lokální databáze žije v `.wrangler/state/v3/d1/` (gitignored) pod identitou `preview_database_id` (nulové UUID ve `wrangler.jsonc`) — díky tomu připojení produkce nezměnilo lokální mapy. `npm run db:local` aplikuje chybějící migrace, při prvním spuštění všech šest. Čistý start = smazat adresář `.wrangler/` a znovu `db:local`.
- Cookie relace je per host: mapu založenou na `127.0.0.1:8797` neuvidíš na `localhost:8797` ([06](./06-known-issues.md)).

| Port | Kdo | Poznámka |
|---|---|---|
| 5173 | `npm run dev` (Vite) | jen frontend; když je obsazený, Vite vezme další volný a vypíše ho |
| 4173 | `npm run preview` a Playwright `webServer` | testy mají `--strictPort` — obsazený port je shodí |
| 8797 | `npm run dev:api` (wrangler dev) | celá aplikace; pevný port, dev build rozšíření důvěřuje jen jemu |
| 8897, 8901 | `test:extension`, `test:prototype` | fixture servery, spouštět postupně |

Prohlížeče: `npm test` na macOS používá nainstalovaný Google Chrome (`channel: 'chrome'`); `test:extension`, `test:prototype` a `npm test` mimo macOS potřebují `npx playwright install chromium`.

---

## Worktrees a hooks

- **Nový worktree** je bez `node_modules`, `dist/`, `build/` i `.wrangler/`: `npm ci`, `npm run build`, `npm run db:local`. Lokální DB je oddělená a prázdná — mapy z hlavního checkoutu tam nejsou. `.env` netřeba; deploy spouštěj z hlavního checkoutu, token nekopíruj.
- Dva worktrees nemohou zároveň držet 8797 ani 4173 — druhý `dev:api` spadne na obsazený port (pevný `--port`), druhý Vite dev se posune na další port.
- **Hooks:** repo žádné nemá (bez husky či lefthook, bez `prepare` / `postinstall`, `core.hooksPath` nenastaven). Před pushem ručně `npm run format:check` a `npm run build`; gate je CI ([05](./05-testing.md)).
