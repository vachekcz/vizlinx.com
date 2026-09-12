import robotsParser from 'robots-parser';
import { type PageResult } from '../shared/scan';
import {
  BodyTooLarge,
  boundedText,
  emptyResult,
  fitResult,
} from '../shared/fetch-result';
export {
  BodyTooLarge,
  boundedText,
  emptyResult,
  fitResult,
} from '../shared/fetch-result';
import { extractHtml } from './extract';

// Browser fetch uses the browser's User-Agent; do not claim a custom crawler identity.
export const ROBOT_AGENT = '*';

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
    const delayMs = (robots.getCrawlDelay(ROBOT_AGENT) ?? 0) * 1000;
    return {
      allowed: (target) => robots.isAllowed(target, ROBOT_AGENT) !== false,
      // Invalid directives fall back to the runner's normal minimum interval.
      delayMs: Number.isFinite(delayMs) && delayMs >= 0 ? delayMs : 0,
    };
  } catch {
    return { allowed: () => false, delayMs: 0 };
  }
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
