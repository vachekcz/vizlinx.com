# 02 – Frontend

> React SPA v `src/` (demo `/`, skener `/scan`, studie `/connections/lab`): build, struktura, routing a stav, theming, a rozšíření pro Chrome jako artefakt buildu. API a pravidla skeneru viz [01](./01-backend.md), hosting assetů viz [04](./04-deployment.md).

**Revidováno:** 2026-09-13 · **Platí pro:** main

## Obsah

1. [Stack](#stack)
2. [Build a assety](#build-a-assety)
3. [Struktura](#struktura)
4. [Routing a stav](#routing-a-stav)
5. [Styling a theming](#styling-a-theming)
6. [Rozšíření pro Chrome](#rozšíření-pro-chrome)

---

## Stack

| Vrstva | Technologie | Poznámka |
|---|---|---|
| Framework | React 19 (`react`, `react-dom`) ve `StrictMode` | vstup `src/main.tsx` |
| Jazyk a build | TypeScript (`tsc -b` přes project references v `tsconfig.json`), Vite + `@vitejs/plugin-react` | `vite.config.ts` obsahuje jen plugin — žádný proxy na API |
| Ikony | `lucide-react` | |
| Fonty | `@fontsource-variable/dm-sans`, `@fontsource-variable/manrope` | self-hosted, `@import` v `src/styles.css:1` |
| Styly | čisté CSS s custom properties ve třech souborech | žádný Tailwind ani CSS-in-JS |
| Stav | React state + context (`GraphDataProvider`) a URL query parametry | žádný router ani store |
| Graf | ručně psané SVG | `src/Graph.tsx` |

Verze v `package.json`.

---

## Build a assety

- **Dev:** `npm run dev` = `vite --host 127.0.0.1` → http://127.0.0.1:5173 s HMR. Servíruje **jen frontend**: `/api/*` neexistuje, takže `/scan` nefunguje ([06](./06-known-issues.md)). Celou aplikaci lokálně dává `npm run dev:full` / `npm run dev:api` na 8797 ([10](./10-local-setup.md)).
- **Produkce:** `npm run build` = `tsc -b && vite build && npm run build:extension`. Nejdřív typová kontrola všech čtyř projektů (app, node/testy, worker, extension), pak Vite bundle do `dist/` (`index.html`, hashované soubory v `dist/assets/`), nakonec build rozšíření (níže). `dist/` servíruje Workers Static Assets se SPA fallbackem ([04](./04-deployment.md)); do gitu nepatří.
- **Preview:** `npm run preview` = `vite preview --host 127.0.0.1` → 4173 nad `dist/`, opět bez API. Používá ho Playwright jako `webServer` ([05](./05-testing.md)).
- **`public/`** se kopíruje 1:1: `_headers` (CSP, `X-Robots-Tag: noindex, nofollow`, cache pro `/assets/*`), `favicon.svg` a statické archivy návrhů `/palettes/` (5 barevných variant) a `/connections/` (8 stylů spojnic) — samostatné HTML + PNG mimo React.
- **CSP** (`public/_headers`) povoluje jen vlastní origin (`script-src 'self'`, `connect-src 'self'`, `font-src 'self'`) a inline styly. Nový externí skript, font nebo API host tedy znamená úpravu `_headers`.

---

## Struktura

```text
src/
├── main.tsx              # entry: nastaví data-theme, vybere obrazovku podle pathname
├── App.tsx               # shell workspace: hlavička, seznam webů, mapa, inspektor, tabulka/CSV; props dataset + live
├── Graph.tsx             # SVG mapa: clustery, stránky, spojnice, drag/zoom, klávesnice, responsivita
├── Inspector.tsx         # pravý panel s detailem webu / stránky / vazby
├── ConnectionStroke.tsx  # styly spojnic (Silk výchozí) + FineConnectionStroke.tsx, connectionStyles.ts
├── ConnectionLab.tsx     # /connections/lab — izolovaná studie spojnic (+ connection-lab.css)
├── data.ts               # typy grafu a ukázková data dema (links, strengthLinks)
├── graph-data.tsx        # GraphDataProvider, demoDataset, useGraphData
├── scan-dataset.ts       # scanToDataset: ScanSnapshot → GraphDataset (stabilní pozice z hashe originu)
├── ScanWorkspace.tsx     # /scan: relace, založení mapy, ovládání, polling, historie běhů, přidání webu
├── ScanLogPanel.tsx      # panel „Průběh skenu“ a indikátor aktivity; čte /log
├── themes.ts             # ThemeId, initialTheme, useTheme
└── styles.css, themes.css, scan-workspace.css
```

**Kde začít číst:** `src/main.tsx` → podle cesty `App` (demo), `ScanWorkspace` (skener) nebo `ConnectionLab`. `ScanWorkspace` obaluje tentýž `App` s `dataset` ze `scanToDataset` a s `live` ovládáním, takže demo a živá mapa sdílejí jednu komponentu.

Typy API bere frontend přímo ze `shared/scan.ts` (`src/ScanWorkspace.tsx:22`) — kontrakt se neduplikuje.

---

## Routing a stav

- **Routing:** bez knihovny. `src/main.tsx:14` porovnává `window.location.pathname` bez koncového lomítka: `/connections/lab` → `ConnectionLab`, `/scan` → `ScanWorkspace`, cokoli jiného → demo `App`. Server vrací `index.html` pro každou neznámou cestu (SPA fallback), proto fungují přímé odkazy.
- **Query parametry dema `/`** (čtou se z `URLSearchParams` při načtení):

  | Parametr | Hodnoty | Efekt | Kde |
  |---|---|---|---|
  | `theme` | `signal`, `midnight` | vynutí vzhled, má přednost před uloženou volbou | `src/themes.ts:12` |
  | `detail` | `index` | otevře rozbalený 20-stránkový cluster `index.example` | `src/App.tsx:79`, `src/App.tsx:117` |
  | `density` | `scale` | dataset se silnými vazbami (`strengthLinks`) | `src/App.tsx:87` |
  | `connections` | id stylu z `connectionStyles` | experimentální styl spojnic, jen při příchodu z archivu | `src/App.tsx:99` |

- **Query parametry `/scan`:** `id` (UUID mapy) a `run` (UUID archivního běhu) — `src/ScanWorkspace.tsx:152`. Po založení mapy se `id` zapíše přes `history.replaceState` (`src/ScanWorkspace.tsx:299`), URL mapy je tedy stabilní; přístup ale řídí cookie, nikoli URL ([01](./01-backend.md)).
- **Stav:** lokální React state a `GraphDataProvider`; zdrojem pravdy pro mapu je server. `ScanWorkspace` volá `POST /session`, `POST /scans`, `POST /scans/:id/start` a pak **polluje snapshot každé 3 s** (`src/ScanWorkspace.tsx:244`); otevřený log panel polluje `/log` s 3 s odstupem (`src/ScanLogPanel.tsx:222`). Každá mutace posílá `runId`, aby zastaralá karta nemohla měnit novější běh.
- **API klient:** funkce `api()` v `src/ScanWorkspace.tsx:55` — `fetch(API_PREFIX + path, { credentials: 'same-origin' })` s JSON a mapováním HTTP kódů na české hlášky. Nový endpoint patří sem, ne do dalšího `fetch`.
- **Pravidlo:** grafová vrstva (`Graph`, `Inspector`, `App`) nezná API — dostává hotový `GraphDataset`; síťová logika žije jen v `ScanWorkspace` a `ScanLogPanel`.

---

## Styling a theming

- **Systém:** čisté CSS; tokeny jako custom properties na `:root` (`src/styles.css:4`), přepis podle `[data-theme]` v `src/themes.css`, styly skeneru v `src/scan-workspace.css`. Fonty: DM Sans Variable pro text, Manrope Variable pro titulky.
- **Témata:** `signal` (světlé) a `midnight` (tmavé), `ThemeId` v `src/themes.ts`. Pořadí: `?theme=` → `localStorage['vizlinx-theme']` → `prefers-color-scheme` (`initialTheme`, `src/themes.ts:26`). `main.tsx` nastaví `data-theme` na `<html>` **před** prvním renderem, aby stránka nebliknula. Přepínač (`useTheme`) uloží volbu do localStorage a odstraní `theme` z URL (`src/themes.ts:47`); bez uložené volby vzhled sleduje systém živě.
- **Směr spojnic:** sdílený `ArrowHead` kreslí plný hrot v barvě zdroje s obrysem podle `--surface`, aby byl čitelný v obou tématech. `FineConnectionStroke` jej natáčí podle tečny křivky; SVG markery v `Graph` jej používají také pro vazby rozbalených stránek a ostatní styly. `markerUnits="userSpaceOnUse"` drží velikost hrotu nezávislou na tloušťce vybrané spojnice. Tloušťka a počet vláken dál vyjadřují sílu vazby.
- **Přidání komponenty:** styl do souboru vrstvy, kam komponenta patří (`styles.css` demo a graf, `scan-workspace.css` skener); barvy přes tokeny, v `themes.css` pak jen přepis tokenů, ne duplikát pravidel.
- **Pravidlo:** žádné inline `<script>` ani externí CSS a fonty — blokuje je CSP z `public/_headers`. Inline `style=` atributy CSP povoluje.

---

## Rozšíření pro Chrome

`extension/` je historický lokální skener (Manifest V3), který dnes slouží jen starým mapám; aktuální skenování běží na serveru ([01](./01-backend.md)). Přesto je součástí každého buildu:

- `scripts/build-extension.mjs` (esbuild) sestaví `extension/background.ts` a `extension/runner.ts` do `build/extension` (produkce, minifikované, pouze originy `https://vizlinx.com` a `https://www.vizlinx.com`) a `build/extension-dev` (navíc `http://127.0.0.1:8797` a `http://localhost:8797`), vygeneruje `manifest.json` a zkopíruje `runner.html` / `runner.css`.
- Produkční složku zabalí do `dist/downloads/vizlinx-extension.zip`, na webu dostupné jako `/downloads/vizlinx-extension.zip`.
- Stabilní veřejný klíč a ID rozšíření jsou ve `shared/extension.ts`. `extension/extract.ts` (parser HTML) importuje i Worker (`worker/server-fetch.ts:8`) — změna extrakce mění chování serverového skeneru.
- Typy kontroluje `extension/tsconfig.json` (`@types/chrome`), chování testuje `npm run test:extension` ([05](./05-testing.md)). Instalace a ovládání: `extension/README.md`.
