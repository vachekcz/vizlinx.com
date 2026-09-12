import {
  API_PREFIX,
  SCAN_LIMITS,
  type PageResult,
  type ScanControl,
  type ScanSite,
  type ScanSnapshot,
  type ScanStatus,
} from '../shared/scan';
import { ApiError, object, pageResult, readJson, sites } from './validation';

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const RUNNER_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_SCAN_BYTES = 4 * 1024 * 1024;
const COOKIE = 'vizlinx_visitor';
const SCAN_STATUSES: ScanStatus[] = [
  'waiting',
  'running',
  'paused',
  'interrupted',
  'completed',
  'limited',
  'error',
];

type ScanRow = {
  id: string;
  owner_hash: string;
  status: ScanStatus;
  sites_json: string;
  created_at: number;
  updated_at: number;
  heartbeat_at: number | null;
};

function randomToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

async function hash(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

function json(value: unknown, status = 200, headers?: HeadersInit): Response {
  return Response.json(value, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    },
  });
}

function sameOrigin(request: Request): void {
  if (request.headers.get('Origin') !== new URL(request.url).origin)
    throw new ApiError(403, 'A same-origin request is required.');
}

async function cleanupExpired(env: Env): Promise<void> {
  const now = Date.now();
  // Small batches keep request cleanup bounded; reads enforce expiry immediately.
  await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM scans WHERE id IN (
      SELECT id FROM scans WHERE created_at <= ?1 ORDER BY created_at LIMIT 2
    )`,
    ).bind(now - RETENTION_MS),
    env.DB.prepare(
      `DELETE FROM visitors WHERE token_hash IN (
      SELECT token_hash FROM visitors WHERE expires_at <= ?1
      AND NOT EXISTS (SELECT 1 FROM scans WHERE owner_hash = visitors.token_hash)
      ORDER BY expires_at LIMIT 50
    )`,
    ).bind(now),
    env.DB.prepare(
      `DELETE FROM creation_quotas WHERE bucket_hash IN (
      SELECT bucket_hash FROM creation_quotas WHERE expires_at <= ?1 ORDER BY expires_at LIMIT 100
    )`,
    ).bind(now),
  ]);
}

async function limitCreation(
  request: Request,
  env: Env,
  kind: 'session' | 'scan',
): Promise<void> {
  const hostname = new URL(request.url).hostname;
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(hostname);
  const address =
    request.headers.get('CF-Connecting-IP') ??
    (local ? 'local-development' : null);
  if (!address || address.length > 64)
    throw new ApiError(400, 'Client network identity is unavailable.');
  const day = Math.floor(Date.now() / 86_400_000);
  const bucket = await hash(`${kind}:${day}:${address}`);
  const allowed = await env.DB.prepare(
    `INSERT INTO creation_quotas (bucket_hash, request_count, expires_at)
    SELECT ?1, 1, ?2 WHERE EXISTS (SELECT 1 FROM creation_quotas WHERE bucket_hash = ?1)
      OR (SELECT COUNT(*) FROM creation_quotas) < 20000
    ON CONFLICT(bucket_hash) DO UPDATE SET request_count = request_count + 1
      WHERE request_count < ?3 RETURNING request_count`,
  )
    .bind(bucket, (day + 1) * 86_400_000, kind === 'session' ? 20 : 50)
    .first();
  if (!allowed)
    throw new ApiError(
      429,
      'Daily creation limit reached. Try again tomorrow.',
    );
}

function visitorToken(request: Request): string | null {
  const token = request.headers
    .get('Cookie')
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1);
  return token && /^[a-f0-9]{64}$/.test(token) ? token : null;
}

function visitorCookie(request: Request, token: string): string {
  return `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${RETENTION_MS / 1000}${new URL(request.url).protocol === 'https:' ? '; Secure' : ''}`;
}

async function renewVisitor(
  request: Request,
  env: Env,
  owner: string,
  now = Date.now(),
): Promise<string> {
  const token = visitorToken(request);
  if (!token) throw new ApiError(401, 'Create a session first.');
  const renewed = await env.DB.prepare(
    'UPDATE visitors SET expires_at = MAX(expires_at, ?1) WHERE token_hash = ?2 AND expires_at > ?3 RETURNING token_hash',
  )
    .bind(now + RETENTION_MS, owner, now)
    .first();
  if (!renewed) throw new ApiError(401, 'Session has expired.');
  return visitorCookie(request, token);
}

async function visitor(request: Request, env: Env): Promise<string | null> {
  const token = visitorToken(request);
  if (!token) return null;
  const tokenHash = await hash(token);
  const found = await env.DB.prepare(
    'SELECT token_hash FROM visitors WHERE token_hash = ?1 AND expires_at > ?2',
  )
    .bind(tokenHash, Date.now())
    .first();
  return found ? tokenHash : null;
}

async function owned(request: Request, env: Env, id: string): Promise<ScanRow> {
  const owner = await visitor(request, env);
  if (!owner) throw new ApiError(401, 'Create a session first.');
  const row = await env.DB.prepare(
    'SELECT * FROM scans WHERE id = ?1 AND owner_hash = ?2 AND created_at > ?3',
  )
    .bind(id, owner, Date.now() - RETENTION_MS)
    .first<ScanRow>();
  if (!row) throw new ApiError(404, 'Scan not found.');
  return row;
}

async function runner(
  request: Request,
  env: Env,
  id: string,
): Promise<ScanRow> {
  const token = request.headers
    .get('Authorization')
    ?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  if (!token) throw new ApiError(401, 'Runner token is required.');
  const row = await env.DB.prepare(
    'SELECT * FROM scans WHERE id = ?1 AND runner_hash = ?2 AND runner_expires_at > ?3 AND created_at > ?4',
  )
    .bind(id, await hash(token), Date.now(), Date.now() - RETENTION_MS)
    .first<ScanRow>();
  if (!row) throw new ApiError(401, 'Runner token is invalid or expired.');
  return row;
}

function control(row: ScanRow): ScanControl {
  return {
    id: row.id,
    status:
      row.status === 'running' && (row.heartbeat_at ?? 0) < Date.now() - 90_000
        ? 'interrupted'
        : row.status,
    sites: JSON.parse(row.sites_json) as ScanSite[],
  };
}

async function snapshot(env: Env, row: ScanRow): Promise<ScanSnapshot> {
  const pages = await env.DB.prepare(
    'SELECT result_json FROM page_results WHERE scan_id = ?1 ORDER BY source_url',
  )
    .bind(row.id)
    .all<{ result_json: string }>();
  const results = pages.results.map(
    (page) => JSON.parse(page.result_json) as PageResult,
  );
  return {
    ...control(row),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    pageCount: results.length,
    results,
  };
}

async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (!path.startsWith('/api/')) return env.ASSETS.fetch(request);
  if (!path.startsWith(`${API_PREFIX}/`))
    throw new ApiError(404, 'Endpoint not found.');
  const isRunner = path.startsWith(`${API_PREFIX}/runner/`);
  if (!isRunner && !['GET', 'HEAD'].includes(request.method))
    sameOrigin(request);

  if (path === `${API_PREFIX}/session` && request.method === 'POST') {
    await readJson(request);
    const owner = await visitor(request, env);
    if (owner)
      return json({ ok: true }, 200, {
        'Set-Cookie': await renewVisitor(request, env, owner),
      });
    await cleanupExpired(env);
    await limitCreation(request, env, 'session');
    const token = randomToken();
    const created = await env.DB.prepare(
      'INSERT INTO visitors (token_hash, expires_at) SELECT ?1, ?2 WHERE (SELECT COUNT(*) FROM visitors) < 10000 RETURNING token_hash',
    )
      .bind(await hash(token), Date.now() + RETENTION_MS)
      .first();
    if (!created)
      throw new ApiError(429, 'Prototype visitor capacity reached.');
    return json({ ok: true }, 200, {
      'Set-Cookie': visitorCookie(request, token),
    });
  }

  if (path === `${API_PREFIX}/scans`) {
    const owner = await visitor(request, env);
    if (!owner) throw new ApiError(401, 'Create a session first.');
    if (request.method === 'POST') {
      const scanSites = sites((await readJson(request)).sites);
      await cleanupExpired(env);
      await limitCreation(request, env, 'scan');
      const now = Date.now();
      const cookie = await renewVisitor(request, env, owner, now);
      const id = crypto.randomUUID();
      const row = await env.DB.prepare(
        `INSERT INTO scans (id, owner_hash, sites_json, created_at, updated_at)
        SELECT ?1, ?2, ?3, ?4, ?4 WHERE (SELECT COUNT(*) FROM scans WHERE owner_hash = ?2 AND created_at > ?5) < 10
        AND (SELECT COUNT(*) FROM scans) < 1000 RETURNING *`,
      )
        .bind(id, owner, JSON.stringify(scanSites), now, now - RETENTION_MS)
        .first<ScanRow>();
      if (!row)
        throw new ApiError(
          429,
          'Visitor scan limit or prototype capacity reached.',
        );
      return json(await snapshot(env, row), 201, { 'Set-Cookie': cookie });
    }
    if (request.method === 'GET') {
      const rows = await env.DB.prepare(
        `SELECT scans.*, (SELECT COUNT(*) FROM page_results WHERE scan_id = scans.id) AS page_count
        FROM scans WHERE owner_hash = ?1 AND created_at > ?2 ORDER BY created_at DESC LIMIT 10`,
      )
        .bind(owner, Date.now() - RETENTION_MS)
        .all<ScanRow & { page_count: number }>();
      return json(
        rows.results.map((row) => ({
          ...control(row),
          createdAt: new Date(row.created_at).toISOString(),
          updatedAt: new Date(row.updated_at).toISOString(),
          pageCount: row.page_count,
        })),
      );
    }
  }

  const webMatch = path.match(
    /^\/api\/v1\/scans\/([a-f0-9-]{36})(\/(?:pairing-ticket|sites))?$/,
  );
  if (webMatch) {
    const row = await owned(request, env, webMatch[1]);
    if (webMatch[2] === '/sites' && request.method === 'POST') {
      const body = await readJson(request);
      const added = sites([body.site])[0];
      const previous = control(row).sites;
      if (previous.some((site) => site.origin === added.origin))
        throw new ApiError(409, 'This origin already belongs to the scan.');
      if (previous.length >= SCAN_LIMITS.sites)
        throw new ApiError(
          409,
          'The scan already contains the maximum number of origins.',
        );
      // The scope change and credential revocation must happen together.
      const updated = await env.DB.prepare(
        `UPDATE scans SET sites_json = ?1, status = 'paused', updated_at = ?2,
        runner_hash = NULL, runner_expires_at = NULL, ticket_hash = NULL,
        ticket_expires_at = NULL, heartbeat_at = NULL
        WHERE id = ?3 AND sites_json = ?4 RETURNING *`,
      )
        .bind(
          JSON.stringify([...previous, added]),
          Date.now(),
          row.id,
          row.sites_json,
        )
        .first<ScanRow>();
      if (!updated)
        throw new ApiError(409, 'The scan changed. Reload it before retrying.');
      return json(await snapshot(env, updated), 201);
    }
    if (webMatch[2] === '/pairing-ticket' && request.method === 'POST') {
      await readJson(request);
      const ticket = randomToken();
      const updated = await env.DB.prepare(
        'UPDATE scans SET ticket_hash = ?1, ticket_expires_at = ?2 WHERE id = ?3 AND sites_json = ?4 RETURNING id',
      )
        .bind(await hash(ticket), Date.now() + 60_000, row.id, row.sites_json)
        .first();
      if (!updated)
        throw new ApiError(
          409,
          'The scan changed. Request a new pairing ticket.',
        );
      return json({ ticket });
    }
    if (!webMatch[2] && request.method === 'GET')
      return json(await snapshot(env, row));
    if (!webMatch[2] && request.method === 'PATCH') {
      const body = await readJson(request);
      if (
        body.status !== undefined &&
        !['paused', 'waiting'].includes(String(body.status))
      )
        throw new ApiError(400, 'Web control supports paused or waiting.');
      const nextSites =
        body.sites === undefined ? control(row).sites : sites(body.sites);
      const previous = control(row).sites;
      if (
        nextSites.length < previous.length &&
        nextSites.every(
          (site, index) =>
            site.origin === previous[index].origin &&
            site.seedUrl === previous[index].seedUrl,
        )
      )
        throw new ApiError(
          409,
          'The scan scope changed. Reload it before retrying.',
        );
      if (
        nextSites.length !== previous.length ||
        nextSites.some(
          (site, index) =>
            site.origin !== previous[index].origin ||
            site.seedUrl !== previous[index].seedUrl,
        )
      )
        throw new ApiError(
          400,
          'Origins and seeds cannot change after creation.',
        );
      const updated = await env.DB.prepare(
        'UPDATE scans SET status = COALESCE(?1, status), sites_json = ?2, updated_at = ?3 WHERE id = ?4 AND sites_json = ?5 RETURNING *',
      )
        .bind(
          body.status ?? null,
          JSON.stringify(nextSites),
          Date.now(),
          row.id,
          row.sites_json,
        )
        .first<ScanRow>();
      if (!updated)
        throw new ApiError(409, 'The scan changed. Reload it before retrying.');
      return json(control(updated));
    }
  }

  if (path === `${API_PREFIX}/runner/exchange` && request.method === 'POST') {
    const body = await readJson(request);
    if (typeof body.ticket !== 'string' || !/^[a-f0-9]{64}$/.test(body.ticket))
      throw new ApiError(401, 'Invalid pairing ticket.');
    const token = randomToken();
    // Consuming the ticket and rotating the runner token are one atomic statement.
    const row = await env.DB.prepare(
      `UPDATE scans SET ticket_hash = NULL, ticket_expires_at = NULL, runner_hash = ?1, runner_expires_at = ?2
      WHERE ticket_hash = ?3 AND ticket_expires_at > ?4 AND created_at > ?5 RETURNING *`,
    )
      .bind(
        await hash(token),
        Date.now() + RUNNER_TTL_MS,
        await hash(body.ticket),
        Date.now(),
        Date.now() - RETENTION_MS,
      )
      .first<ScanRow>();
    if (!row)
      throw new ApiError(401, 'Pairing ticket is expired or already used.');
    return json({ token, scan: await snapshot(env, row) });
  }

  const runnerMatch = path.match(
    /^\/api\/v1\/runner\/scans\/([a-f0-9-]{36})(?:\/(control|results|progress))?$/,
  );
  if (runnerMatch) {
    const row = await runner(request, env, runnerMatch[1]);
    const action = runnerMatch[2];
    if (request.method === 'GET' && !action)
      return json(await snapshot(env, row));
    if (request.method === 'GET' && action === 'control')
      return json(control(row));
    if (request.method === 'POST' && action === 'progress') {
      const body = object(await readJson(request));
      if (!SCAN_STATUSES.includes(body.status as ScanStatus))
        throw new ApiError(400, 'Invalid scan status.');
      // Web pause wins even over an in-flight heartbeat/completion. Only web control resumes it.
      await env.DB.prepare(
        `UPDATE scans SET status = CASE WHEN status = 'paused' THEN status ELSE ?1 END,
        updated_at = ?2, heartbeat_at = ?2 WHERE id = ?3`,
      )
        .bind(body.status, Date.now(), row.id)
        .run();
      return json({ ok: true });
    }
    if (request.method === 'PUT' && action === 'results') {
      const result = pageResult(
        await readJson(request, SCAN_LIMITS.resultBytes),
        control(row).sites,
      );
      const resultJson = JSON.stringify(result);
      const resultHash = await hash(resultJson);
      const bytes = new TextEncoder().encode(resultJson).byteLength;
      const origin = new URL(result.sourceUrl).origin;
      // Capacity checks and insert share a statement, including concurrent deliveries.
      const inserted = await env.DB.prepare(
        `INSERT INTO page_results (scan_id, source_url, source_origin, result_hash, result_json, result_bytes)
        SELECT ?1, ?2, ?3, ?4, ?5, ?6 WHERE
        (SELECT COUNT(*) FROM page_results WHERE scan_id = ?1 AND source_origin = ?3) <
          (SELECT json_extract(value, '$.maxPages') FROM scans, json_each(scans.sites_json) WHERE scans.id = ?1 AND json_extract(value, '$.origin') = ?3)
        AND (SELECT COALESCE(SUM(result_bytes), 0) FROM page_results WHERE scan_id = ?1) + ?6 <= ?7
        ON CONFLICT(scan_id, source_url) DO NOTHING RETURNING source_url`,
      )
        .bind(
          row.id,
          result.sourceUrl,
          origin,
          resultHash,
          resultJson,
          bytes,
          MAX_SCAN_BYTES,
        )
        .first();
      if (!inserted) {
        const existing = await env.DB.prepare(
          'SELECT result_hash FROM page_results WHERE scan_id = ?1 AND source_url = ?2',
        )
          .bind(row.id, result.sourceUrl)
          .first<{ result_hash: string }>();
        if (!existing)
          throw new ApiError(429, 'Scan page or storage limit reached.');
        if (existing.result_hash !== resultHash)
          throw new ApiError(
            409,
            'A different result already exists for this source URL.',
          );
      }
      await env.DB.prepare('UPDATE scans SET updated_at = ?1 WHERE id = ?2')
        .bind(Date.now(), row.id)
        .run();
      return json({ ok: true });
    }
  }
  throw new ApiError(404, 'Endpoint not found.');
}

export default {
  async fetch(request, env) {
    try {
      return await handle(request, env);
    } catch (error) {
      if (error instanceof ApiError)
        return json({ error: error.message }, error.status);
      // Do not log tokens, request bodies, page URLs or extracted content.
      console.error(
        JSON.stringify({
          message: 'Scan API request failed',
          method: request.method,
        }),
      );
      return json({ error: 'Internal server error.' }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
