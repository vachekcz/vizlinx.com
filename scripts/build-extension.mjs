import { build } from 'esbuild';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { EXTENSION_KEY } from '../shared/extension.ts';

const production = ['https://vizlinx.com/*', 'https://www.vizlinx.com/*'];
for (const development of [false, true]) {
  const outdir = resolve(
    development ? 'build/extension-dev' : 'build/extension',
  );
  await mkdir(outdir, { recursive: true });
  await build({
    entryPoints: ['extension/background.ts', 'extension/runner.ts'],
    outdir,
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: 'chrome120',
    minify: !development,
    define: {
      __LOCAL_ORIGINS__: JSON.stringify(
        development ? ['http://127.0.0.1:8797', 'http://localhost:8797'] : [],
      ),
    },
  });
  const hosts = [
    ...production,
    ...(development ? ['http://127.0.0.1/*', 'http://localhost/*'] : []),
  ];
  await writeFile(
    `${outdir}/manifest.json`,
    `${JSON.stringify(
      {
        manifest_version: 3,
        minimum_chrome_version: '120',
        name: development
          ? 'Vizlinx Local Scanner (development)'
          : 'Vizlinx Local Scanner',
        version: '0.1.0',
        description:
          'Načte veřejné odkazy z vámi vybraných domén a zobrazí je v mapě Vizlinx.',
        key: EXTENSION_KEY,
        permissions: ['storage'],
        host_permissions: hosts,
        optional_host_permissions: ['http://*/*', 'https://*/*'],
        externally_connectable: { matches: hosts },
        background: { service_worker: 'background.js', type: 'module' },
        action: { default_title: 'Otevřít lokální skener Vizlinx' },
        content_security_policy: {
          extension_pages:
            "script-src 'self'; object-src 'none'; base-uri 'none'",
        },
      },
      null,
      2,
    )}\n`,
  );
  for (const file of ['runner.html', 'runner.css'])
    await copyFile(`extension/${file}`, `${outdir}/${file}`);
}
await mkdir('dist/downloads', { recursive: true });
// A fresh archive avoids retaining files from a previous package revision.
const archive = resolve('dist/downloads/vizlinx-extension.zip');
execFileSync(
  'zip',
  [
    '-q',
    '-FS',
    archive,
    'manifest.json',
    'background.js',
    'runner.js',
    'runner.html',
    'runner.css',
  ],
  { cwd: resolve('build/extension') },
);
console.log(
  'Built production ZIP and separate unpacked development extension.',
);
