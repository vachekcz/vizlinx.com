import { expect, test } from '@playwright/test';

test('copies full endpoint URLs and keeps the specific link selected when showing it in the map', async ({
  page,
}, testInfo) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator.clipboard, 'writeText', {
      value: async (url: string) => {
        if (document.documentElement.dataset.copyFails) {
          throw new Error('Clipboard access denied');
        }
        document.documentElement.dataset.copiedUrl = url;
      },
    });
  });
  await page.goto('/ux/2?hover=pulse');
  if (testInfo.project.name === 'mobile') {
    await page.getByRole('button', { name: /Skenované weby ·/ }).click();
  }
  await page
    .getByRole('button', { name: 'atlas.example', exact: true })
    .click();
  const detail = page.getByRole('complementary', { name: 'Detail výběru' });
  await detail
    .getByRole('button', {
      name: '5 odkazů ven: z atlas.example na journal.example',
      exact: true,
    })
    .click();
  const link = detail.locator('.ux-link-card').last();
  await link.click();
  const sourceUrl = 'https://atlas.example/partners';
  const targetUrl = 'https://journal.example/about';
  const sourceCopy = detail.getByRole('button', {
    name: `Kopírovat URL ${sourceUrl}`,
    exact: true,
  });
  await page.evaluate(() => {
    document.documentElement.dataset.copyFails = 'true';
  });
  await sourceCopy.click();
  await expect(
    detail
      .getByRole('status')
      .filter({ hasText: 'URL se nepodařilo zkopírovat' }),
  ).toBeVisible();
  await expect(sourceCopy).not.toHaveAttribute('title', 'Zkopírováno');
  await page.evaluate(() => {
    delete document.documentElement.dataset.copyFails;
  });
  for (const url of [sourceUrl, targetUrl]) {
    const copy = detail.getByRole('button', {
      name: `Kopírovat URL ${url}`,
      exact: true,
    });
    await copy.click();
    await expect(page.locator('html')).toHaveAttribute('data-copied-url', url);
    await expect(copy).toHaveAttribute('title', 'Zkopírováno');
  }
  await expect(
    detail.getByText('URL se nepodařilo zkopírovat', { exact: false }),
  ).toHaveCount(0);
  await detail
    .getByRole('button', { name: 'Ukázat tento odkaz v mapě', exact: true })
    .click();
  await expect(
    detail.getByRole('heading', { name: 'Odkud a kam' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', {
      name: 'Stránka atlas.example/partners',
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', {
      name: 'Stránka journal.example/about',
      exact: true,
    }),
  ).toBeVisible();
  const selectedEdge = page.getByRole('button', {
    name: 'Odkaz atlas.example/partners → journal.example/about',
    exact: true,
  });
  await expect(
    selectedEdge.locator(':scope > path[marker-end]'),
  ).toHaveAttribute('opacity', '1');
  await expect(
    page.locator('.page-edge > path[marker-end][opacity="1"]'),
  ).toHaveCount(1);
  await expect(
    page.locator('.page-edge > path[marker-end][opacity="0.06"]').first(),
  ).toBeAttached();
  await expect(page.locator('.ux-scan-row.is-selected')).toContainText(
    'atlas.example',
  );
  await detail.getByRole('button', { name: 'Zpět na seznam odkazů' }).click();
  await expect(link).toBeFocused();
  await detail.getByRole('button', { name: 'Zpět na atlas.example' }).click();
  await expect(
    detail.getByRole('heading', { name: 'atlas.example', exact: true }),
  ).toBeVisible();
});

test('returns through map details with the original site, scroll and focus', async ({
  page,
  context,
}, testInfo) => {
  await context.route(/^https:\/\/[^/]+\.example\//, (route) =>
    route.fulfill({ contentType: 'text/html', body: '<p>Example website</p>' }),
  );
  await page.goto('/ux/2');
  if (testInfo.project.name === 'mobile') {
    await page.getByRole('button', { name: /Skenované weby ·/ }).click();
  }
  await page
    .getByRole('button', { name: 'atlas.example', exact: true })
    .click();
  const detail = page.getByRole('complementary', { name: 'Detail výběru' });
  const openExternal = async (url: string) => {
    const anchor = detail.getByRole('link', {
      name: `Otevřít ${url} v nové kartě`,
      exact: true,
    });
    await expect(anchor).toHaveAttribute('href', new URL(url).href);
    await expect(anchor).toHaveAttribute('rel', 'noopener noreferrer');
    const popupPromise = context.waitForEvent('page');
    await anchor.click();
    const popup = await popupPromise;
    await expect(popup).toHaveURL(new URL(url).href);
    await popup.close();
    await expect(page).toHaveURL(/\/ux\/2$/);
  };
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
  await openExternal('https://journal.example');
  await expect(
    detail.getByRole('heading', { name: 'atlas.example', exact: true }),
  ).toBeVisible();
  const outgoing = detail.getByRole('button', {
    name: '5 odkazů ven: z atlas.example na journal.example',
    exact: true,
  });
  await expect(outgoing).toHaveText('5 odkazů ven');
  await expect(
    detail.getByRole('button', {
      name: '3 odkazy sem: z journal.example na atlas.example',
      exact: true,
    }),
  ).toHaveText('3 odkazy sem');
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
  await expect(
    detail.getByRole('link', {
      name: 'Otevřít https://atlas.example v nové kartě',
      exact: true,
    }),
  ).toHaveAttribute('href', 'https://atlas.example/');
  await openExternal('https://journal.example');
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
  await openExternal('https://atlas.example/partners');
  await openExternal('https://journal.example/about');
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
