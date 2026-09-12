import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const variants = ['silk', 'contour', 'cable'];
const samples = [1, 2, 3, 4, 5, 8, 12, 25, 50, 120];

test('compares hairlines through 100+ in an isolated responsive laboratory', async ({
  page,
}, testInfo) => {
  await page.goto('/connections/lab/?theme=signal');
  await expect(
    page.getByRole('heading', { name: 'Od vlákna k dominantní vazbě.' }),
  ).toBeVisible();
  await expect(page.locator('.app-header, .sidebar, .graph')).toHaveCount(0);
  for (const variant of variants) {
    const widths: number[] = [];
    for (const count of samples) {
      const cell = page.locator(
        `[data-lab-style="${variant}"][data-count="${count}"]`,
      );
      widths.push(
        Number(
          await cell
            .locator('[data-strength-width]')
            .getAttribute('data-strength-width'),
        ),
      );
      if (count <= 5) {
        await expect(cell.getByTestId('fine-strand')).toHaveCount(count);
        expect(
          await cell
            .getByTestId('fine-strand')
            .evaluateAll((paths) =>
              paths.every(
                (path) => path.getAttribute('stroke-width') === '0.7',
              ),
            ),
        ).toBe(true);
      }
    }
    expect(
      widths.every((width, index) => index === 0 || width > widths[index - 1]),
    ).toBe(true);
    expect(widths.at(-1)).toBeGreaterThan(widths[0] * 20);
  }
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: testInfo.outputPath('lab-signal.png'),
    fullPage: true,
  });
  if (testInfo.project.name === 'mobile') {
    const matrix = page.getByRole('region', {
      name: 'Porovnání spojnic podle počtu vazeb',
    });
    await matrix.evaluate((element) => {
      element.scrollLeft = element.scrollWidth;
    });
    await expect(
      page.locator('[data-lab-style="silk"][data-count="120"]'),
    ).toBeInViewport();
  }
  await page.getByRole('slider').fill('150');
  await expect(page.locator('output')).toHaveText('150 vazeb · 100+');
  for (const group of await page
    .locator('.lab-live-variants [data-strength-width]')
    .all())
    await expect(group).toHaveAttribute('data-strength-width', '22');
  await page
    .getByRole('button', { name: 'Noční režim', pressed: false })
    .click();
  await expect(page.locator('.connection-lab')).toHaveAttribute(
    'data-theme',
    'midnight',
  );
  await page.screenshot({
    path: testInfo.outputPath('lab-midnight.png'),
    fullPage: true,
  });
});

test('renders three complete maps with consistent strength data and exact details', async ({
  page,
}, testInfo) => {
  for (const variant of variants) {
    await page.goto(`/?theme=signal&connections=${variant}&density=scale`);
    await expect(page.getByTestId('link-count')).toHaveText('230');
    await expect(page.locator(`[data-fine-style="${variant}"]`)).toHaveCount(
      10,
    );
    await expect(
      page.locator('[data-connection="index:atlas"] .edge-count'),
    ).toHaveText('100+');
    await expect(
      page.locator('[data-connection="index:objects"] .edge-count'),
    ).toHaveText('50+');
    await expect(
      page.locator('[data-connection="index:collective"] .edge-count'),
    ).toHaveText('25+');
    await expect(
      page.locator('[data-connection="index:journal"] .edge-count'),
    ).toHaveText('10+');
    await expect(
      page
        .locator('[data-connection="atlas:journal"]')
        .getByTestId('fine-strand'),
    ).toHaveCount(1);
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({
      path: testInfo.outputPath(`${variant}.png`),
      fullPage: true,
    });
  }
  await page
    .locator('[data-connection="index:atlas"]')
    .getByRole('button')
    .locator('rect')
    .click();
  const detail = page.getByRole('complementary', { name: 'Detail výběru' });
  await expect(detail.getByText('120 unikátních dvojic stránek')).toBeVisible();
  await detail
    .getByRole('button', {
      name: 'index.example/ → atlas.example/',
      exact: true,
    })
    .click();
  await expect(
    detail.getByText('https://index.example/', { exact: true }),
  ).toBeVisible();
  await expect(
    detail.getByText('https://atlas.example/', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Zobrazit tabulku' }).click();
  const downloadPromise = page.waitForEvent('download');
  await page
    .getByRole('button', { name: 'Exportovat zobrazené odkazy do CSV' })
    .click();
  const csv = await readFile((await (await downloadPromise).path())!, 'utf8');
  const rows = csv.trim().split('\r\n').slice(1);
  expect(rows).toHaveLength(230);
  expect(
    new Set(rows.map((row) => row.split(',').slice(0, 2).join(','))).size,
  ).toBe(230);
  await page.getByLabel('Ukázková data 1–100+').uncheck();
  await expect(page.getByTestId('link-count')).toHaveText('51');
  await page.reload();
  await expect(page.getByTestId('link-count')).toHaveText('51');
});
