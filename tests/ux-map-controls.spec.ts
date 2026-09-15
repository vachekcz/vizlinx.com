import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

async function domainGeometry(page: Page) {
  await expect(page.locator('[data-drag-site]').first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
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

async function waitForInitialFraming(page: Page) {
  await expect(
    page.getByLabel('Interaktivní mapa odkazů mezi weby'),
  ).toHaveAttribute('data-framing-ready', 'true');
}

async function panMap(page: Page) {
  const graph = page.getByLabel('Interaktivní mapa odkazů mezi weby');
  await graph.scrollIntoViewIfNeeded();
  const box = (await graph.boundingBox())!;
  const camera = page.getByTestId('graph-camera');
  const before = await camera.getAttribute('transform');
  await page.mouse.move(box.x + 8, box.y + 8);
  await page.mouse.down();
  await page.mouse.move(box.x + 48, box.y + 28, { steps: 5 });
  await page.mouse.up();
  await expect(camera).not.toHaveAttribute('transform', before!);
}

async function openExpandedAtlasLink(page: Page) {
  await page
    .getByRole('button', { name: 'Doména atlas.example', exact: true })
    .press('Enter');
  const detail = page.getByRole('complementary', { name: 'Detail výběru' });
  await detail
    .getByRole('button', { name: 'Zobrazit stránky v mapě', exact: true })
    .click();
  await detail
    .getByRole('button', {
      name: '5 odkazů ven: z atlas.example na journal.example',
      exact: true,
    })
    .click();
  await detail.locator('.ux-link-card').last().click();
  await expect(
    detail.getByRole('heading', { name: 'Odkud a kam', exact: true }),
  ).toBeVisible();
}

test('fits the current drawing without losing moved domains, expanded pages or the detail path', async ({
  page,
}, testInfo) => {
  await page.goto('/ux/2');
  await page.evaluate(() => document.fonts.ready);
  await waitForInitialFraming(page);
  const initial = await domainGeometry(page);
  const atlas = page.getByRole('button', {
    name: 'Doména atlas.example',
    exact: true,
  });
  for (let step = 0; step < 8; step++) await atlas.press('Shift+ArrowRight');
  expect((await domainGeometry(page)).atlas.x).toBeGreaterThan(
    initial.atlas.x + 300,
  );
  await page
    .getByRole('button', { name: 'Přiblížit mapu', exact: true })
    .click();
  await panMap(page);
  await openExpandedAtlasLink(page);
  const geometry = await domainGeometry(page);
  const camera = page.getByTestId('graph-camera');
  const beforeCamera = await camera.getAttribute('transform');
  const selectedEdge = page
    .getByRole('button', {
      name: 'Odkaz atlas.example/partners → journal.example/about',
      exact: true,
    })
    .locator(':scope > path[marker-end]');
  await expect(selectedEdge).toHaveAttribute('opacity', '1');
  await expect(
    page.locator('.page-edge > path[marker-end][opacity="1"]'),
  ).toHaveCount(1);
  await page
    .getByRole('button', { name: 'Zobrazit celou mapu', exact: true })
    .click();
  if (testInfo.project.name === 'mobile') {
    await expect(page.locator('.ux-floating-detail')).toHaveAttribute(
      'data-sheet-position',
      'collapsed',
    );
  }
  await expect(camera).not.toHaveAttribute('transform', beforeCamera!);
  expect(await domainGeometry(page)).toEqual(geometry);
  await expect(
    page.getByRole('button', { name: /^Stránka atlas.example/ }),
  ).toHaveCount(6);
  await expect(selectedEdge).toHaveAttribute('opacity', '1');
  await expect(
    page.locator('.page-edge > path[marker-end][opacity="1"]'),
  ).toHaveCount(1);
  await expect(page.locator('.ux-scan-row.is-selected')).toContainText(
    'atlas.example',
  );
  const frame = (await page
    .getByLabel('Interaktivní mapa odkazů mezi weby')
    .boundingBox())!;
  const obstacles = await page
    .locator('[data-map-obstacle]')
    .evaluateAll((elements) =>
      elements
        .filter((element) => {
          const style = getComputedStyle(element);
          return (
            element.checkVisibility() &&
            style.display !== 'none' &&
            style.visibility !== 'hidden'
          );
        })
        .map((element) => {
          const { x, y, width, height } = element.getBoundingClientRect();
          return { x, y, width, height };
        })
        .filter(({ width, height }) => width > 0 && height > 0),
    );
  for (const node of await page.locator('.site-node').all()) {
    const bounds = (await node.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(frame.x + 30.5);
    expect(bounds.y).toBeGreaterThanOrEqual(frame.y + 30.5);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(
      frame.x + frame.width - 30.5,
    );
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(
      frame.y + frame.height - 30.5,
    );
    for (const obstacle of obstacles) {
      const clearance = Math.max(
        obstacle.x - (bounds.x + bounds.width),
        bounds.x - (obstacle.x + obstacle.width),
        obstacle.y - (bounds.y + bounds.height),
        bounds.y - (obstacle.y + obstacle.height),
      );
      expect(clearance).toBeGreaterThanOrEqual(22.5);
    }
  }
  if (testInfo.project.name === 'mobile') {
    await page
      .getByRole('button', { name: 'Otevřít detail', exact: true })
      .click();
  }
  const detail = page.getByRole('complementary', { name: 'Detail výběru' });
  await expect(
    detail.getByRole('heading', { name: 'Odkud a kam', exact: true }),
  ).toBeVisible();
  await detail.getByRole('button', { name: 'Zpět na seznam odkazů' }).click();
  await expect(detail.locator('.ux-link-card').last()).toBeFocused();
  await detail.getByRole('button', { name: 'Zpět na atlas.example' }).click();
  await expect(
    detail.getByRole('heading', { name: 'atlas.example', exact: true }),
  ).toBeVisible();
  await expect(
    detail.getByRole('button', { name: 'Sbalit stránky v mapě', exact: true }),
  ).toBeVisible();
});

test('restores the default layout, collapses pages and clears the detail selection', async ({
  page,
}) => {
  await page.goto('/ux/2');
  await page.evaluate(() => document.fonts.ready);
  await waitForInitialFraming(page);
  const initial = await domainGeometry(page);
  const initialZoom = await page.getByLabel('Přiblížení mapy').textContent();
  const atlas = page.getByRole('button', {
    name: 'Doména atlas.example',
    exact: true,
  });
  for (let step = 0; step < 5; step++) await atlas.press('Shift+ArrowRight');
  await page
    .getByRole('button', { name: 'Přiblížit mapu', exact: true })
    .click();
  await openExpandedAtlasLink(page);
  expect(await domainGeometry(page)).not.toEqual(initial);
  await page
    .getByRole('button', { name: 'Obnovit rozložení', exact: true })
    .click();
  await waitForInitialFraming(page);
  await expect(page.getByLabel('Přiblížení mapy')).toHaveText(initialZoom!);
  await expect(page.getByRole('button', { name: /^Stránka / })).toHaveCount(0);
  await expect(
    page.getByRole('complementary', { name: 'Detail výběru' }),
  ).toHaveCount(0);
  await expect(page.locator('.graph [aria-pressed="true"]')).toHaveCount(0);
  await expect(page.locator('.ux-scan-row.is-selected')).toHaveCount(0);
  expect(await domainGeometry(page)).toEqual(initial);
  await atlas.press('Enter');
  await expect(page.locator('.ux-detail-back')).toHaveCount(0);
});

test('offers one accessible set of controls with persistent zoom, wheel and pan on narrow screens', async ({
  page,
}, testInfo) => {
  if (testInfo.project.name === 'mobile') {
    await page.setViewportSize({ width: 320, height: 844 });
  }
  await page.goto('/ux/2');
  await page.evaluate(() => document.fonts.ready);
  await waitForInitialFraming(page);
  const controls = page.locator('.ux-map-controls');
  await expect(controls).toHaveCount(1);
  await expect(
    page.locator('[aria-label="Obnovit rozložení mapy"]'),
  ).toHaveCount(0);
  await expect(page.locator('[aria-label="Obnovit pohled"]')).toHaveCount(0);
  for (const label of [
    'Oddálit mapu',
    'Přiblížit mapu',
    'Zobrazit celou mapu',
    'Obnovit rozložení',
  ]) {
    const button = page.getByRole('button', { name: label, exact: true });
    await expect(button).toHaveCount(1);
    await button.click({ trial: true });
    const bounds = (await button.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(
      page.viewportSize()!.width,
    );
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(
      page.viewportSize()!.height,
    );
  }
  const geometry = await domainGeometry(page);
  const zoom = controls.getByLabel('Přiblížení mapy');
  const initialZoom = (await zoom.textContent())!;
  const initialZoomValue = Number.parseFloat(initialZoom);
  await controls
    .getByRole('button', { name: 'Přiblížit mapu', exact: true })
    .click();
  await expect
    .poll(async () => Number.parseFloat((await zoom.textContent())!))
    .toBeGreaterThan(initialZoomValue);
  await controls
    .getByRole('button', { name: 'Oddálit mapu', exact: true })
    .click();
  await expect(zoom).toHaveText(initialZoom);
  const graphBox = (await page
    .getByLabel('Interaktivní mapa odkazů mezi weby')
    .boundingBox())!;
  await page.mouse.move(graphBox.x + 8, graphBox.y + 8);
  await page.mouse.wheel(0, -180);
  await expect(zoom).not.toHaveText(initialZoom);
  const zoomAfterWheel = await zoom.textContent();
  await panMap(page);
  await expect(zoom).toHaveText(zoomAfterWheel!);
  expect(await domainGeometry(page)).toEqual(geometry);
  await page.keyboard.press('Tab');
  await controls
    .getByRole('button', { name: 'Přiblížit mapu', exact: true })
    .focus();
  await expect(page.getByRole('tooltip')).toHaveCount(1);
  for (const label of ['Zobrazit celou mapu', 'Obnovit rozložení']) {
    const button = controls.getByRole('button', { name: label, exact: true });
    await expect(button).not.toBeFocused();
    await button.hover();
    const tooltip = page.getByRole('tooltip');
    await expect(tooltip).toHaveCount(1);
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toContainText(label);
    expect((await tooltip.textContent())!.trim().length).toBeGreaterThan(
      label.length + 10,
    );
    await page.keyboard.press('Escape');
    await expect(tooltip).toBeHidden();
    await page.mouse.move(0, 0);
    await page.keyboard.press('Tab');
    await button.focus();
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toContainText(label);
    await page.keyboard.press('Escape');
    await expect(tooltip).toBeHidden();
    await expect(button).toBeFocused();
  }
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(page.viewportSize()!.width);
});

test('keeps the original fit-and-reset behavior outside variant two', async ({
  page,
}) => {
  for (const route of ['/', '/ux/1']) {
    await page.goto(route);
    await page.evaluate(() => document.fonts.ready);
    const initial = await domainGeometry(page);
    const atlas = page.getByRole('button', {
      name: 'Doména atlas.example',
      exact: true,
    });
    for (let step = 0; step < 3; step++) await atlas.press('Shift+ArrowRight');
    await atlas.press('Enter');
    const detail = page.getByRole('complementary', { name: 'Detail výběru' });
    await detail
      .getByRole('button', { name: /^Prozkoumat \d+ stránek$/ })
      .click();
    await detail
      .getByRole('button', { name: 'Zavřít detail', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Přiblížit mapu', exact: true })
      .click();
    expect(await domainGeometry(page)).not.toEqual(initial);
    await page
      .getByRole('button', { name: 'Zobrazit celou mapu', exact: true })
      .click();
    await expect(page.getByLabel('Přiblížení mapy')).toHaveText('100 %');
    await expect(page.getByRole('button', { name: /^Stránka / })).toHaveCount(
      0,
    );
    expect(await domainGeometry(page)).toEqual(initial);
    await expect(page.locator('.ux-map-controls')).toHaveCount(0);
    await expect(page.locator('[aria-label="Obnovit pohled"]')).toHaveCount(1);
  }
});
