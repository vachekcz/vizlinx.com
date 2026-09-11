export type Site = {
  id: string;
  domain: string;
  name: string;
  category: string;
  color: string;
  tint: string;
  x: number;
  y: number;
  radius: number;
  scanned: boolean;
};

export type Page = { id: string; siteId: string; path: string; title: string };
export type Link = {
  id: string;
  source: Page;
  target: Page;
  anchor: string;
  rel: string;
  region: 'Obsah' | 'Navigace' | 'Patička';
  occurrences: number;
};
export type Connection = {
  id: string;
  source: Site;
  target: Site;
  links: Link[];
};
export type Selection =
  | { type: 'site'; id: string }
  | { type: 'page'; id: string }
  | { type: 'connection'; id: string }
  | { type: 'link'; id: string };

export const sites: Site[] = [
  {
    id: 'atlas',
    domain: 'atlas.example',
    name: 'Studio Atlas',
    category: 'Designové studio',
    color: '#357b61',
    tint: '#e5efe3',
    x: 480,
    y: 350,
    radius: 87,
    scanned: true,
  },
  {
    id: 'journal',
    domain: 'journal.example',
    name: 'The Journal',
    category: 'Magazín o designu',
    color: '#bd775d',
    tint: '#f7e8dc',
    x: 215,
    y: 155,
    radius: 68,
    scanned: true,
  },
  {
    id: 'objects',
    domain: 'objects.example',
    name: 'Objects & Co.',
    category: 'Výběr krásných věcí',
    color: '#b29438',
    tint: '#f5efd4',
    x: 765,
    y: 170,
    radius: 68,
    scanned: true,
  },
  {
    id: 'collective',
    domain: 'collective.example',
    name: 'The Collective',
    category: 'Kreativní komunita',
    color: '#8d7bb2',
    tint: '#eee7f6',
    x: 210,
    y: 535,
    radius: 72,
    scanned: true,
  },
  {
    id: 'index',
    domain: 'index.example',
    name: 'Design Index',
    category: 'Adresář inspirace',
    color: '#658db0',
    tint: '#e4eef6',
    x: 760,
    y: 540,
    radius: 68,
    scanned: true,
  },
  {
    id: 'archive',
    domain: 'archive.example',
    name: 'Open Archive',
    category: 'Objevený externí web',
    color: '#89918c',
    tint: '#eef0eb',
    x: 490,
    y: 645,
    radius: 47,
    scanned: false,
  },
].map((site) => ({
  ...site,
  color: `var(--site-${site.id}, ${site.color})`,
  tint: `var(--site-${site.id}-tint, ${site.tint})`,
}));

const pageDefinitions: Record<string, [string, string][]> = {
  atlas: [
    ['/', 'Studio Atlas'],
    ['/projects', 'Naše projekty'],
    ['/about', 'O studiu'],
    ['/journal', 'Ze života studia'],
    ['/partners', 'Naši partneři'],
    ['/contact', 'Kontakt'],
  ],
  journal: [
    ['/', 'The Journal'],
    ['/design', 'Svět designu'],
    ['/stories/atlas', 'Návštěva ve Studiu Atlas'],
    ['/interviews', 'Rozhovory'],
    ['/resources', 'Naše zdroje'],
    ['/about', 'O magazínu'],
  ],
  objects: [
    ['/', 'Objects & Co.'],
    ['/collection', 'Kolekce'],
    ['/makers', 'Naši tvůrci'],
    ['/stories', 'Příběhy věcí'],
    ['/studio', 'Naše studio'],
    ['/stockists', 'Kde nás najdete'],
  ],
  collective: [
    ['/', 'The Collective'],
    ['/members', 'Členové komunity'],
    ['/events', 'Setkání'],
    ['/projects', 'Společné projekty'],
    ['/reading', 'Co čteme'],
    ['/join', 'Přidejte se'],
  ],
  index: [
    ['/', 'Design Index'],
    ['/studios', 'Designová studia'],
    ['/inspiration', 'Inspirace'],
    ['/editorial', 'Redakční výběr'],
    ['/collections', 'Kolekce'],
    ['/submit', 'Přidat do indexu'],
    ['/architecture', 'Architektura'],
    ['/interiors', 'Interiéry'],
    ['/typography', 'Typografie'],
    ['/branding', 'Vizuální identity'],
    ['/photography', 'Fotografie'],
    ['/illustration', 'Ilustrace'],
    ['/furniture', 'Nábytek'],
    ['/lighting', 'Světla'],
    ['/ceramics', 'Keramika'],
    ['/materials', 'Materiály'],
    ['/exhibitions', 'Výstavy'],
    ['/interviews', 'Rozhovory s tvůrci'],
    ['/resources', 'Zdroje a odkazy'],
    ['/about', 'O Design Indexu'],
  ],
  archive: [
    ['/design', 'Archiv designu'],
    ['/resources', 'Otevřené zdroje'],
  ],
};

export const pages: Page[] = sites.flatMap((site) =>
  pageDefinitions[site.id].map(([path, title], index) => ({
    id: `${site.id}-${index}`,
    siteId: site.id,
    path,
    title,
  })),
);

const relationships: [string, string, number, number?][] = [
  ['atlas', 'journal', 5],
  ['journal', 'atlas', 3],
  ['atlas', 'objects', 4],
  ['objects', 'atlas', 2],
  ['atlas', 'collective', 5],
  ['collective', 'atlas', 3],
  ['atlas', 'index', 2],
  ['index', 'atlas', 4],
  ['index', 'journal', 6, 4],
  ['index', 'objects', 5, 10],
  ['index', 'collective', 5, 15],
  ['journal', 'collective', 2],
  ['objects', 'index', 3],
  ['collective', 'index', 2],
  ['collective', 'archive', 2],
];

export const links: Link[] = relationships.flatMap(
  ([sourceId, targetId, count, sourceOffset = 0]) => {
    const sourcePages = pages.filter((page) => page.siteId === sourceId);
    const targetPages = pages.filter((page) => page.siteId === targetId);
    return Array.from({ length: count }, (_, index) => ({
      id: `${sourceId}-${targetId}-${index}`,
      source: sourcePages[(index + sourceOffset) % sourcePages.length],
      target: targetPages[(index + 1) % targetPages.length],
      anchor: targetPages[(index + 1) % targetPages.length].title,
      rel: index === 2 ? 'nofollow' : '',
      region: (index === 0
        ? 'Navigace'
        : index === 3
          ? 'Patička'
          : 'Obsah') as Link['region'],
      occurrences: index === 0 ? 2 : 1,
    }));
  },
);

export const getSite = (id: string) => sites.find((site) => site.id === id)!;
export const getPage = (id: string) => pages.find((page) => page.id === id)!;
export const pageUrl = (page: Page) =>
  `https://${getSite(page.siteId).domain}${page.path}`;

export function aggregateConnections(visibleLinks: Link[]): Connection[] {
  const connections = new Map<string, Connection>();
  for (const link of visibleLinks) {
    const id = `${link.source.siteId}:${link.target.siteId}`;
    const connection = connections.get(id);
    if (connection) connection.links.push(link);
    else
      connections.set(id, {
        id,
        source: getSite(link.source.siteId),
        target: getSite(link.target.siteId),
        links: [link],
      });
  }
  return [...connections.values()];
}
