import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test('loads all five mockups and opens a matching twenty-page demo', async ({
  page,
}, testInfo) => {
  await page.goto('/palettes/');
  await expect(page.locator('article')).toHaveCount(5);
  await expect(page.locator('img')).toHaveCount(5);
  await expect
    .poll(() =>
      page
        .locator('img')
        .evaluateAll((images) =>
          images.every(
            (image) =>
              image instanceof HTMLImageElement &&
              image.complete &&
              image.naturalWidth > 0,
          ),
        ),
    )
    .toBe(true);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath('palettes.png'),
    fullPage: true,
  });
  await page
    .locator('article')
    .filter({ hasText: 'Midnight' })
    .locator('a[href="/?theme=midnight&detail=index"]')
    .click();
  await expect(page.locator('.app-shell')).toHaveAttribute(
    'data-theme',
    'midnight',
  );
  await expect(
    page.getByRole('button', { name: /^Stránka index.example/ }),
  ).toHaveCount(20);
});

test('renders the map without external requests, errors or horizontal overflow', async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  const external: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (
      new URL(request.url()).origin !==
      new URL(testInfo.project.use.baseURL!).origin
    )
      external.push(request.url());
  });
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'Mapa souvislostí.' }),
  ).toBeVisible();
  await expect(page.getByTestId('link-count')).toHaveText('51');
  await expect(page.getByRole('button', { name: /^Doména / })).toHaveCount(5);
  await expect(
    page.getByRole('region', { name: 'Varianty zobrazení vazeb' }),
  ).toHaveCount(0);
  await expect(
    page.locator('[data-connection="atlas:journal"] [data-fine-style="silk"]'),
  ).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
  expect(external).toEqual([]);
  await page.screenshot({
    path: testInfo.outputPath('demo.png'),
    fullPage: true,
  });
});

test('explores a directed connection down to source and target pages', async ({
  page,
}) => {
  await page.goto('/');
  await page
    .getByRole('button', {
      name: 'Propojení atlas.example → journal.example, 5 vazeb',
      exact: true,
    })
    .locator('rect')
    .click();
  const detail = page.getByRole('complementary', { name: 'Detail výběru' });
  await expect(detail.getByText('5 unikátních dvojic stránek')).toBeVisible();
  await detail.getByRole('button', { name: 'Rozbalit obě domény' }).click();
  await expect(
    page.getByRole('button', { name: /^Stránka atlas.example/ }),
  ).toHaveCount(6);
  await expect(
    page.getByRole('button', { name: /^Stránka journal.example/ }),
  ).toHaveCount(6);
  await detail
    .getByRole('button', {
      name: 'atlas.example/ → journal.example/design',
      exact: true,
    })
    .click();
  await expect(
    detail.getByText('https://atlas.example/', { exact: true }),
  ).toBeVisible();
  await expect(
    detail.getByText('https://journal.example/design', { exact: true }),
  ).toBeVisible();
  await expect(detail.getByText('Prozkoumaný', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Přehled', exact: true }).click();
  await expect(page.getByRole('button', { name: /^Stránka / })).toHaveCount(0);
});

test('zooms, pans, resets and opens a page with the keyboard', async ({
  page,
}, testInfo) => {
  await page.goto('/');
  await page
    .getByRole('button', { name: 'Přiblížit mapu', exact: true })
    .click({ clickCount: 3 });
  await expect(page.getByLabel('Přiblížení mapy')).toHaveText('173 %');
  await expect(page.getByRole('button', { name: /^Stránka / })).toHaveCount(0);
  await page.getByRole('button', { name: 'Prozkoumat 6 stránek' }).click();
  await expect(page.getByRole('button', { name: /^Stránka / })).toHaveCount(6);
  await page
    .getByRole('button', { name: 'Oddálit mapu', exact: true })
    .click({ clickCount: 3 });
  await expect(page.getByLabel('Přiblížení mapy')).toHaveText('100 %');
  await expect(page.getByRole('button', { name: /^Stránka / })).toHaveCount(6);
  await page.getByRole('button', { name: 'Zobrazit celou mapu' }).click();
  await expect(page.getByLabel('Přiblížení mapy')).toHaveText('100 %');
  await expect(page.getByRole('button', { name: /^Stránka / })).toHaveCount(0);
  if (testInfo.project.name === 'desktop') {
    const graph = page.getByLabel('Interaktivní mapa odkazů mezi weby');
    const box = (await graph.boundingBox())!;
    const camera = page.getByTestId('graph-camera');
    const before = await camera.getAttribute('transform');
    await page.mouse.move(box.x + 40, box.y + 70);
    await page.mouse.down();
    await page.mouse.move(box.x + 130, box.y + 120);
    await page.mouse.up();
    await expect(camera).not.toHaveAttribute('transform', before!);
    await page.getByRole('button', { name: 'Zobrazit celou mapu' }).click();
  }
  await page.getByRole('button', { name: 'Prozkoumat 6 stránek' }).click();
  const pageNode = page.getByRole('button', {
    name: 'Stránka atlas.example/projects',
    exact: true,
  });
  await pageNode.focus();
  await pageNode.press('Enter');
  await expect(
    page
      .getByRole('complementary', { name: 'Detail výběru' })
      .getByRole('heading', { name: 'Naše projekty' }),
  ).toBeVisible();
});

test('keeps domain expansion unchanged when zooming with the wheel', async ({
  page,
}) => {
  await page.goto('/');
  const graph = page.getByLabel('Interaktivní mapa odkazů mezi weby');
  const pageNodes = page.getByRole('button', { name: /^Stránka / });
  await page.locator('[data-drag-site="atlas"] circle').hover();
  // Mobile emulation scales wheel deltas; still cross the full zoom range.
  await page.mouse.wheel(0, -10000);
  await expect(page.getByLabel('Přiblížení mapy')).toHaveText('280 %');
  await expect(pageNodes).toHaveCount(0);
  await expect(page.locator('.site-node.is-expanded')).toHaveCount(0);

  await page.getByRole('button', { name: 'Prozkoumat 6 stránek' }).click();
  await expect(pageNodes).toHaveCount(6);
  await graph.hover();
  await page.mouse.wheel(0, 10000);
  await expect(page.getByLabel('Přiblížení mapy')).toHaveText('60 %');
  await expect(pageNodes).toHaveCount(6);
  await page.mouse.wheel(0, -10000);
  await expect(page.getByLabel('Přiblížení mapy')).toHaveText('280 %');
  await expect(pageNodes).toHaveCount(6);
  await expect(page.locator('.site-node.is-expanded')).toHaveCount(1);
});

test('distinguishes unscanned external targets and keeps table and export consistent', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByLabel('Další odkazované weby').check();
  await expect(page.getByTestId('link-count')).toHaveText('53');
  await page
    .getByRole('button', { name: 'Doména archive.example', exact: true })
    .click();
  await expect(
    page
      .getByRole('complementary', { name: 'Detail výběru' })
      .getByText('Neprozkoumáno', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Zobrazit tabulku' }).click();
  await page
    .getByRole('textbox', { name: 'Hledat odkazy' })
    .fill('archive.example');
  await expect(page.locator('tbody tr')).toHaveCount(2);
  const downloadPromise = page.waitForEvent('download');
  await page
    .getByRole('button', { name: 'Exportovat zobrazené odkazy do CSV' })
    .click();
  const download = await downloadPromise;
  const contents = await readFile((await download.path())!, 'utf8');
  expect(contents.trim().split('\r\n')).toHaveLength(3);
  expect(contents).toContain('https://archive.example/resources');
  await page.getByRole('button', { name: 'nofollow', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Žádné odpovídající odkazy' }),
  ).toBeVisible();
});

test('simulates progress, per-site pause and a global pause without losing results', async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name === 'mobile',
    'Per-site controls are in the desktop sidebar.',
  );
  await page.clock.install();
  await page.goto('/');
  await page.getByRole('button', { name: 'Přehrát demo', exact: true }).click();
  await expect(page.getByTestId('link-count')).toHaveText('0');
  await page
    .getByRole('button', { name: 'Pozastavit atlas.example', exact: true })
    .click();
  await page.clock.fastForward(3000);
  await expect(page.getByTestId('link-count')).toHaveText('4');
  await expect(
    page.getByRole('button', { name: /^Propojení atlas.example →/ }),
  ).toHaveCount(0);
  await page
    .getByRole('button', { name: 'Pozastavit demo', exact: true })
    .click();
  await page.clock.fastForward(6000);
  await expect(page.getByTestId('link-count')).toHaveText('4');
  await page
    .getByRole('button', { name: 'Pokračovat atlas.example', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Pokračovat v demu', exact: true })
    .click();
  await page.clock.fastForward(3000);
  await expect(page.getByTestId('link-count')).toHaveText('9');
});

test('opens and dismisses the help dialog', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Jak demo funguje' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Jdu objevovat' }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
});

test('fits all twenty index pages inside their cluster and explores the last page', async ({
  page,
}, testInfo) => {
  await page.goto('/?detail=index');
  const nodes = page.getByRole('button', { name: /^Stránka index.example/ });
  await expect(nodes).toHaveCount(20);
  const bounds = await nodes.locator('rect').evaluateAll((rects) =>
    rects.map((rect) => {
      const box = rect.getBoundingClientRect();
      return { x: box.x, y: box.y, right: box.right, bottom: box.bottom };
    }),
  );
  const viewport = (await page
    .getByLabel('Interaktivní mapa odkazů mezi weby')
    .boundingBox())!;
  for (const [index, box] of bounds.entries()) {
    expect(box.x).toBeGreaterThanOrEqual(viewport.x);
    expect(box.right).toBeLessThanOrEqual(viewport.x + viewport.width);
    expect(box.y).toBeGreaterThanOrEqual(viewport.y);
    expect(box.bottom).toBeLessThanOrEqual(viewport.y + viewport.height);
    for (const other of bounds.slice(index + 1)) {
      expect(
        box.right <= other.x ||
          other.right <= box.x ||
          box.bottom <= other.y ||
          other.bottom <= box.y,
      ).toBe(true);
    }
  }
  expect(
    await page.evaluate(() => {
      const cluster = document.querySelector<SVGCircleElement>(
        '.cluster-fill[data-site="index"]',
      )!;
      const { x, y } = {
        x: cluster.cx.baseVal.value,
        y: cluster.cy.baseVal.value,
      };
      return [
        ...document.querySelectorAll<SVGRectElement>(
          '[aria-label^="Stránka index.example"] rect',
        ),
      ].every((rect) => {
        const box = rect.getBBox();
        return [
          [box.x, box.y],
          [box.x + box.width, box.y],
          [box.x, box.y + box.height],
          [box.x + box.width, box.y + box.height],
        ].every(
          ([px, py]) => Math.hypot(px - x, py - y) < cluster.r.baseVal.value,
        );
      });
    }),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath('twenty-pages.png'),
    fullPage: true,
  });
  await page
    .getByRole('button', { name: 'Stránka index.example/about', exact: true })
    .click();
  const detail = page.getByRole('complementary', { name: 'Detail výběru' });
  await expect(
    detail.getByRole('heading', { name: 'O Design Indexu' }),
  ).toBeVisible();
  await detail
    .getByRole('button', {
      name: 'index.example/about → collective.example/join',
      exact: true,
    })
    .click();
  await expect(
    detail.getByText('https://index.example/about', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Přehled', exact: true }).click();
  await expect(nodes).toHaveCount(0);
  await page
    .getByRole('button', { name: 'Ukázka: 20 stránek', exact: true })
    .click();
  await expect(nodes).toHaveCount(20);
});

test('switches day and night without losing the map and remembers the choice', async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/?detail=index');
  await expect(page.locator('.app-shell')).toHaveAttribute(
    'data-theme',
    'signal',
  );
  await page
    .getByRole('button', { name: 'Noční režim', pressed: false })
    .click();
  await expect(page.locator('.app-shell')).toHaveAttribute(
    'data-theme',
    'midnight',
  );
  await expect(page.locator('html')).toHaveCSS('color-scheme', 'dark');
  await expect(
    page.getByRole('button', { name: /^Stránka index.example/ }),
  ).toHaveCount(20);
  await expect(page.getByTestId('link-count')).toHaveText('51');
  await page.reload();
  await expect(page.locator('.app-shell')).toHaveAttribute(
    'data-theme',
    'midnight',
  );
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: testInfo.outputPath('midnight.png'),
    fullPage: true,
  });
  await page
    .getByRole('button', { name: 'Noční režim', pressed: true })
    .click();
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.reload();
  await expect(page.locator('.app-shell')).toHaveAttribute(
    'data-theme',
    'signal',
  );
  await expect(page.locator('html')).toHaveCSS('color-scheme', 'light');
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: testInfo.outputPath('signal.png'),
    fullPage: true,
  });
});

test('follows the system until a manual choice and lets shared links override it', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');
  await expect(page.locator('.app-shell')).toHaveAttribute(
    'data-theme',
    'midnight',
  );
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('.app-shell')).toHaveAttribute(
    'data-theme',
    'signal',
  );
  await page
    .getByRole('button', { name: 'Noční režim', pressed: false })
    .click();
  await page.goto('/?theme=signal&detail=index');
  await expect(page.locator('.app-shell')).toHaveAttribute(
    'data-theme',
    'signal',
  );
  await page
    .getByRole('button', { name: 'Noční režim', pressed: false })
    .click();
  await expect(page).toHaveURL(/\?detail=index$/);
  await page.reload();
  await expect(page.locator('.app-shell')).toHaveAttribute(
    'data-theme',
    'midnight',
  );
});

test('can toggle when browser storage is blocked', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
      get() {
        throw new DOMException('Storage unavailable', 'SecurityError');
      },
    });
  });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/?theme=invalid');
  await expect(page.locator('.app-shell')).toHaveAttribute(
    'data-theme',
    'signal',
  );
  await page
    .getByRole('button', { name: 'Noční režim', pressed: false })
    .click();
  await expect(page.locator('.app-shell')).toHaveAttribute(
    'data-theme',
    'midnight',
  );
});
