import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

let mf;
let db;
before(async () => {
  const output = await build({
    stdin: {
      resolveDir: process.cwd(),
      contents: `import { scanLogStatements, readScanLog } from './worker/scan-log.ts';
        export default { async fetch(request, env) {
          const input = await request.json();
          for (let offset = 0; offset < (input.events?.length ?? 0); offset += 20) {
            await env.DB.batch(input.events.slice(offset, offset + 20).flatMap(({key, ...event}) =>
              scanLogStatements(env, input.id, key, event)));
          }
          if (input.pauseGeneration !== undefined) {
            await env.DB.batch([
              env.DB.prepare("UPDATE scans SET status = 'paused' WHERE id = ? AND crawl_generation = ?").bind(input.id, input.pauseGeneration),
              ...scanLogStatements(env, input.id, 'pause', {at: new Date().toISOString(), type: 'scan_paused', level: 'info'}, {sql: 'changes() = 1', bindings: []}),
            ]);
          }
          return Response.json(await readScanLog(env, input.id));
        } };`,
    },
    bundle: true,
    format: 'esm',
    write: false,
    platform: 'browser',
    target: 'es2023',
  });
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: output.outputFiles[0].text,
      compatibilityDate: '2026-09-12',
      d1Databases: ['DB'],
    }),
  );
  db = await mf.getD1Database('DB');
  for (const file of (await readdir(new URL('../migrations/', import.meta.url)))
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    for (const sql of (
      await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8')
    )
      .split(';')
      .filter((statement) => statement.trim()))
      await db.prepare(sql).run();
  }
});
after(async () => {
  await mf?.dispose();
});

async function create() {
  const id = crypto.randomUUID();
  await db
    .prepare(
      'INSERT OR IGNORE INTO visitors (token_hash, expires_at) VALUES (?, ?)',
    )
    .bind('fixture', Date.now() + 86_400_000)
    .run();
  await db
    .prepare(
      'INSERT INTO scans (id, owner_hash, sites_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    )
    .bind(id, 'fixture', '[]', Date.now(), Date.now())
    .run();
  return id;
}
async function call(input) {
  const response = await mf.dispatchFetch('https://vizlinx.com/', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}
const event = (key) => ({
  key,
  at: new Date().toISOString(),
  type: 'scan_started',
  level: 'info',
});

test('the retained log is chronological, capped at 500, and reports truncation persistently', async () => {
  const id = await create();
  const initial = await call({
    id,
    events: Array.from({ length: 500 }, (_, index) => event(`start:${index}`)),
  });
  assert.equal(initial.events.length, 500);
  assert.equal(initial.truncated, false);
  const capped = await call({ id, events: [event('start:500')] });
  assert.equal(capped.events.length, 500);
  assert.equal(capped.truncated, true);
  assert.equal(capped.events[0].id, initial.events[1].id);
  assert.ok(
    capped.events.every(
      (entry, index) => index === 0 || entry.id > capped.events[index - 1].id,
    ),
  );
  assert.deepEqual(
    await call({ id }),
    capped,
    'A fresh read must return persisted events and truncation',
  );
  assert.equal(
    (
      await db
        .prepare('SELECT COUNT(*) AS count FROM scan_events WHERE scan_id = ?')
        .bind(id)
        .first()
    ).count,
    500,
  );
  const trimmedAgain = await call({ id, events: [event('start:501')] });
  assert.equal(trimmedAgain.events.length, 500);
  assert.equal(trimmedAgain.truncated, true);
  assert.equal(trimmedAgain.events[0].id, initial.events[2].id);
  assert.deepEqual(
    await call({ id, events: [event('start:501')], pauseGeneration: 99 }),
    trimmedAgain,
    'Duplicate and rejected transitions must not trim an already capped log',
  );
});

test('duplicate event keys are scoped to the map and do not duplicate notifications', async () => {
  const id = await create();
  const another = await create();
  const first = await call({ id, events: [event('start:1')] });
  const duplicate = await call({ id, events: [event('start:1')] });
  assert.deepEqual(duplicate, first);
  assert.equal(
    (await call({ id: another, events: [event('start:1')] })).events.length,
    1,
  );
});

test('only an accepted state change logs its event in the same D1 transaction', async () => {
  const id = await create();
  assert.equal((await call({ id, pauseGeneration: 99 })).events.length, 0);
  assert.equal(
    (await call({ id, pauseGeneration: 0 })).events[0].type,
    'scan_paused',
  );
  assert.equal(
    (await db.prepare('SELECT status FROM scans WHERE id = ?').bind(id).first())
      .status,
    'paused',
  );
});

test('deleting a map cascades its log without affecting another map', async () => {
  const id = await create();
  const another = await create();
  await call({ id, events: [event('start:1')] });
  await call({ id: another, events: [event('start:1')] });
  await db.prepare('DELETE FROM scans WHERE id = ?').bind(id).run();
  assert.equal(
    (
      await db
        .prepare('SELECT COUNT(*) AS count FROM scan_events WHERE scan_id = ?')
        .bind(id)
        .first()
    ).count,
    0,
  );
  assert.equal((await call({ id: another })).events.length, 1);
});
