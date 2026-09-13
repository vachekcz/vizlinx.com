import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

// This operator-only CLI runs locally. Its CPU measurements are not Workers billing data.
export function estimateCpuCapacity(cpuMsPerPage, pagesPerScan = 50) {
  if (!Number.isFinite(cpuMsPerPage) || cpuMsPerPage <= 0)
    throw new Error('CPU milliseconds per page must be positive.');
  if (!Number.isInteger(pagesPerScan) || pagesPerScan < 1)
    throw new Error('Pages per scan must be a positive integer.');
  const pages = Math.floor(30_000_000 / cpuMsPerPage);
  return {
    assumedWorkerCpuMsPerPage: cpuMsPerPage,
    pagesWithinIncludedCpu: pages,
    scansWithinIncludedCpu: Math.floor(pages / pagesPerScan),
    pagesPerScan,
  };
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

export async function benchmarkSite({
  seedUrl,
  maxPages,
  intervalMs,
  fetchRobots,
  fetchPage,
  budgetMs = 120_000,
}) {
  const started = performance.now();
  const origin = new URL(seedUrl).origin;
  const policy = await fetchRobots(origin);
  const interval = Math.max(intervalMs, policy.delayMs);
  const queue = [seedUrl];
  const seen = new Set(queue);
  const pages = [];
  let lastRequest = performance.now();
  let stoppedBy = 'exhausted';
  while (queue.length && pages.length < maxPages) {
    const sourceUrl = queue.shift();
    if (!policy.allowed(sourceUrl)) {
      pages.push({ sourceUrl, status: 'robots_denied' });
      continue;
    }
    const waitMs = Math.max(0, lastRequest + interval - performance.now());
    if (performance.now() - started + waitMs >= budgetMs) {
      stoppedBy = 'time_budget';
      break;
    }
    await sleep(waitMs);
    lastRequest = performance.now();
    const cpuStart = process.cpuUsage();
    const result = await fetchPage(sourceUrl);
    const serializedBytes = Buffer.byteLength(JSON.stringify(result));
    const cpu = process.cpuUsage(cpuStart);
    pages.push({
      sourceUrl,
      status: result.status,
      httpStatus: result.httpStatus,
      wallMs: performance.now() - lastRequest,
      localProcessCpuMs: (cpu.user + cpu.system) / 1000,
      structuredBytes: serializedBytes,
      links: result.links.length,
      truncated: result.truncated,
    });
    for (const target of result.discoveredUrls) {
      if (new URL(target).origin !== origin || seen.has(target)) continue;
      // Keep at most the requested pages plus one marker for an unfinished frontier.
      if (seen.size >= maxPages + 1) break;
      seen.add(target);
      queue.push(target);
    }
  }
  if (queue.length && pages.length >= maxPages) stoppedBy = 'page_limit';
  const attempted = pages.filter((page) => page.wallMs !== undefined);
  const successful = attempted.filter((page) => page.status === 'ok');
  const wallMs = performance.now() - started;
  return {
    seedUrl,
    maxPages,
    intervalMs: interval,
    stoppedBy,
    wallMs,
    attemptedPages: attempted.length,
    successfulPages: successful.length,
    successfulPagesPerMinute: (successful.length * 60_000) / wallMs,
    statusCounts: pages.reduce((counts, page) => {
      counts[page.status] = (counts[page.status] ?? 0) + 1;
      return counts;
    }, {}),
    pageWallMsP50: percentile(
      attempted.map((page) => page.wallMs),
      0.5,
    ),
    pageWallMsP95: percentile(
      attempted.map((page) => page.wallMs),
      0.95,
    ),
    localProcessCpuMs: attempted.reduce(
      (sum, page) => sum + page.localProcessCpuMs,
      0,
    ),
    structuredBytes: attempted.reduce(
      (sum, page) => sum + page.structuredBytes,
      0,
    ),
    pages,
  };
}

export async function startFixture() {
  const server = createServer((request, response) => {
    if (request.url === '/robots.txt') {
      response.writeHead(200, { 'Content-Type': 'text/plain' });
      response.end('User-agent: *\nDisallow: /private\n');
      return;
    }
    const index = Number(request.url?.slice(1) || 0);
    if (!Number.isInteger(index) || index < 0 || index > 49) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    const links = Array.from(
      { length: 50 },
      (_, target) => `<a href="/${target}">Page ${target}</a>`,
    ).join('');
    // Three synthetic sizes exercise the real parser without burdening public sites.
    const paragraphs = '<p>Controlled benchmark content.</p>'.repeat(
      [100, 2500, 20_000][index % 3],
    );
    response.end(
      `<!doctype html><title>Fixture ${index}</title><main>${links}${paragraphs}</main>`,
    );
  });
  await new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', done);
  });
  return {
    seedUrl: `http://127.0.0.1:${server.address().port}/`,
    close: () => new Promise((done) => server.close(done)),
  };
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      fixture: { type: 'boolean', default: false },
      pages: { type: 'string', default: '20' },
      output: { type: 'string', default: 'test-results/scan-benchmark.json' },
    },
  });
  const maxPages = Number(values.pages);
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 50)
    throw new Error('--pages must be an integer between 1 and 50.');
  if (positionals.length > 3 || (values.fixture && positionals.length))
    throw new Error('Use --fixture or up to three public seed URLs.');
  await mkdir('build', { recursive: true });
  await build({
    stdin: {
      contents:
        "export { fetchPage, fetchRobots } from './extension/fetch-page.ts'; export { normalizeScanUrl } from './shared/scan.ts';",
      resolveDir: process.cwd(),
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: 'build/scan-benchmark-runtime.mjs',
  });
  const runtime = await import(
    pathToFileURL(resolve('build/scan-benchmark-runtime.mjs')).href
  );
  const useFixture = values.fixture || !positionals.length;
  const fixture = useFixture ? await startFixture() : null;
  try {
    const seeds = fixture
      ? [fixture.seedUrl]
      : [...new Set(positionals.map(runtime.normalizeScanUrl))];
    const sites = [];
    for (const seedUrl of seeds) {
      console.log(`Scanning ${seedUrl} (up to ${maxPages} pages)...`);
      sites.push(
        await benchmarkSite({
          seedUrl,
          maxPages,
          intervalMs: fixture ? 0 : 1000,
          ...runtime,
        }),
      );
    }
    const report = {
      measuredAt: new Date().toISOString(),
      environment: `local Node ${process.version} on ${process.platform}/${process.arch}`,
      fixture: useFixture,
      limitations: [
        'Local CPU measurements are not Cloudflare Workers CPU billing measurements.',
        'No D1 writes, queue operations, hosted browser, or production traffic are included.',
        'CPU scenarios assume all included account CPU is available to scanning.',
        'Synthetic fixtures do not measure public website latency or bot blocking.',
        'This CLI uses the existing static HTML scanner with no redirects or cookies.',
      ],
      cpuOnlyScenarios: [20, 100, 500].map((cpu) => estimateCpuCapacity(cpu)),
      sites,
    };
    await mkdir(resolve(values.output, '..'), { recursive: true });
    await writeFile(values.output, JSON.stringify(report, null, 2) + '\n');
    console.table(
      sites.map((site) => ({
        url: site.seedUrl,
        attempted: site.attemptedPages,
        successful: site.successfulPages,
        seconds: (site.wallMs / 1000).toFixed(2),
        localCpuMs: site.localProcessCpuMs.toFixed(1),
        resultKiB: (site.structuredBytes / 1024).toFixed(1),
        stoppedBy: site.stoppedBy,
      })),
    );
    console.log(`Report: ${values.output}`);
    console.log(
      'Local measurements; CPU-only Cloudflare scenarios are assumptions.',
    );
  } finally {
    await fixture?.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
