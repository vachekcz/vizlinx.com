import { normalizeLinkUrl } from '../shared/scan';
import type { ScanSnapshot } from '../shared/scan';
import type { GraphDataset, Link, Page, Site } from './data';

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
    addSite(url.origin);
    const page: Page = {
      id: normalized,
      siteId: url.origin,
      path: `${url.pathname}${url.search}`,
      title: `${url.pathname}${url.search}`,
      url: normalized,
      status: 'known',
    };
    pages.set(normalized, page);
    return page;
  };
  for (const site of scan.sites) {
    addSite(site.origin);
    addPage(site.seedUrl);
  }
  const observedSources = new Set<string>();
  for (const result of scan.results) {
    const source = addPage(result.sourceUrl);
    if (!source || observedSources.has(source.id)) continue;
    observedSources.add(source.id);
    source.title = result.title || source.path;
    source.status = result.status;
    source.error = result.error;
    if (result.status !== 'ok') continue;
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
  return {
    sites: [...sites.values()],
    pages: [...pages.values()],
    links: [...links.values()],
  };
}
