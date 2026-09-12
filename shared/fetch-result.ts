import { SCAN_LIMITS, type PageResult } from './scan';

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
