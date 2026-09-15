import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { fitAroundObstacles } from '../src/graph-framing';

async function openFramedMap(page: Page, query = '') {
  await page.goto(`/ux/2${query}`);
  await expect(
    page.getByLabel('Interaktivní mapa odkazů mezi weby'),
  ).toHaveAttribute('data-framing-ready', 'true');
  await expect(page.locator('.site-node').first()).toBeVisible();
}

async function settleLayout(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

async function expectSafeFraming(page: Page) {
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const frame = document.querySelector('.ux-immersive .graph')!;
        const viewport = frame.getBoundingClientRect();
        const obstacles = Array.from(
          document.querySelectorAll('[data-map-obstacle]'),
        )
          .filter((element) => {
            const style = getComputedStyle(element);
            return (
              element.checkVisibility() &&
              style.display !== 'none' &&
              style.visibility !== 'hidden'
            );
          })
          .map((element) => ({
            name: element.className,
            rect: element.getBoundingClientRect(),
          }))
          .filter(({ rect }) => rect.width > 0 && rect.height > 0);
        const violations: string[] = [];
        if (obstacles.length < 5) violations.push('Missing visible UI bounds');
        for (const node of frame.querySelectorAll('.site-node')) {
          const name = node
            .querySelector('[data-drag-site]')!
            .getAttribute('data-drag-site');
          const rect = node.getBoundingClientRect();
          const outerGap = Math.min(
            rect.left - viewport.left,
            rect.top - viewport.top,
            viewport.right - rect.right,
            viewport.bottom - rect.bottom,
          );
          if (outerGap < 30.5)
            violations.push(`${name}: only ${outerGap.toFixed(1)} px to edge`);
          for (const obstacle of obstacles) {
            const gap = Math.max(
              obstacle.rect.left - rect.right,
              rect.left - obstacle.rect.right,
              obstacle.rect.top - rect.bottom,
              rect.top - obstacle.rect.bottom,
            );
            if (gap < 22.5)
              violations.push(
                `${name}: only ${gap.toFixed(1)} px to ${obstacle.name}`,
              );
          }
        }
        return violations;
      }),
    )
    .toEqual([]);
}

for (const query of ['', '?hover=pulse']) {
  test(`uses the whole workspace and initially keeps complete bubbles clear of real controls (${query || 'default'})`, async ({
    page,
  }) => {
    await openFramedMap(page, query);
    const workspace = (await page.locator('.ux-immersive').boundingBox())!;
    const graph = (await page
      .getByLabel('Interaktivní mapa odkazů mezi weby')
      .boundingBox())!;
    expect(graph.x).toBeCloseTo(workspace.x, 0);
    expect(graph.y).toBeCloseTo(workspace.y, 0);
    expect(graph.width).toBeCloseTo(workspace.width, 0);
    expect(graph.height).toBeCloseTo(workspace.height, 0);
    await expectSafeFraming(page);
    for (const domain of await page.locator('[data-drag-site]').all()) {
      await domain.click({ trial: true });
    }
    await expectSafeFraming(page);
  });
}

test('preserves a manually panned camera through hover, selection and changed panel bounds until fit is requested', async ({
  page,
}, testInfo) => {
  await openFramedMap(page, '?hover=pulse');
  const graph = (await page
    .getByLabel('Interaktivní mapa odkazů mezi weby')
    .boundingBox())!;
  const camera = page.getByTestId('graph-camera');
  const initialCamera = await camera.getAttribute('transform');
  await page.mouse.move(graph.x + 8, graph.y + 8);
  await page.mouse.down();
  await page.mouse.move(graph.x + 53, graph.y + 33, { steps: 5 });
  await page.mouse.up();
  await expect(camera).not.toHaveAttribute('transform', initialCamera!);
  const manualCamera = (await camera.getAttribute('transform'))!;
  if (testInfo.project.name === 'mobile') {
    await page.getByRole('button', { name: /Skenované weby ·/ }).click();
    await settleLayout(page);
    await expect(camera).toHaveAttribute('transform', manualCamera);
  }
  const atlas = page.getByRole('button', {
    name: 'atlas.example',
    exact: true,
  });
  await atlas.hover();
  await expect(page.locator('[data-highlight-site="atlas"]')).toHaveCount(1);
  await expect(camera).toHaveAttribute('transform', manualCamera);
  await atlas.click();
  const detail = page.getByRole('complementary', { name: 'Detail výběru' });
  await expect(detail).toBeVisible();
  await settleLayout(page);
  await expect(camera).toHaveAttribute('transform', manualCamera);
  await page.locator('.ux-floating-detail').evaluate((element) => {
    element.style.height = '220px';
  });
  await settleLayout(page);
  await expect(camera).toHaveAttribute('transform', manualCamera);
  await page
    .getByRole('button', { name: 'Zobrazit celou mapu', exact: true })
    .click();
  await expectSafeFraming(page);
  await expect(
    detail.getByRole('heading', { name: 'atlas.example', exact: true }),
  ).toBeVisible();
});

test('measures the current site panel when fitting after its size changes', async ({
  page,
}, testInfo) => {
  await openFramedMap(page);
  if (testInfo.project.name === 'mobile') {
    await page.getByRole('button', { name: /Skenované weby ·/ }).click();
  }
  const camera = page.getByTestId('graph-camera');
  const before = (await camera.getAttribute('transform'))!;
  await page.locator('.ux-floating-sites').evaluate((element) => {
    element.style.maxHeight = 'none';
    element.style.height = `${element.getBoundingClientRect().height + 64}px`;
  });
  await settleLayout(page);
  await expect(camera).toHaveAttribute('transform', before);
  await page
    .getByRole('button', { name: 'Zobrazit celou mapu', exact: true })
    .click();
  await expectSafeFraming(page);
});

test('allows panning through empty space between the heading and status', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'Desktop has a heading gap');
  await openFramedMap(page);
  const point = await page
    .locator('.ux-floating-heading')
    .evaluate((heading) => {
      const title = heading.firstElementChild!.getBoundingClientRect();
      const status = heading.lastElementChild!.getBoundingClientRect();
      const y = title.top + title.height / 2;
      for (let x = title.right + 30; x < status.left - 30; x += 20) {
        const element = document.elementFromPoint(x, y);
        if (
          element?.closest('.graph') &&
          !element.closest('[data-interactive="true"]')
        ) {
          return { x, y };
        }
      }
      return null;
    });
  expect(
    point,
    'The empty heading gap should pass pointer input to the map',
  ).not.toBeNull();
  const camera = page.getByTestId('graph-camera');
  const before = (await camera.getAttribute('transform'))!;
  await page.mouse.move(point!.x, point!.y);
  await page.mouse.down();
  await page.mouse.move(point!.x + 35, point!.y + 20, { steps: 5 });
  await page.mouse.up();
  await expect(camera).not.toHaveAttribute('transform', before);
});

test('keeps full size by using space below a panel and beside it for different bubbles', () => {
  const frame = { left: 0, top: 0, right: 600, bottom: 500 };
  const placement = fitAroundObstacles(
    frame,
    [
      { left: 300, top: 0, right: 600, bottom: 100 },
      { left: 0, top: 300, right: 100, bottom: 500 },
    ],
    frame,
    [{ left: 0, top: 0, right: 200, bottom: 200 }],
  );
  expect(placement).toEqual({ x: 0, y: 0, zoom: 1 });
});
