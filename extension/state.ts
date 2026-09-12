import {
  normalizeScanUrl,
  SCAN_LIMITS,
  type PageResult,
  type RunnerSession,
  type ScanSnapshot,
} from '../shared/scan';

export type StoredScan = {
  apiOrigin: string;
  token: string;
  scan: ScanSnapshot;
  queue: string[];
  visited: string[];
  lastRequest: Record<string, number>;
  outbox: PageResult | null;
};

export const scanKey = (id: string) => `scan:${id}`;

export async function readScan(id: string): Promise<StoredScan | undefined> {
  return (await chrome.storage.local.get(scanKey(id)))[scanKey(id)] as
    StoredScan | undefined;
}

export async function storeScan(value: StoredScan): Promise<void> {
  await chrome.storage.local.set({ [scanKey(value.scan.id)]: value });
}

export async function saveSession(apiOrigin: string, session: RunnerSession) {
  const previous = await readScan(session.scan.id);
  const visited = session.scan.results.map((result) => result.sourceUrl);
  const candidates = [
    ...session.scan.sites.map((site) => site.seedUrl),
    ...session.scan.results.flatMap((result) => [
      ...result.discoveredUrls,
      ...result.links.map((link) => link.targetUrl),
    ]),
  ];
  const counts = new Map<string, number>();
  const queue = [...new Set(candidates)].filter((url) => {
    try {
      const origin = new URL(normalizeScanUrl(url)).origin;
      if (
        visited.includes(url) ||
        !session.scan.sites.some((site) => site.origin === origin)
      )
        return false;
      const count = counts.get(origin) ?? 0;
      counts.set(origin, count + 1);
      return count < SCAN_LIMITS.pagesPerSite;
    } catch {
      return false;
    }
  });
  await storeScan({
    apiOrigin,
    token: session.token,
    scan: session.scan,
    queue: previous?.queue ?? queue,
    visited: previous?.visited ?? visited,
    lastRequest: previous?.lastRequest ?? {},
    outbox: previous?.outbox ?? null,
  });
  await chrome.storage.local.set({ lastScanId: session.scan.id });
}
