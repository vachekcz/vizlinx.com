import { build } from 'esbuild';
import { readFile, copyFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export const TEST_APP_ORIGIN = 'http://127.0.0.1:8897';
export const TEST_APP_PORT = 8897;
export const TEST_FIXTURE_PORT = 8901;

export async function buildTestExtension() {
  const outdir = resolve('build/extension-test');
  await mkdir(outdir, { recursive: true });
  await build({
    entryPoints: ['extension/background.ts', 'extension/runner.ts'],
    outdir,
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: 'chrome120',
    define: {
      __LOCAL_ORIGINS__: JSON.stringify([
        TEST_APP_ORIGIN,
        'http://localhost:8897',
      ]),
    },
  });
  const manifest = JSON.parse(
    await readFile('build/extension/manifest.json', 'utf8'),
  );
  manifest.name = 'Vizlinx Local Scanner (isolated test)';
  manifest.host_permissions.push('http://127.0.0.1/*', 'http://localhost/*');
  manifest.externally_connectable.matches.push(
    'http://127.0.0.1/*',
    'http://localhost/*',
  );
  await writeFile(
    `${outdir}/manifest.json`,
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  for (const file of ['runner.html', 'runner.css'])
    await copyFile(`extension/${file}`, `${outdir}/${file}`);
  return outdir;
}
