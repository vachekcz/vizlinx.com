import assert from 'node:assert/strict';
import { test } from 'node:test';
import { benchmarkSite, estimateCpuCapacity } from './benchmark-scan.mjs';

test('CPU scenarios use the shared monthly allowance and reject invalid inputs', () => {
  assert.deepEqual(estimateCpuCapacity(100), {
    assumedWorkerCpuMsPerPage: 100,
    pagesWithinIncludedCpu: 300_000,
    scansWithinIncludedCpu: 6000,
    pagesPerScan: 50,
  });
  assert.equal(estimateCpuCapacity(500).pagesWithinIncludedCpu, 60_000);
  assert.throws(() => estimateCpuCapacity(0));
  assert.throws(() => estimateCpuCapacity(100, 0));
});

test('crawler bounds the frontier, deduplicates links, and stays on the seed origin', async () => {
  const fetched = [];
  const result = await benchmarkSite({
    seedUrl: 'https://example.com/',
    maxPages: 2,
    intervalMs: 0,
    fetchRobots: async () => ({ allowed: () => true, delayMs: 0 }),
    fetchPage: async (sourceUrl) => {
      fetched.push(sourceUrl);
      return {
        status: 'ok',
        httpStatus: 200,
        links: [],
        discoveredUrls: [
          'https://outside.org/',
          'https://example.com/',
          'https://example.com/next',
          'https://example.com/next',
          'https://example.com/later',
        ],
      };
    },
  });
  assert.deepEqual(fetched, [
    'https://example.com/',
    'https://example.com/next',
  ]);
  assert.equal(result.stoppedBy, 'page_limit');
  assert.equal(result.successfulPages, 2);
});

test('robots-denied pages are not fetched or counted as successful throughput', async () => {
  const result = await benchmarkSite({
    seedUrl: 'https://example.com/',
    maxPages: 20,
    intervalMs: 0,
    fetchRobots: async () => ({ allowed: () => false, delayMs: 0 }),
    fetchPage: async () => assert.fail('Blocked page must not be fetched.'),
  });
  assert.equal(result.attemptedPages, 0);
  assert.equal(result.successfulPagesPerMinute, 0);
  assert.equal(result.pageWallMsP50, null);
  assert.deepEqual(result.statusCounts, { robots_denied: 1 });
});

test('long crawl delays stop within the budget without fetching early', async () => {
  const result = await benchmarkSite({
    seedUrl: 'https://example.com/',
    maxPages: 20,
    intervalMs: 0,
    budgetMs: 100,
    fetchRobots: async () => ({ allowed: () => true, delayMs: 60_000 }),
    fetchPage: async () => assert.fail('Crawl delay must not be bypassed.'),
  });
  assert.equal(result.stoppedBy, 'time_budget');
  assert.equal(result.attemptedPages, 0);
});

test('HTTP failures are counted separately from successful pages', async () => {
  const result = await benchmarkSite({
    seedUrl: 'https://example.com/',
    maxPages: 20,
    intervalMs: 0,
    fetchRobots: async () => ({ allowed: () => true, delayMs: 0 }),
    fetchPage: async () => ({
      status: 'http_error',
      httpStatus: 429,
      links: [],
      discoveredUrls: [],
    }),
  });
  assert.equal(result.attemptedPages, 1);
  assert.equal(result.successfulPages, 0);
  assert.deepEqual(result.statusCounts, { http_error: 1 });
});
