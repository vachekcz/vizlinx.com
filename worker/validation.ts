import {
  SCAN_LIMITS,
  normalizeLinkUrl,
  normalizeScanUrl,
  type PageResult,
  type ScanSite,
} from '../shared/scan';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ApiError(400, 'Expected a JSON object.');
  return value as Record<string, unknown>;
}

function string(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length > max)
    throw new ApiError(400, 'Invalid string or length.');
  return value;
}

function integer(value: unknown, min: number, max: number): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  )
    throw new ApiError(400, 'Integer is outside the allowed range.');
  return value;
}

function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean')
    throw new ApiError(400, 'Expected a boolean.');
  return value;
}

function array(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max)
    throw new ApiError(400, 'Invalid array or length.');
  return value;
}

export function sites(value: unknown): ScanSite[] {
  const parsed = array(value, SCAN_LIMITS.sites).map((item) => {
    const site = object(item);
    const origin = publicUrl(site.origin);
    const seedUrl = publicUrl(site.seedUrl);
    if (
      new URL(seedUrl).origin !== new URL(origin).origin ||
      origin !== `${new URL(origin).origin}/`
    )
      throw new ApiError(400, 'Seed must belong to the exact origin.');
    return {
      origin: new URL(origin).origin,
      seedUrl,
      intervalMs: integer(
        site.intervalMs,
        SCAN_LIMITS.minIntervalMs,
        SCAN_LIMITS.maxIntervalMs,
      ),
      maxPages: integer(site.maxPages, 1, SCAN_LIMITS.pagesPerSite),
      paused: boolean(site.paused),
    };
  });
  if (
    !parsed.length ||
    new Set(parsed.map((site) => site.origin)).size !== parsed.length
  )
    throw new ApiError(400, 'Choose one to three distinct origins.');
  return parsed;
}

function publicUrl(value: unknown): string {
  try {
    return normalizeScanUrl(string(value, SCAN_LIMITS.urlLength));
  } catch {
    throw new ApiError(400, 'Invalid public URL.');
  }
}

export function pageResult(value: unknown, scope: ScanSite[]): PageResult {
  const body = object(value);
  const sourceUrl = publicUrl(body.sourceUrl);
  const sourceOrigin = new URL(sourceUrl).origin;
  if (!scope.some((site) => site.origin === sourceOrigin))
    throw new ApiError(403, 'Source URL is outside the scan scope.');
  const observedAt = string(body.observedAt, 40);
  if (
    !Number.isFinite(Date.parse(observedAt)) ||
    new Date(observedAt).toISOString() !== observedAt
  )
    throw new ApiError(400, 'Expected an ISO observation time.');
  const status = string(body.status, 30);
  if (
    ![
      'ok',
      'http_error',
      'network_error',
      'redirect_unresolved',
      'robots_denied',
      'not_html',
      'too_large',
    ].includes(status)
  )
    throw new ApiError(400, 'Invalid page status.');
  const links = array(body.links, SCAN_LIMITS.linksPerPage).map((item) => {
    const link = object(item);
    const targetUrl = normalizeLinkUrl(
      string(link.targetUrl, SCAN_LIMITS.urlLength),
      sourceUrl,
    );
    if (!targetUrl) throw new ApiError(400, 'Invalid target URL.');
    const region = string(link.region, 20);
    if (!['content', 'navigation', 'footer', 'unknown'].includes(region))
      throw new ApiError(400, 'Invalid link region.');
    return {
      targetUrl,
      anchor: string(link.anchor, SCAN_LIMITS.anchorLength),
      rel: array(link.rel, 20).map((item) => string(item, 64)),
      region: region as PageResult['links'][number]['region'],
      occurrences: integer(link.occurrences, 1, 100_000),
    };
  });
  const discoveredUrls = array(
    body.discoveredUrls,
    SCAN_LIMITS.discoveredPerPage,
  ).map((item) => {
    const url = publicUrl(item);
    if (new URL(url).origin !== sourceOrigin)
      throw new ApiError(
        400,
        'Discovered URL must belong to its source origin.',
      );
    return url;
  });
  return {
    sourceUrl,
    title: string(body.title, 512),
    observedAt,
    status: status as PageResult['status'],
    httpStatus:
      body.httpStatus === null ? null : integer(body.httpStatus, 100, 599),
    ...(body.error === undefined ? {} : { error: string(body.error, 512) }),
    links,
    discoveredUrls,
    truncated: boolean(body.truncated),
  };
}

export async function readJson(
  request: Request,
  limit = 16 * 1024,
): Promise<Record<string, unknown>> {
  if (
    request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !==
    'application/json'
  )
    throw new ApiError(415, 'Use application/json.');
  if (Number(request.headers.get('content-length')) > limit)
    throw new ApiError(413, 'Request body is too large.');
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400, 'JSON body is required.');
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > limit) {
      await reader.cancel();
      throw new ApiError(413, 'Request body is too large.');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return object(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    throw new ApiError(400, 'Invalid JSON object.');
  }
}
