import robotsParser from 'robots-parser';
import { SCAN_LIMITS, type PageResult } from '../shared/scan';
import { extractHtml } from './extract';

// Browser fetch uses the browser's User-Agent; do not claim a custom crawler identity.
export const ROBOT_AGENT = '*';

export class BodyTooLarge extends Error {}

export async function boundedText(response: Response): Promise<string> {
  if (Number(response.headers.get('content-length')) > SCAN_LIMITS.htmlBytes) {
    await response.body?.cancel();
    throw new BodyTooLarge('Document exceeds 2 MB.');
  }
  const reader = response.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let size = 0;
  let result = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > SCAN_LIMITS.htmlBytes)
        throw new BodyTooLarge('Document exceeds 2 MB.');
      result += decoder.decode(value, { stream: true });
    }
    return result + decoder.decode();
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

export async function localFetch(url: string): Promise<Response> {
  return fetch(url, {
    credentials: 'omit',
    redirect: 'manual',
    cache: 'no-store',
    referrerPolicy: 'no-referrer',
    signal: AbortSignal.timeout(20_000),
  });
}

export type RobotsPolicy = {
  allowed: (url: string) => boolean;
  delayMs: number;
};

export async function fetchRobots(origin: string): Promise<RobotsPolicy> {
  const url = `${origin}/robots.txt`;
  try {
    const response = await localFetch(url);
    // Missing robots files allow crawling; redirects, rate limits and server errors fail closed.
    if (
      response.status >= 400 &&
      response.status < 500 &&
      response.status !== 429
    ) {
      await response.body?.cancel();
      return { allowed: () => true, delayMs: 0 };
    }
    if (!response.ok || response.type === 'opaqueredirect') {
      await response.body?.cancel();
      return { allowed: () => false, delayMs: 0 };
    }
    const robots = robotsParser(url, await boundedText(response));
    return {
      allowed: (target) => robots.isAllowed(target, ROBOT_AGENT) !== false,
      delayMs: Math.max(0, (robots.getCrawlDelay(ROBOT_AGENT) ?? 0) * 1000),
    };
  } catch {
    return { allowed: () => false, delayMs: 0 };
  }
}

export function emptyResult(
  sourceUrl: string,
  status: PageResult['status'],
  error?: string,
): PageResult {
  return {
    sourceUrl,
    status,
    error,
    title: '',
    observedAt: new Date().toISOString(),
    httpStatus: null,
    links: [],
    discoveredUrls: [],
    truncated: false,
  };
}

export function fitResult(result: PageResult): PageResult {
  // Keep enough room for UTF-8 metadata inside the server's request limit.
  const encoder = new TextEncoder();
  while (
    encoder.encode(JSON.stringify(result)).length >
    SCAN_LIMITS.resultBytes - 1024
  ) {
    result.truncated = true;
    if (result.discoveredUrls.length) result.discoveredUrls.pop();
    else if (result.links.length) result.links.pop();
    else break;
  }
  return result;
}

export async function fetchPage(sourceUrl: string): Promise<PageResult> {
  const result = emptyResult(sourceUrl, 'network_error');
  try {
    const response = await localFetch(sourceUrl);
    result.httpStatus = response.status || null;
    if (
      response.type === 'opaqueredirect' ||
      (response.status >= 300 && response.status < 400)
    ) {
      result.status = 'redirect_unresolved';
      result.error =
        'Redirect was not followed. Add the final origin explicitly.';
      await response.body?.cancel();
      return result;
    }
    if (!response.ok) {
      result.status = 'http_error';
      result.error = `HTTP ${response.status}`;
      await response.body?.cancel();
      return result;
    }
    if (
      !/^(text\/html|application\/xhtml\+xml)(?:;|$)/i.test(
        response.headers.get('content-type') ?? '',
      )
    ) {
      result.status = 'not_html';
      await response.body?.cancel();
      return result;
    }
    return fitResult({
      ...result,
      status: 'ok',
      ...extractHtml(await boundedText(response), sourceUrl),
    });
  } catch (error) {
    result.status =
      error instanceof BodyTooLarge ? 'too_large' : 'network_error';
    result.truncated = error instanceof BodyTooLarge;
    result.error =
      error instanceof BodyTooLarge
        ? error.message
        : 'Page request failed or timed out.';
    return result;
  }
}
