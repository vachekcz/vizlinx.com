import {
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  ChevronRight,
  FileText,
  Layers2,
  Link2,
  X,
} from 'lucide-react';
import { aggregateConnections, getPage, getSite, pages, pageUrl } from './data';
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
      {site.id.charAt(0)}
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
  onIntervalChange: (id: string, interval: number) => void;
};

function LinkDetails({ link }: { link: Link }) {
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
            {getSite(link.target.siteId).scanned
              ? 'Prozkoumaný'
              : 'Neprozkoumaný'}
          </dd>
        </div>
        <div>
          <dt>Zjištěno (ukázka, Praha)</dt>
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
  if (!links.length)
    return (
      <p className="empty-note">V této části dema zatím nejsou žádné vazby.</p>
    );
  return (
    <div className="detail-link-list">
      {links.map((link) => (
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
}: Props) {
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
              {site.scanned ? 'Ukázkový web' : 'Neprozkoumáno'}
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
                ? `Prozkoumat ${pages.filter((item) => item.siteId === site.id).length} stránek`
                : 'Zobrazit známé cílové URL'}
            <ArrowUpRight size={16} />
          </button>
          {site.scanned && (
            <div className="interval-control">
              <label htmlFor="site-interval">
                Interval simulace <strong>{intervals[site.id]} s</strong>
              </label>
              <input
                id="site-interval"
                type="range"
                min="1"
                max="10"
                value={intervals[site.id]}
                onChange={(event) =>
                  onIntervalChange(site.id, Number(event.target.value))
                }
              />
              <div>
                <span>Rychleji</span>
                <span>Pomaleji</span>
              </div>
            </div>
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
                Zatím žádné vazby. Objeví se v průběhu simulace.
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
              {getSite(page.siteId).scanned
                ? 'Prozkoumaná stránka · ukázka'
                : 'Pouze známý cíl odkazu'}
            </span>
          </div>
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
          Tato vazba se objeví v průběhu simulace. Mezitím vyberte některou
          doménu.
        </p>
      )}
      <div className="inspector-footer">
        <i /> Pouze ukázková data. Žádné požadavky na cílové weby.
      </div>
    </aside>
  );
}
