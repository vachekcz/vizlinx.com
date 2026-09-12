export const API_PREFIX = '/api/v1';
export const SCAN_LIMITS = {
  sites: 3,
  pagesPerSite: 100,
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
export type PageResult = {
  sourceUrl: string;
  title: string;
  observedAt: string;
  status: PageStatus;
  httpStatus: number | null;
  error?: string;
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
};
export type ScanSnapshot = ScanSummary & { results: PageResult[] };
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
