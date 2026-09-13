import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {
  buildGalleryModel,
  type GalleryCaption,
} from './screenshot-gallery/model';
import {
  isGalleryLang,
  renderGalleryHtml,
  type GalleryLang,
} from './screenshot-gallery/html';

const root = path.resolve(process.argv[2] ?? 'screenshots-output');

// Caption sidecars share the screenshot naming: <viewport>/<section>/<state>.json.
const CAPTION_PATH = /^[a-z0-9-]+\/([a-z0-9-]+\/[a-z0-9-]+)\.json$/;

function walkFiles(dir: string, base: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(dir, entry.name);
    const relative = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return walkFiles(absolute, relative);
    return [relative];
  });
}

function readCaptions(files: string[]): Record<string, GalleryCaption> {
  const captions: Record<string, GalleryCaption> = {};
  for (const file of files) {
    const match = CAPTION_PATH.exec(file);
    if (!match) continue;
    try {
      const parsed = JSON.parse(
        fs.readFileSync(path.join(root, file), 'utf8'),
      ) as Partial<GalleryCaption>;
      if (
        typeof parsed.title === 'string' &&
        typeof parsed.description === 'string'
      ) {
        captions[match[1]] = {
          title: parsed.title,
          description: parsed.description,
        };
      }
    } catch {
      console.warn(`Skipping unreadable caption sidecar: ${file}`);
    }
  }
  return captions;
}

// An unknown GALLERY_LANG falls back instead of failing the deploy: a typo in
// workflow env should not cost the nightly gallery.
function resolveLang(value: string | undefined): GalleryLang {
  if (!value) return 'cs';
  if (isGalleryLang(value)) return value;
  console.warn(`Unknown GALLERY_LANG "${value}", falling back to "cs".`);
  return 'cs';
}

try {
  const files = walkFiles(root, '');
  const pngs = files.filter((file) => file.endsWith('.png'));
  if (pngs.length === 0) {
    console.error(`No screenshots found in ${root}`);
    process.exit(1);
  }
  const model = buildGalleryModel(pngs, readCaptions(files));
  // The model drops anything that is not <viewport>/<section>/<state>.png with
  // [a-z0-9-] segments. Silent dropping is the safe default for a public page,
  // but a mistyped slug would otherwise just be missing from the gallery.
  const rendered = model.sections.reduce(
    (total, section) =>
      total +
      section.states.reduce(
        (count, state) => count + Object.keys(state.images).length,
        0,
      ),
    0,
  );
  if (rendered < pngs.length) {
    console.warn(
      `Ignored ${pngs.length - rendered} screenshot(s) outside the <viewport>/<section>/<state>.png convention.`,
    );
  }
  const html = renderGalleryHtml(model, {
    generatedAt: new Date().toISOString(),
    commitSha: process.env.GALLERY_COMMIT_SHA ?? 'unknown',
    repoUrl: process.env.GALLERY_REPO_URL ?? '',
    title: process.env.GALLERY_TITLE ?? '',
    lang: resolveLang(process.env.GALLERY_LANG),
  });
  const target = path.join(root, 'index.html');
  fs.writeFileSync(target, html);
  console.log(`Gallery written to ${target} (${rendered} screenshots).`);
} catch (error) {
  console.error('Failed to build gallery:', error);
  process.exit(1);
}
