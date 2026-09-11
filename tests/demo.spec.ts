import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

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
  await expect(page.getByTestId('link-count')).toHaveText('35');
  await expect(page.getByRole('button', { name: /^Doména / })).toHaveCount(5);
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
  await expect(page.getByRole('button', { name: /^Stránka / })).toHaveCount(30);
  await page.getByRole('button', { name: 'Zobrazit celou mapu' }).click();
  await expect(page.getByLabel('Přiblížení mapy')).toHaveText('100 %');
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

test('distinguishes unscanned external targets and keeps table and export consistent', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByLabel('Další odkazované weby').check();
  await expect(page.getByTestId('link-count')).toHaveText('37');
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
