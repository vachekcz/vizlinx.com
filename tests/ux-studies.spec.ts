import { expect, test } from '@playwright/test';

test('returns through map details with the original site, scroll and focus', async ({
  page,
}, testInfo) => {
  await page.goto('/ux/2');
  if (testInfo.project.name === 'mobile') {
    await page.getByRole('button', { name: /Skenované weby ·/ }).click();
  }
  await page
    .getByRole('button', { name: 'atlas.example', exact: true })
    .click();
  const detail = page.getByRole('complementary', { name: 'Detail výběru' });
  const selectedSite = page.locator('.ux-scan-row.is-selected');
  const journal = detail.getByRole('group', {
    name: 'journal.example',
    exact: true,
  });
  await expect(
    journal.getByRole('heading', { name: 'journal.example', exact: true }),
  ).toHaveCount(1);
  await expect(journal.getByRole('button')).toHaveCount(2);
  await expect(
    detail
      .getByRole('group', { name: 'objects.example', exact: true })
      .getByRole('button'),
  ).toHaveCount(1);
  await journal.getByRole('heading').click();
  await expect(
    detail.getByRole('heading', { name: 'atlas.example', exact: true }),
  ).toBeVisible();
  const outgoing = detail.getByRole('button', {
    name: 'journal.example 5 odkazů z atlas.example',
    exact: true,
  });
  await expect(
    detail.getByRole('button', {
      name: 'journal.example 3 odkazy na atlas.example',
      exact: true,
    }),
  ).toBeVisible();
  await detail.evaluate((element) => {
    element.scrollTop = 100;
  });
  await outgoing.scrollIntoViewIfNeeded();
  const siteScroll = await detail.evaluate((element) => element.scrollTop);
  await outgoing.click();
  await expect(
    detail.getByRole('heading', {
      name: 'Odkazy z atlas.example na journal.example',
    }),
  ).toBeVisible();
  await expect(detail.locator('.ux-link-card')).toHaveCount(5);
  await expect(selectedSite).toContainText('atlas.example');
  if (testInfo.project.name === 'desktop') {
    await expect(page.locator('.ux-floating-detail')).toHaveAttribute(
      'data-anchored',
      'true',
    );
  }
  const lastLink = detail.locator('.ux-link-card').last();
  await lastLink.scrollIntoViewIfNeeded();
  const connectionScroll = await detail.evaluate(
    (element) => element.scrollTop,
  );
  await lastLink.focus();
  await page.keyboard.press('Enter');
  await expect(
    detail.getByRole('heading', { name: 'Odkud a kam' }),
  ).toBeVisible();
  await expect(selectedSite).toContainText('atlas.example');
  await detail.getByRole('button', { name: 'Zpět na seznam odkazů' }).click();
  await expect(lastLink).toBeFocused();
  expect(await detail.evaluate((element) => element.scrollTop)).toBeCloseTo(
    connectionScroll,
    0,
  );
  await detail.getByRole('button', { name: 'Zpět na atlas.example' }).click();
  await expect(
    detail.getByRole('heading', { name: 'atlas.example', exact: true }),
  ).toBeVisible();
  await expect(outgoing).toBeFocused();
  expect(await detail.evaluate((element) => element.scrollTop)).toBeCloseTo(
    siteScroll,
    0,
  );
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(page.viewportSize()!.width);
});

test('starts a new detail path when changing sites or closing the panel', async ({
  page,
}, testInfo) => {
  await page.goto('/ux/2');
  const openSites = async () => {
    if (testInfo.project.name === 'mobile') {
      await page.getByRole('button', { name: /Skenované weby ·/ }).click();
    }
  };
  await openSites();
  await page
    .getByRole('button', { name: 'atlas.example', exact: true })
    .click();
  const detail = page.getByRole('complementary', { name: 'Detail výběru' });
  await detail.locator('.ux-related-row').first().click();
  await openSites();
  await page
    .getByRole('button', { name: 'journal.example', exact: true })
    .click();
  await expect(detail.locator('.ux-detail-back')).toHaveCount(0);
  await expect(page.locator('.ux-scan-row.is-selected')).toContainText(
    'journal.example',
  );
  await detail.locator('.ux-related-row').first().click();
  await expect(
    detail.getByRole('button', { name: 'Zpět na journal.example' }),
  ).toBeVisible();
  await detail.getByRole('button', { name: 'Zavřít detail' }).click();
  await expect(detail).toHaveCount(0);
  await expect(page.locator('.ux-scan-row.is-selected')).toHaveCount(0);
  await openSites();
  await page
    .getByRole('button', { name: 'atlas.example', exact: true })
    .click();
  await expect(detail.locator('.ux-detail-back')).toHaveCount(0);
});
