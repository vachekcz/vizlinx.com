import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

async function openSite(page: Page, domain: string) {
  await page
    .getByRole('button', { name: `Doména ${domain}`, exact: true })
    .press('Enter');
  const expand = page.getByRole('button', {
    name: 'Roztáhnout detail',
    exact: true,
  });
  if (await expand.isVisible()) await expand.click();
  return page.getByRole('region', { name: 'Stránky webu', exact: true });
}

function trackApiRequests(page: Page) {
  const requests: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/')) {
      requests.push(request.url());
    }
  });
  return requests;
}

async function freezeTime(page: Page) {
  await page.clock.install({ time: new Date('2026-09-15T10:00:00Z') });
  await page.goto('/ux/2');
  await expect(
    page.getByRole('button', { name: 'Skenovat znovu', exact: true }),
  ).toBeVisible();
  await page.clock.pauseAt(new Date('2026-09-15T10:01:00Z'));
}

async function dismissNotice(page: Page) {
  const close = page.getByRole('button', {
    name: 'Zavřít oznámení',
    exact: true,
  });
  if (await close.isVisible()) await close.click();
}

async function createMap(page: Page, domains: string[]) {
  const close = page.getByRole('button', {
    name: 'Zavřít detail',
    exact: true,
  });
  if (await close.isVisible()) await close.click();
  await page.getByRole('button', { name: 'Nová mapa', exact: true }).click();
  const form = page.locator('.ux-new-map form');
  for (const [index, domain] of domains.entries()) {
    if (index > 0) {
      await form
        .getByRole('button', { name: 'Přidat další web', exact: true })
        .click();
    }
    await form
      .getByRole('textbox', { name: `Web ${index + 1}`, exact: true })
      .fill(domain);
  }
  await form
    .getByRole('button', {
      name: 'Vytvořit mapu a spustit sken',
      exact: true,
    })
    .click();
  await dismissNotice(page);
}

test('shows all known pages and separates map expansion from searching and scan status', async ({
  page,
}) => {
  const apiRequests = trackApiRequests(page);
  await page.goto('/ux/2');
  const section = await openSite(page, 'atlas.example');
  const detail = page.getByRole('complementary', { name: 'Detail výběru' });
  const rows = section.locator('.ux-page-row');
  const count = await rows.count();
  expect(count).toBe(6);
  await expect(
    section.locator('[data-page-id="atlas-1"] .ux-page-status'),
  ).toHaveText('Načtená');
  await expect(
    section.locator('[data-page-id="atlas-5"] .ux-page-status'),
  ).toHaveText('Chyba');
  await detail
    .getByRole('button', { name: 'Zobrazit stránky v mapě', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: /^Stránka atlas\.example/ }),
  ).toHaveCount(count);
  await detail
    .getByRole('button', { name: 'Sbalit stránky v mapě', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: /^Stránka atlas\.example/ }),
  ).toHaveCount(0);
  await expect(rows).toHaveCount(count);

  const search = section.getByRole('textbox', { name: 'Hledat stránky webu' });
  await search.fill('ATLAS.EXAMPLE');
  await expect(rows).toHaveCount(count);
  for (const query of [
    'https://atlas.example/projects',
    '/projects',
    'Naše projekty',
  ]) {
    await search.fill(query);
    await expect(rows).toHaveCount(1);
    await expect(rows).toHaveAttribute('data-page-id', 'atlas-1');
    await expect(section.locator('.ux-page-count')).toContainText(/1.*6/);
  }
  await search.fill('stranka-ktera-neexistuje');
  await expect(rows).toHaveCount(0);
  await expect(section).toContainText(/žádn|nenalez/i);
  await search.fill('');
  await expect(rows).toHaveCount(count);
  expect(apiRequests).toEqual([]);
});

test('keeps external navigation and page selection independent of manual scanning', async ({
  page,
  context,
}) => {
  const apiRequests = trackApiRequests(page);
  await context.route(/^https:\/\/journal\.example\//, (route) =>
    route.fulfill({ contentType: 'text/html', body: '<p>Example page</p>' }),
  );
  await page.goto('/ux/2');
  const section = await openSite(page, 'journal.example');
  const row = section.locator('[data-page-id="journal-5"]');
  const url = 'https://journal.example/about';
  const detail = page.getByRole('complementary', { name: 'Detail výběru' });
  await expect(row.locator('.ux-page-status')).toHaveText('Nenačtená');
  const select = row.getByRole('button', {
    name: `Detail stránky ${url}`,
    exact: true,
  });
  await select.hover();
  await expect(
    detail.getByRole('heading', { name: 'journal.example', exact: true }),
  ).toBeVisible();
  await expect(row.locator('.ux-page-status')).toHaveText('Nenačtená');
  const external = row.getByRole('link', {
    name: `Otevřít ${url} v nové kartě`,
    exact: true,
  });
  await expect(external).toHaveAttribute('href', url);
  await expect(external).toHaveAttribute('target', '_blank');
  await expect(external).toHaveAttribute('rel', 'noopener noreferrer');
  const popupPromise = context.waitForEvent('page');
  await external.click();
  const popup = await popupPromise;
  await expect(popup).toHaveURL(url);
  await popup.close();
  await expect(row.locator('.ux-page-status')).toHaveText('Nenačtená');
  await expect(row.locator('.page-scan-button')).toBeEnabled();
  await select.click();
  await expect(
    detail.getByRole('heading', { name: 'O magazínu', exact: true }),
  ).toBeVisible();
  await detail
    .getByRole('button', { name: 'Zpět na journal.example', exact: true })
    .click();
  await expect(select).toBeFocused();
  await expect(row.locator('.ux-page-status')).toHaveText('Nenačtená');
  await expect(row.locator('.page-scan-button')).toBeEnabled();
  expect(apiRequests).toEqual([]);
});

test('simulates a manual scan once through queued and fetching states without calling the API', async ({
  page,
}, testInfo) => {
  const apiRequests = trackApiRequests(page);
  await freezeTime(page);
  await expect(page.getByText('Načteno 8', { exact: true })).toBeVisible();
  const section = await openSite(page, 'journal.example');
  const row = section.locator('[data-page-id="journal-5"]');
  const status = row.locator('.ux-page-status');
  const scan = row.locator('.page-scan-button');
  const detail = page.getByRole('complementary', { name: 'Detail výběru' });
  await expect(scan).toHaveAccessibleName(
    'Proskenovat https://journal.example/about',
  );
  await scan.click();
  await expect(status).toHaveText('Čeká');
  await expect(scan).toBeDisabled();
  await expect(
    detail.getByRole('heading', { name: 'journal.example', exact: true }),
  ).toBeVisible();
  await scan.press('Enter');
  await scan.press('Enter');
  await expect(status).toHaveText('Čeká');
  await page.clock.fastForward(1100);
  await expect(status).toHaveText('Načítá se');
  await expect(scan).toBeDisabled();
  await expect(row).toHaveCount(1);
  await page.clock.fastForward(2000);
  await expect(status).toHaveText('Načtená');
  await expect(scan).toHaveCount(0);
  await expect(row).toHaveCount(1);
  await expect(page.getByText('Načteno 9', { exact: true })).toBeVisible();
  await row
    .getByRole('button', {
      name: 'Detail stránky https://journal.example/about',
      exact: true,
    })
    .click();
  await detail
    .getByRole('button', { name: 'Zpět na journal.example', exact: true })
    .click();
  await expect(status).toHaveText('Načtená');
  await page
    .getByRole('button', { name: 'Zavřít detail', exact: true })
    .click();
  if (testInfo.project.name === 'mobile') {
    await page.getByRole('button', { name: /Skenované weby ·/ }).click();
  }
  await page.getByRole('button', { name: 'Přidat web', exact: true }).click();
  const add = page.locator('.ux-add-site-form');
  await add
    .getByRole('textbox', { name: 'Adresa webu' })
    .fill('objects.example');
  await add
    .getByRole('button', { name: 'Přidat do mapy', exact: true })
    .click();
  await dismissNotice(page);
  await expect(page.locator('.ux-scan-row')).toHaveCount(3);
  await openSite(page, 'journal.example');
  await expect(status).toHaveText('Načtená');
  await expect(scan).toHaveCount(0);
  await createMap(page, [
    'atlas.example',
    'journal.example',
    'objects.example',
  ]);
  await openSite(page, 'journal.example');
  await expect(status).toHaveText('Nenačtená');
  await expect(scan).toBeEnabled();
  expect(apiRequests).toEqual([]);
});

test('isolates a new map from a pending manual scan even with the same domains and run number', async ({
  page,
}) => {
  const apiRequests = trackApiRequests(page);
  await freezeTime(page);
  const domains = ['atlas.example', 'journal.example'];
  await createMap(page, domains);
  await page.getByRole('button', { name: 'Průběh skenu', exact: true }).click();
  const log = page.getByRole('dialog', { name: 'Průběh skenu' });
  await expect(log.getByText('Běh #1 · aktuální')).toBeVisible();
  await log
    .getByRole('button', { name: 'Dokončit ukázkový sken', exact: true })
    .click();
  await page.keyboard.press('Escape');
  await dismissNotice(page);
  const section = await openSite(page, 'journal.example');
  const row = section.locator('[data-page-id="journal-5"]');
  await row.locator('.page-scan-button').click();
  await page.clock.fastForward(1100);
  await expect(row.locator('.ux-page-status')).toHaveText('Načítá se');
  await createMap(page, domains);
  await expect(page.locator('.ux-status')).toContainText('Skenování probíhá');
  await openSite(page, 'journal.example');
  await expect(row.locator('.ux-page-status')).toHaveText('Nenačtená');
  await expect(row.locator('.page-scan-button')).toBeEnabled();
  await page.clock.fastForward(5000);
  await expect(row.locator('.ux-page-status')).toHaveText('Nenačtená');
  await expect(page.locator('.ux-status')).toContainText('Skenování probíhá');
  await expect(page.getByText('Načteno 8', { exact: true })).toBeVisible();
  expect(apiRequests).toEqual([]);
});

test('explains why manual scanning is unavailable while paused and in an archived run', async ({
  page,
}) => {
  const apiRequests = trackApiRequests(page);
  await freezeTime(page);
  await page
    .getByRole('button', { name: 'Skenovat znovu', exact: true })
    .click();
  await page.clock.fastForward(4000);
  await page.getByRole('button', { name: 'Pozastavit', exact: true }).click();
  let section = await openSite(page, 'journal.example');
  let scan = section.locator('[data-page-id="journal-5"]').getByRole('button', {
    name: 'Proskenovat https://journal.example/about',
    exact: true,
  });
  await expect(scan).toBeDisabled();
  await expect(scan).toHaveAttribute('title', /pozastaven/i);
  await page
    .getByRole('button', { name: 'Zavřít detail', exact: true })
    .click();
  await page.getByRole('button', { name: 'Pokračovat', exact: true }).click();
  section = await openSite(page, 'journal.example');
  await expect(
    section.locator('[data-page-id="journal-5"] .page-scan-button'),
  ).toBeEnabled();
  await page
    .getByRole('button', { name: 'Zavřít detail', exact: true })
    .click();
  await page
    .getByRole('navigation', { name: 'Zobrazení mapy' })
    .getByRole('button', { name: /Historie/ })
    .click();
  await page.getByRole('button', { name: /^Sken #3 Archiv/ }).click();
  section = await openSite(page, 'journal.example');
  scan = section.locator('[data-page-id="journal-5"] .page-scan-button');
  await expect(scan).toBeDisabled();
  await expect(scan).toHaveAttribute('title', /archiv/i);
  await page.clock.fastForward(5000);
  await expect(
    section.locator('[data-page-id="journal-5"] .ux-page-status'),
  ).toHaveText('Nenačtená');
  expect(apiRequests).toEqual([]);
});

test('restores the filtered list and its own scroll after page detail navigation and mobile collapse', async ({
  page,
}, testInfo) => {
  await page.goto('/ux/2');
  const section = await openSite(page, 'journal.example');
  const search = section.getByRole('textbox', { name: 'Hledat stránky webu' });
  await search.fill('journal.example');
  const list = section.locator('.ux-page-list');
  const select = section
    .locator('[data-page-id="journal-5"]')
    .getByRole('button', {
      name: 'Detail stránky https://journal.example/about',
      exact: true,
    });
  await select.scrollIntoViewIfNeeded();
  const scrollTop = await list.evaluate((element) => element.scrollTop);
  expect(scrollTop).toBeGreaterThan(0);
  await select.click();
  const detail = page.getByRole('complementary', { name: 'Detail výběru' });
  await detail
    .getByRole('button', { name: 'Zpět na journal.example', exact: true })
    .click();
  await expect(search).toHaveValue('journal.example');
  await expect(select).toBeFocused();
  await expect
    .poll(() => list.evaluate((element) => element.scrollTop))
    .toBeCloseTo(scrollTop, 0);
  if (testInfo.project.name === 'mobile') {
    await page
      .getByRole('button', { name: 'Sbalit detail', exact: true })
      .click();
    await expect(section).toBeHidden();
    await page
      .getByRole('button', { name: 'Otevřít detail', exact: true })
      .click();
    await expect(search).toHaveValue('journal.example');
    await expect
      .poll(() => list.evaluate((element) => element.scrollTop))
      .toBeCloseTo(scrollTop, 0);
  }
});
