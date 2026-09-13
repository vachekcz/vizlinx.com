import fs from 'node:fs/promises';
import path from 'node:path';
import type { Page, TestInfo } from '@playwright/test';

export const SCREENSHOTS_ROOT = 'screenshots-output';

export type CaptureCaption = {
  /** Short human title shown in the gallery, e.g. "Krok 1: Biometrika". */
  title: string;
  /** One or two sentences describing the captured state (user-facing). */
  description: string;
};

const FOLD_MARKER_ID = '__gallery-fold-marker';

// Keep the language set in sync with GALLERY_TEXTS in
// scripts/screenshot-gallery/html.ts — both read the same GALLERY_LANG.
const FOLD_LABELS: Record<string, string> = {
  cs: '↑ viditelné bez scrollu',
  en: '↑ visible without scrolling',
};
const foldLabel =
  FOLD_LABELS[process.env.GALLERY_LANG ?? 'cs'] ?? FOLD_LABELS.cs;

/**
 * Draws a dashed "fold" line into the live page at exactly one viewport
 * height, so the full-page screenshot shows what is visible without
 * scrolling. Skipped when the page fits in the viewport. Returns a cleanup
 * that removes the marker again.
 */
async function addFoldMarker(page: Page): Promise<() => Promise<void>> {
  const viewportHeight = page.viewportSize()?.height;
  if (viewportHeight) {
    await page.evaluate(
      ({ id, top, label }) => {
        if (document.documentElement.scrollHeight <= top) return;
        const marker = document.createElement('div');
        marker.id = id;
        marker.style.cssText =
          'position:absolute;left:0;right:0;pointer-events:none;z-index:2147483647;' +
          `top:${top}px;border-top:2px dashed rgba(220,38,38,0.75);`;
        const caption = document.createElement('span');
        caption.textContent = label;
        caption.style.cssText =
          'position:absolute;right:8px;top:3px;font:600 11px system-ui,sans-serif;' +
          'color:#dc2626;background:rgba(255,255,255,0.92);padding:1px 6px;' +
          'border-radius:4px;';
        marker.appendChild(caption);
        document.body.appendChild(marker);
      },
      { id: FOLD_MARKER_ID, top: viewportHeight, label: foldLabel },
    );
  }
  return async () => {
    await page.evaluate(
      (id) => document.getElementById(id)?.remove(),
      FOLD_MARKER_ID,
    );
  };
}

/**
 * Captures a named full-page screenshot for the gallery.
 * `slug` follows the "NN-section/NN-state" convention, e.g. "01-onboarding/02-goal";
 * the current project name (desktop/mobile) becomes the top-level folder.
 * The optional caption is written as a JSON sidecar next to the PNG and becomes
 * the state's title/description in the published gallery.
 */
export async function capture(
  page: Page,
  testInfo: TestInfo,
  slug: string,
  caption?: CaptureCaption,
): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
  await page.evaluate(() => document.fonts.ready);
  const basePath = path.join(SCREENSHOTS_ROOT, testInfo.project.name, slug);
  const removeFoldMarker = await addFoldMarker(page);
  try {
    await page.screenshot({
      path: `${basePath}.png`,
      fullPage: true,
      animations: 'disabled',
    });
  } finally {
    await removeFoldMarker();
  }
  if (caption) {
    await fs.writeFile(`${basePath}.json`, JSON.stringify(caption, null, 2));
  }
}
