import { createContext, useContext, useMemo } from 'react';
import type { ReactNode } from 'react';
import { sites, pages, links } from './data';
import type { Connection, GraphDataset, Link, Page } from './data';

export type { GraphDataset } from './data';
export const demoDataset: GraphDataset = { sites, pages, links };
const GraphDataContext = createContext({ dataset: demoDataset, live: false });

export function GraphDataProvider({
  dataset,
  live,
  children,
}: {
  dataset: GraphDataset;
  live: boolean;
  children: ReactNode;
}) {
  const value = useMemo(() => ({ dataset, live }), [dataset, live]);
  return (
    <GraphDataContext.Provider value={value}>
      {children}
    </GraphDataContext.Provider>
  );
}

export function useGraphData() {
  const { dataset, live } = useContext(GraphDataContext);
  return useMemo(() => {
    const sitesById = new Map(dataset.sites.map((site) => [site.id, site]));
    const pagesById = new Map(dataset.pages.map((page) => [page.id, page]));
    const getSite = (id: string) => sitesById.get(id)!;
    const getPage = (id: string) => pagesById.get(id)!;
    const pageUrl = (page: Page) =>
      page.url ?? `https://${getSite(page.siteId).domain}${page.path}`;
    const aggregateConnections = (visibleLinks: Link[]): Connection[] => {
      const grouped = new Map<string, Connection>();
      for (const link of visibleLinks) {
        const source = getSite(link.source.siteId);
        const target = getSite(link.target.siteId);
        if (!source || !target) continue;
        const id = `${source.id}:${target.id}`;
        const existing = grouped.get(id);
        if (existing) existing.links.push(link);
        else grouped.set(id, { id, source, target, links: [link] });
      }
      return [...grouped.values()];
    };
    return {
      ...dataset,
      live,
      getSite,
      getPage,
      pageUrl,
      aggregateConnections,
    };
  }, [dataset, live]);
}

export function pageStatusLabel(page: Page) {
  switch (page.status) {
    case 'ok':
      return 'Úspěšně načtená stránka';
    case 'known':
      return 'Pouze známá URL · zatím nenačteno';
    case 'http_error':
      return 'Chyba HTTP';
    case 'network_error':
      return 'Chyba připojení';
    case 'redirect_unresolved':
      return 'HTTP přesměrování';
    case 'robots_denied':
      return 'Zakázáno robots.txt';
    case 'not_html':
      return 'Obsah není HTML';
    case 'too_large':
      return 'Překročen limit velikosti';
    default:
      return 'Ukázková stránka';
  }
}
