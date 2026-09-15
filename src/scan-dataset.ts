import { normalizeLinkUrl } from '../shared/scan';
import type { ScanSnapshot } from '../shared/scan';
import type { GraphDataset, Link, Page, Site } from './data';
import { resolveScanResult } from './scan-results';

function hash(value: string) {
  let result = 2166136261;
  for (const character of value)
    result = Math.imul(result ^ character.charCodeAt(0), 16777619);
  return result >>> 0;
}

export function scanToDataset(scan: ScanSnapshot): GraphDataset {
  const sites = new Map<string, Site>();
  const pages = new Map<string, Page>();
  const links = new Map<string, Link>();
  const scoped = new Set(scan.sites.map((site) => site.origin));
  const scanDisabledReason = scan.archived
    ? 'Historický průchod je pouze ke čtení.'
    : scan.limitReason === 'time_limit'
      ? 'Tento průchod dosáhl časového limitu. Spusť nový sken.'
      : scan.limitReason === 'scan_storage_limit'
        ? 'Tato mapa dosáhla limitu velikosti. Spusť nový sken.'
        : scan.status === 'paused'
          ? 'Nejprve pokračuj ve skenování mapy.'
          : undefined;
  const owners = new Map<string, string>();
  const ownerOf = (origin: string): string => {
    let owner = origin;
    while (owners.has(owner)) owner = owners.get(owner)!;
    return owner;
  };
  const assignOwner = (origin: string, owner: string) => {
    const root = ownerOf(origin);
    const target = ownerOf(owner);
    if (root === target) return;
    if (!scoped.has(root)) owners.set(root, target);
    else if (!scoped.has(target)) owners.set(target, root);
  };
  // Server evidence joins aliases; explicitly selected origins stay independent.
  for (const result of scan.results) {
    if (result.siteOrigin)
      assignOwner(new URL(result.sourceUrl).origin, result.siteOrigin);
  }
  for (const result of scan.results) {
    if (result.redirect?.kind === 'site_variant')
      assignOwner(
        new URL(result.redirect.targetUrl).origin,
        result.siteOrigin ?? new URL(result.sourceUrl).origin,
      );
  }
  const addSite = (origin: string) => {
    if (sites.has(origin)) return;
    const url = new URL(origin);
    const seed = hash(origin);
    const palette = ['atlas', 'journal', 'objects', 'collective', 'index'];
    const scopeIndex = scan.sites.findIndex((site) => site.origin === origin);
    const scopePositions = [
      [480, 350],
      [215, 155],
      [765, 170],
    ];
    const angle = ((seed % 3600) / 3600) * Math.PI * 2;
    const distance = 320 + ((seed >>> 12) % 160);
    const [x, y] = scopePositions[scopeIndex] ?? [
      500 + Math.cos(angle) * distance,
      400 + Math.sin(angle) * distance,
    ];
    sites.set(origin, {
      id: origin,
      origin,
      domain: url.host,
      name: url.host,
      category: scoped.has(origin)
        ? `Povolený origin · ${url.protocol.slice(0, -1)}`
        : `Odkazovaný origin · ${url.protocol.slice(0, -1)}`,
      color: `var(--site-${palette[seed % palette.length]}, #2457ff)`,
      tint: 'var(--cluster-bg, #fff)',
      x,
      y,
      radius: scoped.has(origin) ? 78 : 58,
      scanned: scoped.has(origin),
    });
  };
  const addPage = (value: string, base = value): Page | null => {
    const normalized = normalizeLinkUrl(value, base);
    if (!normalized) return null;
    const existing = pages.get(normalized);
    if (existing) return existing;
    const url = new URL(normalized);
    const owner = ownerOf(url.origin);
    addSite(owner);
    const page: Page = {
      id: normalized,
      siteId: owner,
      path: `${url.pathname}${url.search}`,
      title: `${url.pathname}${url.search}`,
      url: normalized,
      status: 'known',
      scanDisabledReason:
        scanDisabledReason ??
        (scan.sites.some((site) => site.origin === owner && site.paused)
          ? 'Nejprve pokračuj ve skenování tohoto webu.'
          : undefined),
    };
    pages.set(normalized, page);
    return page;
  };
  for (const site of scan.sites) {
    addSite(site.origin);
    addPage(site.seedUrl);
  }
  for (const url of scan.pendingPages ?? []) {
    const page = addPage(url);
    if (page) page.scanState = 'queued';
  }
  if (
    scan.status === 'running' &&
    scan.activity?.phase === 'fetching_page' &&
    scan.activity.url
  ) {
    const page = addPage(scan.activity.url);
    if (page) page.scanState = 'fetching';
  }
  const observedSources = new Set<string>();
  for (const result of scan.results) {
    const source = addPage(result.sourceUrl);
    if (!source || observedSources.has(source.id)) continue;
    observedSources.add(source.id);
    source.title = result.title || source.path;
    source.status = result.status;
    source.scanState = undefined;
    source.error = result.error;
    source.crawlMode = result.crawlMode;
    if (result.redirect?.targetUrl)
      addPage(result.redirect.targetUrl, result.sourceUrl);
    if (result.status !== 'ok') continue;
    for (const url of result.discoveredUrls) addPage(url, result.sourceUrl);
    for (const found of result.links) {
      const target = addPage(found.targetUrl, result.sourceUrl);
      if (!target || source.siteId === target.siteId) continue;
      const id = JSON.stringify([source.id, target.id]);
      const existing = links.get(id);
      if (existing) {
        existing.occurrences += found.occurrences;
        existing.rel = [...new Set([...existing.rel.split(' '), ...found.rel])]
          .filter(Boolean)
          .join(' ');
        continue;
      }
      links.set(id, {
        id,
        source,
        target,
        anchor: found.anchor,
        rel: [...new Set(found.rel)].join(' '),
        region: (
          {
            content: 'Obsah',
            navigation: 'Navigace',
            footer: 'Patička',
            unknown: 'Neznámé',
          } as const
        )[found.region],
        occurrences: found.occurrences,
        observedAt: result.observedAt,
      });
    }
  }
  const resultsByUrl = new Map(
    scan.results.map((result) => [result.sourceUrl, result]),
  );
  for (const site of sites.values()) {
    if (site.scanned) continue;
    const previewPages = [...pages.values()].filter(
      (page) =>
        page.siteId === site.id &&
        (page.crawlMode === 'preview' || page.crawlMode === 'manual'),
    );
    const directLinks = [...links.values()].filter(
      (link) =>
        link.target.siteId === site.id && scoped.has(link.source.siteId),
    );
    const targets = new Set(directLinks.map((link) => link.target.id));
    const sources = new Set(directLinks.map((link) => link.source.siteId));
    let checkedTargets = 0;
    let failedTargets = 0;
    for (const target of targets) {
      const initial = resultsByUrl.get(target);
      const result = initial && resolveScanResult(initial, resultsByUrl);
      if (result?.status === 'ok') checkedTargets++;
      else if (result) failedTargets++;
    }
    site.preview = {
      attemptedPages: previewPages.length,
      inspectedPages: previewPages.filter((page) => page.status === 'ok')
        .length,
      knownTargets: targets.size,
      checkedTargets,
      failedTargets,
      backlinkCount: [...links.values()].filter(
        (link) =>
          link.source.siteId === site.id && sources.has(link.target.siteId),
      ).length,
    };
  }
  return {
    sites: [...sites.values()],
    pages: [...pages.values()],
    links: [...links.values()],
  };
}
