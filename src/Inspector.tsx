import { useEffect, useState } from 'react';
import {
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  ChevronRight,
  FileText,
  Layers2,
  Link2,
  Pause,
  Play,
  X,
} from 'lucide-react';
import ExternalLink from './ExternalLink';
import PageScanButton, { type PageScanControl } from './PageScanButton';
import {
  pageStatusLabel,
  previewStatusLabel,
  siteUrl,
  useGraphData,
} from './graph-data';
import type { Link, Page, Selection, Site } from './data';

const observationFormatter = new Intl.DateTimeFormat('cs-CZ', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Europe/Prague',
});

export function SiteMark({
  site,
  small = false,
}: {
  site: Site;
  small?: boolean;
}) {
  return (
    <span
      className={`site-mark ${small ? 'small' : ''}`}
      style={{ color: site.color, background: site.tint }}
    >
      {site.domain.charAt(0)}
    </span>
  );
}

type Props = PageScanControl & {
  selection: Selection;
  links: Link[];
  expanded: string[];
  onExpand: (ids: string[]) => void;
  onSelect: (selection: Selection) => void;
  onClose: () => void;
  intervals: Record<string, number>;
  onIntervalChange?: (id: string, interval: number) => void;
  pausedSites?: string[];
  onPauseSite?: (id: string) => void;
  controlsDisabled?: boolean;
  pageLimits?: Record<string, number>;
  onPageLimitChange?: (id: string, limit: number) => void;
  onExploreSite?: (id: string) => void;
  exploreDisabledReason?: string;
};

function IntervalControl({
  value,
  live,
  disabled,
  onChange,
}: {
  value: number;
  live: boolean;
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing && !disabled) setDraft(value);
  }, [value, editing, disabled]);
  const commit = (next: number) => {
    if (!live || disabled) return;
    setEditing(false);
    if (next !== value) onChange(next);
  };
  return (
    <div className="interval-control">
      <label htmlFor="site-interval">
        {live ? 'Interval skenu' : 'Interval simulace'}{' '}
        <strong>{live ? draft : value} s</strong>
      </label>
      <input
        id="site-interval"
        type="range"
        min="1"
        max={live ? 60 : 10}
        disabled={disabled}
        value={live ? draft : value}
        onPointerDown={() => setEditing(true)}
        onPointerUp={(event) => commit(Number(event.currentTarget.value))}
        onPointerCancel={() => {
          setEditing(false);
          setDraft(value);
        }}
        onKeyDown={() => setEditing(true)}
        onKeyUp={(event) => commit(Number(event.currentTarget.value))}
        onBlur={(event) => commit(Number(event.currentTarget.value))}
        onChange={(event) => {
          const next = Number(event.target.value);
          if (live) {
            setEditing(true);
            setDraft(next);
          } else onChange(next);
        }}
      />
      <div>
        <span>Rychleji</span>
        <span>Pomaleji</span>
      </div>
    </div>
  );
}

function PageLimitControl({
  value,
  disabled,
  onChange,
}: {
  value: number;
  disabled: boolean;
  onChange: (limit: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => {
    if (!disabled) setDraft(String(value));
  }, [value, disabled]);
  return (
    <div className="page-limit-control">
      <label htmlFor="site-page-limit">Limit stránek skenu</label>
      <input
        id="site-page-limit"
        type="number"
        min={1}
        max={50}
        required
        disabled={disabled}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
        }}
        onBlur={(event) => {
          if (disabled) return;
          if (!event.currentTarget.checkValidity()) {
            setDraft(String(value));
            return;
          }
          const next = Number(event.currentTarget.value);
          if (next !== value) onChange(next);
        }}
      />
      <p className="empty-note">
        1–50 stránek. Změna se uloží po opuštění pole nebo klávesou Enter.
      </p>
    </div>
  );
}

function LinkDetails({
  link,
  ...scanControl
}: { link: Link } & PageScanControl) {
  const { getSite, pageUrl, live } = useGraphData();
  return (
    <div className="link-details">
      <div className="url-stop">
        <span
          className="url-dot"
          style={{ background: getSite(link.source.siteId).color }}
        />
        <span className="eyebrow">ZDROJOVÁ STRÁNKA</span>
        <strong>{link.source.title}</strong>
        <div className="external-url">
          <code>{pageUrl(link.source)}</code>
          <ExternalLink url={pageUrl(link.source)} />
        </div>
      </div>
      <div className="url-connector">
        <ArrowRight size={14} />
        <span>{link.anchor}</span>
      </div>
      <div className="url-stop">
        <span
          className="url-dot"
          style={{ background: getSite(link.target.siteId).color }}
        />
        <span className="eyebrow">CÍLOVÁ STRÁNKA</span>
        <strong>{link.target.title}</strong>
        <div className="external-url">
          <code>{pageUrl(link.target)}</code>
          <ExternalLink url={pageUrl(link.target)} />
        </div>
      </div>
      <PageScanButton page={link.target} {...scanControl} />
      <dl className="metadata">
        <div>
          <dt>Umístění</dt>
          <dd>{link.region}</dd>
        </div>
        <div>
          <dt>Atribut rel</dt>
          <dd>{link.rel || 'Bez atributu'}</dd>
        </div>
        <div>
          <dt>Výskyty na stránce</dt>
          <dd>{link.occurrences}</dd>
        </div>
        <div>
          <dt>Stav cíle</dt>
          <dd>
            {live
              ? pageStatusLabel(link.target)
              : getSite(link.target.siteId).scanned
                ? 'Prozkoumaný'
                : 'Neprozkoumaný'}
          </dd>
        </div>
        <div>
          <dt>{live ? 'Zjištěno (Praha)' : 'Zjištěno (ukázka, Praha)'}</dt>
          <dd>
            <time dateTime={link.observedAt}>
              {observationFormatter.format(new Date(link.observedAt))}
            </time>
          </dd>
        </div>
      </dl>
    </div>
  );
}

function LinkList({
  links,
  onSelect,
}: {
  links: Link[];
  onSelect: Props['onSelect'];
}) {
  const { getSite, pageUrl, live } = useGraphData();
  if (!links.length)
    return (
      <p className="empty-note">
        {live
          ? 'Zatím nebyly zjištěny žádné vazby.'
          : 'V této části dema zatím nejsou žádné vazby.'}
      </p>
    );
  return (
    <div className="detail-link-list">
      {links.slice(0, live ? 200 : undefined).map((link) => (
        <div className="detail-link-row" key={link.id}>
          <FileText size={15} aria-hidden="true" />
          <div className="detail-link-urls">
            <div className="external-url">
              <button
                aria-label={`${getSite(link.source.siteId).domain}${link.source.path} → ${getSite(link.target.siteId).domain}${link.target.path}`}
                onClick={() => onSelect({ type: 'link', id: link.id })}
              >
                <strong>
                  {getSite(link.source.siteId).domain}
                  {link.source.path}
                </strong>
              </button>
              <ExternalLink url={pageUrl(link.source)} />
            </div>
            <div className="external-url">
              <button onClick={() => onSelect({ type: 'link', id: link.id })}>
                <small>
                  → {getSite(link.target.siteId).domain}
                  {link.target.path}
                </small>
              </button>
              <ExternalLink url={pageUrl(link.target)} />
            </div>
          </div>
          <button
            className="icon-button"
            aria-label={`Detail odkazu ${pageUrl(link.source)} → ${pageUrl(link.target)}`}
            onClick={() => onSelect({ type: 'link', id: link.id })}
          >
            <ChevronRight size={14} />
          </button>
        </div>
      ))}
      {live && links.length > 200 && (
        <p className="empty-note">
          Zobrazeno 200 z {links.length} vazeb. Všechny vazby najdeš v tabulce a
          CSV.
        </p>
      )}
    </div>
  );
}

function KnownPages({
  pages,
  onSelect,
  ...scanControl
}: PageScanControl & {
  pages: Page[];
  onSelect: Props['onSelect'];
}) {
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const pageSize = 20;
  const filtered = pages.filter((page) =>
    `${page.url} ${page.title}`.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <section className="known-pages" aria-label="Známé stránky webu">
      <div className="detail-section-heading">
        <h3>Známé stránky</h3>
        <span>{pages.length}</span>
      </div>
      <input
        aria-label="Hledat stránku webu"
        placeholder="Najít URL nebo název…"
        value={search}
        onChange={(event) => {
          setSearch(event.target.value);
          setOffset(0);
        }}
      />
      <ul>
        {filtered.slice(offset, offset + pageSize).map((page) => (
          <li key={page.id}>
            <div className="external-url">
              <button
                className="known-page-select"
                onClick={() => onSelect({ type: 'page', id: page.id })}
                title={page.url}
              >
                {page.path}
              </button>
              <ExternalLink url={page.url!} />
            </div>
            <small>{pageStatusLabel(page)}</small>
            <PageScanButton page={page} {...scanControl} />
          </li>
        ))}
      </ul>
      {!filtered.length && (
        <p className="empty-note">Žádná stránka neodpovídá hledání.</p>
      )}
      {filtered.length > pageSize && (
        <div className="known-pages-pagination">
          <button
            className="outline-button"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - pageSize))}
          >
            Předchozí stránky
          </button>
          <span>
            {offset + 1}–{Math.min(offset + pageSize, filtered.length)} z{' '}
            {filtered.length}
          </span>
          <button
            className="outline-button"
            disabled={offset + pageSize >= filtered.length}
            onClick={() => setOffset(offset + pageSize)}
          >
            Další stránky
          </button>
        </div>
      )}
    </section>
  );
}

export default function Inspector({
  selection,
  links,
  expanded,
  onExpand,
  onSelect,
  onClose,
  intervals,
  onIntervalChange,
  pausedSites = [],
  onPauseSite,
  controlsDisabled = false,
  pageLimits = {},
  onPageLimitChange,
  onExploreSite,
  onScanPage,
  exploreDisabledReason,
}: Props) {
  const {
    aggregateConnections,
    getSite,
    getPage,
    pageUrl,
    pages,
    sites,
    live,
  } = useGraphData();
  const connections = aggregateConnections(links);
  const site = selection.type === 'site' ? getSite(selection.id) : null;
  const page = selection.type === 'page' ? getPage(selection.id) : null;
  const connection =
    selection.type === 'connection'
      ? connections.find((item) => item.id === selection.id)
      : null;
  const link =
    selection.type === 'link'
      ? links.find((item) => item.id === selection.id)
      : null;

  return (
    <aside className="inspector" aria-label="Detail výběru">
      <div className="inspector-heading">
        <span className="eyebrow">
          {site
            ? 'DETAIL DOMÉNY'
            : page
              ? 'DETAIL STRÁNKY'
              : link
                ? 'DETAIL ODKAZU'
                : 'DETAIL PROPOJENÍ'}
        </span>
        <button
          className="icon-button"
          onClick={onClose}
          aria-label="Zavřít detail"
        >
          <X size={16} />
        </button>
      </div>
      {live && (
        <label className="inspector-site-picker">
          Vybrat web
          <select
            aria-label="Vybrat web v mapě"
            value={site?.id ?? page?.siteId ?? ''}
            onChange={(event) => {
              if (event.target.value)
                onSelect({ type: 'site', id: event.target.value });
            }}
          >
            <option value="">Vyber web…</option>
            {sites.map((item) => (
              <option key={item.id} value={item.id}>
                {item.origin ?? item.domain}
              </option>
            ))}
          </select>
        </label>
      )}
      {site && (
        <>
          <div className="site-profile">
            <SiteMark site={site} />
            <span className={`status-chip ${site.scanned ? '' : 'unexplored'}`}>
              <i />
              {site.scanned
                ? live
                  ? 'Povolený origin'
                  : 'Ukázkový web'
                : previewStatusLabel(site)}
            </span>
            <div className="external-url">
              <h2>{site.domain}</h2>
              <ExternalLink url={siteUrl(site)} />
            </div>
            <p>
              {site.name} <span>·</span> {site.category}
            </p>
          </div>
          {live && !site.scanned && (
            <div className="site-preview" data-testid="site-preview">
              {site.preview?.attemptedPages ? (
                <>
                  <p>
                    {site.preview.knownTargets > 0
                      ? `Zkontrolováno ${site.preview.checkedTargets} z ${site.preview.knownTargets} známých cílových URL z vybraných webů.`
                      : `Prozkoumáno ${site.preview.inspectedPages} jednotlivých stránek tohoto webu.`}
                  </p>
                  {site.preview.failedTargets > 0 && (
                    <p className="empty-note">
                      Nepodařilo se ověřit {site.preview.failedTargets} cílových
                      URL. Podrobnosti jsou u jednotlivých stránek.
                    </p>
                  )}
                  {site.preview.inspectedPages > 0 &&
                    site.preview.knownTargets > 0 && (
                      <p>
                        {site.preview.backlinkCount > 0
                          ? `Nalezené odkazy zpět na odkazující vybrané weby: ${site.preview.backlinkCount}.`
                          : 'Na zkontrolovaných stránkách jsme odkaz zpět na odkazující vybrané weby nenašli.'}
                      </p>
                    )}
                  <p className="empty-note">
                    Jde pouze o kontrolu cílových stránek, nikoli celého webu.
                  </p>
                </>
              ) : (
                <p className="empty-note">
                  Tento web známe pouze z odkazů. Jeho stránky zatím nebyly
                  zkontrolovány.
                </p>
              )}
              {onExploreSite && (
                <>
                  <button
                    className="outline-button expand-button"
                    disabled={
                      controlsDisabled || Boolean(exploreDisabledReason)
                    }
                    onClick={() => onExploreSite(site.id)}
                  >
                    <Play size={16} />
                    Prozkoumat web
                  </button>
                  <p className="empty-note">
                    {exploreDisabledReason ??
                      'Naváže běžným skenem webu. Mapa i dosavadní výsledky zůstanou zachované.'}
                  </p>
                </>
              )}
            </div>
          )}
          <div className="inspector-stats">
            <div>
              <ArrowUpRight size={16} />
              <strong>
                {links.filter((item) => item.source.siteId === site.id).length}
              </strong>
              <span>Odchozí vazby</span>
            </div>
            <div>
              <ArrowDownLeft size={16} />
              <strong>
                {links.filter((item) => item.target.siteId === site.id).length}
              </strong>
              <span>Příchozí vazby</span>
            </div>
          </div>
          <button
            className="outline-button expand-button"
            onClick={() =>
              onExpand(
                expanded.includes(site.id)
                  ? expanded.filter((id) => id !== site.id)
                  : [...expanded, site.id],
              )
            }
          >
            <Layers2 size={16} />
            {expanded.includes(site.id)
              ? site.scanned
                ? 'Sbalit stránky'
                : 'Sbalit známé cílové URL'
              : site.scanned
                ? live
                  ? `Zobrazit ${pages.filter((item) => item.siteId === site.id).length} známých URL`
                  : `Prozkoumat ${pages.filter((item) => item.siteId === site.id).length} stránek`
                : 'Zobrazit známé cílové URL'}
            <ArrowUpRight size={16} />
          </button>
          {live && (
            <KnownPages
              key={`known-pages-${site.id}`}
              pages={pages.filter((item) => item.siteId === site.id)}
              onSelect={onSelect}
              onScanPage={onScanPage}
              controlsDisabled={controlsDisabled}
            />
          )}
          {site.scanned && onIntervalChange && (
            <IntervalControl
              key={site.id}
              value={intervals[site.id] ?? 3}
              live={live}
              disabled={controlsDisabled}
              onChange={(value) => onIntervalChange(site.id, value)}
            />
          )}
          {site.scanned && onPageLimitChange && (
            <PageLimitControl
              key={`page-limit-${site.id}`}
              value={pageLimits[site.id] ?? 20}
              disabled={controlsDisabled}
              onChange={(limit) => onPageLimitChange(site.id, limit)}
            />
          )}
          {site.scanned && onPauseSite && (
            <button
              className="outline-button"
              disabled={controlsDisabled}
              onClick={() => onPauseSite(site.id)}
            >
              {pausedSites.includes(site.id) ? (
                <Play size={15} />
              ) : (
                <Pause size={15} />
              )}
              {pausedSites.includes(site.id)
                ? 'Pokračovat ve skenování webu'
                : 'Pozastavit skenování webu'}
            </button>
          )}
          <div className="detail-section-heading">
            <h3>Propojené weby</h3>
            <span>
              {
                new Set(
                  connections
                    .filter(
                      (item) =>
                        item.source.id === site.id ||
                        item.target.id === site.id,
                    )
                    .map((item) =>
                      item.source.id === site.id
                        ? item.target.id
                        : item.source.id,
                    ),
                ).size
              }
            </span>
          </div>
          <div className="connection-list">
            {!connections.some(
              (item) =>
                item.source.id === site.id || item.target.id === site.id,
            ) && (
              <p className="empty-note">
                {live
                  ? 'Zatím nebyly zjištěny žádné vazby.'
                  : 'Zatím žádné vazby. Objeví se v průběhu simulace.'}
              </p>
            )}
            {connections
              .filter(
                (item) =>
                  item.source.id === site.id || item.target.id === site.id,
              )
              .map((item) => {
                const outgoing = item.source.id === site.id;
                const other = outgoing ? item.target : item.source;
                return (
                  <div className="connection-row" key={item.id}>
                    <button
                      className="connection-select"
                      onClick={() =>
                        onSelect({ type: 'connection', id: item.id })
                      }
                    >
                      <SiteMark site={other} small />
                      <span>
                        <strong>{other.domain}</strong>
                        <small>
                          {outgoing ? 'Odchozí' : 'Příchozí'}{' '}
                          <ArrowRight size={10} />
                        </small>
                      </span>
                      <b>{item.links.length}</b>
                      <ChevronRight size={14} />
                    </button>
                    <ExternalLink url={siteUrl(other)} />
                  </div>
                );
              })}
          </div>
          {!live && !site.scanned && (
            <p className="empty-note">
              Tento web známe pouze z odkazů. Jeho stránky nebyly prozkoumány.
            </p>
          )}
        </>
      )}
      {page && (
        <>
          <div className="detail-title">
            <SiteMark site={getSite(page.siteId)} />
            <h2>{page.title}</h2>
            <div className="external-url">
              <code>{pageUrl(page)}</code>
              <ExternalLink url={pageUrl(page)} />
            </div>
            <span className="status-chip">
              {live
                ? pageStatusLabel(page)
                : getSite(page.siteId).scanned
                  ? 'Prozkoumaná stránka · ukázka'
                  : 'Pouze známý cíl odkazu'}
            </span>
          </div>
          <PageScanButton
            page={page}
            onScanPage={onScanPage}
            controlsDisabled={controlsDisabled}
          />
          {page.scanDisabledReason && page.status === 'known' && (
            <p className="empty-note">{page.scanDisabledReason}</p>
          )}
          {page.error && <p className="empty-note">{page.error}</p>}
          <div className="detail-section-heading">
            <h3>Vazby této stránky</h3>
            <Link2 size={15} />
          </div>
          <LinkList
            links={links.filter(
              (item) =>
                item.source.id === page.id || item.target.id === page.id,
            )}
            onSelect={onSelect}
          />
        </>
      )}
      {connection && (
        <>
          <div className="connection-profile">
            <div>
              <SiteMark site={connection.source} />
              <ArrowRight size={22} />
              <SiteMark site={connection.target} />
            </div>
            <h2>
              <span className="external-url">
                <span>{connection.source.domain}</span>
                <ExternalLink url={siteUrl(connection.source)} />
              </span>
              <ArrowRight size={16} />
              <span className="external-url">
                <span>{connection.target.domain}</span>
                <ExternalLink url={siteUrl(connection.target)} />
              </span>
            </h2>
            <p>{connection.links.length} unikátních dvojic stránek</p>
          </div>
          <button
            className="outline-button expand-button"
            onClick={() =>
              onExpand([
                ...new Set([
                  ...expanded,
                  connection.source.id,
                  connection.target.id,
                ]),
              ])
            }
          >
            <Layers2 size={16} />
            Rozbalit obě domény
            <ArrowUpRight size={16} />
          </button>
          <div className="detail-section-heading">
            <h3>Konkrétní odkazy</h3>
            <span>{connection.links.length}</span>
          </div>
          <LinkList links={connection.links} onSelect={onSelect} />
          <p className="detail-tip">
            Vyberte odkaz a podívejte se, která stránka odkazuje na kterou.
          </p>
        </>
      )}
      {link && (
        <>
          <button
            className="back-link"
            onClick={() =>
              onSelect({
                type: 'connection',
                id: `${link.source.siteId}:${link.target.siteId}`,
              })
            }
          >
            ← Všechny vazby mezi weby
          </button>
          <LinkDetails
            link={link}
            onScanPage={onScanPage}
            controlsDisabled={controlsDisabled}
          />
        </>
      )}
      {!site && !page && !connection && !link && (
        <p className="empty-note">
          {live
            ? 'Vyberte doménu nebo odkaz v mapě.'
            : 'Tato vazba se objeví v průběhu simulace. Mezitím vyberte některou doménu.'}
        </p>
      )}
      <div className="inspector-footer">
        <i />{' '}
        {live
          ? 'Výsledky serverového skenu. Známá URL neznamená načtenou stránku.'
          : 'Pouze ukázková data. Žádné požadavky na cílové weby.'}
      </div>
    </aside>
  );
}
