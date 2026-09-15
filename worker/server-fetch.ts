import robotsParser from 'robots-parser';
import {
  normalizeScanUrl,
  normalizeLinkUrl,
  isSiteVariant,
  SCAN_LIMITS,
  type PageResult,
  type ScanRedirect,
} from '../shared/scan';
import { extractHtml } from '../extension/extract';
import {
  BodyTooLarge,
  boundedText,
  emptyResult,
  fitResult,
} from '../shared/fetch-result';

export const ROBOT_AGENT = 'VizlinxBot';
export type StoredRobots = {
  body: string;
  denied: boolean;
  delayMs: number;
  httpStatus?: number;
  redirect?: ScanRedirect;
};

// Use only the public Workers fetch API, never a private network/service binding.
// Redirect targets are queued separately so every hop retains scope and budgets.
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

function classifyRedirect(
  response: Response,
  sourceUrl: string,
  scopeOrigin: string,
): ScanRedirect {
  const location = response.headers.get('location');
  const targetUrl = location?.trim()
    ? normalizeLinkUrl(location, sourceUrl)
    : null;
  const supported = [301, 302, 303, 307, 308].includes(response.status);
  const invalid = (reason: 'unsupported_status' | 'invalid_target') =>
    ({
      kind: 'invalid',
      reason,
      ...(targetUrl ? { targetUrl } : {}),
    }) satisfies ScanRedirect;
  if (!supported) return invalid('unsupported_status');
  if (!targetUrl) return invalid('invalid_target');
  try {
    normalizeScanUrl(targetUrl);
  } catch {
    return invalid('invalid_target');
  }
  return {
    kind:
      new URL(targetUrl).origin === new URL(sourceUrl).origin
        ? 'same_origin'
        : isSiteVariant(scopeOrigin, targetUrl)
          ? 'site_variant'
          : 'external',
    targetUrl,
  };
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

export async function fetchServerRobots(
  origin: string,
  url = `${origin}/robots.txt`,
): Promise<StoredRobots> {
  const denied: StoredRobots = { body: '', denied: true, delayMs: 0 };
  try {
    if (!isSiteVariant(origin, url)) return denied;
    const sourceUrl = normalizeScanUrl(url);
    const response = await publicFetch(sourceUrl, new URL(sourceUrl).origin);
    denied.httpStatus = response.status;
    if (response.status >= 300 && response.status < 400) {
      denied.redirect = classifyRedirect(response, sourceUrl, origin);
      await response.body?.cancel();
      return denied;
    }
    // An absent robots file allows crawling. Authentication failures, rate limits,
    // and unavailable policies fail closed. Redirects need another queue tick.
    if (response.status === 404 || response.status === 410) {
      await response.body?.cancel();
      return { ...denied, denied: false };
    }
    if (!response.ok) {
      await response.body?.cancel();
      return denied;
    }
    const body = await boundedText(response, 64 * 1024);
    const robots = robotsParser(`${origin}/robots.txt`, body);
    const delay = (robots.getCrawlDelay(ROBOT_AGENT) ?? 0) * 1000;
    return {
      body,
      denied: false,
      delayMs: Number.isFinite(delay) && delay >= 0 ? delay : 0,
      httpStatus: response.status,
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
      result.redirect = classifyRedirect(response, sourceUrl, origin);
      if (
        result.redirect.kind !== 'same_origin' &&
        result.redirect.kind !== 'site_variant'
      )
        result.error =
          result.redirect.kind === 'external'
            ? 'Redirect leaves the source site and was not followed.'
            : result.redirect.reason === 'unsupported_status'
              ? `Unsupported redirect status HTTP ${response.status} was not followed.`
              : 'Redirect has no supported public HTTP(S) target and was not followed.';
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
