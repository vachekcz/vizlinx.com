import { expect, test } from '@playwright/test';

const variants = [
  ['strands', 'Vlákna'],
  ['fan', 'Vějíř'],
  ['ribbon', 'Pásy'],
  ['pulses', 'Proud'],
  ['metro', 'Metro'],
];

test('compares five edge styles with capped counts and exact details', async ({
  page,
}, testInfo) => {
  await page.goto('/?theme=signal');
  const connection = page.locator('[data-connection="index:journal"]');
  for (const [id, name] of variants) {
    await page
      .getByRole('button', { name: new RegExp(`0[1-5]\\s*${name}`) })
      .click();
    await expect(connection.locator('.edge-count')).toHaveText('5+');
    await expect(connection.getByTestId('aggregate-strand')).toHaveCount(
      id === 'ribbon' || id === 'pulses' ? 1 : 5,
    );
    await expect(page.getByTestId('link-count')).toHaveText('51');
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({
      path: testInfo.outputPath(`${id}.png`),
      fullPage: true,
    });
  }
  await connection.getByRole('button').locator('rect').click();
  await expect(
    page
      .getByRole('complementary', { name: 'Detail výběru' })
      .getByText('6 unikátních dvojic stránek'),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole('button', { name: /05\s*Metro/ }),
  ).toHaveAttribute('aria-pressed', 'true');
});

test('drags a domain independently at zoom and updates its connections', async ({
  page,
}, testInfo) => {
  await page.goto('/?theme=midnight');
  await page
    .getByRole('button', { name: 'Přiblížit mapu', exact: true })
    .click();
  const node = page.locator('[data-drag-site="atlas"] circle');
  const other = page.locator('[data-drag-site="journal"] circle');
  const edge = page
    .locator(
      '[data-connection="atlas:journal"] [data-testid="aggregate-strand"]',
    )
    .first();
  const originalEdge = await edge.getAttribute('d');
  const otherX = await other.getAttribute('cx');
  const camera = await page
    .getByTestId('graph-camera')
    .getAttribute('transform');
  const before = (await node.boundingBox())!;
  const start = {
    x: before.x + before.width / 2,
    y: before.y + before.height / 2,
  };
  const dx = testInfo.project.name === 'mobile' ? 45 : 85;
  if (testInfo.project.name === 'mobile') {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [start],
    });
    for (let step = 1; step <= 5; step++) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [
          { x: start.x + (dx * step) / 5, y: start.y - (25 * step) / 5 },
        ],
      });
    }
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchEnd',
      touchPoints: [],
    });
    await cdp.detach();
  } else {
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + dx, start.y - 25, { steps: 5 });
    await page.mouse.up();
  }
  await expect
    .poll(async () => Math.round((await node.boundingBox())!.x - before.x))
    .toBe(dx);
  await expect(other).toHaveAttribute('cx', otherX!);
  await expect(page.getByTestId('graph-camera')).toHaveAttribute(
    'transform',
    camera!,
  );
  await expect(edge).not.toHaveAttribute('d', originalEdge!);
  await page.getByRole('button', { name: /02\s*Vějíř/ }).click();
  expect(Math.round((await node.boundingBox())!.x - before.x)).toBe(dx);
  await page.getByRole('button', { name: 'Zobrazit celou mapu' }).click();
  await expect(node).toHaveAttribute(
    'cx',
    testInfo.project.name === 'mobile' ? '300' : '480',
  );
});

test('moves an expanded domain and all its pages together with the keyboard', async ({
  page,
}) => {
  await page.goto('/?detail=index');
  const domain = page.getByRole('button', {
    name: 'Doména index.example',
    exact: true,
  });
  const cards = page
    .getByRole('button', { name: /^Stránka index.example/ })
    .locator('rect');
  const before = await cards.evaluateAll((nodes) =>
    nodes.map((node) => Number(node.getAttribute('x'))),
  );
  await domain.focus();
  await domain.press('ArrowRight');
  const after = await cards.evaluateAll((nodes) =>
    nodes.map((node) => Number(node.getAttribute('x'))),
  );
  expect(after).toEqual(before.map((x) => x + 15));
  await expect(cards).toHaveCount(20);
});

test('opens the comparison gallery with five loaded previews and live night links', async ({
  page,
}, testInfo) => {
  await page.goto('/connections/');
  await expect(page.locator('article')).toHaveCount(5);
  await expect
    .poll(() =>
      page
        .locator('img')
        .evaluateAll(
          (images) =>
            images.length === 5 &&
            images.every((image) => image.complete && image.naturalWidth > 0),
        ),
    )
    .toBe(true);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath('connections.png'),
    fullPage: true,
  });
  await page
    .locator('article')
    .filter({ hasText: 'Vějíř' })
    .getByRole('link', { name: 'Vyzkoušet v noci' })
    .click();
  await expect(page.locator('.app-shell')).toHaveAttribute(
    'data-theme',
    'midnight',
  );
  await expect(
    page.getByRole('button', { name: /02\s*Vějíř/ }),
  ).toHaveAttribute('aria-pressed', 'true');
});
