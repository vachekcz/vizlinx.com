import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test('opens details from entire result rows and keeps external navigation independent', async ({
  page,
  context,
}) => {
  await context.route(/^https:\/\/[^/]+\.example\//, (route) =>
    route.fulfill({ contentType: 'text/html', body: '<p>Example website</p>' }),
  );
  await page.goto('/ux/2?hover=pulse');
  await page
    .getByRole('navigation', { name: 'Zobrazení mapy' })
    .getByRole('button', { name: /Odkazy/ })
    .click();
  const results = page.locator('.ux-results');
  const rows = results.locator('tbody tr');
  const first = rows.first();
  const detail = page.getByRole('complementary', { name: 'Detail výběru' });

  for (const url of [
    'https://atlas.example/',
    'https://journal.example/design',
  ]) {
    const external = first.getByRole('link', {
      name: `Otevřít ${url} v nové kartě`,
      exact: true,
    });
    await expect(external).toHaveAttribute('href', url);
    await expect(external).toHaveAttribute('rel', 'noopener noreferrer');
    const popupPromise = context.waitForEvent('page');
    await external.click();
    const popup = await popupPromise;
    await expect(popup).toHaveURL(url);
    await popup.close();
    await expect(detail).toHaveCount(0);
    await expect(
      page.getByRole('heading', { name: 'Odkazy 21', exact: true }),
    ).toBeVisible();
  }

  for (const cell of [0, 1, 2, 3]) {
    await first
      .locator('td')
      .nth(cell)
      .click({ position: { x: 8, y: 8 } });
    await expect(
      detail.getByRole('heading', { name: 'Odkud a kam' }),
    ).toBeInViewport();
    await expect(detail.locator('.ux-url-endpoint code').last()).toHaveText(
      '/design',
    );
    await detail.getByRole('button', { name: 'Zavřít detail' }).click();
  }

  const last = rows.last();
  const openLast = last.getByRole('button', { name: /^Detail odkazu/ });
  await openLast.focus();
  const scrollTop = await results.evaluate((element) => element.scrollTop);
  expect(scrollTop).toBeGreaterThan(0);
  await page.keyboard.press('Enter');
  await expect(
    detail.getByRole('heading', { name: 'Odkud a kam' }),
  ).toBeInViewport();
  await expect(detail.locator('.ux-url-endpoint code').last()).toHaveText(
    '/events',
  );
  await detail.getByRole('button', { name: 'Zavřít detail' }).click();
  expect(await results.evaluate((element) => element.scrollTop)).toBeCloseTo(
    scrollTop,
    0,
  );
  await last
    .locator('td')
    .first()
    .click({ position: { x: 8, y: 8 } });
  await expect(
    detail.getByRole('heading', { name: 'Odkud a kam' }),
  ).toBeInViewport();
  await expect(detail.locator('.ux-url-endpoint code').last()).toHaveText(
    '/events',
  );
});

test('keeps result fields, filtering, counts and filtered CSV export', async ({
  page,
}) => {
  await page.goto('/ux/2');
  await page
    .getByRole('navigation', { name: 'Zobrazení mapy' })
    .getByRole('button', { name: /Odkazy/ })
    .click();
  const results = page.locator('.ux-results');
  const rows = results.locator('tbody tr');
  const heading = page.getByRole('heading', { name: /^Odkazy / });
  await expect(heading).toHaveText('Odkazy 21');
  await expect(rows).toHaveCount(21);
  await expect(results.getByRole('columnheader')).toHaveText([
    'Zdrojová stránka',
    'Cílová stránka',
    'Text odkazu',
    'Umístění',
    'Detail',
  ]);
  const nofollowCount = await results.locator('.ux-rel').count();
  await results
    .getByRole('button', { name: 'Jen nofollow', exact: true })
    .click();
  await expect(rows).toHaveCount(nofollowCount);
  await expect(heading).toHaveText(`Odkazy ${nofollowCount}`);
  await results
    .getByRole('textbox', { name: 'Hledat v odkazech' })
    .fill('/interviews');
  await expect(rows).toHaveCount(1);
  await expect(heading).toHaveText('Odkazy 1');
  await expect(rows.first()).toContainText('Rozhovory');
  await expect(rows.first()).toContainText('Obsah');
  await expect(rows.first()).toContainText('nofollow');
  const downloadPromise = page.waitForEvent('download');
  await results
    .getByRole('button', { name: 'Export CSV', exact: true })
    .click();
  const download = await downloadPromise;
  const csv = await readFile((await download.path())!, 'utf8');
  expect(csv.trim().split(/\r?\n/)).toHaveLength(2);
  expect(csv).toContain('https://atlas.example/about');
  expect(csv).toContain('https://journal.example/interviews');
  expect(csv).toContain('nofollow');
  expect(csv).toContain('ux_mockup');
  await results
    .getByRole('textbox', { name: 'Hledat v odkazech' })
    .fill('no-matching-page');
  await expect(heading).toHaveText('Odkazy 0');
  await results
    .getByRole('button', { name: 'Zrušit filtry', exact: true })
    .click();
  await expect(rows).toHaveCount(21);
  await expect(heading).toHaveText('Odkazy 21');
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(page.viewportSize()!.width);
});
