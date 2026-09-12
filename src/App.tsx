import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  ArrowDownToLine,
  ArrowRight,
  BookOpen,
  Check,
  ChevronRight,
  CircleHelp,
  Command,
  FileText,
  Globe2,
  Layers2,
  Link2,
  List,
  Network,
  Pause,
  Moon,
  Sun,
  Play,
  RotateCcw,
  Search,
  SlidersHorizontal,
  Sparkles,
  X,
} from 'lucide-react';
import Graph from './Graph';
import Inspector, { SiteMark } from './Inspector';
import { links as defaultLinks, strengthLinks } from './data';
import type { GraphDataset, Selection } from './data';
import { demoDataset, GraphDataProvider, useGraphData } from './graph-data';
import { useTheme } from './themes';
import { connectionStyles } from './connectionStyles';
import type { ConnectionStyleId } from './connectionStyles';

export type LiveWorkspace = {
  title: string;
  status: string;
  toolbar?: ReactNode;
  onPauseSite?: (id: string) => void;
  onIntervalChange?: (id: string, seconds: number) => void;
  pausedSites?: string[];
  intervals?: Record<string, number>;
  controlsDisabled?: boolean;
};

export default function App({
  dataset = demoDataset,
  live,
}: {
  dataset?: GraphDataset;
  live?: LiveWorkspace;
}) {
  return (
    <GraphDataProvider dataset={dataset} live={Boolean(live)}>
      <Workspace live={live} />
    </GraphDataProvider>
  );
}

function Workspace({ live }: { live?: LiveWorkspace }) {
  const {
    sites,
    pages,
    links: datasetLinks,
    getSite,
    pageUrl,
    aggregateConnections,
  } = useGraphData();
  const scannedSites = sites.filter((site) => site.scanned);
  const firstSiteId = scannedSites[0]?.id ?? sites[0]?.id;
  const initialSelection: Selection | null = firstSiteId
    ? {
        type: 'site',
        id:
          !live &&
          new URLSearchParams(window.location.search).get('detail') === 'index'
            ? 'index'
            : firstSiteId,
      }
    : null;
  const { theme, toggleTheme } = useTheme();
  const [strengthDemo, setStrengthDemo] = useState(
    () =>
      new URLSearchParams(window.location.search).get('density') === 'scale',
  );
  const links = live
    ? datasetLinks
    : strengthDemo
      ? strengthLinks
      : datasetLinks;
  const [connectionStyle, setConnectionStyle] = useState<ConnectionStyleId>(
    () =>
      connectionStyles.find(
        (style) =>
          style.id ===
          new URLSearchParams(window.location.search).get('connections'),
      )?.id ?? 'silk',
  );
  const [showConnectionStudies] = useState(() =>
    connectionStyles.some(
      (style) =>
        style.id ===
        new URLSearchParams(window.location.search).get('connections'),
    ),
  );
  const selectedAppearanceUrl = new URL(window.location.href);
  selectedAppearanceUrl.searchParams.delete('connections');
  const [view, setView] = useState<'map' | 'table'>('map');
  const [selection, setSelection] = useState<Selection | null>(
    initialSelection,
  );
  const [expanded, setExpanded] = useState<string[]>(() =>
    !live &&
    new URLSearchParams(window.location.search).get('detail') === 'index'
      ? ['index']
      : [],
  );
  const [autoExpanded, setAutoExpanded] = useState(false);
  const [collapsedAtZoom, setCollapsedAtZoom] = useState<string[]>([]);
  const visibleExpanded = sites
    .filter(
      (site) =>
        expanded.includes(site.id) ||
        (autoExpanded && !collapsedAtZoom.includes(site.id)),
    )
    .map((site) => site.id);
  useEffect(() => {
    if (!autoExpanded) setCollapsedAtZoom([]);
  }, [autoExpanded]);
  const changeExpanded = (ids: string[]) => {
    const removed = visibleExpanded.filter((id) => !ids.includes(id));
    const added = ids.filter((id) => !visibleExpanded.includes(id));
    setExpanded((previous) => [
      ...new Set([...previous.filter((id) => !removed.includes(id)), ...added]),
    ]);
    setCollapsedAtZoom((previous) =>
      autoExpanded
        ? [
            ...new Set([
              ...previous.filter((id) => !ids.includes(id)),
              ...removed,
            ]),
          ]
        : [],
    );
    setView('map');
  };
  const [showExternal, setShowExternal] = useState(Boolean(live));
  const [siteSearch, setSiteSearch] = useState('');
  const [linkSearch, setLinkSearch] = useState('');
  const [nofollowOnly, setNofollowOnly] = useState(false);
  const [running, setRunning] = useState(false);
  const [demoPausedSites, setPausedSites] = useState<string[]>([]);
  const [revealedIds, setRevealedIds] = useState<string[]>(
    links.map((link) => link.id),
  );
  const [demoIntervals, setIntervals] = useState<Record<string, number>>(
    Object.fromEntries(sites.map((site) => [site.id, 3])),
  );
  const pausedSites = live?.pausedSites ?? demoPausedSites;
  const intervals = live?.intervals ?? demoIntervals;
  const pauseSite = (id: string) => {
    if (live) live.onPauseSite?.(id);
    else
      setPausedSites((previous) =>
        previous.includes(id)
          ? previous.filter((item) => item !== id)
          : [...previous, id],
      );
  };
  const [resetKey, setResetKey] = useState(0);
  const elapsed = useRef<Record<string, number>>({});
  const helpRef = useRef<HTMLDialogElement>(null);
  const complete = revealedIds.length === links.length;
  const visibleSites = sites.filter((site) => site.scanned || showExternal);
  const mapSites = live
    ? [
        ...visibleSites.filter((site) => site.scanned),
        ...visibleSites.filter((site) => !site.scanned).slice(0, 10),
      ]
    : visibleSites;
  const hiddenMapSites = visibleSites.length - mapSites.length;
  const mapSiteIds = new Set(mapSites.map((site) => site.id));
  const visibleSiteIds = new Set(visibleSites.map((site) => site.id));
  const visibleLinks = links.filter(
    (link) =>
      (Boolean(live) || revealedIds.includes(link.id)) &&
      visibleSiteIds.has(link.source.siteId) &&
      visibleSiteIds.has(link.target.siteId),
  );
  const connections = aggregateConnections(visibleLinks);
  const filteredLinks = visibleLinks.filter(
    (link) =>
      (!nofollowOnly || link.rel.split(/\s+/).includes('nofollow')) &&
      `${pageUrl(link.source)} ${pageUrl(link.target)} ${link.anchor}`
        .toLowerCase()
        .includes(linkSearch.toLowerCase()),
  );

  useEffect(() => {
    if (live || !running) return;
    const timer = window.setInterval(() => {
      const readySites = scannedSites.filter((site) => {
        if (pausedSites.includes(site.id)) return false;
        elapsed.current[site.id] = (elapsed.current[site.id] ?? 0) + 1;
        if (elapsed.current[site.id] < intervals[site.id]) return false;
        elapsed.current[site.id] = 0;
        return true;
      });
      setRevealedIds((previous) => {
        const next = [...previous];
        for (const site of readySites) {
          const link = links.find(
            (item) => item.source.siteId === site.id && !next.includes(item.id),
          );
          if (link) next.push(link.id);
        }
        return next;
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [running, pausedSites, intervals, links, live]);

  useEffect(() => {
    if (complete) setRunning(false);
  }, [complete]);

  const restart = () => {
    elapsed.current = {};
    setRevealedIds([]);
    setPausedSites([]);
    setSelection(firstSiteId ? { type: 'site', id: firstSiteId } : null);
    setRunning(true);
  };
  const select = (next: Selection) => setSelection(next);
  const overview = () => {
    setExpanded([]);
    setResetKey((previous) => previous + 1);
    setSelection(firstSiteId ? { type: 'site', id: firstSiteId } : null);
  };
  const toggleExternal = () => {
    if (showExternal)
      setSelection(firstSiteId ? { type: 'site', id: firstSiteId } : null);
    setShowExternal(!showExternal);
  };
  const exportCsv = () => {
    const rows = [
      [
        'source_url',
        'target_url',
        'anchor_text',
        'rel',
        'region',
        'occurrences',
        'observed_at',
        'data_source',
      ],
      ...filteredLinks.map((link) => [
        pageUrl(link.source),
        pageUrl(link.target),
        link.anchor,
        link.rel,
        link.region,
        String(link.occurrences),
        link.observedAt,
        live ? 'local_scan' : 'demo',
      ]),
    ];
    const csv =
      '\uFEFF' +
      rows
        .map((row) =>
          row
            .map((cell) => {
              const literal = /^[=+\-@\t\r\n]/.test(cell) ? `'${cell}` : cell;
              return `"${literal.replaceAll('"', '""')}"`;
            })
            .join(','),
        )
        .join('\r\n');
    const url = URL.createObjectURL(
      new Blob([csv], { type: 'text/csv;charset=utf-8' }),
    );
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = live ? 'vizlinx-scan.csv' : 'vizlinx-demo.csv';
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div className="app-shell" data-theme={theme}>
      <header className="app-header">
        <a href="/" className="brand" aria-label="Vizlinx — úvod">
          <img src="/favicon.svg" alt="" />
          <span>
            vizlinx<span className="brand-dot">.</span>
          </span>
        </a>
        <div className="breadcrumb">
          <span>Pracovní prostor</span>
          <ChevronRight size={13} />
          <strong>{live?.title ?? 'Studio Atlas'}</strong>
          <span className="demo-badge">{live ? 'SKEN' : 'DEMO'}</span>
        </div>
        <div className="header-actions">
          <button
            className="theme-toggle"
            onClick={toggleTheme}
            aria-label="Noční režim"
            aria-pressed={theme === 'midnight'}
            title={
              theme === 'signal' ? 'Zapnout noční režim' : 'Zapnout denní režim'
            }
          >
            {theme === 'signal' ? <Moon size={16} /> : <Sun size={16} />}
            <span>Noční režim</span>
          </button>
          <span className="local-indicator">
            <i /> {live ? 'Lokální sken' : 'Ukázková data'}
          </span>
          {!live && (
            <a className="outline-button" href="/scan">
              Skenovat vlastní weby
            </a>
          )}
          {!live && (
            <button
              className="icon-button help-button"
              aria-label="Jak demo funguje"
              onClick={() => helpRef.current?.showModal()}
            >
              <CircleHelp size={19} />
            </button>
          )}
          {!live && <span className="avatar">A</span>}
        </div>
      </header>

      <div className="app-body">
        <aside className="sidebar">
          <div className="project-card">
            <span className="project-icon">
              <Layers2 size={19} />
            </span>
            <span>
              <strong>{live?.title ?? 'Studio Atlas'}</strong>
              <small>{live ? 'Vlastní sken' : 'Ukázkový projekt'}</small>
            </span>
            <span className="project-dot" />
          </div>
          <nav aria-label="Zobrazení">
            <button
              className={view === 'map' ? 'nav-item active' : 'nav-item'}
              onClick={() => setView('map')}
            >
              <Network size={18} />
              Mapa propojení
              <span className="nav-count">{visibleSites.length}</span>
            </button>
            <button
              className={view === 'table' ? 'nav-item active' : 'nav-item'}
              onClick={() => setView('table')}
            >
              <List size={18} />
              Všechny odkazy
              <span className="nav-count">{visibleLinks.length}</span>
            </button>
          </nav>
          {hiddenMapSites > 0 && (
            <p className="empty-note">
              Dalších {hiddenMapSites} odkazovaných webů najdete v tabulce.
            </p>
          )}
          <div className="sidebar-section-label">
            <span>WEBY V MAPĚ</span>
            <span>{visibleSites.length.toString().padStart(2, '0')}</span>
          </div>
          <label className="search-field">
            <Search size={15} />
            <input
              aria-label="Hledat doménu v seznamu"
              placeholder="Najít doménu…"
              value={siteSearch}
              onChange={(event) => setSiteSearch(event.target.value)}
            />
            <span>⌕</span>
          </label>
          <div className="site-list">
            {mapSites
              .filter((site) =>
                `${site.domain} ${site.name}`
                  .toLowerCase()
                  .includes(siteSearch.toLowerCase()),
              )
              .map((site) => {
                const paused = pausedSites.includes(site.id);
                const siteComplete = links
                  .filter((link) => link.source.siteId === site.id)
                  .every((link) => revealedIds.includes(link.id));
                const state = live
                  ? !site.scanned
                    ? 'Známý cíl odkazu'
                    : paused
                      ? 'Pozastaveno'
                      : `${pages.filter((page) => page.siteId === site.id && page.status === 'ok').length} načteno · ${pages.filter((page) => page.siteId === site.id).length} URL`
                  : !site.scanned
                    ? 'Neprozkoumáno'
                    : siteComplete
                      ? 'Ukázka načtená'
                      : paused
                        ? 'Pozastaveno'
                        : running
                          ? 'Simulace běží'
                          : 'Připraveno';
                return (
                  <div
                    className={`site-list-row ${selection?.type === 'site' && selection.id === site.id ? 'selected' : ''}`}
                    key={site.id}
                  >
                    <button
                      className="site-select"
                      onClick={() => select({ type: 'site', id: site.id })}
                    >
                      <SiteMark site={site} small />
                      <span>
                        <strong>{site.domain}</strong>
                        <small>
                          <i
                            className={
                              running && !paused && !siteComplete
                                ? 'live-dot'
                                : ''
                            }
                            style={{ background: site.color }}
                          />
                          {state}
                        </small>
                      </span>
                    </button>
                    {site.scanned && (!live || live.onPauseSite) && (
                      <button
                        className="site-pause icon-button"
                        aria-label={`${paused ? 'Pokračovat' : 'Pozastavit'} ${site.domain}`}
                        disabled={live?.controlsDisabled}
                        aria-pressed={paused}
                        onClick={() => pauseSite(site.id)}
                      >
                        {paused ? (
                          <Play size={13} />
                        ) : live || (running && !siteComplete) ? (
                          <Pause size={13} />
                        ) : (
                          <Check size={13} />
                        )}
                      </button>
                    )}
                  </div>
                );
              })}
            {!visibleSites.some((site) =>
              `${site.domain} ${site.name}`
                .toLowerCase()
                .includes(siteSearch.toLowerCase()),
            ) && <p className="empty-note">Žádná doména neodpovídá hledání.</p>}
          </div>
          {!live && (
            <div className="sidebar-bottom">
              <div className="discovery-card">
                <span className="discovery-icon">
                  <Sparkles size={18} />
                </span>
                <h3>
                  Malé odkazy.
                  <br />
                  Velké souvislosti.
                </h3>
                <p>Prozkoumejte, co vaše weby spojuje.</p>
                <button onClick={() => helpRef.current?.showModal()}>
                  Jak číst mapu <ArrowRight size={14} />
                </button>
                <div className="decorative-orbit" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </div>
              </div>
              <div className="sidebar-footnote">
                <span>VIZLINX EXPLORER</span>
                <span>v0.1</span>
              </div>
            </div>
          )}
        </aside>

        <main className="main">
          <section className="workspace-heading">
            <div>
              <div className="eyebrow workspace-eyebrow">
                <span /> OBJEVUJTE PROPOJENÍ
              </div>
              <h1>
                Mapa souvislostí<span>.</span>
              </h1>
              <p>
                {live ? live.title : 'Každý web je součástí většího příběhu.'}
              </p>
            </div>
            {live ? (
              live.toolbar
            ) : (
              <div className="scan-actions">
                <button
                  className="icon-button restart-button"
                  aria-label="Přehrát demo od začátku"
                  onClick={restart}
                >
                  <RotateCcw size={17} />
                </button>
                <button
                  className="primary-button"
                  onClick={() => (complete ? restart() : setRunning(!running))}
                >
                  {running ? (
                    <Pause size={15} />
                  ) : (
                    <Play size={15} fill="currentColor" />
                  )}
                  {running
                    ? 'Pozastavit demo'
                    : complete
                      ? 'Přehrát demo'
                      : 'Pokračovat v demu'}
                </button>
              </div>
            )}
          </section>
          <div className="workspace-stats">
            <span>
              <Globe2 size={15} />
              <strong>{visibleSites.length}</strong> webů
            </span>
            <span>
              <FileText size={15} />
              <strong>
                {
                  pages.filter((page) =>
                    live ? page.status === 'ok' : getSite(page.siteId).scanned,
                  ).length
                }
              </strong>{' '}
              {live ? 'úspěšně načtených stránek' : 'prozkoumaných stránek'}
            </span>
            <span>
              <Link2 size={15} />
              <strong data-testid="link-count">
                {visibleLinks.length}
              </strong>{' '}
              vazeb
            </span>
            <div className="scan-status" role="status">
              <i className={running ? 'live-dot' : ''} />
              {live
                ? live.status
                : running
                  ? 'Simulovaný sken běží'
                  : complete
                    ? 'Ukázka je připravená k prozkoumání'
                    : 'Simulace pozastavena'}
            </div>
          </div>
          {!live && (
            <div className="connection-study-tools">
              <a href="/connections/lab/">
                Jen spojnice · škála 1–100+ <ArrowRight size={13} />
              </a>
              <label>
                <input
                  type="checkbox"
                  checked={strengthDemo}
                  onChange={(event) => {
                    const enabled = event.target.checked;
                    setStrengthDemo(enabled);
                    setRevealedIds(
                      (enabled ? strengthLinks : defaultLinks).map(
                        (link) => link.id,
                      ),
                    );
                    setRunning(false);
                    setPausedSites([]);
                    elapsed.current = {};
                    setExpanded([]);
                    setSelection(
                      firstSiteId ? { type: 'site', id: firstSiteId } : null,
                    );
                    setResetKey((previous) => previous + 1);
                    const url = new URL(window.location.href);
                    if (enabled) url.searchParams.set('density', 'scale');
                    else url.searchParams.delete('density');
                    window.history.replaceState(null, '', url);
                  }}
                />
                Ukázková data 1–100+
              </label>
            </div>
          )}
          {!live && showConnectionStudies && (
            <section
              className="connection-studies"
              aria-label="Varianty zobrazení vazeb"
            >
              <div className="connection-studies-heading">
                <strong>Archiv návrhů spojnic</strong>
                <a href={selectedAppearanceUrl.toString()}>
                  Použít vybrané Hedvábí <ArrowRight size={13} />
                </a>
              </div>
              <div className="connection-style-options">
                {connectionStyles.map((style, index) => (
                  <button
                    key={style.id}
                    aria-pressed={style.id === connectionStyle}
                    onClick={() => {
                      setConnectionStyle(style.id);
                      const url = new URL(window.location.href);
                      url.searchParams.set('connections', style.id);
                      window.history.replaceState(null, '', url);
                    }}
                  >
                    <span>0{index + 1}</span>
                    {style.name}
                  </button>
                ))}
              </div>
              <p>
                {
                  connectionStyles.find((style) => style.id === connectionStyle)
                    ?.description
                }{' '}
                Domény lze přetahovat; přesný počet vazeb najdete v detailu.
              </p>
            </section>
          )}
          <div className={`explorer ${selection ? 'with-inspector' : ''}`}>
            <section
              className="map-workspace"
              aria-label="Průzkumník propojení"
            >
              <div className="map-toolbar">
                <div className="view-switch">
                  <button
                    className={view === 'map' ? 'selected' : ''}
                    onClick={() => setView('map')}
                    aria-label="Zobrazit mapu"
                  >
                    <Network size={15} />
                    Mapa
                  </button>
                  <button
                    className={view === 'table' ? 'selected' : ''}
                    onClick={() => setView('table')}
                    aria-label="Zobrazit tabulku"
                  >
                    <List size={15} />
                    Tabulka
                  </button>
                </div>
                <label className="external-toggle">
                  <input
                    type="checkbox"
                    checked={showExternal}
                    onChange={toggleExternal}
                  />
                  <span className="switch" />
                  Další odkazované weby
                </label>
                {view === 'map' && (
                  <button
                    className="toolbar-button overview-button"
                    onClick={overview}
                  >
                    <Layers2 size={14} />
                    Přehled
                  </button>
                )}
              </div>
              {live && view === 'map' && (
                <p className="empty-note">
                  Mapa ukazuje nejvýše 10 odkazovaných webů; detail nejvýše 60
                  URL a 200 vazeb v jednom směru.{' '}
                  {hiddenMapSites > 0
                    ? `${hiddenMapSites} webů je mimo mapu. `
                    : ''}
                  Všechny zjištěné vazby zůstávají v tabulce a CSV.
                </p>
              )}
              {view === 'map' ? (
                <Graph
                  sites={mapSites}
                  links={visibleLinks.filter(
                    (link) =>
                      mapSiteIds.has(link.source.siteId) &&
                      mapSiteIds.has(link.target.siteId),
                  )}
                  selection={selection}
                  onSelect={select}
                  expanded={visibleExpanded}
                  focusedExpanded={expanded}
                  onExpandedChange={changeExpanded}
                  onAutoExpandedChange={setAutoExpanded}
                  onFocusSite={(id) => {
                    setExpanded([id]);
                    setCollapsedAtZoom([]);
                  }}
                  running={running}
                  resetKey={resetKey}
                  connectionStyle={connectionStyle}
                />
              ) : (
                <div className="table-view">
                  <div className="table-tools">
                    <label className="search-field">
                      <Search size={15} />
                      <input
                        aria-label="Hledat odkazy"
                        placeholder="Hledat URL nebo text odkazu…"
                        value={linkSearch}
                        onChange={(event) => setLinkSearch(event.target.value)}
                      />
                    </label>
                    <button
                      className={`filter-button ${nofollowOnly ? 'active' : ''}`}
                      aria-pressed={nofollowOnly}
                      onClick={() => setNofollowOnly(!nofollowOnly)}
                    >
                      <SlidersHorizontal size={14} />
                      nofollow
                    </button>
                    <button
                      className="icon-button"
                      aria-label="Exportovat zobrazené odkazy do CSV"
                      onClick={exportCsv}
                    >
                      <ArrowDownToLine size={17} />
                    </button>
                  </div>
                  <div className="table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>Zdrojová stránka</th>
                          <th>Cílová stránka</th>
                          <th>Rel</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {filteredLinks.map((link) => (
                          <tr
                            key={link.id}
                            className={
                              selection?.type === 'link' &&
                              selection.id === link.id
                                ? 'selected'
                                : ''
                            }
                          >
                            <td>
                              <span
                                className="table-site-dot"
                                style={{
                                  background: getSite(link.source.siteId).color,
                                }}
                              />
                              <strong>
                                {getSite(link.source.siteId).domain}
                              </strong>
                              <small>{link.source.path}</small>
                            </td>
                            <td>
                              <strong>
                                {getSite(link.target.siteId).domain}
                              </strong>
                              <small>{link.target.path}</small>
                            </td>
                            <td>
                              <span className="rel-tag">{link.rel || '—'}</span>
                            </td>
                            <td>
                              <button
                                className="icon-button"
                                aria-label={`Detail odkazu ${pageUrl(link.source)} → ${pageUrl(link.target)}`}
                                onClick={() =>
                                  select({ type: 'link', id: link.id })
                                }
                              >
                                <ChevronRight size={16} />
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {filteredLinks.length === 0 && (
                      <div className="empty-table">
                        <Search size={28} />
                        <h3>Žádné odpovídající odkazy</h3>
                        <p>Zkuste upravit hledání nebo filtr.</p>
                        <button
                          className="outline-button"
                          onClick={() => {
                            setLinkSearch('');
                            setNofollowOnly(false);
                          }}
                        >
                          Vymazat filtry
                        </button>
                      </div>
                    )}
                  </div>
                  <div className="table-footer">
                    Zobrazeno {filteredLinks.length} z {visibleLinks.length}{' '}
                    vazeb <span>{live ? 'Lokální sken' : 'Ukázková data'}</span>
                  </div>
                </div>
              )}
              <footer className="workspace-footer">
                <span>
                  <i />
                  {connections.length} směrových propojení
                  <span className="footer-separator">/</span>
                  {showExternal
                    ? 'Včetně neprozkoumaných cílů'
                    : 'Mezi vybranými weby'}
                </span>
                <span>
                  <Command size={12} /> Vytvořeno pro zvědavost
                </span>
              </footer>
            </section>
            {selection && (
              <Inspector
                selection={selection}
                links={visibleLinks}
                expanded={visibleExpanded}
                onExpand={changeExpanded}
                onSelect={select}
                onClose={() => setSelection(null)}
                intervals={intervals}
                pausedSites={pausedSites}
                onPauseSite={live?.onPauseSite}
                controlsDisabled={live?.controlsDisabled}
                onIntervalChange={
                  live
                    ? live.onIntervalChange
                    : (id, interval) => {
                        elapsed.current[id] = 0;
                        setIntervals((previous) => ({
                          ...previous,
                          [id]: interval,
                        }));
                      }
                }
              />
            )}
          </div>
        </main>
      </div>

      <dialog ref={helpRef} className="help-dialog">
        <form method="dialog">
          <button
            className="icon-button dialog-close"
            aria-label="Zavřít nápovědu"
          >
            <X size={20} />
          </button>
        </form>
        <div className="help-symbol">
          <BookOpen size={27} />
        </div>
        <span className="eyebrow">VÍTEJTE VE VIZLINX</span>
        <h2>Najděte společné nitky.</h2>
        <p>
          Toto je grafické demo s fiktivními weby. Pomáhá nám doladit vzhled a
          ovládání budoucí aplikace.
        </p>
        <ol>
          <li>
            <Network size={19} />
            <div>
              <strong>Od celku k detailu</strong>
              <p>
                Kliknutím vyberte doménu. Dvojklikem nebo tlačítkem „Prozkoumat
                stránky“ ji rozbalíte.
              </p>
            </div>
          </li>
          <li>
            <Link2 size={19} />
            <div>
              <strong>Každá šipka má svůj příběh</strong>
              <p>
                Číslo na spojnici udává počet dvojic stránek v daném směru.
                Kliknutím zobrazíte konkrétní odkazy.
              </p>
            </div>
          </li>
          <li>
            <Play size={19} />
            <div>
              <strong>Sledujte, jak mapa roste</strong>
              <p>
                „Přehrát demo“ postupně odhalí vazby. Simulaci můžete
                pozastavit, měnit interval webu nebo ji spustit znovu.
              </p>
            </div>
          </li>
        </ol>
        <div className="help-note">
          Vše běží lokálně nad ukázkovými daty. Demo nic neskenuje ani neukládá
          na server. Obnovení stránky vrátí výchozí mapu.
        </div>
        <form method="dialog">
          <button className="primary-button">
            Jdu objevovat <ArrowRight size={16} />
          </button>
        </form>
      </dialog>
    </div>
  );
}
