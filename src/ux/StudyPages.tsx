import { useLayoutEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Clock3,
  FileText,
  LoaderCircle,
  Search,
  X,
} from 'lucide-react';
import type { Page, Selection } from '../data';
import ExternalLink from '../ExternalLink';
import PageScanButton from '../PageScanButton';
import type { PreviewEvents } from './HoverStudies';
import './study-pages.css';

export type PageListState = { query: string; scrollTop: number };

export function StudyPageStatus({ page }: { page: Page }) {
  const state =
    page.scanState === 'fetching'
      ? 'loading'
      : page.scanState === 'queued'
        ? 'queued'
        : page.status === 'ok'
          ? 'loaded'
          : page.status === 'known'
            ? 'known'
            : page.status === 'robots_denied' || page.status === 'not_html'
              ? 'skipped'
              : 'error';
  const label = {
    loading: 'Načítá se',
    queued: 'Čeká',
    loaded: 'Načtená',
    known: 'Nenačtená',
    skipped: 'Vynechaná',
    error: 'Chyba',
  }[state];
  const Icon =
    state === 'loading'
      ? LoaderCircle
      : state === 'queued'
        ? Clock3
        : state === 'loaded'
          ? Check
          : state === 'known'
            ? FileText
            : AlertTriangle;
  return (
    <span className={`ux-page-status is-${state}`}>
      <Icon size={12} aria-hidden="true" />
      {label}
    </span>
  );
}

export default function StudyPages({
  pages,
  memory,
  onSelect,
  onScanPage,
  previewEvents,
}: {
  pages: Page[];
  memory: PageListState;
  onSelect: (selection: Selection) => void;
  onScanPage: (url: string) => void;
  previewEvents?: PreviewEvents;
}) {
  const [query, setQuery] = useState(memory.query);
  const listRef = useRef<HTMLDivElement>(null);
  const filtered = pages.filter((page) =>
    `${page.url} ${page.path} ${page.title}`
      .toLocaleLowerCase('cs-CZ')
      .includes(query.trim().toLocaleLowerCase('cs-CZ')),
  );
  useLayoutEffect(() => {
    if (listRef.current) listRef.current.scrollTop = memory.scrollTop;
  }, [memory]);
  const search = (value: string) => {
    memory.query = value;
    memory.scrollTop = 0;
    if (listRef.current) listRef.current.scrollTop = 0;
    setQuery(value);
  };
  return (
    <section className="ux-site-pages" aria-label="Stránky webu">
      <div className="ux-page-list-heading">
        <h3>Stránky</h3>
        <span className="ux-page-count" aria-live="polite">
          {query.trim()
            ? `${filtered.length} z ${pages.length}`
            : `${pages.length} URL`}
        </span>
      </div>
      <label className="ux-search">
        <Search size={14} aria-hidden="true" />
        <input
          aria-label="Hledat stránky webu"
          placeholder="Hledat stránku…"
          value={query}
          onChange={(event) => search(event.target.value)}
        />
        {query && (
          <button
            type="button"
            className="ux-icon"
            aria-label="Vymazat hledání stránek"
            onClick={() => search('')}
          >
            <X size={14} />
          </button>
        )}
      </label>
      <div
        className="ux-page-list"
        ref={listRef}
        onScroll={(event) => {
          memory.scrollTop = event.currentTarget.scrollTop;
        }}
      >
        {filtered.map((page) => (
          <div
            className="ux-page-row"
            key={page.id}
            data-page-id={page.id}
            onClick={(event) => {
              if (
                event.target instanceof Element &&
                event.target.closest('button, a')
              )
                return;
              event.currentTarget
                .querySelector<HTMLButtonElement>('.ux-page-select')
                ?.focus({ preventScroll: true });
              onSelect({ type: 'page', id: page.id });
            }}
          >
            <button
              type="button"
              className="ux-page-select"
              data-detail-target={`page:${page.id}`}
              aria-label={`Detail stránky ${page.url}`}
              {...previewEvents?.({ type: 'page', id: page.id })}
              onClick={() => onSelect({ type: 'page', id: page.id })}
            >
              <span className="ux-page-path" title={page.url}>
                {page.path}
              </span>
              <span className="ux-page-title">{page.title}</span>
              <StudyPageStatus page={page} />
            </button>
            <ExternalLink url={page.url!} />
            <div className="ux-page-row-footer">
              <PageScanButton page={page} onScanPage={onScanPage} />
              {(page.error || page.scanDisabledReason) && (
                <small className="ux-page-reason">
                  {page.error ?? page.scanDisabledReason}
                </small>
              )}
            </div>
          </div>
        ))}
        {!filtered.length && (
          <p className="ux-page-empty">
            {query.trim()
              ? 'Žádná stránka neodpovídá hledání.'
              : 'Zatím neznáme žádnou stránku tohoto webu.'}
          </p>
        )}
      </div>
      <p className="ux-page-list-note">
        Proskenovat načte jen vybranou stránku.
      </p>
    </section>
  );
}
