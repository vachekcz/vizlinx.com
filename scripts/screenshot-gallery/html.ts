import type { GalleryModel, GalleryState } from './model';

/**
 * Every user-facing string of the gallery lives here — nothing is inlined into
 * the markup below. Adding a language means adding a key; the page picks a set
 * via GALLERY_LANG. Keep the fold-marker label in `capture.ts` in sync.
 */
export const GALLERY_TEXTS = {
  cs: {
    heading: 'UI galerie',
    lightboxLabel: 'Náhled screenshotu',
    prev: 'Předchozí',
    next: 'Další',
    close: 'Zavřít',
    /** Returns HTML — `commitLink` is already-escaped markup, do not escape again. */
    generatedLine: (date: string, commitLink: string) =>
      `Vygenerováno ${date} z commitu ${commitLink}`,
  },
  en: {
    heading: 'UI gallery',
    lightboxLabel: 'Screenshot preview',
    prev: 'Previous',
    next: 'Next',
    close: 'Close',
    generatedLine: (date: string, commitLink: string) =>
      `Generated ${date} from commit ${commitLink}`,
  },
} as const;

export type GalleryLang = keyof typeof GALLERY_TEXTS;

export function isGalleryLang(value: string): value is GalleryLang {
  return value in GALLERY_TEXTS;
}

export type GalleryMeta = {
  generatedAt: string;
  commitSha: string;
  repoUrl: string;
  /** Project name shown before the gallery heading; empty renders the heading alone. */
  title: string;
  lang: GalleryLang;
};

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function renderCard(
  state: GalleryState,
  viewports: string[],
  stateIndex: number,
): string {
  const shots = viewports
    .filter((viewport) => state.images[viewport])
    .map((viewport) => {
      const src = escapeHtml(state.images[viewport]);
      const alt = `${escapeHtml(state.title)} (${escapeHtml(viewport)})`;
      return `<a class="shot" data-viewport="${escapeHtml(viewport)}" data-index="${stateIndex}" href="${src}"><img src="${src}" alt="${alt}" loading="lazy" /></a>`;
    })
    .join('\n        ');
  return `<figure class="card">
        ${shots}
        <figcaption>${escapeHtml(state.title)}</figcaption>
      </figure>`;
}

export function renderGalleryHtml(
  model: GalleryModel,
  meta: GalleryMeta,
): string {
  const texts = GALLERY_TEXTS[meta.lang];
  const pageTitle = meta.title
    ? `${meta.title} — ${texts.heading}`
    : texts.heading;
  const shortSha = meta.commitSha.slice(0, 7);
  const generatedDate = meta.generatedAt.slice(0, 10);
  const commitLink = meta.repoUrl
    ? `<a href="${escapeHtml(`${meta.repoUrl}/commit/${meta.commitSha}`)}">${escapeHtml(shortSha)}</a>`
    : escapeHtml(shortSha);
  const defaultViewport = model.viewports[0] ?? 'desktop';

  const viewportToggle = model.viewports
    .map((viewport, index) => {
      const checked = index === 0 ? ' checked' : '';
      return `<label><input type="radio" name="viewport" value="${escapeHtml(viewport)}"${checked} /> ${escapeHtml(viewport)}</label>`;
    })
    .join('\n      ');

  const nav = model.sections
    .map(
      (section) =>
        `<a href="#${escapeHtml(section.slug)}">${escapeHtml(section.title)}</a>`,
    )
    .join('\n      ');

  // Viewport names are restricted to [a-z0-9-] by the model's path regex,
  // so raw interpolation into the <style> block is safe.
  const viewportCss = model.viewports
    .map(
      (viewport) =>
        `body[data-viewport="${viewport}"] .shot:not([data-viewport="${viewport}"]) { display: none; }`,
    )
    .join('\n      ');

  let stateIndex = 0;
  const sections = model.sections
    .map(
      (section) => `<section id="${escapeHtml(section.slug)}">
      <h2>${escapeHtml(section.title)}</h2>
      <div class="grid">
      ${section.states.map((state) => renderCard(state, model.viewports, stateIndex++)).join('\n      ')}
      </div>
    </section>`,
    )
    .join('\n    ');

  // Flattened in the exact card order, so data-index maps 1:1 onto this array.
  const statesPayload = model.sections.flatMap((section) =>
    section.states.map((state) => ({
      section: section.title,
      title: state.title,
      description: state.description ?? '',
      images: state.images,
    })),
  );
  // < keeps a hostile "</script>" inside caption text from closing the tag.
  const galleryDataJson = JSON.stringify(statesPayload).replaceAll(
    '<',
    '\\u003c',
  );

  return `<!doctype html>
<html lang="${meta.lang}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${escapeHtml(pageTitle)}</title>
<style>
  * { box-sizing: border-box; margin: 0; }
  body {
    font-family: system-ui, sans-serif;
    background: #f4f4f5;
    color: #18181b;
    padding: 1.5rem;
  }
  header { max-width: 1200px; margin: 0 auto 1rem; }
  header h1 { font-size: 1.4rem; }
  header p { color: #52525b; font-size: 0.9rem; margin-top: 0.25rem; }
  .toolbar {
    max-width: 1200px;
    margin: 0 auto 1.5rem;
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem 1.5rem;
    align-items: center;
    background: #fff;
    border: 1px solid #e4e4e7;
    border-radius: 0.5rem;
    padding: 0.75rem 1rem;
    position: sticky;
    top: 0.5rem;
    z-index: 10;
  }
  .toolbar .viewports { display: flex; gap: 1rem; font-weight: 600; }
  .toolbar nav { display: flex; flex-wrap: wrap; gap: 0.75rem; font-size: 0.9rem; }
  .toolbar a { color: #2563eb; text-decoration: none; }
  .toolbar a:hover { text-decoration: underline; }
  main { max-width: 1200px; margin: 0 auto; }
  section { margin-bottom: 2.5rem; }
  section h2 {
    font-size: 1.1rem;
    margin-bottom: 0.75rem;
    padding-bottom: 0.4rem;
    border-bottom: 1px solid #e4e4e7;
    scroll-margin-top: 5rem;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
    gap: 1rem;
    align-items: start;
  }
  .card {
    background: #fff;
    border: 1px solid #e4e4e7;
    border-radius: 0.5rem;
    overflow: hidden;
  }
  .card img {
    display: block;
    width: 100%;
    height: auto;
    background: #fff;
    border-bottom: 1px solid #e4e4e7;
  }
  .card figcaption { padding: 0.6rem 0.8rem; font-size: 0.9rem; font-weight: 600; }
  #lightbox {
    border: none;
    padding: 0;
    width: min(96vw, 1280px);
    max-height: 92vh;
    background: #18181b;
    color: #fafafa;
    border-radius: 0.5rem;
    overflow: hidden;
  }
  #lightbox[open] { display: flex; flex-direction: column; }
  #lightbox::backdrop { background: rgba(24, 24, 27, 0.9); }
  .lb-header {
    display: flex;
    gap: 1rem;
    align-items: flex-start;
    justify-content: space-between;
    padding: 0.75rem 1rem;
  }
  .lb-section {
    font-size: 0.78rem;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: #a1a1aa;
  }
  .lb-title { font-size: 1.05rem; font-weight: 700; margin-top: 0.1rem; }
  .lb-desc { font-size: 0.88rem; color: #d4d4d8; margin-top: 0.25rem; max-width: 75ch; }
  .lb-controls { display: flex; gap: 0.4rem; align-items: center; flex-shrink: 0; }
  .lb-counter {
    font-variant-numeric: tabular-nums;
    color: #a1a1aa;
    font-size: 0.9rem;
    margin-right: 0.35rem;
  }
  .lb-controls button {
    background: #27272a;
    color: #fafafa;
    border: 1px solid #3f3f46;
    border-radius: 0.375rem;
    width: 2.1rem;
    height: 2.1rem;
    font-size: 1.05rem;
    line-height: 1;
    cursor: pointer;
  }
  .lb-controls button:hover { background: #3f3f46; }
  .lb-body {
    overflow: auto;
    background: #09090b;
    cursor: pointer;
  }
  /* Classic (non-overlay) scrollbar so it is visible immediately whenever
     the screenshot continues below the fold — overlay scrollbars only
     appear once the user already scrolls. ::-webkit-scrollbar is the only
     way to force an always-visible bar on macOS (Chrome + Safari), and
     since Chrome 121 it is IGNORED when the standard scrollbar-color
     property is also set — so the standard properties are scoped to
     engines without ::-webkit-scrollbar support (Firefox), where they at
     least tint the native bar. */
  .lb-body::-webkit-scrollbar { width: 12px; }
  .lb-body::-webkit-scrollbar-track { background: #27272a; }
  .lb-body::-webkit-scrollbar-thumb {
    background: #71717a;
    border-radius: 6px;
    border: 2px solid #27272a;
  }
  .lb-body::-webkit-scrollbar-thumb:hover { background: #a1a1aa; }
  @supports not selector(::-webkit-scrollbar) {
    .lb-body {
      scrollbar-width: auto;
      scrollbar-color: #71717a #27272a;
    }
  }
  .lb-body img { display: block; width: 100%; height: auto; }
  ${viewportCss}
</style>
</head>
<body data-viewport="${escapeHtml(defaultViewport)}">
  <header>
    <h1>${escapeHtml(pageTitle)}</h1>
    <p>${texts.generatedLine(escapeHtml(generatedDate), commitLink)}</p>
  </header>
  <div class="toolbar">
    <div class="viewports">
      ${viewportToggle}
    </div>
    <nav>
      ${nav}
    </nav>
  </div>
  <main>
    ${sections}
  </main>
  <dialog id="lightbox" aria-label="${escapeHtml(texts.lightboxLabel)}">
    <div class="lb-header">
      <div>
        <p class="lb-section"></p>
        <p class="lb-title"></p>
        <p class="lb-desc"></p>
      </div>
      <div class="lb-controls">
        <span class="lb-counter"></span>
        <button type="button" class="lb-prev" aria-label="${escapeHtml(texts.prev)}">&#8249;</button>
        <button type="button" class="lb-next" aria-label="${escapeHtml(texts.next)}">&#8250;</button>
        <button type="button" class="lb-close" aria-label="${escapeHtml(texts.close)}">&#215;</button>
      </div>
    </div>
    <div class="lb-body"><img alt="" /></div>
  </dialog>
  <script id="gallery-data" type="application/json">${galleryDataJson}</script>
  <script>
    document.querySelectorAll('input[name="viewport"]').forEach((input) => {
      input.addEventListener("change", () => {
        document.body.dataset.viewport = input.value;
      });
    });

    // Native <dialog> + showModal(): focus trap, Escape handling and focus
    // restore to the invoking element all come for free.
    const galleryStates = JSON.parse(
      document.getElementById("gallery-data").textContent,
    );
    const lightbox = document.getElementById("lightbox");
    const lightboxBody = lightbox.querySelector(".lb-body");
    const lightboxImg = lightboxBody.querySelector("img");
    const sectionEl = lightbox.querySelector(".lb-section");
    const titleEl = lightbox.querySelector(".lb-title");
    const descEl = lightbox.querySelector(".lb-desc");
    const counterEl = lightbox.querySelector(".lb-counter");
    let current = -1;

    function showState(index) {
      current = (index + galleryStates.length) % galleryStates.length;
      const state = galleryStates[current];
      const viewport = document.body.dataset.viewport;
      const src = state.images[viewport] ?? Object.values(state.images)[0];
      lightboxImg.src = src;
      lightboxImg.alt = state.title;
      sectionEl.textContent = state.section;
      titleEl.textContent = state.title;
      descEl.textContent = state.description;
      descEl.hidden = !state.description;
      counterEl.textContent = current + 1 + " / " + galleryStates.length;
      if (!lightbox.open) lightbox.showModal();
      lightboxBody.scrollTop = 0;
    }

    document.querySelectorAll("a.shot").forEach((link) => {
      link.addEventListener("click", (event) => {
        event.preventDefault();
        showState(Number(link.dataset.index));
      });
    });
    lightbox.querySelector(".lb-prev").addEventListener("click", () => {
      showState(current - 1);
    });
    lightbox.querySelector(".lb-next").addEventListener("click", () => {
      showState(current + 1);
    });
    lightbox.querySelector(".lb-close").addEventListener("click", () => {
      lightbox.close();
    });
    lightboxBody.addEventListener("click", () => showState(current + 1));
    lightbox.addEventListener("click", (event) => {
      if (event.target === lightbox) lightbox.close();
    });
    document.addEventListener("keydown", (event) => {
      if (!lightbox.open) return;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        showState(current - 1);
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        showState(current + 1);
      }
    });
    lightbox.addEventListener("close", () => {
      lightboxImg.removeAttribute("src");
    });
  </script>
</body>
</html>
`;
}
