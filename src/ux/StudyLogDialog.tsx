import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  ArrowUp,
  Check,
  LoaderCircle,
  Pause,
  ShieldCheck,
  X,
} from 'lucide-react';
import type { Link, Page, Site } from '../data';
import ExternalLink from '../ExternalLink';
import { useGraphData } from '../graph-data';
import './study-log.css';

export type StudyScanIssue = {
  siteId: string;
  url: string;
  message: string;
  level: 'error' | 'warning';
  httpStatus?: number;
};

type StudyLogEvent = {
  id: string;
  at: number;
  siteId: string;
  title: string;
  level: 'info' | 'error' | 'warning';
  url: string;
  redirectUrl?: string;
  httpStatus?: number;
  linkCount?: number;
  loading?: boolean;
};

function initialEvents(
  sites: Site[],
  links: Link[],
  issues: StudyScanIssue[],
  pageUrl: (page: Page) => string,
): StudyLogEvent[] {
  const rows: Omit<StudyLogEvent, 'id' | 'at'>[] = sites.flatMap((site) => [
    {
      siteId: site.id,
      title: 'Robots.txt povoluje procházení',
      level: 'info',
      url: `https://${site.domain}/robots.txt`,
      httpStatus: 200,
    },
    ...Array.from(
      new Map(
        links
          .filter((link) => link.source.siteId === site.id)
          .map((link) => [link.source.id, link.source]),
      ).values(),
      (page) => ({
        siteId: site.id,
        title: 'Stránka načtena',
        level: 'info' as const,
        url: pageUrl(page),
        httpStatus: 200,
        linkCount: links.filter((link) => link.source.id === page.id).length,
      }),
    ),
  ]);
  const firstSite = sites[0];
  if (firstSite) {
    const hostname = firstSite.domain.replace(/^www\./, '');
    rows.push({
      siteId: firstSite.id,
      title: 'Přesměrování',
      level: 'info',
      url: `http://${hostname}/journal`,
      redirectUrl: `https://www.${hostname}/journal`,
      httpStatus: 301,
    });
  }
  rows.push(...issues.map((issue) => ({ ...issue, title: issue.message })));
  const start = Date.now() - rows.length * 3000;
  return rows
    .map((row, index) => ({
      ...row,
      id: `seed-${index}`,
      at: start + index * 3000,
    }))
    .reverse();
}

function linkCountLabel(count: number) {
  return `${count} ${count === 1 ? 'odkaz' : count >= 2 && count <= 4 ? 'odkazy' : 'odkazů'}`;
}

export default function StudyLogDialog({
  open,
  sites,
  links,
  state,
  run,
  archived,
  activeSiteIds,
  countLabel,
  issues,
  onClose,
  onComplete,
}: {
  open: boolean;
  sites: Site[];
  links: Link[];
  state: 'running' | 'paused' | 'completed';
  run: number;
  archived: boolean;
  activeSiteIds: string[];
  countLabel: string;
  issues: StudyScanIssue[];
  onClose: () => void;
  onComplete: () => void;
}) {
  const { pageUrl } = useGraphData();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const scrollRef = useRef({ top: 0, height: 0 });
  const followingRef = useRef(true);
  const resetScrollRef = useRef(true);
  const sequenceRef = useRef(0);
  const [following, setFollowing] = useState(true);
  const [siteId, setSiteId] = useState('all');
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [events, setEvents] = useState(() =>
    initialEvents(sites, links, issues, pageUrl),
  );

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!open || !dialog) return;
    const trigger = document.activeElement;
    resetScrollRef.current = true;
    dialog.showModal();
    return () => {
      dialog.close();
      if (trigger instanceof HTMLElement && trigger.isConnected) {
        trigger.focus({ preventScroll: true });
      }
    };
  }, [open]);

  useEffect(() => {
    if (!open || archived || state !== 'running') return;
    const activeSites = sites.filter((site) => activeSiteIds.includes(site.id));
    if (!activeSites.length) return;
    // Replay activity locally; the study never requests or crawls these URLs.
    const timer = window.setInterval(() => {
      const sequence = sequenceRef.current++;
      const site = activeSites[sequence % activeSites.length];
      const sourcePages = Array.from(
        new Map(
          links
            .filter((link) => link.source.siteId === site.id)
            .map((link) => [link.source.id, link.source]),
        ).values(),
      );
      const page =
        sourcePages[
          Math.floor(sequence / activeSites.length) % sourcePages.length
        ];
      setEvents((previous) => [
        {
          id: `live-${sequence}`,
          at: Date.now(),
          siteId: site.id,
          title: 'Načítání stránky',
          level: 'info',
          loading: true,
          url: page ? pageUrl(page) : `https://${site.domain}/`,
        },
        ...previous,
      ]);
    }, 3000);
    return () => window.clearInterval(timer);
  }, [open, archived, state, sites, activeSiteIds, links, pageUrl]);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!open || !list) return;
    if (resetScrollRef.current || followingRef.current) {
      list.scrollTop = 0;
      followingRef.current = true;
      setFollowing(true);
      resetScrollRef.current = false;
    } else {
      // Disable native anchoring in CSS to avoid compensating twice on prepend.
      list.scrollTop =
        scrollRef.current.top + list.scrollHeight - scrollRef.current.height;
    }
    scrollRef.current = { top: list.scrollTop, height: list.scrollHeight };
  }, [open, events, siteId, errorsOnly]);

  const rows = events.filter(
    (event) =>
      (siteId === 'all' || event.siteId === siteId) &&
      (!errorsOnly || event.level === 'error'),
  );
  const status = archived
    ? 'Pouze ke čtení'
    : state === 'running'
      ? 'Skenování probíhá'
      : state === 'paused'
        ? 'Sken pozastaven'
        : 'Sken dokončen';

  return (
    <dialog
      ref={dialogRef}
      className="ux ux-log-dialog ux-study-log"
      aria-labelledby="ux-study-log-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <header className="ux-study-log-header">
        <div>
          <div className="ux-kicker">
            Běh #{run} · {archived ? 'archiv' : 'aktuální'}
          </div>
          <h2 id="ux-study-log-title">Průběh skenu</h2>
          <p className="ux-study-log-status">
            {state === 'running' ? (
              <LoaderCircle className="ux-scan-spinner" size={14} />
            ) : state === 'paused' ? (
              <Pause size={14} />
            ) : (
              <Check size={14} />
            )}
            {status}
            <span>· Načteno: {countLabel}</span>
          </p>
        </div>
        <button
          className="ux-icon"
          onClick={onClose}
          aria-label="Zavřít průběh skenu"
          autoFocus
        >
          <X size={20} />
        </button>
      </header>
      <div className="ux-study-log-controls">
        <p className="ux-study-log-summary">
          <span>
            Chyby:{' '}
            <b>{issues.filter((issue) => issue.level === 'error').length}</b>
          </span>
          <span>
            Neúspěšné / vynechané stránky: <b>{issues.length}</b>
          </span>
        </p>
        <div className="ux-study-log-filters">
          <select
            aria-label="Filtrovat log podle webu"
            value={siteId}
            onChange={(event) => {
              resetScrollRef.current = true;
              setSiteId(event.target.value);
            }}
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
              onChange={(event) => {
                resetScrollRef.current = true;
                setErrorsOnly(event.target.checked);
              }}
            />
            Jen chyby
          </label>
        </div>
      </div>
      <div className="ux-study-log-body">
        <ol
          ref={listRef}
          className="ux-study-log-events"
          aria-label="Události skenu, nejnovější nahoře"
          tabIndex={0}
          onScroll={(event) => {
            const list = event.currentTarget;
            followingRef.current = list.scrollTop <= 24;
            setFollowing(followingRef.current);
            scrollRef.current = {
              top: list.scrollTop,
              height: list.scrollHeight,
            };
          }}
        >
          {rows.map((row) => (
            <li
              key={row.id}
              data-event-id={row.id}
              className={`is-${row.level}`}
            >
              <time
                dateTime={new Date(row.at).toISOString()}
                title={new Date(row.at).toLocaleString('cs-CZ')}
              >
                {new Date(row.at).toLocaleTimeString('cs-CZ', {
                  hour: '2-digit',
                  minute: '2-digit',
                  second: '2-digit',
                })}
              </time>
              <span className="ux-study-log-event-icon" aria-hidden="true">
                {row.level === 'error' ? (
                  <X size={15} />
                ) : row.level === 'warning' ? (
                  <AlertTriangle size={15} />
                ) : row.redirectUrl ? (
                  <ArrowRight size={15} />
                ) : row.loading ? (
                  <Activity size={15} />
                ) : (
                  <Check size={15} />
                )}
              </span>
              <div className="ux-study-log-event-content">
                <div className="ux-study-log-event-heading">
                  <strong>{row.title}</strong>
                  {row.httpStatus !== undefined && (
                    <span>HTTP {row.httpStatus}</span>
                  )}
                  {row.linkCount !== undefined && (
                    <span>{linkCountLabel(row.linkCount)}</span>
                  )}
                </div>
                <div className="ux-study-log-url">
                  <span>{row.url}</span>
                  <ExternalLink url={row.url} />
                </div>
                {row.redirectUrl && (
                  <div className="ux-study-log-url ux-study-log-redirect">
                    <ArrowRight size={13} aria-label="Cíl přesměrování" />
                    <span>{row.redirectUrl}</span>
                    <ExternalLink url={row.redirectUrl} />
                  </div>
                )}
              </div>
            </li>
          ))}
          {!rows.length && (
            <li className="ux-empty">
              <ShieldCheck size={25} />
              <h3>{errorsOnly ? 'Žádné chyby.' : 'Zatím žádné události.'}</h3>
              <p>Pro zvolený filtr tu nejsou žádné události.</p>
            </li>
          )}
        </ol>
        {!following && (
          <button
            className="ux-button ux-study-log-latest"
            onClick={() => {
              if (listRef.current) listRef.current.scrollTop = 0;
              followingRef.current = true;
              setFollowing(true);
              listRef.current?.focus({ preventScroll: true });
            }}
          >
            <ArrowUp size={14} />K nejnovějším
          </button>
        )}
      </div>
      <footer className="ux-study-log-footer">
        <p>
          <span>
            {rows.length} z {events.length} událostí
          </span>
          <span>Ukázkový průběh · nejnovější nahoře</span>
        </p>
        {state !== 'completed' && !archived && (
          <button className="ux-button ux-primary" onClick={onComplete}>
            <Check size={15} />
            Dokončit ukázkový sken
          </button>
        )}
      </footer>
    </dialog>
  );
}
