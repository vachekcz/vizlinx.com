#!/usr/bin/env node
'use strict';

// Check inline Markdown links against exact paths in the Git index.
const { execFileSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { posix, join } = require('node:path');

const help = `Použití: node scripts/check-doc-links.cjs [--exclude docs/cesta]...

Kontroluje relativní inline odkazy v trackovaných docs/**/*.md (Node.js 22+).
Cíle porovnává s Git indexem, obsah čte z pracovního stromu.
Spouštěj z libovolného adresáře cílového repozitáře.

  --exclude CESTA  Vynechá zdrojový soubor nebo podstrom pod docs/.
                  Cesta je relativní ke kořeni repa; bez globů, opakovatelná.
  --help          Vypíše tuto nápovědu.

Bez --exclude se kontrolují všechny trackované Markdown soubory pod docs/.
Příklad: node scripts/check-doc-links.cjs --exclude docs/done --exclude docs/superpowers
Návratové kódy: 0 = bez nálezů, 1 = rozbité odkazy, 2 = chyba spuštění.
`;

function readOptions(args) {
  const excludes = [];
  for (let i = 0; i < args.length; i++) {
    if (
      args[i] !== '--exclude' ||
      !args[i + 1] ||
      args[i + 1].startsWith('--')
    ) {
      throw new Error(`Neplatný argument: ${args[i]}. Použij --help.`);
    }
    const value = args[++i].replace(/\/+$/, '');
    if (
      !/^docs\/.+/.test(value) ||
      value.includes('\\') ||
      /[*?\[\]]/.test(value) ||
      value.split('/').some((part) => !part || part === '.' || part === '..')
    ) {
      throw new Error(`Výjimka musí být konkrétní cesta pod docs/: ${value}`);
    }
    excludes.push(value);
  }
  return excludes;
}

function blank(value) {
  return value.replace(/[^\n]/g, ' ');
}

function withoutCode(source) {
  let fence;
  const prose = source
    .split('\n')
    .map((line) => {
      const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (fence) {
        if (
          match &&
          match[1][0] === fence.character &&
          match[1].length >= fence.length &&
          /^\s*$/.test(match[2])
        )
          fence = undefined;
        return blank(line);
      }
      if (match && (match[1][0] !== '`' || !match[2].includes('`'))) {
        fence = { character: match[1][0], length: match[1].length };
        return blank(line);
      }
      return line;
    })
    .join('\n');

  // A code span ends only at a backtick run of the same length, even across lines.
  const runs = [...prose.matchAll(/`+/g)];
  let result = '';
  let offset = 0;
  for (let i = 0; i < runs.length; i++) {
    const start = runs[i];
    if (isEscaped(prose, start.index)) continue;
    let endIndex = i + 1;
    while (
      endIndex < runs.length &&
      runs[endIndex][0].length !== start[0].length
    )
      endIndex++;
    if (endIndex === runs.length) continue;
    const end = runs[endIndex].index + runs[endIndex][0].length;
    result +=
      prose.slice(offset, start.index) + blank(prose.slice(start.index, end));
    offset = end;
    i = endIndex;
  }
  return result + prose.slice(offset);
}

function isEscaped(source, index) {
  let count = 0;
  while (index > 0 && source[--index] === '\\') count++;
  return count % 2 === 1;
}

function destinationAt(source, start) {
  let index = start;
  while (/\s/.test(source[index] || '') && index < source.length) index++;
  // Preserve the bundle's placeholder convention; angle destinations are out of scope.
  if (source[index] === '<') return undefined;
  let depth = 0;
  let destination = '';
  for (; index < source.length; index++) {
    const character = source[index];
    if (
      character === '\\' &&
      /[!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~]/.test(source[index + 1] || '')
    ) {
      destination += source[++index];
    } else if (character === '(') {
      depth++;
      destination += character;
    } else if (character === ')') {
      if (depth === 0) return destination;
      depth--;
      destination += character;
    } else if (/\s/.test(character)) {
      if (depth > 0) return undefined;
      const tail = source.slice(index);
      return /^\s*(?:(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\((?:\\.|[^)\\])*\))\s*)?\)/.test(
        tail,
      )
        ? destination
        : undefined;
    } else {
      destination += character;
    }
  }
  return undefined;
}

function check(excludes) {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  const tracked = new Set(
    execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
      .split('\0')
      .filter(Boolean),
  );
  const directories = new Set(['.']);
  for (const file of tracked) {
    const parts = file.split('/');
    for (let i = 1; i < parts.length; i++)
      directories.add(parts.slice(0, i).join('/'));
  }
  let broken = 0;
  let checked = 0;
  for (const file of tracked) {
    if (
      !file.startsWith('docs/') ||
      !file.endsWith('.md') ||
      excludes.some(
        (exclude) => file === exclude || file.startsWith(`${exclude}/`),
      )
    )
      continue;
    checked++;
    const source = withoutCode(readFileSync(join(root, file), 'utf8'));
    for (const match of source.matchAll(/!?\[(?:\\.|[^\[\]\n])*\]\(/g)) {
      if (isEscaped(source, match.index)) continue;
      const link = destinationAt(source, match.index + match[0].length);
      if (!link || /^(?:[a-z][a-z\d+.-]*:|\/|#|\?)/i.test(link)) continue;
      const path = link.split(/[?#]/, 1)[0];
      let decoded;
      try {
        decoded = decodeURIComponent(path);
      } catch {
        decoded = undefined;
      }
      const target =
        decoded === undefined
          ? undefined
          : posix
              .normalize(posix.join(posix.dirname(file), decoded))
              .replace(/\/+$/, '') || '.';
      if (
        target === undefined ||
        !(decoded.endsWith('/') ? directories : tracked).has(target)
      ) {
        const line = source.slice(0, match.index).split('\n').length;
        process.stdout.write(`ROZBITÝ ODKAZ: ${file}:${line} -> ${link}\n`);
        broken++;
      }
    }
  }
  process.stderr.write(
    `Zkontrolováno dokumentů: ${checked}; rozbitých odkazů: ${broken}.\n`,
  );
  return broken ? 1 : 0;
}

try {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write(help);
  } else {
    process.exitCode = check(readOptions(args));
  }
} catch (error) {
  process.stderr.write(`Kontrola odkazů selhala: ${error.message}\n`);
  process.exitCode = 2;
}
