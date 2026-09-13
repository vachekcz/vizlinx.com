import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { expectSiteSpacing } from './graph-spacing';

async function domainCircles(page: Page) {
  return page.locator('[data-drag-site]').evaluateAll((domains) =>
    Object.fromEntries(
      domains.map((domain) => {
        const circle = domain.querySelector('circle')!;
        return [
          domain.getAttribute('data-drag-site')!,
          {
            x: Number(circle.getAttribute('cx')),
            y: Number(circle.getAttribute('cy')),
            radius: Number(circle.getAttribute('r')),
          },
        ];
      }),
    ),
  );
}

function expectSameCenter(
  actual: { x: number; y: number },
  expected: { x: number; y: number },
) {
  expect(actual.x).toBeCloseTo(expected.x, 5);
  expect(actual.y).toBeCloseTo(expected.y, 5);
}

test('expands a domain in place and makes room for neighbouring domains and labels', async ({
  page,
}, testInfo) => {
  await page.goto('/');
  const before = await domainCircles(page);
  await page.getByLabel('Interaktivní mapa odkazů mezi weby').screenshot({
    path: testInfo.outputPath('before-expansion.png'),
  });
  await page
    .getByRole('button', { name: 'Doména index.example', exact: true })
    .dblclick();
  await expect(
    page.getByRole('button', { name: /^Stránka index.example/ }),
  ).toHaveCount(20);
  const after = await domainCircles(page);
  expectSameCenter(after.index, before.index);
  await expectSiteSpacing(page);
  expect(after.index.radius).toBeGreaterThan(before.index.radius);
  expect(
    Math.hypot(after.atlas.x - before.atlas.x, after.atlas.y - before.atlas.y),
  ).toBeGreaterThan(0);
  const circles = Object.entries(after);
  for (let i = 0; i < circles.length; i += 1) {
    for (let j = i + 1; j < circles.length; j += 1) {
      const [firstId, first] = circles[i];
      const [secondId, second] = circles[j];
      expect(
        Math.hypot(first.x - second.x, first.y - second.y),
        `${firstId} and ${secondId} should not overlap`,
      ).toBeGreaterThanOrEqual(first.radius + second.radius - 0.1);
    }
  }
  await page.getByLabel('Interaktivní mapa odkazů mezi weby').screenshot({
    path: testInfo.outputPath('after-expansion.png'),
  });
});

test('keeps an isolated distant domain fixed while expansion moves nearby domains', async ({
  page,
}) => {
  await page.goto('/');
  const distant = page.getByRole('button', {
    name: 'Doména journal.example',
    exact: true,
  });
  await distant.focus();
  // Place this domain outside the chain of neighbours displaced by expansion.
  for (let step = 0; step < 20; step++) await distant.press('Shift+ArrowLeft');
  await page
    .getByRole('button', { name: 'Doména index.example', exact: true })
    .press('Enter');
  const before = await domainCircles(page);
  await page
    .getByRole('complementary', { name: 'Detail výběru' })
    .getByRole('button', { name: 'Prozkoumat 20 stránek' })
    .click();
  await expect(
    page.getByRole('button', { name: /^Stránka index.example/ }),
  ).toHaveCount(20);
  const after = await domainCircles(page);
  expectSameCenter(after.journal, before.journal);
  expectSameCenter(after.index, before.index);
  expect(
    Math.hypot(after.atlas.x - before.atlas.x, after.atlas.y - before.atlas.y),
  ).toBeGreaterThan(0);
  await expectSiteSpacing(page);
});

test('retains a dragged domain position when expanding and collapsing through the inspector', async ({
  page,
}, testInfo) => {
  await page.goto('/');
  await page.getByLabel('Další odkazované weby').check();
  const domain = page.getByRole('button', {
    name: 'Doména index.example',
    exact: true,
  });
  await domain.scrollIntoViewIfNeeded();
  const initial = (await domainCircles(page)).index;
  const box = (await domain.locator('circle').boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 25, y - 20, { steps: 5 });
  await page.mouse.up();
  const moved = (await domainCircles(page)).index;
  expect(Math.hypot(moved.x - initial.x, moved.y - initial.y)).toBeGreaterThan(
    10,
  );
  await domain.click();
  expectSameCenter((await domainCircles(page)).index, moved);
  const inspector = page.getByRole('complementary', { name: 'Detail výběru' });
  await page.getByLabel('Interaktivní mapa odkazů mezi weby').screenshot({
    path: testInfo.outputPath('dragged-before-expansion.png'),
  });
  expectSameCenter((await domainCircles(page)).index, moved);
  for (let cycle = 0; cycle < 2; cycle += 1) {
    await inspector
      .getByRole('button', { name: 'Prozkoumat 20 stránek' })
      .click();
    await expect(
      page.getByRole('button', { name: /^Stránka index.example/ }),
    ).toHaveCount(20);
    expectSameCenter((await domainCircles(page)).index, moved);
    if (cycle === 0) {
      await page.getByLabel('Interaktivní mapa odkazů mezi weby').screenshot({
        path: testInfo.outputPath('dragged-after-expansion.png'),
      });
    }
    await inspector.getByRole('button', { name: 'Sbalit stránky' }).click();
    await expect(
      page.getByRole('button', { name: /^Stránka index.example/ }),
    ).toHaveCount(0);
    expectSameCenter((await domainCircles(page)).index, moved);
    const frame = (await page
      .getByLabel('Interaktivní mapa odkazů mezi weby')
      .boundingBox())!;
    for (const element of await page
      .locator('[data-drag-site] circle, .cluster-category')
      .all()) {
      const bounds = (await element.boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(frame.x - 1);
      expect(bounds.y).toBeGreaterThanOrEqual(frame.y - 1);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(
        frame.x + frame.width + 1,
      );
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(
        frame.y + frame.height + 1,
      );
    }
  }
});

test('opens the twenty-page shortcut without resetting zoom, pan or the domain position', async ({
  page,
}) => {
  await page.goto('/');
  const camera = page.getByTestId('graph-camera');
  const initialCamera = await camera.getAttribute('transform');
  await page
    .getByRole('button', { name: 'Přiblížit mapu', exact: true })
    .click();
  const zoomedCamera = await camera.getAttribute('transform');
  const graph = page.getByLabel('Interaktivní mapa odkazů mezi weby');
  await graph.scrollIntoViewIfNeeded();
  const box = (await graph.boundingBox())!;
  await page.mouse.move(box.x + 10, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + 45, box.y + 35, { steps: 5 });
  await page.mouse.up();
  const beforeCamera = await camera.getAttribute('transform');
  expect(beforeCamera).not.toBe(initialCamera);
  expect(beforeCamera).not.toBe(zoomedCamera);
  const beforePosition = (await domainCircles(page)).index;
  const beforeZoom = await page.getByLabel('Přiblížení mapy').textContent();
  await page
    .getByRole('button', { name: 'Ukázka: 20 stránek', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: /^Stránka index.example/ }),
  ).toHaveCount(20);
  expectSameCenter((await domainCircles(page)).index, beforePosition);
  await expect(camera).toHaveAttribute('transform', beforeCamera!);
  await expect(page.getByLabel('Přiblížení mapy')).toHaveText(beforeZoom!);
});
