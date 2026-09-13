import { expect, test } from '@playwright/test';

test('keeps page-link arrowheads outside expanded target cards as the map changes', async ({
  page,
}, testInfo) => {
  await page.goto('/?theme=signal');
  const target = page.getByRole('button', {
    name: 'Doména journal.example',
    exact: true,
  });
  await target.dblclick();
  await expect(page.locator('.page-node')).toHaveCount(6);

  async function expectExposedArrowheads() {
    const results = await page.locator('.page-edge').evaluateAll((edges) => {
      const cards = new Map(
        Array.from(document.querySelectorAll('.page-node')).map((node) => [
          node.getAttribute('aria-label')!.replace('Stránka ', ''),
          node.querySelector('rect')!,
        ]),
      );
      return edges.flatMap((edge) => {
        const targetName = edge.getAttribute('aria-label')!.split(' → ')[1];
        const card = cards.get(targetName);
        if (!card) return [];
        const bounds = card.getBBox();
        const path = edge.querySelector<SVGPathElement>('path[marker-end]')!;
        const length = path.getTotalLength();
        const tip = path.getPointAtLength(length);
        const before = path.getPointAtLength(Math.max(0, length - 0.1));
        const angle = Math.atan2(tip.y - before.y, tip.x - before.x);
        const markerId = path.getAttribute('marker-end')!.slice(5, -1);
        const marker = document.querySelector<SVGMarkerElement>(
          `marker#${CSS.escape(markerId)}`,
        )!;
        const head = marker.querySelector<SVGPathElement>('path')!;
        const headBounds = head.getBBox();
        const outline =
          Number.parseFloat(getComputedStyle(head).strokeWidth) / 2;
        const headLength = head.getTotalLength();
        // Sample the actual outline at sub-pixel intervals in marker coordinates.
        const samples = Math.ceil(headLength / 0.5);
        const covered = Array.from({ length: samples + 1 }, (_, index) => {
          const point = head.getPointAtLength((index / samples) * headLength);
          const x = point.x - marker.refX.baseVal.value;
          const y = point.y - marker.refY.baseVal.value;
          const px = tip.x + x * Math.cos(angle) - y * Math.sin(angle);
          const py = tip.y + x * Math.sin(angle) + y * Math.cos(angle);
          return (
            px >= bounds.x - outline &&
            px <= bounds.x + bounds.width + outline &&
            py >= bounds.y - outline &&
            py <= bounds.y + bounds.height + outline
          );
        }).some(Boolean);
        const distance = Math.hypot(
          Math.max(bounds.x - tip.x, 0, tip.x - bounds.x - bounds.width),
          Math.max(bounds.y - tip.y, 0, tip.y - bounds.y - bounds.height),
        );
        return [
          {
            targetName,
            covered,
            distance,
            outline,
            headExtent: Math.hypot(headBounds.width, headBounds.height),
            // The coordinate comparison requires unscaled user-space markers.
            unscaled:
              marker.getAttribute('markerUnits') === 'userSpaceOnUse' &&
              marker.markerWidth.baseVal.value ===
                marker.viewBox.baseVal.width &&
              marker.markerHeight.baseVal.value ===
                marker.viewBox.baseVal.height,
          },
        ];
      });
    });
    expect(results.length).toBeGreaterThan(0);
    for (const result of results) {
      expect(result.covered, result.targetName).toBe(false);
      expect(result.unscaled, result.targetName).toBe(true);
      expect(result.distance, result.targetName).toBeGreaterThan(
        result.outline,
      );
      // Keep the direction cue adjacent to the card without coupling to clipping padding.
      expect(result.distance, result.targetName).toBeLessThan(
        result.headExtent,
      );
    }
  }

  await expectExposedArrowheads();
  await page
    .getByRole('button', { name: 'Doména atlas.example', exact: true })
    .dblclick();
  await expect(page.locator('.page-node')).toHaveCount(12);
  await expectExposedArrowheads();
  await target.focus();
  await target.press('Shift+ArrowRight');
  await target.press('Shift+ArrowDown');
  await page
    .getByRole('button', { name: 'Přiblížit mapu', exact: true })
    .click();
  await expectExposedArrowheads();
  await page
    .getByRole('button', { name: 'Noční režim', pressed: false })
    .click();
  const link = page
    .locator('[data-connection="atlas:journal"] .page-edge')
    .first();
  await link.focus();
  await link.press('Enter');
  await expect(link.locator('path[marker-end]')).toHaveAttribute(
    'stroke-width',
    '2.8',
  );
  await expectExposedArrowheads();
  await page.screenshot({
    path: testInfo.outputPath('expanded-arrowheads.png'),
    fullPage: true,
  });
});
