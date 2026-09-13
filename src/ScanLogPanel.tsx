import { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  CirclePause,
  List,
  LoaderCircle,
  X,
} from 'lucide-react';
import {
  API_PREFIX,
  type PageStatus,
  type ScanLogEvent,
  type ScanSnapshot,
  type ScanRedirect,
} from '../shared/scan';

const pageLabels: Record<PageStatus, string> = {
  ok: 'Načteno',
  http_error: 'Přístup odmítnut nebo chyba HTTP',
  network_error: 'Stránku se nepodařilo načíst',
  redirect_unresolved: 'Přesměrování – zadej cílovou URL',
  robots_denied: 'Skenování zakázáno v robots.txt',
  not_html: 'Vynecháno – není HTML',
  too_large: 'Stránka překročila limit velikosti',
};
const limitLabels = {
  page_limit: 'Dosažen limit stránek na web',
  scan_storage_limit: 'Dosažen limit velikosti mapy',
  time_limit: 'Dosažen časový limit',
  daily_limit: 'Dosažen denní limit',
};
export function redirectLabel(redirect: ScanRedirect): string {
  return {
    same_origin: 'Přesměrování v rámci webu',
    external: 'Přesměrování mimo web – nenásledováno',
    invalid: 'Přesměrování bez platného HTTP(S) cíle – nenásledováno',
  }[redirect.kind];
}
function eventLabel(event: ScanLogEvent) {
  switch (event.type) {
    case 'scan_started':
      return 'Spuštěn sken';
    case 'scan_paused':
      return 'Sken pozastaven';
    case 'site_added':
      return 'Přidán web do mapy';
    case 'site_throttled':
      return 'Web pozastaven po HTTP 429 – pokračování povol v detailu webu';
    case 'settings_changed':
      return 'Změněno nastavení skenu';
    case 'robots_checked':
      return event.status === 'robots_denied'
        ? 'Robots.txt nepovoluje skenování'
        : 'Zkontrolována pravidla robots.txt';
    case 'page_finished':
      if (event.redirect) return redirectLabel(event.redirect);
      return event.status ? pageLabels[event.status] : 'Stránka zpracována';
    case 'scan_completed':
      return 'Známá fronta je dokončená';
    case 'scan_limited':
      return event.reason
        ? limitLabels[event.reason]
        : 'Dosažen limit skenování';
    case 'scan_error':
      return 'Skenování se nepodařilo dokončit';
  }
}

export function ScanActivityStatus({
  scan,
  refreshError = '',
}: {
  scan: ScanSnapshot;
  refreshError?: string;
}) {
  const [now, setNow] = useState(Date.now);
  const running = !scan.archived && scan.status === 'running' && !refreshError;
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);
  const activity = scan.activity;
  const emptyCompletion =
    scan.status === 'completed' &&
    !scan.results.some((result) => result.status === 'ok');
  let title = {
    waiting: 'Připraveno ke skenování',
    running: 'Skenování běží na serveru',
    paused: 'Skenování pozastaveno',
    interrupted: 'Skenování bylo přerušeno',
    completed: emptyCompletion
      ? 'Sken skončil bez načtených stránek'
      : 'Sken dokončen',
    limited: 'Sken zastaven na limitu',
    error: 'Skenování vyžaduje pozornost',
  }[scan.status];
  let detail = '';
  if (refreshError) {
    detail = `Poslední známý stav: ${title.toLowerCase()}`;
    title = 'Aktuální stav se nedaří ověřit';
  }
  if (running) {
    if (activity?.phase === 'fetching_robots') title = 'Kontroluji robots.txt';
    else if (activity?.phase === 'fetching_page') title = 'Načítám stránku';
    else if (activity?.phase === 'waiting') {
      const next = Date.parse(activity.nextRequestAt ?? '');
      const seconds = Number.isFinite(next)
        ? Math.max(0, Math.ceil((next - now) / 1000))
        : 0;
      title =
        seconds > 0
          ? `Odstup mezi požadavky · ${seconds} s`
          : 'Čeká na zpracování';
    } else if (activity?.phase === 'queued') title = 'Čeká na zpracování';
    detail = activity?.url ?? activity?.origin ?? '';
  }
  return (
    <div
      className={`scan-activity${running ? ' is-running' : ''}`}
      data-testid="scan-activity"
    >
      {running ? (
        <LoaderCircle
          className="scan-activity-spinner"
          size={21}
          aria-hidden="true"
        />
      ) : emptyCompletion ? (
        <AlertTriangle size={21} aria-hidden="true" />
      ) : scan.status === 'completed' ? (
        <Check size={21} aria-hidden="true" />
      ) : scan.status === 'paused' ? (
        <CirclePause size={21} aria-hidden="true" />
      ) : (
        <span className="scan-activity-dot" aria-hidden="true" />
      )}
      <div className="scan-activity-description">
        <strong>{title}</strong>
        {detail && <span title={detail}>{detail}</span>}
      </div>
      <span className="scan-activity-count">
        {scan.results.length}{' '}
        {scan.results.length === 1
          ? 'zpracovaná stránka'
          : scan.results.length >= 2 && scan.results.length <= 4
            ? 'zpracované stránky'
            : 'zpracovaných stránek'}
      </span>
    </div>
  );
}

function LogDrawer({
  scan,
  onClose,
  onErrorCount,
  refreshError,
}: {
  scan: ScanSnapshot;
  onClose: () => void;
  onErrorCount: (count: number) => void;
  refreshError: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const close = () => {
    dialog.current?.close();
    onClose();
  };
  const following = useRef(true);
  const [follow, setFollow] = useState(true);
  const [events, setEvents] = useState<ScanLogEvent[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [origin, setOrigin] = useState('');
  const [errorsOnly, setErrorsOnly] = useState(false);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  const logVersion = scan.status === 'running' ? '' : scan.updatedAt;
  useEffect(() => {
    const controller = new AbortController();
    let timer: number | undefined;
    const refresh = async () => {
      try {
        const response = await fetch(
          `${API_PREFIX}/scans/${encodeURIComponent(scan.id)}${scan.runId ? `/runs/${encodeURIComponent(scan.runId)}` : ''}/log`,
          {
            credentials: 'same-origin',
            signal: controller.signal,
          },
        );
        if (!response.ok) throw new Error('Log unavailable');
        const result = (await response.json()) as {
          events: ScanLogEvent[];
          truncated: boolean;
        };
        if (controller.signal.aborted) return;
        setEvents(result.events);
        setTruncated(result.truncated);
        onErrorCount(
          result.events.filter((event) => event.level === 'error').length,
        );
        setError('');
      } catch {
        if (!controller.signal.aborted)
          setError(
            'Průběh skenu se nepodařilo načíst. Skenování tím není zastavené.',
          );
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
          if (!scan.archived && scan.status === 'running')
            timer = window.setTimeout(() => {
              void refresh();
            }, 3000);
        }
      }
    };
    void refresh();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [
    scan.id,
    scan.runId,
    scan.archived,
    scan.status,
    logVersion,
    revision,
    onErrorCount,
  ]);
  useEffect(() => {
    if (following.current && list.current)
      list.current.scrollTop = list.current.scrollHeight;
  }, [events, origin, errorsOnly]);
  const resumeFollowing = () => {
    following.current = true;
    setFollow(true);
    if (list.current) list.current.scrollTop = list.current.scrollHeight;
  };
  const filtered = events.filter(
    (event) =>
      (!origin || event.origin === origin) &&
      (!errorsOnly || event.level === 'error'),
  );
  return (
    <dialog
      ref={dialog}
      className="scan-log-panel"
      aria-labelledby="scan-log-title"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <header className="scan-log-header">
        <div>
          <span className="scan-eyebrow">ULOŽENÁ HISTORIE</span>
          <h2 id="scan-log-title">Průběh skenu</h2>
        </div>
        <button
          className="scan-button"
          onClick={close}
          aria-label="Zavřít průběh skenu"
        >
          <X size={20} aria-hidden="true" />
        </button>
      </header>
      <ScanActivityStatus scan={scan} refreshError={refreshError} />
      <div className="scan-log-filters">
        <label>
          Web{' '}
          <select
            value={origin}
            onChange={(event) => {
              setOrigin(event.target.value);
              resumeFollowing();
            }}
          >
            <option value="">Všechny weby</option>
            {scan.sites.map((site) => (
              <option key={site.origin} value={site.origin}>
                {new URL(site.origin).host}
              </option>
            ))}
          </select>
        </label>
        <label className="scan-log-checkbox">
          <input
            type="checkbox"
            checked={errorsOnly}
            onChange={(event) => {
              setErrorsOnly(event.target.checked);
              resumeFollowing();
            }}
          />
          Jen chyby
        </label>
        {!follow && (
          <button className="scan-button" onClick={resumeFollowing}>
            Sledovat nové záznamy
          </button>
        )}
      </div>
      {error && (
        <div className="scan-log-error" role="alert">
          {error}{' '}
          <button
            className="scan-button"
            onClick={() => setRevision((value) => value + 1)}
          >
            Zkusit znovu
          </button>
        </div>
      )}
      <div
        ref={list}
        className="scan-log-list"
        role="region"
        aria-label="Záznamy skenu"
        tabIndex={0}
        onScroll={() => {
          const element = list.current;
          if (!element) return;
          const atBottom =
            element.scrollHeight - element.clientHeight - element.scrollTop <
            24;
          following.current = atBottom;
          setFollow(atBottom);
        }}
      >
        {loading ? (
          <p className="scan-log-empty">Načítám průběh skenu…</p>
        ) : filtered.length === 0 ? (
          <p className="scan-log-empty">
            {events.length === 0
              ? 'Zatím nejsou uložené žádné záznamy. Nové události se objeví během skenování.'
              : 'Tomuto filtru neodpovídají žádné záznamy.'}
          </p>
        ) : (
          <ol>
            {filtered.map((event) => (
              <li key={event.id} data-level={event.level}>
                <time
                  dateTime={event.at}
                  title={new Date(event.at).toLocaleString('cs-CZ')}
                >
                  {new Date(event.at).toLocaleTimeString('cs-CZ')}
                </time>
                <span className="scan-log-symbol" aria-hidden="true">
                  {event.level === 'error' ? (
                    <X size={15} />
                  ) : event.level === 'warning' ? (
                    <AlertTriangle size={15} />
                  ) : event.type === 'page_finished' ? (
                    <Check size={15} />
                  ) : (
                    '·'
                  )}
                </span>
                <div>
                  <strong>{eventLabel(event)}</strong>
                  {event.httpStatus != null && (
                    <span className="scan-log-meta">
                      {' '}
                      · HTTP {event.httpStatus}
                    </span>
                  )}
                  {event.linkCount != null && (
                    <span className="scan-log-meta">
                      {' '}
                      · {event.linkCount} odkazů
                    </span>
                  )}
                  {(event.url || event.origin) && (
                    <span className="scan-log-url">
                      {event.url || event.origin}
                    </span>
                  )}
                  {event.redirect?.targetUrl && (
                    <span className="scan-log-url">
                      Cíl přesměrování: {event.redirect.targetUrl}
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>
      <footer className="scan-log-footer">
        <span>
          {truncated
            ? 'Zobrazeno nejvýše 500 nejnovějších záznamů.'
            : `${filtered.length} záznamů`}
        </span>
        <span>
          {scan.status === 'running'
            ? 'Průběžně aktualizováno'
            : 'Historie je uložená s mapou'}
        </span>
      </footer>
    </dialog>
  );
}

export default function ScanLogPanel({
  scan,
  refreshError = '',
}: {
  scan: ScanSnapshot;
  refreshError?: string;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [logErrors, setLogErrors] = useState(0);
  const resultErrors = scan.results.filter(
    (result) =>
      result.status === 'http_error' || result.status === 'network_error',
  ).length;
  const errors = Math.max(resultErrors, logErrors);
  return (
    <>
      <button
        className="scan-button"
        ref={trigger}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <List size={15} aria-hidden="true" />
        Průběh skenu
        {errors > 0 && (
          <span className="scan-log-badge">
            {errors} {errors === 1 ? 'chyba' : errors < 5 ? 'chyby' : 'chyb'}
          </span>
        )}
      </button>
      {open && (
        <LogDrawer
          scan={scan}
          onClose={() => {
            setOpen(false);
            window.requestAnimationFrame(() => trigger.current?.focus());
          }}
          refreshError={refreshError}
          onErrorCount={setLogErrors}
        />
      )}
    </>
  );
}
