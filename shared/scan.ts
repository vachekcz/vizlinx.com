export const API_PREFIX = '/api/v1';
export const SCAN_LIMITS = {
  sites: 3,
  runsPerMap: 10,
  pagesPerSite: 100,
  previewPagesPerSite: 10,
  previewPagesPerScan: 100,
  linksPerPage: 500,
  discoveredPerPage: 500,
  htmlBytes: 2 * 1024 * 1024,
  resultBytes: 256 * 1024,
  urlLength: 4096,
  anchorLength: 512,
  minIntervalMs: 1000,
  maxIntervalMs: 60_000,
} as const;

export type ScanStatus =
  | 'waiting'
  | 'running'
  | 'paused'
  | 'interrupted'
  | 'completed'
  | 'limited'
  | 'error';
export type PageStatus =
  | 'ok'
  | 'http_error'
  | 'network_error'
  | 'redirect_unresolved'
  | 'robots_denied'
  | 'not_html'
  | 'too_large';
export type FoundLink = {
  targetUrl: string;
  anchor: string;
  rel: string[];
  region: 'content' | 'navigation' | 'footer' | 'unknown';
  occurrences: number;
};
export type ScanRedirect =
  | { kind: 'same_origin'; targetUrl: string }
  | { kind: 'site_variant'; targetUrl: string }
  | { kind: 'external'; targetUrl: string }
  | {
      kind: 'invalid';
      targetUrl?: string;
      reason?:
        | 'unsupported_status'
        | 'invalid_target'
        | 'redirect_loop'
        | 'redirect_limit';
    };
export type PageResult = {
  sourceUrl: string;
  // Server crawl owner; the actual request URL keeps its original origin.
  siteOrigin?: string;
  crawlMode?: 'preview';
  title: string;
  observedAt: string;
  status: PageStatus;
  httpStatus: number | null;
  error?: string;
  redirect?: ScanRedirect;
  links: FoundLink[];
  discoveredUrls: string[];
  truncated: boolean;
};
export type ScanSite = {
  origin: string;
  seedUrl: string;
  intervalMs: number;
  maxPages: number;
  paused: boolean;
};
export type ScanControl = {
  id: string;
  status: ScanStatus;
  sites: ScanSite[];
  limitReason?:
    'page_limit' | 'scan_storage_limit' | 'time_limit' | 'daily_limit';
};
export type ScanSummary = ScanControl & {
  createdAt: string;
  updatedAt: string;
  pageCount: number;
  runId?: string;
  runNumber?: number;
  runCreatedAt?: string;
  archived?: boolean;
};
export type ScanRunSummary = ScanSummary & {
  runId: string;
  runNumber: number;
  runCreatedAt: string;
  archived: boolean;
};
export type ScanHistory = { runs: ScanRunSummary[]; limit: number };
export type ScanActivity = {
  crawlMode?: 'preview';
  phase:
    | 'queued'
    | 'fetching_robots'
    | 'fetching_page'
    | 'waiting'
    | 'paused'
    | 'completed'
    | 'limited'
    | 'error'
    | 'interrupted';
  updatedAt: string;
  origin?: string;
  url?: string;
  nextRequestAt?: string;
};
export type ScanLogEvent = {
  id: number;
  crawlMode?: 'preview';
  at: string;
  type:
    | 'scan_started'
    | 'scan_paused'
    | 'site_added'
    | 'site_throttled'
    | 'settings_changed'
    | 'robots_checked'
    | 'page_finished'
    | 'scan_completed'
    | 'scan_limited'
    | 'scan_error';
  level: 'info' | 'warning' | 'error';
  origin?: string;
  url?: string;
  httpStatus?: number;
  status?: PageStatus;
  linkCount?: number;
  redirect?: ScanRedirect;
  reason?: ScanControl['limitReason'];
};
export type ScanLogResponse = { events: ScanLogEvent[]; truncated: boolean };
export type ScanSnapshot = ScanSummary & {
  results: PageResult[];
  activity?: ScanActivity;
};
export type RunnerSession = { token: string; scan: ScanSnapshot };

// Fetch scope is an exact public HTTP(S) origin, not a suffix match.
export function normalizeScanUrl(value: string): string {
  const url = new URL(
    /^[a-z][a-z\d+.-]*:/i.test(value.trim())
      ? value.trim()
      : `https://${value.trim()}`,
  );
  const host = url.hostname.toLowerCase();
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.port ||
    host.endsWith('.') ||
    !host.includes('.') ||
    host.includes(':') ||
    /^\d+(?:\.\d+){3}$/.test(host) ||
    /(?:^|\.)(?:localhost|local|internal|test|invalid|example|home|lan)$/.test(
      host,
    ) ||
    url.href.length > SCAN_LIMITS.urlLength
  ) {
    throw new Error('Enter a public HTTP(S) URL on its standard port.');
  }
  url.hash = '';
  return url.href;
}

export function normalizeLinkUrl(value: string, base: string): string | null {
  try {
    const url = new URL(value, base);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.href.length > SCAN_LIMITS.urlLength
    )
      return null;
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

export function isSiteVariant(source: string, target: string): boolean {
  try {
    const left = new URL(normalizeScanUrl(source));
    const right = new URL(normalizeScanUrl(target));
    return (
      left.hostname.replace(/^www\./, '') ===
      right.hostname.replace(/^www\./, '')
    );
  } catch {
    return false;
  }
}

export function isFollowableRedirect(
  redirect: ScanRedirect | undefined,
): redirect is Extract<ScanRedirect, { kind: 'same_origin' | 'site_variant' }> {
  return redirect?.kind === 'same_origin' || redirect?.kind === 'site_variant';
}
