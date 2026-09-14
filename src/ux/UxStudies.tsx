import { useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clock3,
  FileText,
  Globe2,
  History,
  LayoutDashboard,
  Link2,
  List,
  LoaderCircle,
  Maximize2,
  Moon,
  Network,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Sun,
  X,
} from 'lucide-react';
import Graph from '../Graph';
import ExternalLink from '../ExternalLink';
import { demoDataset, GraphDataProvider, useGraphData } from '../graph-data';
import type { GraphDataset, Link, Selection, Site } from '../data';
import { useTheme } from '../themes';
import './ux-studies.css';

const concepts = [
  {
    id: 1,
    name: 'Pracovní plocha',
    short: 'Plocha',
    label: 'Všechno má své místo.',
    description:
      'Weby vlevo, mapa uprostřed, souvislosti vpravo. Jedno stabilní místo pro každou činnost.',
    benefit: 'Pro každodenní práci s mapou',
    icon: LayoutDashboard,
  },
  {
    id: 2,
    name: 'Mapa naplno',
    short: 'Mapa',
    label: 'Prostor pro souvislosti.',
    description:
      'Velká mapa a ovládání po ruce. Detail se objeví až ve chvíli, kdy ho potřebuješ.',
    benefit: 'Pro vizuální průzkum webů',
    icon: Maximize2,
  },
  {
    id: 3,
    name: 'Od přehledu k detailu',
    short: 'Přehled',
    label: 'Nejdřív pochopit. Pak zkoumat.',
    description:
      'Srozumitelný přehled výsledků, mapa a konkrétní vazby vedle sebe. Bez hledání dalšího kroku.',
    benefit: 'Pro první návštěvu a čtení výsledků',
    icon: List,
  },
] as const;
type View = 'map' | 'results' | 'history' | 'new';
type ScanState = 'running' | 'paused' | 'completed';
type StudyScanIssue = {
  siteId: string;
  url: string;
  message: string;
  level: 'error' | 'warning';
};
const tabs: {
  id: Exclude<View, 'new'>;
  label: string;
  icon: typeof Network;
}[] = [
  { id: 'map', label: 'Mapa', icon: Network },
  { id: 'results', label: 'Odkazy', icon: List },
  { id: 'history', label: 'Historie', icon: History },
];
const initialDomains = ['atlas.example', 'journal.example', 'objects.example'];

function formatPageCount(count: number): string {
  const label =
    count === 1 ? 'stránka' : count >= 2 && count <= 4 ? 'stránky' : 'stránek';
  return `${count} ${label}`;
}

function runLinkCount(currentRun: number, selectedRun: number, total: number) {
  return Math.max(1, total - (currentRun - selectedRun) * 3);
}

function normalizeDomain(value: string): string {
  const trimmed = value.trim();
  const url = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !url.hostname.includes('.') ||
    url.username ||
    url.password ||
    url.port
  ) {
    throw new Error('Invalid public web address');
  }
  return url.hostname;
}

function createDataset(domains: string[]): GraphDataset {
  const scannedIds = demoDataset.sites
    .slice(0, domains.length)
    .map((site) => site.id);
  const sites = demoDataset.sites.map((site, index) => ({
    ...site,
    domain: domains[index] ?? site.domain,
    scanned: scannedIds.includes(site.id),
  }));
  const links = demoDataset.links.filter((link) =>
    scannedIds.includes(link.source.siteId),
  );
  const usedPages = new Set(
    links.flatMap((link) => [link.source.id, link.target.id]),
  );
  const usedSites = new Set(
    links.flatMap((link) => [link.source.siteId, link.target.siteId]),
  );
  return {
    sites: sites.filter((site) => site.scanned || usedSites.has(site.id)),
    links,
    pages: demoDataset.pages.filter((page) => usedPages.has(page.id)),
  };
}

function Brand() {
  return (
    <a className="ux-brand" href="/ux" aria-label="Vizlinx – přehled UX návrhů">
      vizlinx<span>.</span>
    </a>
  );
}

function ThemeButton() {
  const { theme, toggleTheme } = useTheme();
  return (
    <button
      className="ux-icon"
      onClick={toggleTheme}
      aria-label={theme === 'signal' ? 'Noční režim' : 'Denní režim'}
    >
      {theme === 'signal' ? <Moon size={18} /> : <Sun size={18} />}
    </button>
  );
}

function SiteDot({ site }: { site: Site }) {
  return (
    <span
      className="ux-site-dot"
      style={{
        color: site.color,
        background: `color-mix(in srgb, ${site.color} 10%, var(--surface))`,
      }}
    >
      {site.domain[0].toUpperCase()}
    </span>
  );
}

export default function UxStudies() {
  const variant = Number(window.location.pathname.split('/')[2]);
  const concept = concepts.find((item) => item.id === variant);
  const [domains, setDomains] = useState(() =>
    variant === 2 ? initialDomains.slice(0, 2) : initialDomains,
  );
  if (!concept) return <Gallery />;
  return (
    <GraphDataProvider dataset={createDataset(domains)} live={false}>
      <Study
        variant={concept.id}
        domains={domains}
        onDomainsChange={setDomains}
      />
    </GraphDataProvider>
  );
}

function Gallery() {
  return (
    <div className="ux ux-gallery">
      <header className="ux-gallery-header">
        <Brand />
        <span>Studie uživatelského zážitku</span>
        <ThemeButton />
      </header>
      <main>
        <div className="ux-kicker">VIZLINX / TŘI SMĚRY</div>
        <h1>
          Stejné barvy.
          <br />
          <span>Jasnější souvislosti.</span>
        </h1>
        <p className="ux-gallery-intro">
          Tři způsoby, jak dát mapě prostor a ovládání řád.
          <br />
          Otevři si návrh a projdi celý zážitek od zadání webů po výsledky.
        </p>
        <div className="ux-concepts">
          {concepts.map((concept) => (
            <a
              className="ux-concept"
              href={`/ux/${concept.id}`}
              key={concept.id}
            >
              <div className="ux-concept-preview">
                <img
                  src={`/ux-previews/${concept.id}.png`}
                  alt={`Náhled návrhu ${concept.name}`}
                />
                <span>0{concept.id}</span>
              </div>
              <div className="ux-concept-copy">
                <div className="ux-concept-tag">
                  <concept.icon size={15} />
                  {concept.benefit}
                </div>
                <h2>
                  {concept.name}
                  <ArrowUpRight size={22} />
                </h2>
                <p>{concept.description}</p>
                <strong>
                  Prozkoumat návrh <ArrowRight size={16} />
                </strong>
              </div>
            </a>
          ))}
        </div>
        <div className="ux-gallery-note">
          <CircleHelp size={18} />
          <p>
            Interaktivní návrhy s ukázkovými daty. Vyzkoušej mapu, detail vazby,
            hledání, export, pauzu, historii i založení nové mapy. Přepínač
            vpravo nahoře zachovává oba současné barevné režimy.
          </p>
        </div>
      </main>
      <footer>
        <span>Signal & Midnight · původní paleta Vizlinx</span>
        <a href="/">
          Současná aplikace <ArrowUpRight size={14} />
        </a>
      </footer>
    </div>
  );
}

function Study({
  variant,
  domains,
  onDomainsChange,
}: {
  variant: number;
  domains: string[];
  onDomainsChange: (domains: string[]) => void;
}) {
  const { sites, links, pages, pageUrl, aggregateConnections } = useGraphData();
  const [view, setView] = useState<View>('map');
  const [selection, setSelection] = useState<Selection | null>(
    variant === 1 && window.innerWidth > 680
      ? { type: 'site', id: 'atlas' }
      : null,
  );
  const [expanded, setExpanded] = useState<string[]>([]);
  const [showExternal, setShowExternal] = useState(true);
  const [state, setState] = useState<ScanState>('completed');
  const [pausedSites, setPausedSites] = useState<string[]>([]);
  const [activeSites, setActiveSites] = useState<string[]>([]);
  const [intervals, setIntervals] = useState<Record<string, number>>({
    atlas: 3,
    journal: 3,
    objects: 3,
  });
  const [query, setQuery] = useState('');
  const [nofollow, setNofollow] = useState(false);
  const [resetKey, setResetKey] = useState(0);
  const [archivedRun, setArchivedRun] = useState<number | null>(null);
  const archived = archivedRun !== null;
  const [run, setRun] = useState(variant === 2 ? 6 : 3);
  const [logOpen, setLogOpen] = useState(false);
  const [toast, setToast] = useState('');
  const [sitesOpen, setSitesOpen] = useState(false);
  const [siteQuery, setSiteQuery] = useState('');
  const [addingSite, setAddingSite] = useState(false);
  const scanned = sites.filter((site) => site.scanned);
  const listedSites = scanned.filter((site) =>
    `${site.domain} ${site.name}`
      .toLowerCase()
      .includes(siteQuery.trim().toLowerCase()),
  );
  const currentLinks = archived
    ? links.slice(0, runLinkCount(run, archivedRun, links.length))
    : links;
  const loadedPageIds = new Set(currentLinks.map((link) => link.source.id));
  const scanIssues: StudyScanIssue[] =
    variant === 2
      ? pages
          .filter(
            (page) =>
              scanned.some((site) => site.id === page.siteId) &&
              !loadedPageIds.has(page.id),
          )
          .slice(0, 3)
          .map((page, index) => ({
            siteId: page.siteId,
            url: pageUrl(page),
            message: [
              'HTTP 404 · stránka nenalezena',
              'Chyba sítě · vypršel čas načítání',
              'Vynecháno · zakázáno robots.txt',
            ][index],
            level: index === 2 ? 'warning' : 'error',
          }))
      : [];
  const errorCount = scanIssues.filter(
    (issue) => issue.level === 'error',
  ).length;
  const visibleSites = sites.filter((site) => site.scanned || showExternal);
  const visibleIds = new Set(visibleSites.map((site) => site.id));
  const visibleLinks = currentLinks.filter(
    (link) =>
      visibleIds.has(link.source.siteId) && visibleIds.has(link.target.siteId),
  );
  const filtered = visibleLinks.filter(
    (link) =>
      (!nofollow || link.rel.split(/\s+/).includes('nofollow')) &&
      `${pageUrl(link.source)} ${pageUrl(link.target)} ${link.anchor}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const connections = aggregateConnections(visibleLinks).sort(
    (a, b) => b.links.length - a.links.length,
  );
  const pageCount = pages.filter((page) =>
    scanned.some((site) => site.id === page.siteId),
  ).length;
  const scanLabel = archived
    ? `Archiv · sken #${archivedRun}`
    : state === 'completed'
      ? 'Sken dokončen'
      : state === 'paused'
        ? 'Sken pozastaven'
        : 'Skenování probíhá';

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(''), 3500);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const select = (next: Selection) => {
    setSelection(next);
    setSitesOpen(false);
  };
  const expand = (ids: string[]) => {
    setExpanded(ids);
    setView('map');
  };
  const start = () => {
    setArchivedRun(null);
    setState('running');
    if (variant === 2) {
      setActiveSites(scanned.map((site) => site.id));
      setPausedSites([]);
    }
    setRun((previous) => previous + 1);
    setToast(
      'Ukázka nového skenu spuštěna. Můžeš ji pozastavit nebo otevřít průběh.',
    );
  };
  const siteState = (id: string): ScanState => {
    if (archived || !activeSites.includes(id)) return 'completed';
    return state === 'paused' || pausedSites.includes(id)
      ? 'paused'
      : 'running';
  };
  const toggleSiteScan = (site: Site) => {
    if (archived) return;
    const currentState = siteState(site.id);
    if (currentState === 'completed') {
      setActiveSites((previous) => [...previous, site.id]);
      setPausedSites((previous) => previous.filter((id) => id !== site.id));
      if (state === 'completed') setRun((previous) => previous + 1);
      setState('running');
      setToast(`Ukázkové skenování webu ${site.domain} spuštěno znovu.`);
      return;
    }
    if (currentState === 'paused') {
      setPausedSites((previous) => previous.filter((id) => id !== site.id));
      setState('running');
      return;
    }
    const nextPaused = [...pausedSites, site.id];
    setPausedSites(nextPaused);
    if (activeSites.every((id) => nextPaused.includes(id))) setState('paused');
  };
  const exportCsv = () => {
    const rows = [
      ['source_url', 'target_url', 'anchor', 'rel', 'data_source'],
      ...filtered.map((link) => [
        pageUrl(link.source),
        pageUrl(link.target),
        link.anchor,
        link.rel,
        'ux_mockup',
      ]),
    ];
    const csv =
      '\uFEFF' +
      rows
        .map((row) =>
          row
            .map(
              (value) =>
                `"${(/^[=+\-@\t\r\n]/.test(value) ? "'" : '') + value.replaceAll('"', '""')}"`,
            )
            .join(','),
        )
        .join('\r\n');
    const url = URL.createObjectURL(
      new Blob([csv], { type: 'text/csv;charset=utf-8' }),
    );
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'vizlinx-ukazkove-odkazy.csv';
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setToast(`Exportováno ${filtered.length} ukázkových vazeb.`);
  };
  const primaryAction = (
    <button
      className="ux-button ux-primary"
      disabled={archived}
      onClick={
        state === 'completed'
          ? start
          : () => {
              if (variant === 2) {
                setPausedSites(state === 'running' ? activeSites : []);
              }
              setState(state === 'running' ? 'paused' : 'running');
            }
      }
    >
      {state === 'running' ? <Pause size={15} /> : <Play size={15} />}
      {state === 'completed'
        ? 'Skenovat znovu'
        : state === 'running'
          ? 'Pozastavit'
          : 'Pokračovat'}
    </button>
  );
  const status = (
    <span
      className={`ux-status ${state === 'running' && !archived ? 'is-running' : ''}`}
    >
      {state === 'completed' || archived ? (
        <Check size={14} />
      ) : (
        <span className="ux-status-dot" />
      )}
      {scanLabel}
    </span>
  );
  const navigation = (
    <nav className="ux-tabs" aria-label="Zobrazení mapy">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          aria-current={view === tab.id ? 'page' : undefined}
          onClick={() => {
            setView(tab.id);
            setSelection(null);
          }}
        >
          <tab.icon size={16} />
          {tab.label}
          {tab.id === 'results' && <span>{visibleLinks.length}</span>}
          {tab.id === 'history' && variant === 2 && (
            <span>{Math.min(run, 10)}</span>
          )}
        </button>
      ))}
    </nav>
  );
  const externalToggle = (
    <label className="ux-switch">
      <input
        type="checkbox"
        checked={showExternal}
        onChange={(event) => {
          setShowExternal(event.target.checked);
          setSelection(null);
        }}
      />
      <span />
      Další odkazované weby
    </label>
  );
  const graph = (
    <div className="ux-canvas">
      <Graph
        sites={visibleSites}
        links={visibleLinks}
        selection={selection}
        onSelect={select}
        expanded={expanded}
        focusedExpanded={expanded}
        onFocusSite={(id) => expand([id])}
        onExpandedChange={expand}
        running={state === 'running' && !archived}
        resetKey={resetKey}
        connectionStyle="silk"
      />
    </div>
  );
  const detail = selection && (
    <Detail
      selection={selection}
      links={currentLinks}
      expanded={expanded}
      onExpand={expand}
      onSelect={select}
      onClose={() => setSelection(null)}
    />
  );
  const siteList = (
    <div className="ux-sites-content">
      <div className="ux-section-label">
        <span>SKENOVANÉ WEBY</span>
        <span>
          {variant === 2
            ? `${scanned.length} ze 3 webů`
            : `${scanned.length}/3`}
        </span>
      </div>
      {variant === 2 && (
        <label className="ux-site-search">
          <Search size={14} aria-hidden="true" />
          <input
            type="search"
            aria-label="Najít doménu"
            placeholder="Najít doménu…"
            value={siteQuery}
            onChange={(event) => setSiteQuery(event.target.value)}
          />
        </label>
      )}
      {listedSites.map((site) =>
        variant === 2 ? (
          <ScannedSiteRow
            key={site.id}
            site={site}
            state={siteState(site.id)}
            selected={selection?.type === 'site' && selection.id === site.id}
            disabled={archived}
            loadedPages={
              new Set(
                currentLinks
                  .filter((link) => link.source.siteId === site.id)
                  .map((link) => link.source.id),
              ).size
            }
            knownUrls={pages.filter((page) => page.siteId === site.id).length}
            onSelect={() => {
              select({ type: 'site', id: site.id });
              setView('map');
            }}
            onAction={() => toggleSiteScan(site)}
          />
        ) : (
          <div
            className={`ux-site-row ${selection?.type === 'site' && selection.id === site.id ? 'is-selected' : ''}`}
            key={site.id}
          >
            <button
              onClick={() => {
                select({ type: 'site', id: site.id });
                setView('map');
              }}
            >
              <SiteDot site={site} />
              <span>
                <strong>{site.domain}</strong>
                <small>
                  {pausedSites.includes(site.id)
                    ? 'Pozastaveno'
                    : `${pages.filter((page) => page.siteId === site.id).length} stránek prozkoumáno`}
                </small>
              </span>
            </button>
            <button
              className="ux-icon ux-site-pause"
              disabled={archived}
              aria-label={`${pausedSites.includes(site.id) ? 'Povolit' : 'Pozastavit'} ${site.domain}`}
              onClick={() =>
                setPausedSites((previous) =>
                  previous.includes(site.id)
                    ? previous.filter((id) => id !== site.id)
                    : [...previous, site.id],
                )
              }
            >
              {pausedSites.includes(site.id) ? (
                <Play size={13} />
              ) : (
                <Pause size={13} />
              )}
            </button>
          </div>
        ),
      )}
      {variant === 2 && listedSites.length === 0 && (
        <p className="ux-site-note" role="status">
          Žádný web neodpovídá hledání.
        </p>
      )}
      <button
        className="ux-add-site"
        disabled={variant === 2 && (archived || scanned.length >= 3)}
        aria-expanded={variant === 2 ? addingSite : undefined}
        onClick={() => {
          if (variant === 2) {
            setAddingSite(!addingSite);
            return;
          }
          setView('new');
          setSitesOpen(false);
        }}
      >
        <Plus size={15} />
        {variant === 2 ? 'Přidat web' : 'Nová sestava webů'}
      </button>
      {variant === 2 && scanned.length >= 3 && (
        <p className="ux-site-note">V mapě mohou být nejvýše 3 weby.</p>
      )}
      {variant === 2 && addingSite && !archived && scanned.length < 3 && (
        <AddSiteForm
          domains={domains}
          onCancel={() => setAddingSite(false)}
          onAdd={(domain) => {
            onDomainsChange([...domains, domain]);
            setAddingSite(false);
            setSiteQuery('');
            setToast(`Web ${domain} přidán do současné mapy.`);
          }}
        />
      )}
      <details className="ux-settings">
        <summary>
          <Settings2 size={15} />
          Nastavení skenu
          <ChevronDown size={14} />
        </summary>
        <p>Interval požadavků pro každý web</p>
        {scanned.map((site) => (
          <label key={site.id}>
            {site.domain}
            <select
              aria-label={`Interval ${site.domain}`}
              value={intervals[site.id] ?? 3}
              disabled={archived}
              onChange={(event) =>
                setIntervals({
                  ...intervals,
                  [site.id]: Number(event.target.value),
                })
              }
            >
              {[1, 3, 5, 10, 30, 60].map((value) => (
                <option key={value} value={value}>
                  {value} s
                </option>
              ))}
            </select>
          </label>
        ))}
        <small>
          Nejvýše 100 stránek na web.
          <br />
          Veřejné HTML, bez JavaScriptu.
        </small>
      </details>
    </div>
  );
  const activity = (
    <button
      className="ux-activity"
      aria-label="Průběh skenu"
      onClick={() => setLogOpen(true)}
    >
      <span className="ux-activity-symbol">
        <Activity size={18} />
      </span>
      <span>
        <strong>
          {state === 'running'
            ? 'Procházíme tvoje weby'
            : state === 'paused'
              ? 'Pokračuj, až budeš chtít'
              : 'Všechny výsledky uloženy'}
        </strong>
        <small>
          {pageCount} stránek · {currentLinks.length} vazeb
        </small>
      </span>
      <ChevronRight size={16} />
    </button>
  );

  return (
    <div className={`ux ux-study ux-variant-${variant}`}>
      <div className="ux-study-bar">
        <a href="/ux">
          <ArrowLeft size={13} />
          <span>Všechny návrhy</span>
        </a>
        <div className="ux-variant-switch">
          {concepts.map((concept) => (
            <a
              href={`/ux/${concept.id}`}
              key={concept.id}
              aria-current={variant === concept.id ? 'page' : undefined}
            >
              <span>0{concept.id}</span>
              {concept.short}
            </a>
          ))}
        </div>
        <span className="ux-study-label">UX studie · ukázková data</span>
      </div>
      <header className="ux-topbar">
        <Brand />
        <div className="ux-project-crumb">
          <span>Moje mapy</span>
          <ChevronRight size={14} />
          <strong>Studio Atlas</strong>
        </div>
        <div className="ux-topbar-actions">
          <button
            className="ux-button ux-new-button"
            onClick={() => setView('new')}
          >
            <Plus size={16} />
            Nová mapa
          </button>
          <ThemeButton />
        </div>
      </header>
      {view === 'new' ? (
        <NewMap
          variant={variant}
          domains={domains}
          onCancel={() => setView('map')}
          onStart={(next) => {
            onDomainsChange(next);
            setArchivedRun(null);
            setState('running');
            if (variant === 2) {
              setActiveSites(
                demoDataset.sites.slice(0, next.length).map((site) => site.id),
              );
              setPausedSites([]);
            }
            setRun(1);
            setSelection(null);
            setExpanded([]);
            setView('map');
            setQuery('');
            setSiteQuery('');
            setAddingSite(false);
            setToast(
              'Ukázková mapa vytvořena. Na zadané weby neodesíláme požadavky.',
            );
          }}
        />
      ) : (
        <>
          {variant === 1 && (
            <div className="ux-workbench">
              <aside className="ux-sidebar">
                <div className="ux-project-card">
                  <span className="ux-project-icon">
                    <Network size={21} />
                  </span>
                  <div>
                    <strong>Studio Atlas</strong>
                    <small>Mapa propojení webů</small>
                  </div>
                </div>
                {siteList}
                <div className="ux-sidebar-bottom">
                  {activity}
                  <p>
                    <ShieldCheck size={13} />
                    Soukromé v tomto prohlížeči
                  </p>
                </div>
              </aside>
              <main className="ux-workbench-main">
                <div className="ux-page-heading">
                  <div>
                    <div className="ux-kicker">TVŮJ WEB V SOUVISLOSTECH</div>
                    <h1>Studio Atlas</h1>
                    <p>
                      {pageCount} prozkoumaných stránek <span>·</span>{' '}
                      {connections.length} směrových propojení
                    </p>
                  </div>
                  <div className="ux-heading-actions">
                    {status}
                    {primaryAction}
                  </div>
                </div>
                <div className="ux-view-toolbar">
                  {navigation}
                  <div className="ux-view-tools">
                    {view === 'map' && externalToggle}
                    <button
                      className="ux-icon"
                      onClick={exportCsv}
                      aria-label="Exportovat odkazy do CSV"
                    >
                      <ArrowDownToLine size={17} />
                    </button>
                  </div>
                </div>
                {archived && (
                  <ArchiveNotice
                    onReturn={() => {
                      setArchivedRun(null);
                      setSelection(null);
                    }}
                  />
                )}
                <div className="ux-workbench-content">
                  {view === 'map' ? (
                    <>
                      {graph}
                      {detail ?? (
                        <div className="ux-detail-placeholder">
                          <Link2 size={28} />
                          <h2>Každý odkaz má příběh.</h2>
                          <p>
                            Vyber web nebo spojnici a prozkoumej, co je
                            propojuje.
                          </p>
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="ux-content-page">
                      {view === 'results' ? (
                        <Results
                          links={filtered}
                          query={query}
                          onQuery={setQuery}
                          nofollow={nofollow}
                          onNofollow={setNofollow}
                          onExport={exportCsv}
                          onSelect={select}
                        />
                      ) : (
                        <RunHistory
                          run={run}
                          state={state}
                          count={links.length}
                          onOpen={(old) => {
                            setArchivedRun(old === run ? null : old);
                            setView('map');
                            setSelection(null);
                          }}
                        />
                      )}
                      {detail}
                    </div>
                  )}
                </div>
                <div className="ux-footline">
                  <span>
                    <Check size={13} />
                    {archived
                      ? 'Archiv pouze ke čtení'
                      : 'Uloženo v tomto prohlížeči'}
                  </span>
                  <button onClick={() => setLogOpen(true)}>
                    <Activity size={13} />
                    Průběh skenu
                    <ChevronRight size={13} />
                  </button>
                </div>
              </main>
            </div>
          )}

          {variant === 2 && (
            <main
              className={`ux-immersive ${view !== 'map' ? 'has-sheet' : ''} ${selection ? 'has-selection' : ''}`}
            >
              <div className="ux-immersive-canvas">{graph}</div>
              <div className="ux-floating-heading">
                <div>
                  <h1>Studio Atlas</h1>
                  <span>
                    {connections.length} propojení. Jeden společný příběh.
                  </span>
                </div>
                {status}
              </div>
              <aside
                className={`ux-floating-sites ${sitesOpen ? 'is-open' : ''}`}
              >
                <button
                  className="ux-mobile-sites-toggle"
                  aria-expanded={sitesOpen}
                  onClick={() => setSitesOpen(!sitesOpen)}
                >
                  <Globe2 size={16} />
                  Skenované weby · {scanned.length} ze 3
                  <ChevronDown size={14} />
                </button>
                {siteList}
              </aside>
              <div className="ux-floating-options">
                {externalToggle}
                <button
                  className="ux-icon"
                  onClick={() => {
                    setResetKey((previous) => previous + 1);
                    setExpanded([]);
                    setSelection(null);
                  }}
                  aria-label="Obnovit rozložení mapy"
                >
                  <Maximize2 size={16} />
                </button>
              </div>
              {view === 'map' && detail && (
                <div className="ux-floating-detail">{detail}</div>
              )}
              {view !== 'map' && (
                <section
                  className={`ux-bottom-sheet ${view === 'history' ? 'ux-history-sheet' : ''}`}
                >
                  <div className="ux-sheet-heading">
                    <span>
                      {view === 'results'
                        ? 'Každý odkaz, přehledně.'
                        : 'Historie skenů'}
                    </span>
                    <button
                      className="ux-icon"
                      onClick={() => setView('map')}
                      aria-label="Zavřít panel"
                    >
                      <X size={18} />
                    </button>
                  </div>
                  {view === 'results' ? (
                    <Results
                      links={filtered}
                      query={query}
                      onQuery={setQuery}
                      nofollow={nofollow}
                      onNofollow={setNofollow}
                      onExport={exportCsv}
                      onSelect={select}
                    />
                  ) : (
                    <RunHistory
                      compact
                      run={run}
                      state={state}
                      count={links.length}
                      onOpen={(old) => {
                        setArchivedRun(old === run ? null : old);
                        setView('map');
                        setSelection(null);
                      }}
                    />
                  )}
                  {detail}
                </section>
              )}
              {archived && (
                <div className="ux-floating-archive">
                  <ArchiveNotice onReturn={() => setArchivedRun(null)} />
                </div>
              )}
              <div className="ux-map-dock">
                {navigation}
                <span className="ux-dock-divider" />
                <div className="ux-dock-scan">
                  <div className="ux-dock-scan-actions">
                    <button
                      className="ux-progress-button"
                      aria-label="Průběh skenu"
                      aria-describedby="ux-scan-error-count"
                      onClick={() => setLogOpen(true)}
                    >
                      {state === 'running' && !archived ? (
                        <LoaderCircle
                          className="ux-scan-spinner"
                          size={17}
                          aria-hidden="true"
                        />
                      ) : state === 'paused' && !archived ? (
                        <Pause size={17} aria-hidden="true" />
                      ) : (
                        <Activity size={17} aria-hidden="true" />
                      )}
                      Průběh skenu
                      <span
                        id="ux-scan-error-count"
                        className={`ux-error-count ${errorCount ? 'has-errors' : ''}`}
                      >
                        <span className="ux-sr-only">Počet chyb: </span>
                        {errorCount}
                      </span>
                    </button>
                    {primaryAction}
                  </div>
                  <div className="ux-dock-scan-summary">
                    <span>Načteno {loadedPageIds.size}</span>
                    <span>·</span>
                    <span>Neúspěšné / vynechané: {scanIssues.length}</span>
                  </div>
                </div>
              </div>
              <details className="ux-canvas-note">
                <summary>
                  <ShieldCheck size={12} />
                  Přístup k mapě je vázaný na tento prohlížeč.
                  <CircleHelp size={12} />
                </summary>
                <p>
                  Výsledky se ukládají na serveru na 30 dní od založení mapy.
                  Smazáním dat prohlížeče můžeš ztratit přístup.
                </p>
              </details>
            </main>
          )}

          {variant === 3 && (
            <main className="ux-report">
              <div className="ux-report-heading">
                <div>
                  <div className="ux-kicker">PŘEHLED MAPY / STUDIO ATLAS</div>
                  <h1>
                    Weby, které spolu souvisí<span>.</span>
                  </h1>
                  <p>Od celkového obrazu ke konkrétnímu odkazu.</p>
                </div>
                <div className="ux-heading-actions">
                  {status}
                  {primaryAction}
                </div>
              </div>
              <div className="ux-stat-grid">
                <Stat
                  icon={<Globe2 size={21} />}
                  value={String(scanned.length)}
                  label="prozkoumané weby"
                  note="Každý má svůj prostor v mapě"
                />
                <Stat
                  icon={<FileText size={21} />}
                  value={String(pageCount)}
                  label="načtených stránek"
                  note="Z jejich veřejného HTML"
                />
                <Stat
                  icon={<Link2 size={21} />}
                  value={String(currentLinks.length)}
                  label="nalezených vazeb"
                  note={`${connections.length} směrových propojení mezi weby`}
                />
              </div>
              <div className="ux-report-sites">
                <span>TVOJE WEBY</span>
                {scanned.map((site) => (
                  <button
                    key={site.id}
                    onClick={() => {
                      select({ type: 'site', id: site.id });
                      setView('map');
                    }}
                  >
                    <SiteDot site={site} />
                    {site.domain}
                    <ChevronRight size={13} />
                  </button>
                ))}
                <button
                  className="ux-icon"
                  onClick={() => setSitesOpen(!sitesOpen)}
                  aria-label="Nastavení webů"
                >
                  <Settings2 size={17} />
                </button>
              </div>
              {sitesOpen && (
                <aside className="ux-report-settings">{siteList}</aside>
              )}
              <div className="ux-report-nav">
                {navigation}
                <button className="ux-button" onClick={exportCsv}>
                  <ArrowDownToLine size={15} />
                  Export CSV
                </button>
              </div>
              {archived && (
                <ArchiveNotice onReturn={() => setArchivedRun(null)} />
              )}
              {view === 'map' ? (
                <div className="ux-report-grid">
                  <section className="ux-report-map">
                    <div className="ux-panel-title">
                      <div>
                        <h2>Jak jsou weby propojené</h2>
                        <p>Klikni na web nebo na počet vazeb.</p>
                      </div>
                      {externalToggle}
                    </div>
                    {graph}
                  </section>
                  <section className="ux-relationships">
                    {detail ?? (
                      <>
                        <div className="ux-panel-title">
                          <div>
                            <h2>Nejsilnější propojení</h2>
                            <p>Seřazeno podle počtu nalezených vazeb</p>
                          </div>
                          <Link2 size={19} />
                        </div>
                        <div className="ux-ranked-links">
                          {connections.slice(0, 5).map((connection, index) => (
                            <button
                              key={connection.id}
                              onClick={() =>
                                select({
                                  type: 'connection',
                                  id: connection.id,
                                })
                              }
                            >
                              <span className="ux-rank">0{index + 1}</span>
                              <div>
                                <strong>{connection.source.domain}</strong>
                                <small>
                                  <ArrowRight size={12} />
                                  {connection.target.domain}
                                </small>
                                <span
                                  className="ux-strength"
                                  style={{
                                    width: `${(connection.links.length / (connections[0]?.links.length || 1)) * 100}%`,
                                    background: connection.source.color,
                                  }}
                                />
                              </div>
                              <span className="ux-count">
                                {connection.links.length}
                                <ChevronRight size={13} />
                              </span>
                            </button>
                          ))}
                        </div>
                        <button
                          className="ux-all-links"
                          onClick={() => setView('results')}
                        >
                          Prohlédnout všech {visibleLinks.length} vazeb
                          <ArrowRight size={16} />
                        </button>
                      </>
                    )}
                  </section>
                </div>
              ) : (
                <section className="ux-report-data">
                  {view === 'results' ? (
                    <Results
                      links={filtered}
                      query={query}
                      onQuery={setQuery}
                      nofollow={nofollow}
                      onNofollow={setNofollow}
                      onExport={exportCsv}
                      onSelect={select}
                    />
                  ) : (
                    <RunHistory
                      run={run}
                      state={state}
                      count={links.length}
                      onOpen={(old) => {
                        setArchivedRun(old === run ? null : old);
                        setView('map');
                        setSelection(null);
                      }}
                    />
                  )}
                  {detail}
                </section>
              )}
              <div className="ux-report-bottom">
                {activity}
                <p>
                  <ShieldCheck size={16} />
                  Výsledky patří tomuto prohlížeči. Uchováváme je 30 dní od
                  založení mapy.
                </p>
              </div>
            </main>
          )}
        </>
      )}
      {logOpen && (
        <LogDialog
          sites={scanned}
          state={archived ? 'completed' : state}
          count={variant === 2 ? loadedPageIds.size : pageCount}
          issues={scanIssues}
          onClose={() => setLogOpen(false)}
          onComplete={() => {
            setState('completed');
            if (variant === 2) {
              setActiveSites([]);
              setPausedSites([]);
            }
            setToast('Ukázkový sken dokončen. Výsledky jsou připravené.');
          }}
        />
      )}
      {toast && (
        <div className="ux-toast" role="status">
          <Check size={17} />
          {toast}
          <button
            className="ux-icon"
            onClick={() => setToast('')}
            aria-label="Zavřít oznámení"
          >
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  );
}

function ArchiveNotice({ onReturn }: { onReturn: () => void }) {
  return (
    <div className="ux-archive-notice">
      <History size={15} />
      <span>Prohlížíš starší průchod. Výsledky jsou pouze ke čtení.</span>
      <button onClick={onReturn}>
        Zpět k aktuálnímu
        <ArrowRight size={14} />
      </button>
    </div>
  );
}

function Stat({
  icon,
  value,
  label,
  note,
}: {
  icon: ReactNode;
  value: string;
  label: string;
  note: string;
}) {
  return (
    <div className="ux-stat">
      <div className="ux-stat-icon">{icon}</div>
      <div>
        <strong>{value}</strong>
        <span>{label}</span>
        <small>{note}</small>
      </div>
    </div>
  );
}

function Detail({
  selection,
  links,
  expanded,
  onExpand,
  onSelect,
  onClose,
}: {
  selection: Selection;
  links: Link[];
  expanded: string[];
  onExpand: (ids: string[]) => void;
  onSelect: (selection: Selection) => void;
  onClose: () => void;
}) {
  const { getSite, getPage, pageUrl, aggregateConnections, pages } =
    useGraphData();
  const site = selection.type === 'site' ? getSite(selection.id) : null;
  const link =
    selection.type === 'link'
      ? links.find((item) => item.id === selection.id)
      : null;
  const page = selection.type === 'page' ? getPage(selection.id) : null;
  const selectedLinks = site
    ? links.filter(
        (item) =>
          item.source.siteId === site.id || item.target.siteId === site.id,
      )
    : page
      ? links.filter(
          (item) => item.source.id === page.id || item.target.id === page.id,
        )
      : links.filter(
          (item) =>
            `${item.source.siteId}:${item.target.siteId}` === selection.id,
        );
  const connection =
    selection.type === 'connection'
      ? aggregateConnections(selectedLinks)[0]
      : null;
  return (
    <aside className="ux-detail" aria-label="Detail výběru">
      <div className="ux-detail-top">
        <span>
          {site
            ? 'DETAIL WEBU'
            : link
              ? 'DETAIL ODKAZU'
              : page
                ? 'DETAIL STRÁNKY'
                : 'DETAIL PROPOJENÍ'}
        </span>
        <button
          className="ux-icon"
          onClick={onClose}
          aria-label="Zavřít detail"
        >
          <X size={17} />
        </button>
      </div>
      {site ? (
        <>
          <SiteDot site={site} />
          <h2>{site.domain}</h2>
          <p>
            {site.scanned
              ? 'Prozkoumaný web'
              : 'Objevený web · zatím neprozkoumán'}
          </p>
          <div className="ux-detail-stats">
            <div>
              <strong>
                {links.filter((item) => item.source.siteId === site.id).length}
              </strong>
              <span>odchozích vazeb</span>
            </div>
            <div>
              <strong>
                {links.filter((item) => item.target.siteId === site.id).length}
              </strong>
              <span>příchozích vazeb</span>
            </div>
          </div>
          <button
            className="ux-button ux-soft ux-full"
            onClick={() =>
              onExpand(
                expanded.includes(site.id)
                  ? expanded.filter((id) => id !== site.id)
                  : [...expanded, site.id],
              )
            }
          >
            <Maximize2 size={15} />
            {expanded.includes(site.id)
              ? 'Sbalit stránky'
              : `Prozkoumat ${pages.filter((item) => item.siteId === site.id).length} stránek`}
          </button>
          <h3>Propojené weby</h3>
          {aggregateConnections(selectedLinks).map((item) => (
            <button
              className="ux-related-row"
              key={item.id}
              onClick={() => onSelect({ type: 'connection', id: item.id })}
            >
              <span>
                <strong>
                  {item.source.id === site.id
                    ? item.target.domain
                    : item.source.domain}
                </strong>
                <small>
                  {item.source.id === site.id ? 'Odchozí' : 'Příchozí'}
                </small>
              </span>
              <b>{item.links.length}</b>
              <ChevronRight size={14} />
            </button>
          ))}
        </>
      ) : link ? (
        <>
          <h2>Odkud a kam</h2>
          <div className="ux-url-step">
            <span>ZDROJ</span>
            <strong>{getSite(link.source.siteId).domain}</strong>
            <code>{link.source.path}</code>
          </div>
          <div className="ux-url-arrow">
            <ArrowRight size={19} />
          </div>
          <div className="ux-url-step">
            <span>CÍL</span>
            <strong>{getSite(link.target.siteId).domain}</strong>
            <code>{link.target.path}</code>
          </div>
          <dl className="ux-metadata">
            <div>
              <dt>Text odkazu</dt>
              <dd>{link.anchor}</dd>
            </div>
            <div>
              <dt>Umístění</dt>
              <dd>{link.region}</dd>
            </div>
            <div>
              <dt>Atributy</dt>
              <dd>{link.rel || 'Bez atributu rel'}</dd>
            </div>
            <div>
              <dt>Výskyty na stránce</dt>
              <dd>{link.occurrences}</dd>
            </div>
          </dl>
          <button
            className="ux-button ux-soft ux-full"
            onClick={() => {
              onSelect({
                type: 'connection',
                id: `${link.source.siteId}:${link.target.siteId}`,
              });
              onExpand([link.source.siteId, link.target.siteId]);
            }}
          >
            <Network size={15} />
            Zobrazit stránky v mapě
          </button>
        </>
      ) : (
        <>
          <h2>
            {page
              ? page.title
              : connection
                ? connection.source.domain
                : 'Propojení'}
          </h2>
          <p className="ux-detail-direction">
            {page
              ? pageUrl(page)
              : connection && (
                  <>
                    <ArrowRight size={15} />
                    {connection.target.domain}
                  </>
                )}
          </p>
          <div className="ux-detail-total">
            <strong>{selectedLinks.length}</strong>
            <span>konkrétních vazeb</span>
          </div>
          {selectedLinks.map((item) => (
            <button
              className="ux-link-card"
              key={item.id}
              onClick={() => onSelect({ type: 'link', id: item.id })}
            >
              <span>
                {item.source.path}
                <ArrowRight size={12} />
                {item.target.path}
              </span>
              <strong>{item.anchor}</strong>
              <small>
                {item.region}
                <ChevronRight size={13} />
              </small>
            </button>
          ))}
        </>
      )}
      <div className="ux-detail-note">
        <CircleHelp size={13} />
        Ukázkové výsledky pro posouzení návrhu.
      </div>
    </aside>
  );
}

function Results({
  links,
  query,
  onQuery,
  nofollow,
  onNofollow,
  onExport,
  onSelect,
}: {
  links: Link[];
  query: string;
  onQuery: (value: string) => void;
  nofollow: boolean;
  onNofollow: (value: boolean) => void;
  onExport: () => void;
  onSelect: (selection: Selection) => void;
}) {
  const { pageUrl, getSite } = useGraphData();
  return (
    <section className="ux-results">
      <div className="ux-results-heading">
        <div>
          <h2>Každý odkaz má svůj zdroj.</h2>
          <p>Prohledej URL nebo text odkazu a rozklikni souvislosti.</p>
        </div>
      </div>
      <div className="ux-table-tools">
        <label className="ux-search">
          <Search size={16} />
          <input
            aria-label="Hledat v odkazech"
            placeholder="Hledat URL nebo text odkazu…"
            value={query}
            onChange={(event) => onQuery(event.target.value)}
          />
        </label>
        <button
          className={`ux-button ${nofollow ? 'ux-soft' : ''}`}
          aria-pressed={nofollow}
          onClick={() => onNofollow(!nofollow)}
        >
          <Settings2 size={15} />
          Jen nofollow
        </button>
        <button className="ux-button" onClick={onExport}>
          <ArrowDownToLine size={16} />
          Export CSV
        </button>
      </div>
      <div className="ux-table-scroll">
        <table>
          <thead>
            <tr>
              <th>Zdrojová stránka</th>
              <th>Cílová stránka</th>
              <th>Text odkazu</th>
              <th>Umístění</th>
              <th>
                <span className="ux-sr-only">Detail</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {links.map((link) => (
              <tr key={link.id}>
                <td>
                  <strong>{getSite(link.source.siteId).domain}</strong>
                  <span>{link.source.path}</span>
                </td>
                <td>
                  <strong>{getSite(link.target.siteId).domain}</strong>
                  <span>{link.target.path}</span>
                </td>
                <td>
                  {link.anchor}
                  {link.rel.includes('nofollow') && (
                    <small className="ux-rel">nofollow</small>
                  )}
                </td>
                <td>{link.region}</td>
                <td>
                  <button
                    className="ux-icon"
                    onClick={() => onSelect({ type: 'link', id: link.id })}
                    aria-label={`Detail odkazu ${pageUrl(link.source)} na ${pageUrl(link.target)}`}
                  >
                    <ArrowUpRight size={17} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {links.length === 0 && (
        <div className="ux-empty">
          <Search size={27} />
          <h3>Tady zatím nic není.</h3>
          <p>Zkus jiný výraz nebo zruš filtr nofollow.</p>
          <button
            className="ux-button ux-soft"
            onClick={() => {
              onQuery('');
              onNofollow(false);
            }}
          >
            Zrušit filtry
          </button>
        </div>
      )}
      <div className="ux-table-summary">
        {links.length} zobrazených vazeb
        <span>CSV respektuje zvolené filtry</span>
      </div>
    </section>
  );
}

function RunHistory({
  compact = false,
  run,
  state,
  count,
  onOpen,
}: {
  compact?: boolean;
  run: number;
  state: ScanState;
  count: number;
  onOpen: (run: number) => void;
}) {
  const offsets = Array.from(
    { length: Math.min(run, compact ? 10 : 2) },
    (_, index) => index,
  );
  const dateFormat = new Intl.DateTimeFormat('cs-CZ', {
    day: 'numeric',
    month: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Prague',
  });
  return (
    <section className={`ux-history ${compact ? 'ux-history-compact' : ''}`}>
      {compact ? (
        <div className="ux-history-caption">
          {offsets.length} průchodů · vyber výsledky k prohlédnutí
        </div>
      ) : (
        <>
          <div className="ux-kicker">HISTORIE MAPY</div>
          <h2>Každý průchod zůstává po ruce.</h2>
          <p>Otevři starší výsledky nebo se vrať k aktuálnímu skenu.</p>
        </>
      )}
      <div className="ux-run-list">
        {offsets.map((offset) => (
          <button
            className="ux-run"
            key={run - offset}
            onClick={() => onOpen(run - offset)}
          >
            <span className="ux-run-icon">
              {offset > 0 ? <History size={22} /> : <Check size={22} />}
            </span>
            <span>
              <strong>
                Sken #{run - offset}{' '}
                <span>{offset > 0 ? 'Archiv' : 'Aktuální'}</span>
              </strong>
              <small>
                {dateFormat.format(
                  new Date(Date.UTC(2026, 8, 14, 8, 42) - offset * 86400000),
                )}{' '}
                ·{' '}
                {offset > 0
                  ? 'Pouze ke čtení'
                  : state === 'completed'
                    ? 'Dokončeno'
                    : state === 'running'
                      ? 'Probíhá'
                      : 'Pozastaveno'}
              </small>
            </span>
            <b>{runLinkCount(run, run - offset, count)} vazeb</b>
            <ChevronRight size={20} />
          </button>
        ))}
      </div>
      <div className="ux-history-note">
        <Clock3 size={19} />
        <p>
          Nejvýše 10 průchodů na mapu. Historie se uchovává 30 dní od založení
          mapy; nový sken tuto dobu neprodlužuje.
        </p>
      </div>
    </section>
  );
}

function ScannedSiteRow({
  site,
  state,
  selected,
  disabled,
  loadedPages,
  knownUrls,
  onSelect,
  onAction,
}: {
  site: Site;
  state: ScanState;
  selected: boolean;
  disabled: boolean;
  loadedPages: number;
  knownUrls: number;
  onSelect: () => void;
  onAction: () => void;
}) {
  const action =
    state === 'completed'
      ? 'Skenovat znovu'
      : state === 'paused'
        ? 'Pokračovat'
        : 'Pozastavit';
  const ActionIcon =
    state === 'completed' ? RefreshCw : state === 'paused' ? Play : Pause;
  return (
    <div className={`ux-site-row ux-scan-row ${selected ? 'is-selected' : ''}`}>
      <SiteDot site={site} />
      <div className="ux-scan-site-info">
        <div className="ux-scan-site-heading">
          <button
            className="ux-scan-site-title"
            onClick={onSelect}
            title={site.domain}
          >
            <strong>{site.domain}</strong>
          </button>
          <ExternalLink url={site.origin ?? `https://${site.domain}`} />
        </div>
        <small>
          Celkem: {formatPageCount(loadedPages)} · {knownUrls} URL
        </small>
        {state !== 'completed' && (
          <small>
            {state === 'paused' ? 'Pozastaveno' : 'Skenování probíhá'}
          </small>
        )}
      </div>
      <button
        className="ux-icon ux-site-action"
        disabled={disabled}
        onClick={onAction}
        aria-label={`${action} ${site.domain}`}
        title={`${action} ${site.domain}`}
      >
        <ActionIcon size={14} aria-hidden="true" />
      </button>
    </div>
  );
}

function AddSiteForm({
  domains,
  onAdd,
  onCancel,
}: {
  domains: string[];
  onAdd: (domain: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (domains.length >= 3) return;
    try {
      const domain = normalizeDomain(value);
      if (domains.includes(domain)) {
        setError('Tento web už v mapě je. Zadej jiný.');
        return;
      }
      onAdd(domain);
    } catch {
      setError('Zadej veřejnou adresu webu, například tvuj-web.cz.');
    }
  };
  return (
    <form className="ux-add-site-form" onSubmit={submit}>
      <label htmlFor="ux-added-domain">Adresa webu</label>
      <input
        id="ux-added-domain"
        autoFocus
        autoCapitalize="none"
        spellCheck={false}
        required
        value={value}
        placeholder="tvuj-web.cz"
        aria-invalid={Boolean(error)}
        aria-describedby={error ? 'ux-added-domain-error' : undefined}
        onChange={(event) => {
          setValue(event.target.value);
          setError('');
        }}
      />
      <p className="ux-site-note">
        Přidá se do této mapy. Dosavadní výsledky zůstanou zachované.
      </p>
      {error && (
        <p id="ux-added-domain-error" className="ux-form-error" role="alert">
          {error}
        </p>
      )}
      <div>
        <button className="ux-button ux-primary" type="submit">
          Přidat do mapy
        </button>
        <button className="ux-button" type="button" onClick={onCancel}>
          Zrušit
        </button>
      </div>
    </form>
  );
}

function NewMap({
  variant,
  domains,
  onCancel,
  onStart,
}: {
  variant: number;
  domains: string[];
  onCancel: () => void;
  onStart: (domains: string[]) => void;
}) {
  const [values, setValues] = useState(domains);
  const [error, setError] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    try {
      const normalized = values
        .map((value) => value.trim())
        .filter(Boolean)
        .map(normalizeDomain);
      if (
        !normalized.length ||
        new Set(normalized).size !== normalized.length
      ) {
        setError(
          'Zadej alespoň jeden web. Každý web může být v mapě jen jednou.',
        );
        return;
      }
      onStart(normalized);
    } catch {
      setError('Zkontroluj adresy webů, například https://tvuj-web.cz.');
    }
  };
  return (
    <main className={`ux-new-map ux-new-${variant}`}>
      <button className="ux-back" onClick={onCancel}>
        <ArrowLeft size={15} />
        Zpět k mapě
      </button>
      <div className="ux-new-layout">
        <section>
          <div className="ux-kicker">NOVÁ MAPA / PRVNÍ KROK</div>
          <h1>
            Které weby
            <br />
            spolu souvisí<span>?</span>
          </h1>
          <p>
            Zadej až tři weby. My najdeme odkazy,
            <br />
            ty objevíš jejich souvislosti.
          </p>
          <div className="ux-new-steps">
            <div>
              <span>01</span>
              <strong>Vyber weby</strong>
              <p>Stačí adresa. Účet nepotřebuješ.</p>
            </div>
            <div>
              <span>02</span>
              <strong>Sleduj, jak mapa roste</strong>
              <p>Sken pokračuje i po zavření karty.</p>
            </div>
            <div>
              <span>03</span>
              <strong>Prozkoumej konkrétní vazby</strong>
              <p>Od webu ke stránce a textu odkazu.</p>
            </div>
          </div>
        </section>
        <form onSubmit={submit}>
          <div className="ux-form-heading">
            <h2>Tvoje weby</h2>
            <span>{values.length}/3</span>
          </div>
          {values.map((value, index) => (
            <label className="ux-domain-field" key={index}>
              <span>Web {index + 1}</span>
              <div>
                <Globe2 size={18} />
                <input
                  required={index === 0}
                  aria-label={`Web ${index + 1}`}
                  value={value}
                  placeholder="tvuj-web.cz"
                  onChange={(event) =>
                    setValues(
                      values.map((item, i) =>
                        i === index ? event.target.value : item,
                      ),
                    )
                  }
                />
                {values.length > 1 && (
                  <button
                    type="button"
                    className="ux-icon"
                    aria-label={`Odebrat web ${index + 1}`}
                    onClick={() =>
                      setValues(values.filter((_, i) => i !== index))
                    }
                  >
                    <X size={15} />
                  </button>
                )}
              </div>
            </label>
          ))}
          {values.length < 3 && (
            <button
              type="button"
              className="ux-add-site"
              onClick={() => setValues([...values, ''])}
            >
              <Plus size={15} />
              Přidat další web
            </button>
          )}
          <div className="ux-form-limits">
            <ShieldCheck size={18} />
            <p>
              <strong>Šetrně k webům</strong>Nejvýše 100 stránek na web.
              Procházíme veřejné HTML; odkazy vytvořené JavaScriptem nemusíme
              najít.
            </p>
          </div>
          {error && (
            <p className="ux-form-error" role="alert">
              {error}
            </p>
          )}
          <button className="ux-button ux-primary ux-full" type="submit">
            Vytvořit mapu a spustit sken
            <ArrowRight size={17} />
          </button>
          <p className="ux-form-footnote">
            V této studii se zobrazí ukázková data. Nic se skutečně neskenuje
            ani neukládá.
          </p>
        </form>
      </div>
    </main>
  );
}

function LogDialog({
  sites,
  state,
  count,
  issues = [],
  onClose,
  onComplete,
}: {
  sites: Site[];
  state: ScanState;
  count: number;
  issues?: StudyScanIssue[];
  onClose: () => void;
  onComplete: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [siteId, setSiteId] = useState('all');
  const [errorsOnly, setErrorsOnly] = useState(false);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  const rows = [
    ...sites.flatMap((site, index) => [
      {
        siteId: site.id,
        time: `10:42:${String(8 + index * 3).padStart(2, '0')}`,
        message: `Načteno https://${site.domain}/partners`,
        level: 'info',
      },
      {
        siteId: site.id,
        time: `10:42:${String(7 + index * 3).padStart(2, '0')}`,
        message: `robots.txt povoluje procházení ${site.domain}`,
        level: 'info',
      },
    ]),
    ...issues.map((issue, index) => ({
      siteId: issue.siteId,
      time: `10:42:${30 + index}`,
      message: `${issue.message} · ${issue.url}`,
      level: issue.level,
    })),
  ]
    .filter(
      (row) =>
        (!errorsOnly || row.level === 'error') &&
        (siteId === 'all' || row.siteId === siteId),
    )
    .sort((a, b) => b.time.localeCompare(a.time));
  return (
    <dialog
      ref={dialog}
      className="ux ux-log-dialog"
      onCancel={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="ux-log-inner">
        <header>
          <div>
            <div className="ux-kicker">STUDIO ATLAS</div>
            <h2>Průběh skenu</h2>
            <p>
              {count} stránek ·{' '}
              {state === 'running'
                ? 'Skenování probíhá'
                : state === 'paused'
                  ? 'Sken je pozastavený'
                  : 'Hotovo, výsledky jsou uložené'}
            </p>
          </div>
          <button
            className="ux-icon"
            onClick={onClose}
            aria-label="Zavřít průběh skenu"
          >
            <X size={21} />
          </button>
        </header>
        {issues.length > 0 && (
          <p className="ux-log-summary">
            Chyby: {issues.filter((issue) => issue.level === 'error').length} ·
            Neúspěšné / vynechané stránky: {issues.length}
          </p>
        )}
        <div className="ux-log-tools">
          <select
            aria-label="Filtrovat log podle webu"
            value={siteId}
            onChange={(event) => setSiteId(event.target.value)}
          >
            <option value="all">Všechny weby</option>
            {sites.map((site) => (
              <option key={site.id} value={site.id}>
                {site.domain}
              </option>
            ))}
          </select>
          <label>
            <input
              type="checkbox"
              checked={errorsOnly}
              onChange={(event) => setErrorsOnly(event.target.checked)}
            />
            Jen chyby
          </label>
        </div>
        <div className="ux-log-rows">
          {rows.length ? (
            rows.map((row) => (
              <div
                key={`${row.siteId}-${row.time}`}
                className={`is-${row.level}`}
              >
                <time>{row.time}</time>
                {row.level === 'error' ? (
                  <X size={16} />
                ) : row.level === 'warning' ? (
                  <AlertTriangle size={16} />
                ) : (
                  <Check size={16} />
                )}
                <span>{row.message}</span>
                <small>
                  {row.level === 'error'
                    ? 'Chyba'
                    : row.level === 'warning'
                      ? 'Vynecháno'
                      : 'OK'}
                </small>
              </div>
            ))
          ) : (
            <div className="ux-empty">
              <ShieldCheck size={25} />
              <h3>Žádné chyby.</h3>
              <p>Pro zvolený filtr tu nejsou žádné události.</p>
            </div>
          )}
        </div>
        <footer>
          <span>Ukázkový průběh · nejnovější události nahoře</span>
          {state !== 'completed' && (
            <button className="ux-button ux-primary" onClick={onComplete}>
              <Check size={15} />
              Dokončit ukázkový sken
            </button>
          )}
        </footer>
      </div>
    </dialog>
  );
}
