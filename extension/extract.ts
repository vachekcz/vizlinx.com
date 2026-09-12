import { parse, type DefaultTreeAdapterMap } from 'parse5';
import {
  normalizeLinkUrl,
  SCAN_LIMITS,
  type FoundLink,
  type PageResult,
} from '../shared/scan';

type Node = DefaultTreeAdapterMap['node'];
const children = (node: Node): Node[] =>
  'childNodes' in node ? node.childNodes : [];
const attribute = (node: Node, name: string) =>
  'attrs' in node
    ? node.attrs.find((item) => item.name === name)?.value
    : undefined;

function text(node: Node): string {
  const parts: string[] = [];
  const stack = [node];
  while (stack.length) {
    const current = stack.pop()!;
    if (
      'tagName' in current &&
      ['script', 'style', 'template'].includes(current.tagName)
    )
      continue;
    if (current.nodeName === '#text' && 'value' in current)
      parts.push(current.value);
    stack.push(...children(current).toReversed());
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

export function extractHtml(
  html: string,
  sourceUrl: string,
): Pick<PageResult, 'title' | 'links' | 'discoveredUrls' | 'truncated'> {
  const document = parse(html);
  const nodes: Node[] = [document];
  let baseUrl = sourceUrl;
  let foundBase = false;
  let title = '';
  while (nodes.length) {
    const node = nodes.pop()!;
    if (node.nodeName === 'title' && !title)
      title = text(node).slice(0, SCAN_LIMITS.anchorLength);
    if (node.nodeName === 'base' && !foundBase) {
      foundBase = true;
      baseUrl =
        normalizeLinkUrl(attribute(node, 'href') ?? '', sourceUrl) ?? sourceUrl;
    }
    nodes.push(...children(node).toReversed());
  }
  const links = new Map<string, FoundLink>();
  const discovered = new Set<string>();
  let truncated = false;
  const stack: { node: Node; region: FoundLink['region'] }[] = [
    { node: document, region: 'unknown' },
  ];
  while (stack.length) {
    const { node, region: parentRegion } = stack.pop()!;
    if (['script', 'style', 'template'].includes(node.nodeName)) continue;
    const region =
      node.nodeName === 'nav' || attribute(node, 'role') === 'navigation'
        ? 'navigation'
        : node.nodeName === 'footer'
          ? 'footer'
          : ['main', 'article'].includes(node.nodeName)
            ? 'content'
            : parentRegion;
    if (node.nodeName === 'a' || node.nodeName === 'area') {
      const href = attribute(node, 'href');
      const targetUrl =
        href === undefined ? null : normalizeLinkUrl(href, baseUrl);
      if (targetUrl) {
        const anchor = (
          text(node) ||
          attribute(node, 'aria-label') ||
          attribute(node, 'alt') ||
          ''
        ).slice(0, SCAN_LIMITS.anchorLength);
        const rel = [
          ...new Set(
            (attribute(node, 'rel') ?? '')
              .toLowerCase()
              .split(/\s+/)
              .filter(Boolean),
          ),
        ]
          .slice(0, 20)
          .map((value) => value.slice(0, 64));
        const key = JSON.stringify([targetUrl, anchor, rel.toSorted(), region]);
        const previous = links.get(key);
        if (previous) {
          if (previous.occurrences < 100_000) previous.occurrences += 1;
          else truncated = true;
        } else if (links.size < SCAN_LIMITS.linksPerPage)
          links.set(key, { targetUrl, anchor, rel, region, occurrences: 1 });
        else truncated = true;
        if (new URL(targetUrl).origin !== new URL(sourceUrl).origin) continue;
        if (discovered.size < SCAN_LIMITS.discoveredPerPage)
          discovered.add(targetUrl);
        else if (!discovered.has(targetUrl)) truncated = true;
      }
    }
    stack.push(
      ...children(node)
        .toReversed()
        .map((child) => ({ node: child, region })),
    );
  }
  return {
    title,
    links: [...links.values()],
    discoveredUrls: [...discovered],
    truncated,
  };
}
