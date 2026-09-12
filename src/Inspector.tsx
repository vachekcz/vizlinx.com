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
import { pageStatusLabel, useGraphData } from './graph-data';
import type { Link, Selection, Site } from './data';

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

type Props = {
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
    <div className="interval-control">
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

function LinkDetails({ link }: { link: Link }) {
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
        <code>{pageUrl(link.source)}</code>
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
        <code>{pageUrl(link.target)}</code>
      </div>
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
  const { getSite, live } = useGraphData();
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
        <button
          key={link.id}
          onClick={() => onSelect({ type: 'link', id: link.id })}
        >
          <FileText size={15} />
          <span>
            <strong>
              {getSite(link.source.siteId).domain}
              {link.source.path}
            </strong>
            <small>
              → {getSite(link.target.siteId).domain}
              {link.target.path}
            </small>
          </span>
          <ChevronRight size={14} />
        </button>
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
}: Props) {
  const { aggregateConnections, getSite, getPage, pageUrl, pages, live } =
    useGraphData();
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
                : 'Neprozkoumáno'}
            </span>
            <h2>{site.domain}</h2>
            <p>
              {site.name} <span>·</span> {site.category}
            </p>
          </div>
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
              key={site.id}
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
                  <button
                    key={item.id}
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
                );
              })}
          </div>
          {!site.scanned && (
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
            <code>{pageUrl(page)}</code>
            <span className="status-chip">
              {live
                ? pageStatusLabel(page)
                : getSite(page.siteId).scanned
                  ? 'Prozkoumaná stránka · ukázka'
                  : 'Pouze známý cíl odkazu'}
            </span>
          </div>
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
              {connection.source.domain}
              <ArrowRight size={16} />
              {connection.target.domain}
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
          <LinkDetails link={link} />
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
          ? 'Výsledky lokálního skenu. Známá URL neznamená načtenou stránku.'
          : 'Pouze ukázková data. Žádné požadavky na cílové weby.'}
      </div>
    </aside>
  );
}
