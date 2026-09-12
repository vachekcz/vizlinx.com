import robotsParser from 'robots-parser';
import { normalizeScanUrl, SCAN_LIMITS, type PageResult } from '../shared/scan';
import { extractHtml } from '../extension/extract';
import {
  BodyTooLarge,
  boundedText,
  emptyResult,
  fitResult,
} from '../shared/fetch-result';

export const ROBOT_AGENT = 'VizlinxBot';
export type StoredRobots = { body: string; denied: boolean; delayMs: number };

// Use only the public Workers fetch API, never a private network/service binding.
// Manual redirects keep each request inside the explicitly approved exact origin.
async function publicFetch(value: string, origin: string): Promise<Response> {
  const url = normalizeScanUrl(value);
  if (new URL(url).origin !== origin)
    throw new Error('URL is outside the scan origin.');
  return fetch(url, {
    method: 'GET',
    redirect: 'manual',
    headers: {
      'User-Agent': `${ROBOT_AGENT}/1.0 (+https://vizlinx.com)`,
      Accept: 'text/html,application/xhtml+xml,text/plain;q=0.5',
    },
    signal: AbortSignal.timeout(20_000),
  });
}

export function robotsAllows(
  policy: StoredRobots,
  origin: string,
  url: string,
): boolean {
  return (
    !policy.denied &&
    robotsParser(`${origin}/robots.txt`, policy.body).isAllowed(
      url,
      ROBOT_AGENT,
    ) !== false
  );
}

export async function fetchServerRobots(origin: string): Promise<StoredRobots> {
  const denied: StoredRobots = { body: '', denied: true, delayMs: 0 };
  try {
    const response = await publicFetch(`${origin}/robots.txt`, origin);
    // An absent robots file allows crawling. Authentication failures, rate limits,
    // redirects and unavailable policies fail closed for this prototype.
    if (response.status === 404 || response.status === 410) {
      await response.body?.cancel();
      return { body: '', denied: false, delayMs: 0 };
    }
    if (!response.ok) {
      await response.body?.cancel();
      return denied;
    }
    const body = await boundedText(response);
    if (new TextEncoder().encode(body).byteLength > 64 * 1024) return denied;
    const robots = robotsParser(`${origin}/robots.txt`, body);
    const delay = (robots.getCrawlDelay(ROBOT_AGENT) ?? 0) * 1000;
    return {
      body,
      denied: false,
      delayMs: Number.isFinite(delay) && delay >= 0 ? delay : 0,
    };
  } catch {
    return denied;
  }
}

export async function fetchServerPage(
  sourceUrl: string,
  origin: string,
): Promise<PageResult> {
  const result = emptyResult(sourceUrl, 'network_error');
  try {
    const response = await publicFetch(sourceUrl, origin);
    result.httpStatus = response.status;
    if (response.status >= 300 && response.status < 400) {
      result.status = 'redirect_unresolved';
      result.error = 'Redirect was not followed. Add the final URL explicitly.';
    } else if (!response.ok) {
      result.status = 'http_error';
      result.error = `HTTP ${response.status}`;
    } else if (
      !/^(text\/html|application\/xhtml\+xml)(?:;|$)/i.test(
        response.headers.get('content-type') ?? '',
      )
    ) {
      result.status = 'not_html';
    } else {
      return fitResult({
        ...result,
        status: 'ok',
        ...extractHtml(await boundedText(response), sourceUrl),
      });
    }
    await response.body?.cancel();
  } catch (error) {
    result.status =
      error instanceof BodyTooLarge ? 'too_large' : 'network_error';
    result.truncated = error instanceof BodyTooLarge;
    result.error =
      error instanceof BodyTooLarge
        ? `Document exceeds ${SCAN_LIMITS.htmlBytes} bytes.`
        : 'Page request failed or timed out.';
  }
  return result;
}
