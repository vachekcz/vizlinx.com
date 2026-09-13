import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  AlertTriangle,
  Mail,
  Globe2,
  Moon,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Sun,
} from 'lucide-react';
import App from './App';
import ScanLogPanel, {
  ScanActivityStatus,
  redirectLabel,
} from './ScanLogPanel';
import { scanToDataset } from './scan-dataset';
import { useTheme } from './themes';
import { API_PREFIX, normalizeScanUrl, SCAN_LIMITS } from '../shared/scan';
import type {
  ScanSite,
  ScanSnapshot,
  ScanStatus,
  ScanSummary,
  ScanRunSummary,
} from '../shared/scan';
import './scan-workspace.css';

const statusLabels: Record<ScanStatus, string> = {
  waiting: 'Připraveno ke skenování',
  running: 'Skenování běží na serveru',
  paused: 'Skenování pozastaveno',
  interrupted: 'Skenování bylo přerušeno',
  completed: 'Známá fronta je dokončená',
  limited: 'Dosažen nastavený limit',
  error: 'Skenování vyžaduje pozornost',
};

function runLabel(run: ScanSummary) {
  const status = {
    waiting: 'Připraveno',
    running: 'Běží',
    paused: 'Pozastaveno',
    interrupted: 'Přerušeno',
    completed: 'Dokončeno',
    limited: 'Dosažen limit',
    error: 'Chyba',
  }[run.status];
  return `#${run.runNumber ?? 1} · ${new Date(run.runCreatedAt ?? run.createdAt).toLocaleString('cs-CZ', { dateStyle: 'short', timeStyle: 'short' })} · ${status}`;
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_PREFIX}${path}`, {
    ...init,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...init.headers },
  });
  if (!response.ok) {
    const messages: Record<number, string> = {
      400: 'Zkontroluj zadané weby a nastavení skenu.',
      401: 'Relace vypršela. Obnov stránku a zkus akci znovu.',
      404: 'Mapa není dostupná v tomto prohlížeči nebo její platnost vypršela.',
      409: 'Stav skenu se změnil. Obnov data a zkus akci znovu.',
      413: 'Výsledek překročil limit prvního prototypu.',
      429: 'Kapacita skenování nebo denní limit jsou vyčerpané. Uložené výsledky zůstávají dostupné. Zkus to později.',
    };
    throw new Error(
      messages[response.status] ??
        'Server je dočasně nedostupný. Zkus to znovu.',
    );
  }
  return response.json() as Promise<T>;
}

function ScanLimitNotice({
  reason,
  adminEmail,
}: {
  reason: ScanSummary['limitReason'];
  adminEmail: string | null;
}) {
  const titles = {
    page_limit: `Dosažen limit ${SCAN_LIMITS.pagesPerSite} stránek na web`,
    scan_storage_limit: 'Dosažen limit velikosti mapy',
    time_limit: 'Dosažen časový limit skenování',
    daily_limit: 'Dosažen denní limit skenování',
  };
  const title = reason ? titles[reason] : 'Dosažen limit skenování';
  return (
    <section
      className="scan-limit-notice"
      role="alert"
      aria-labelledby="scan-limit-title"
    >
      <AlertTriangle size={28} aria-hidden="true" />
      <div>
        <h2 id="scan-limit-title">{title}</h2>
        <p>
          Sken se zastavil na bezpečnostním limitu. Dosavadní výsledky zůstávají
          uložené a můžeš je dál prohlížet.
        </p>
        {reason === 'daily_limit' && (
          <p>
            Denní rozpočet se obnovuje o půlnoci UTC. Potom můžeš pokračovat ve
            stejné mapě.
          </p>
        )}
        <p>
          <strong>Pro vyšší limit kontaktuj správce.</strong>
        </p>
        {adminEmail && (
          <a
            className="scan-button scan-button-primary"
            href={`mailto:${adminEmail}?subject=${encodeURIComponent('Vizlinx – žádost o vyšší limit skenování')}`}
          >
            <Mail size={16} aria-hidden="true" /> Kontaktovat správce
          </a>
        )}
      </div>
    </section>
  );
}

function parseSites(value: string, interval: number): ScanSite[] {
  const seeds = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const origins = new Map<string, string>();
  for (const seed of seeds) {
    const url = normalizeScanUrl(seed);
    const origin = new URL(url).origin;
    if (!origins.has(origin)) origins.set(origin, url);
  }
  if (origins.size < 1 || origins.size > SCAN_LIMITS.sites)
    throw new Error('Zadej 1 až 3 veřejné weby, každý na vlastní řádek.');
  return [...origins].map(([origin, seedUrl]) => ({
    origin,
    seedUrl,
    intervalMs: interval * 1000,
    maxPages: SCAN_LIMITS.pagesPerSite,
    paused: false,
  }));
}

export default function ScanWorkspace() {
  const { theme, toggleTheme } = useTheme();
  const [scanId, setScanId] = useState<string | null>(() =>
    new URL(window.location.href).searchParams.get('id'),
  );
  const [selectedRunId, setSelectedRunId] = useState<string | null>(() =>
    new URL(window.location.href).searchParams.get('run'),
  );
  const [runs, setRuns] = useState<ScanRunSummary[]>([]);
  const [runLimit, setRunLimit] = useState(10);
  const [historyError, setHistoryError] = useState('');
  const [historyRevision, setHistoryRevision] = useState(0);
  const [scan, setScan] = useState<ScanSnapshot | null>(null);
  const [saved, setSaved] = useState<ScanSummary[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [refreshError, setRefreshError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [adminEmail, setAdminEmail] = useState<string | null>(null);
  const [seeds, setSeeds] = useState('');
  const [interval, setIntervalSeconds] = useState(3);
  const [addingSite, setAddingSite] = useState(false);
  const [newSiteUrl, setNewSiteUrl] = useState('');
  const [newSiteInterval, setNewSiteInterval] = useState(3);
  const [refreshRevision, setRefreshRevision] = useState(0);
  const refreshEpoch = useRef(0);
  const actionInFlight = useRef(false);
  const historical = Boolean(scan?.archived);
  const dataset = useMemo(
    () => (scan ? scanToDataset(scan) : undefined),
    [scan],
  );

  useEffect(() => {
    let cancelled = false;
    void api<{ ok: boolean }>('/session', { method: 'POST', body: '{}' })
      .then(() => {
        if (!cancelled) setReady(true);
      })
      .catch((cause: unknown) => {
        if (!cancelled)
          setError(
            cause instanceof Error
              ? cause.message
              : 'Připojení k serveru selhalo.',
          );
      });
    void api<{ adminEmail: string | null; maxPagesPerSite: number }>('/config')
      .then((config) => {
        if (!cancelled) setAdminEmail(config.adminEmail);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    let fetching = false;
    let archivedLoaded = false;
    const refresh = async () => {
      if (fetching || archivedLoaded || actionInFlight.current) return;
      fetching = true;
      const epoch = refreshEpoch.current;
      const current = () =>
        !cancelled && !actionInFlight.current && epoch === refreshEpoch.current;
      try {
        if (scanId) {
          const snapshot = await api<ScanSnapshot>(
            `/scans/${encodeURIComponent(scanId)}${selectedRunId ? `/runs/${encodeURIComponent(selectedRunId)}` : ''}`,
          );
          if (current()) {
            setScan(snapshot);
            archivedLoaded = Boolean(snapshot.archived);
          }
        } else {
          const maps = await api<ScanSummary[]>('/scans');
          if (current()) setSaved(maps);
        }
        if (current()) setRefreshError('');
      } catch (cause) {
        if (current())
          setRefreshError(
            cause instanceof Error
              ? cause.message
              : 'Data se nepodařilo aktualizovat.',
          );
      } finally {
        fetching = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => {
      void refresh();
    }, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [ready, scanId, selectedRunId, refreshRevision]);

  useEffect(() => {
    if (!ready || !scanId || !scan?.runId) return;
    let cancelled = false;
    void api<{ runs: ScanRunSummary[]; limit: number }>(`/scans/${scanId}/runs`)
      .then((result) => {
        if (cancelled) return;
        setRuns(result.runs);
        setRunLimit(result.limit);
        setHistoryError('');
      })
      .catch(() => {
        if (!cancelled)
          setHistoryError(
            'Historii skenů se nepodařilo načíst. Zkus načtení zopakovat.',
          );
      });
    return () => {
      cancelled = true;
    };
  }, [
    ready,
    scanId,
    scan?.runId,
    scan?.status,
    refreshRevision,
    historyRevision,
  ]);

  const selectScan = (
    id: string | null,
    snapshot: ScanSnapshot | null = null,
  ) => {
    refreshEpoch.current += 1;
    setScan(snapshot);
    setScanId(id);
    setSelectedRunId(null);
    setRuns([]);
    setHistoryError('');
    setError('');
    setRefreshError('');
    setNotice('');
    setAddingSite(false);
    setNewSiteUrl('');
    window.history.replaceState(
      null,
      '',
      id ? `/scan?id=${encodeURIComponent(id)}` : '/scan',
    );
  };
  const selectRun = (runId: string | null) => {
    if (actionInFlight.current) return;
    refreshEpoch.current += 1;
    setSelectedRunId(runId);
    setScan(null);
    setError('');
    setRefreshError('');
    setNotice('');
    setAddingSite(false);
    window.history.replaceState(
      null,
      '',
      `/scan?id=${encodeURIComponent(scanId!)}${runId ? `&run=${encodeURIComponent(runId)}` : ''}`,
    );
  };
  const action = async (work: () => Promise<void>) => {
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    refreshEpoch.current += 1;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await work();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Akci se nepodařilo dokončit.',
      );
    } finally {
      refreshEpoch.current += 1;
      actionInFlight.current = false;
      setBusy(false);
      setRefreshRevision((revision) => revision + 1);
    }
  };
  const start = () => {
    void action(async () => {
      if (!scan || historical) return;
      setScan(
        await api<ScanSnapshot>(`/scans/${scan.id}/start`, {
          method: 'POST',
          body: JSON.stringify({ runId: scan.runId }),
        }),
      );
      setNotice(
        'Skenování běží na serveru. Tuto kartu můžeš zavřít a k mapě se později vrátit.',
      );
    });
  };
  const changeSite = (
    id: string,
    change: Partial<Pick<ScanSite, 'intervalMs' | 'paused'>>,
  ) => {
    void action(async () => {
      if (!scan || historical) return;
      const sites = scan.sites.map((site) =>
        site.origin === id ? { ...site, ...change } : site,
      );
      await api(`/scans/${scan.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ sites, runId: scan.runId }),
      });
      setScan(await api<ScanSnapshot>(`/scans/${scan.id}`));
    });
  };

  const addSite = () => {
    void action(async () => {
      if (!scan || historical) return;
      let site: ScanSite;
      try {
        const parsed = parseSites(newSiteUrl, newSiteInterval);
        if (parsed.length !== 1) throw new Error('Expected one origin.');
        site = parsed[0];
      } catch {
        throw new Error(
          'Zadej jeden veřejný HTTP(S) web bez přihlašovacích údajů a nestandardního portu.',
        );
      }
      if (scan.sites.some((existing) => existing.origin === site.origin))
        throw new Error('Tento web už je součástí mapy.');
      const updated = await api<ScanSnapshot>(`/scans/${scan.id}/sites`, {
        method: 'POST',
        body: JSON.stringify({ site, runId: scan.runId }),
      });
      setScan(updated);
      setRefreshError('');
      setAddingSite(false);
      setNewSiteUrl('');
      setNotice(
        'Web je přidaný a dosavadní výsledky zůstaly uložené. Klikni na „Pokračovat ve skenování“ a server prozkoumá i nový web.',
      );
    });
  };

  const rescan = () => {
    void action(async () => {
      if (!scan || historical || !scan.runId) return;
      const updated = await api<ScanSnapshot>(`/scans/${scan.id}/rescan`, {
        method: 'POST',
        body: JSON.stringify({ runId: scan.runId }),
      });
      setSelectedRunId(null);
      window.history.replaceState(
        null,
        '',
        `/scan?id=${encodeURIComponent(scan.id)}`,
      );
      setScan(updated);
      setAddingSite(false);
      setNotice(
        'Nový sken běží. Výsledky přibývají živě; předchozí průchod najdeš v historii skenů.',
      );
    });
  };

  if (scan && dataset) {
    const currentRun =
      runs.find((run) => !run.archived) ?? (!historical ? scan : null);
    const rescanIsPrimary =
      Boolean(scan.runId) &&
      (scan.status === 'completed' ||
        scan.limitReason === 'time_limit' ||
        scan.limitReason === 'scan_storage_limit' ||
        (scan.status === 'limited' && scan.limitReason !== 'daily_limit'));
    const toolbar = (
      <section
        className="scan-live-controls"
        aria-label="Ovládání skutečného skenu"
      >
        <div className="scan-control-row">
          <button
            className="scan-button"
            disabled={busy}
            onClick={() => selectScan(null)}
          >
            <ArrowLeft size={15} /> Uložené mapy
          </button>
          {!historical && (
            <>
              <button
                className="scan-button"
                disabled={busy || scan.sites.length >= SCAN_LIMITS.sites}
                aria-expanded={addingSite}
                onClick={() => setAddingSite((visible) => !visible)}
              >
                <Plus size={15} /> Přidat web
              </button>
              {!rescanIsPrimary && (
                <button
                  className="scan-button scan-button-primary"
                  disabled={
                    busy ||
                    scan.status === 'running' ||
                    scan.status === 'completed' ||
                    scan.limitReason === 'time_limit' ||
                    scan.limitReason === 'scan_storage_limit' ||
                    (scan.status === 'limited' &&
                      scan.limitReason !== 'daily_limit')
                  }
                  onClick={start}
                >
                  <Play size={15} />{' '}
                  {scan.status === 'interrupted' ||
                  scan.status === 'paused' ||
                  scan.limitReason === 'daily_limit'
                    ? 'Pokračovat ve skenování'
                    : scan.status === 'running'
                      ? 'Skenování běží'
                      : 'Spustit skenování'}
                </button>
              )}
              {scan.status === 'running' && (
                <button
                  className="scan-button"
                  disabled={busy}
                  onClick={() => {
                    void action(async () => {
                      await api(`/scans/${scan.id}`, {
                        method: 'PATCH',
                        body: JSON.stringify({
                          status: 'paused',
                          runId: scan.runId,
                        }),
                      });
                      setScan(await api<ScanSnapshot>(`/scans/${scan.id}`));
                    });
                  }}
                >
                  <Pause size={15} /> Pozastavit sken
                </button>
              )}
              {scan.runId && (
                <button
                  className={`scan-button${rescanIsPrimary ? ' scan-button-primary' : ''}`}
                  disabled={
                    busy ||
                    scan.status === 'running' ||
                    scan.status === 'waiting' ||
                    runs.length >= runLimit ||
                    Boolean(historyError) ||
                    runs.length === 0
                  }
                  onClick={rescan}
                >
                  <RotateCcw size={15} /> Skenovat znovu
                </button>
              )}
            </>
          )}
          <ScanLogPanel
            key={scan.runId ?? scan.id}
            scan={scan}
            refreshError={refreshError}
          />
          <span className="scan-stats">
            {scan.results.filter((result) => result.status === 'ok').length}{' '}
            načtených ·{' '}
            {scan.results.filter((result) => result.status !== 'ok').length}{' '}
            neúspěšných / vynechaných
          </span>
        </div>
        {scan.runId && (
          <div className="scan-history-row">
            <label htmlFor="scan-history">Historie skenů</label>
            <select
              id="scan-history"
              value={selectedRunId ?? ''}
              disabled={busy}
              onChange={(event) => selectRun(event.target.value || null)}
            >
              <option value="">
                Aktuální sken{currentRun ? ` · ${runLabel(currentRun)}` : ''}
              </option>
              {runs
                .filter((run) => run.archived || run.runId === selectedRunId)
                .map((run) => (
                  <option key={run.runId} value={run.runId}>
                    {runLabel(run)}
                    {run.archived ? '' : ' · aktuální'}
                  </option>
                ))}
            </select>
            <span className="scan-note">
              {runs.length || 1}/{runLimit} průchodů · historie se uchovává do
              vypršení mapy (30 dní od založení)
            </span>
          </div>
        )}
        {historical && (
          <div className="scan-history-notice" role="status">
            <div>
              <strong>Prohlížíš historii · sken #{scan.runNumber}</strong>
              <p>
                Uložený průchod je pouze ke čtení. Nové výsledky a ovládání
                najdeš v aktuálním skenu.
              </p>
            </div>
            <button className="scan-button" onClick={() => selectRun(null)}>
              Zpět na aktuální sken
            </button>
          </div>
        )}
        {runs.length >= runLimit && (
          <p className="scan-notice" role="status">
            Dosažen limit {runLimit} průchodů této mapy. Pro vyšší limit
            kontaktuj správce.
            {adminEmail && (
              <>
                {' '}
                <a href={`mailto:${adminEmail}`}>Kontaktovat správce</a>
              </>
            )}
          </p>
        )}
        {historyError && (
          <p className="scan-error" role="alert">
            {historyError}{' '}
            <button
              className="scan-button"
              onClick={() => {
                setHistoryError('');
                setHistoryRevision((revision) => revision + 1);
              }}
            >
              Zkusit načíst historii znovu
            </button>
          </p>
        )}
        <ScanActivityStatus scan={scan} refreshError={refreshError} />
        {scan.sites.length >= SCAN_LIMITS.sites && (
          <p className="scan-note">
            Limit prototypu: {SCAN_LIMITS.sites} weby v jedné mapě.
          </p>
        )}
        {addingSite && !historical && (
          <form
            className="scan-card scan-add-site"
            aria-label="Přidat web do mapy"
            onSubmit={(event) => {
              event.preventDefault();
              addSite();
            }}
          >
            <label htmlFor="new-site-url">Nový web</label>
            <input
              id="new-site-url"
              value={newSiteUrl}
              onChange={(event) => setNewSiteUrl(event.target.value)}
              placeholder="https://dalsi-web.cz"
              required
              disabled={busy}
              autoCapitalize="none"
              spellCheck={false}
              autoFocus
            />
            <div className="scan-form-grid">
              <label>
                Interval nového webu (sekundy)
                <input
                  type="number"
                  min={1}
                  max={60}
                  required
                  disabled={busy}
                  value={newSiteInterval}
                  onChange={(event) =>
                    setNewSiteInterval(Number(event.target.value))
                  }
                />
              </label>
              <p className="scan-note">
                Pevný limit:{' '}
                <strong>{SCAN_LIMITS.pagesPerSite} stránek na web.</strong>
              </p>
            </div>
            <p className="scan-note">
              Mapa i nalezené odkazy zůstanou zachované. Přidání pozastaví sken;
              pokračování spustíš tlačítkem „Pokračovat ve skenování“.
            </p>
            <div className="scan-control-row">
              <button
                className="scan-button scan-button-primary"
                type="submit"
                disabled={busy}
              >
                {busy ? 'Přidávám web…' : 'Přidat do mapy'}
              </button>
              <button
                className="scan-button"
                type="button"
                disabled={busy}
                onClick={() => setAddingSite(false)}
              >
                Zrušit
              </button>
            </div>
          </form>
        )}
        <p className="scan-note">
          Čteme veřejné statické HTML bez spouštění JavaScriptu a bez tvého
          přihlášení. Sken běží na serveru i po zavření karty. Nejvýše{' '}
          {SCAN_LIMITS.pagesPerSite} stránek na web.
        </p>
        {(scan.status === 'limited' || scan.limitReason) && (
          <ScanLimitNotice reason={scan.limitReason} adminEmail={adminEmail} />
        )}
        {(error || refreshError) && (
          <p className="scan-error" role="alert">
            {error || refreshError}
          </p>
        )}
        {notice && (
          <p className="scan-notice" role="status">
            {notice}
          </p>
        )}
        {scan.results.some(
          (result) => result.status !== 'ok' || result.truncated,
        ) && (
          <details className="scan-issues">
            <summary>Podrobnosti neúplných výsledků</summary>
            <ul>
              {scan.results
                .filter((result) => result.status !== 'ok' || result.truncated)
                .map((result) => (
                  <li key={result.sourceUrl}>
                    <span>{result.sourceUrl}</span> —{' '}
                    {result.redirect
                      ? redirectLabel(result.redirect)
                      : result.truncated
                        ? 'výsledek zkrácen limitem'
                        : {
                            http_error: 'chyba HTTP',
                            network_error: 'síťová chyba',
                            redirect_unresolved:
                              'přesměrování vyžaduje zadat cílovou URL',
                            robots_denied: 'zakázáno robots.txt',
                            not_html: 'není HTML',
                            too_large: 'stránka je příliš velká',
                            ok: 'načteno',
                          }[result.status]}
                    {result.httpStatus ? ` (${result.httpStatus})` : ''}
                    {result.redirect?.targetUrl && (
                      <span> → {result.redirect.targetUrl}</span>
                    )}
                  </li>
                ))}
            </ul>
          </details>
        )}
      </section>
    );
    return (
      <App
        key={scan.runId ?? scan.id}
        dataset={dataset}
        live={{
          title: scan.sites
            .map((site) => new URL(site.origin).host)
            .join(' · '),
          status: statusLabels[scan.status],
          toolbar,
          controlsDisabled: busy || historical,
          pageLimits: Object.fromEntries(
            scan.sites.map((site) => [site.origin, site.maxPages]),
          ),
          pausedSites: scan.sites
            .filter((site) => site.paused)
            .map((site) => site.origin),
          intervals: Object.fromEntries(
            scan.sites.map((site) => [site.origin, site.intervalMs / 1000]),
          ),
          onPauseSite: historical
            ? undefined
            : (id) =>
                changeSite(id, {
                  paused: !scan.sites.find((site) => site.origin === id)
                    ?.paused,
                }),
          onIntervalChange: historical
            ? undefined
            : (id, seconds) => changeSite(id, { intervalMs: seconds * 1000 }),
        }}
      />
    );
  }

  return (
    <main className="scan-workspace" data-theme={theme}>
      <header className="scan-header">
        <a className="scan-brand" href="/">
          vizlinx<span>.</span>
        </a>
        <span>Skutečné propojení webů</span>
        <button
          className="theme-toggle"
          aria-label="Noční režim"
          aria-pressed={theme === 'midnight'}
          onClick={toggleTheme}
        >
          {theme === 'midnight' ? <Sun size={17} /> : <Moon size={17} />}
        </button>
      </header>
      <div className="scan-content">
        <div className="scan-intro">
          <span className="scan-eyebrow">SERVEROVÝ SKEN · PROTOTYP</span>
          <h1>
            Objev propojení vlastních webů<span>.</span>
          </h1>
          <p>
            Zadej weby a sleduj, které konkrétní stránky je propojují. Sken běží
            na serveru a výsledky se průběžně ukládají do tvé mapy. Nic
            neinstaluješ a kartu můžeš během skenování zavřít.
          </p>
        </div>
        {(error || refreshError) && (
          <p className="scan-error" role="alert">
            {error || refreshError}
          </p>
        )}
        {notice && (
          <p className="scan-notice" role="status">
            {notice}
          </p>
        )}
        {scanId ? (
          <section className="scan-card">
            <p role="status">
              {error || refreshError
                ? 'Tuto mapu se nepodařilo otevřít.'
                : 'Načítám uloženou mapu…'}
            </p>
            {selectedRunId && (
              <button className="scan-button" onClick={() => selectRun(null)}>
                Zpět na aktuální sken
              </button>
            )}
            <button className="scan-button" onClick={() => selectScan(null)}>
              Zpět na seznam map
            </button>
          </section>
        ) : (
          <div className="scan-columns">
            <section className="scan-card">
              <h2>Nová mapa</h2>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void action(async () => {
                    let sites: ScanSite[];
                    try {
                      sites = parseSites(seeds, interval);
                    } catch {
                      throw new Error(
                        'Zadej 1 až 3 veřejné HTTP(S) weby bez přihlašovacích údajů a nestandardních portů. Každý na samostatný řádek.',
                      );
                    }
                    const snapshot = await api<ScanSnapshot>('/scans', {
                      method: 'POST',
                      body: JSON.stringify({ sites }),
                    });
                    selectScan(snapshot.id, snapshot);
                    setScan(
                      await api<ScanSnapshot>(`/scans/${snapshot.id}/start`, {
                        method: 'POST',
                        body: JSON.stringify({ runId: snapshot.runId }),
                      }),
                    );
                  });
                }}
              >
                <label htmlFor="scan-seeds">Weby k prozkoumání</label>
                <textarea
                  id="scan-seeds"
                  value={seeds}
                  onChange={(event) => setSeeds(event.target.value)}
                  rows={5}
                  placeholder={'https://tvuj-web.cz\nhttps://partnersky-web.cz'}
                  required
                  autoCapitalize="none"
                  spellCheck={false}
                />
                <p className="scan-note">
                  Nejvýše 3 weby. Povoluješ konkrétní hosty; ostatní nalezené
                  cíle se uloží, ale nezačnou se samy skenovat.
                </p>
                <div className="scan-form-grid">
                  <label>
                    Interval požadavků (sekundy)
                    <input
                      type="number"
                      min={1}
                      max={60}
                      value={interval}
                      onChange={(event) =>
                        setIntervalSeconds(Number(event.target.value))
                      }
                      required
                    />
                  </label>
                  <p className="scan-note">
                    Pevný limit:{' '}
                    <strong>{SCAN_LIMITS.pagesPerSite} stránek na web.</strong>{' '}
                    Pro vyšší limit kontaktuj správce.
                  </p>
                </div>
                <p className="scan-note">
                  Bez účtu. Mapy patří tomuto prohlížeči a uchovávají se nejvýše
                  30 dní. Smazáním jeho dat můžeš ztratit přístup.
                </p>
                <button
                  className="scan-button scan-button-primary"
                  disabled={!ready || busy}
                  type="submit"
                >
                  <Globe2 size={16} />
                  {busy ? 'Spouštím sken…' : 'Spustit sken'}
                  <ArrowRight size={16} />
                </button>
              </form>
            </section>
            <aside>
              <section className="scan-card">
                <h2>Jak sken funguje</h2>
                <p className="scan-note">
                  Procházíme veřejné odkazy ve statickém HTML. Stránky za
                  přihlášením a odkazy vytvořené JavaScriptem nemusí být
                  dostupné.
                </p>
                <p className="scan-note">
                  Výsledky přibývají průběžně. Po zavření této karty sken
                  pokračuje a uloženou mapu najdeš po návratu v tomto
                  prohlížeči.
                </p>
              </section>
              <section className="scan-card scan-saved">
                <h2>Uložené mapy</h2>
                {saved.length ? (
                  <ul>
                    {saved.map((item) => (
                      <li key={item.id}>
                        <button onClick={() => selectScan(item.id)}>
                          <strong>
                            {item.sites
                              .map((site) => new URL(site.origin).host)
                              .join(' · ')}
                          </strong>
                          <span>
                            {statusLabels[item.status]} · {item.pageCount}{' '}
                            stránek
                          </span>
                          <small>
                            {new Date(item.createdAt).toLocaleString('cs-CZ')}
                          </small>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="scan-note">
                    {ready
                      ? 'Zatím tu nejsou žádné mapy. První se objeví po zadání webů.'
                      : 'Připojuji se k serveru…'}
                  </p>
                )}
              </section>
            </aside>
          </div>
        )}
      </div>
    </main>
  );
}
