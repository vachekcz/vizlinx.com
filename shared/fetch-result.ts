import { SCAN_LIMITS, type PageResult } from './scan';

export class BodyTooLarge extends Error {}

export async function boundedText(
  response: Response,
  maxBytes = SCAN_LIMITS.htmlBytes,
): Promise<string> {
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel();
    throw new BodyTooLarge(`Document exceeds ${maxBytes} bytes.`);
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
      if (size > maxBytes)
        throw new BodyTooLarge(`Document exceeds ${maxBytes} bytes.`);
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
  const limit = SCAN_LIMITS.resultBytes - 1024;
  let bytes = encoder.encode(JSON.stringify(result)).length;
  if (bytes <= limit) return result;

  // Switching false to true removes one JSON byte. Serialize each removed item
  // only once instead of repeatedly encoding the entire remaining payload.
  if (!result.truncated) bytes -= 1;
  result.truncated = true;
  for (const items of [result.discoveredUrls, result.links]) {
    while (bytes > limit && items.length) {
      const removed = items.pop();
      bytes -= encoder.encode(JSON.stringify(removed)).length;
      if (items.length) bytes -= 1; // The comma before the removed final item.
    }
  }
  return result;
}
