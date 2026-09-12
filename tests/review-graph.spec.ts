import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

async function expectArchiveInFrame(page: Page) {
  const graph = (await page
    .getByLabel('Interaktivní mapa odkazů mezi weby')
    .boundingBox())!;
  const elements = page.locator(
    '[data-drag-site="archive"] circle, .site-node:has([data-drag-site="archive"]) .cluster-category, [aria-label^="Stránka archive.example"] rect',
  );
  await expect(elements).toHaveCount(4);
  for (const element of await elements.all()) {
    const box = (await element.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(graph.x - 1);
    expect(box.y).toBeGreaterThanOrEqual(graph.y - 1);
    expect(box.x + box.width).toBeLessThanOrEqual(graph.x + graph.width + 1);
    expect(box.y + box.height).toBeLessThanOrEqual(graph.y + graph.height + 1);
  }
}

test('keeps positions and framing stable across automatic expansion and synchronizes the inspector', async ({
  page,
}) => {
  await page.goto('/');
  const inspector = page.getByRole('complementary', { name: 'Detail výběru' });
  await inspector.getByRole('button', { name: 'Prozkoumat 6 stránek' }).click();
  await inspector.getByRole('button', { name: 'Sbalit stránky' }).click();
  const domain = page.getByRole('button', {
    name: 'Doména atlas.example',
    exact: true,
  });
  await domain.focus();
  await domain.press('ArrowRight');
  const x = await domain.locator('circle').getAttribute('cx');
  const graph = page.getByLabel('Interaktivní mapa odkazů mezi weby');
  const frame = await graph.getAttribute('viewBox');
  await page
    .getByRole('button', { name: 'Přiblížit mapu', exact: true })
    .click({ clickCount: 3 });
  await expect(page.getByRole('button', { name: /^Stránka / })).toHaveCount(44);
  await expect(graph).toHaveAttribute('viewBox', frame!);
  await expect(domain.locator('circle')).toHaveAttribute('cx', x!);
  await expect(page.locator('.graph-area')).not.toHaveClass(/has-dense-site/);
  await inspector.getByRole('button', { name: 'Sbalit stránky' }).click();
  await expect(
    page.getByRole('button', { name: /^Stránka atlas.example/ }),
  ).toHaveCount(0);
  await expect(
    inspector.getByRole('button', { name: 'Prozkoumat 6 stránek' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: /^Stránka journal.example/ }),
  ).toHaveCount(6);
  await page.getByRole('button', { name: 'Zobrazit celou mapu' }).click();
  await page
    .getByRole('button', { name: 'Ukázka: 20 stránek', exact: true })
    .click();
  await expect(page.locator('.graph-area')).toHaveClass(/has-dense-site/);
  await expect(
    page.getByRole('button', { name: /^Stránka index.example/ }),
  ).toHaveCount(20);
});

test('frames the expanded external domain and its category in both layouts', async ({
  page,
}, testInfo) => {
  for (const path of ['/', '/?detail=index']) {
    await page.goto(path);
    await page.getByLabel('Další odkazované weby').check();
    await page
      .getByRole('button', { name: 'Doména archive.example', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Zobrazit známé cílové URL' })
      .click();
    await expectArchiveInFrame(page);
    const domain = page.getByRole('button', {
      name: 'Doména archive.example',
      exact: true,
    });
    await domain.focus();
    await domain.press('Shift+ArrowDown');
    await domain.press('Shift+ArrowRight');
    await expectArchiveInFrame(page);
    await page.screenshot({
      path: testInfo.outputPath(
        path === '/' ? 'archive.png' : 'archive-dense.png',
      ),
      fullPage: true,
    });
  }
});

test('keeps framing stable during a domain drag and fits the moved pages on release', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByLabel('Další odkazované weby').check();
  const domain = page.getByRole('button', {
    name: 'Doména archive.example',
    exact: true,
  });
  await domain.click();
  await page.getByRole('button', { name: 'Zobrazit známé cílové URL' }).click();
  await domain.scrollIntoViewIfNeeded();
  const graph = page.getByLabel('Interaktivní mapa odkazů mezi weby');
  const frame = await graph.getAttribute('viewBox');
  const circle = domain.locator('circle');
  const before = (await circle.boundingBox())!;
  const startX = before.x + before.width / 2;
  const startY = before.y + before.height * 0.2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 30, startY + 45, { steps: 5 });
  await expect(graph).toHaveAttribute('viewBox', frame!);
  const during = (await circle.boundingBox())!;
  expect(during.x - before.x).toBeCloseTo(30, 0);
  expect(during.y - before.y).toBeCloseTo(45, 0);
  await page.mouse.up();
  await expect(graph).not.toHaveAttribute('viewBox', frame!);
  await expectArchiveInFrame(page);
});

test('suppresses a zero-detail click following a drag and accepts the next click and keyboard activation', async ({
  page,
}) => {
  await page.goto('/');
  const journal = page.locator('[data-drag-site="journal"]');
  await journal.scrollIntoViewIfNeeded();
  const box = (await journal.locator('circle').boundingBox())!;
  await page.evaluate(() => {
    const journal = document.querySelector('[data-drag-site="journal"]')!;
    document.addEventListener(
      'click',
      (event) => {
        event.stopImmediatePropagation();
        journal.dispatchEvent(
          new MouseEvent('click', { bubbles: true, detail: 0 }),
        );
      },
      { capture: true, once: true },
    );
  });
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    box.x + box.width / 2 + 25,
    box.y + box.height / 2 + 20,
    { steps: 4 },
  );
  await page.mouse.up();
  const inspector = page.getByRole('complementary', { name: 'Detail výběru' });
  await expect(
    inspector.getByRole('heading', { name: 'atlas.example', exact: true }),
  ).toBeVisible();
  await journal.click();
  await expect(
    inspector.getByRole('heading', { name: 'journal.example', exact: true }),
  ).toBeVisible();
  const atlas = page.getByRole('button', {
    name: 'Doména atlas.example',
    exact: true,
  });
  await atlas.focus();
  await atlas.press('Enter');
  await expect(
    inspector.getByRole('heading', { name: 'atlas.example', exact: true }),
  ).toBeVisible();
});

test('animates simulation flow without changing Silk strands and respects reduced motion', async ({
  page,
}) => {
  await page.clock.install();
  await page.goto('/');
  await page.getByRole('button', { name: 'Přehrát demo', exact: true }).click();
  await page.clock.fastForward(3000);
  await expect(page.locator('.connection-flow').first()).toHaveCSS(
    'animation-name',
    'flow',
  );
  await expect(page.getByTestId('fine-strand').first()).toHaveAttribute(
    'stroke-width',
    '0.7',
  );
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.locator('.connection-flow').first()).toHaveCSS(
    'animation-name',
    'none',
  );
  await page
    .getByRole('button', { name: 'Pozastavit demo', exact: true })
    .click();
  await expect(page.locator('.connection-flow')).toHaveCount(0);
});
