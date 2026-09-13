import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';

export async function expectSiteSpacing(page: Page, framed = true) {
  const nodes = page.locator('.site-node');
  const boxes = await nodes.evaluateAll((elements) =>
    elements.map((element) => {
      const box = (element as SVGGElement).getBBox();
      return {
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
        name: element
          .querySelector('[data-drag-site]')
          ?.getAttribute('aria-label'),
      };
    }),
  );
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      const gap = Math.max(
        b.x - a.x - a.width,
        a.x - b.x - b.width,
        b.y - a.y - a.height,
        a.y - b.y - b.height,
      );
      expect(
        gap,
        `${a.name} and ${b.name} need room for their labels`,
      ).toBeGreaterThanOrEqual(31);
    }
  }
  if (!framed) return;
  const frame = (await page
    .getByLabel('Interaktivní mapa odkazů mezi weby')
    .boundingBox())!;
  const controls = (await page.locator('.map-bottom').boundingBox())!;
  const caption = (await page.locator('.map-caption').boundingBox())!;
  expect(frame.y).toBeGreaterThan(caption.y + caption.height);
  expect(frame.y + frame.height).toBeLessThan(controls.y);
  for (const node of await nodes.all()) {
    const box = (await node.boundingBox())!;
    expect(box.x).toBeGreaterThan(frame.x);
    expect(box.y).toBeGreaterThan(frame.y);
    expect(box.x + box.width).toBeLessThan(frame.x + frame.width);
    expect(box.y + box.height).toBeLessThan(frame.y + frame.height);
  }
}
