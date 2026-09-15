import { isFollowableRedirect, type PageResult } from '../shared/scan';

export function resolveScanResult(
  result: PageResult,
  resultsByUrl: Map<string, PageResult>,
): PageResult | undefined {
  const visited = new Set<string>();
  let current: PageResult | undefined = result;
  while (
    current &&
    isFollowableRedirect(current.redirect) &&
    !visited.has(current.sourceUrl)
  ) {
    visited.add(current.sourceUrl);
    current = resultsByUrl.get(current.redirect.targetUrl);
  }
  return current;
}
