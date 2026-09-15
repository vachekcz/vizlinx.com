import { useEffect, useState } from 'react';
import type { Page } from '../data';

type Scan = {
  siteId: string;
  state: 'queued' | 'fetching' | 'ok';
  readyAt: number;
};

export function useStudyPageScans(
  runKey: string,
  displayedRunKey: string,
  paused: boolean,
  pausedSites: string[],
) {
  const [runs, setRuns] = useState<Record<string, Record<string, Scan>>>({});
  const current = runs[runKey];
  const pending = Object.values(current ?? {}).filter(
    (scan) => scan.state !== 'ok',
  );

  useEffect(() => {
    if (!pending.length || paused) return;
    const timer = window.setInterval(() => {
      setRuns((previous) => {
        const scans = previous[runKey];
        if (!scans) return previous;
        const next = { ...scans };
        let changed = false;
        for (const [id, scan] of Object.entries(scans)) {
          if (
            scan.state === 'ok' ||
            pausedSites.includes(scan.siteId) ||
            Date.now() < scan.readyAt
          )
            continue;
          changed = true;
          next[id] = {
            ...scan,
            state: scan.state === 'queued' ? 'fetching' : 'ok',
            readyAt: Date.now() + 1800,
          };
        }
        return changed ? { ...previous, [runKey]: next } : previous;
      });
    }, 200);
    return () => window.clearInterval(timer);
  }, [runKey, pending.length, paused, pausedSites]);

  return {
    pendingSiteIds: pending.map((scan) => scan.siteId),
    apply(page: Page): Page {
      const scan = runs[displayedRunKey]?.[page.id];
      if (!scan) return page;
      if (displayedRunKey !== runKey && scan.state !== 'ok') return page;
      return {
        ...page,
        status: scan.state === 'ok' ? 'ok' : 'known',
        scanState: scan.state === 'ok' ? undefined : scan.state,
        crawlMode: 'manual',
      };
    },
    scan(page: Page) {
      if (page.status !== 'known' || page.scanState || page.scanDisabledReason)
        return;
      setRuns((previous) => {
        if (previous[runKey]?.[page.id]) return previous;
        return {
          ...previous,
          [runKey]: {
            ...previous[runKey],
            [page.id]: {
              siteId: page.siteId,
              state: 'queued',
              readyAt: Date.now() + 1000,
            },
          },
        };
      });
    },
  };
}
