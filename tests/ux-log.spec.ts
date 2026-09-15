import { expect, test } from '@playwright/test';

test('preserves scan metadata and filters, opens exact redirect URLs and restores focus', async ({
  page,
  context,
}) => {
  await context.route(/^https?:\/\/[^/]+\.example\//, (route) =>
    route.fulfill({ contentType: 'text/html', body: '<p>Example website</p>' }),
  );
  await page.goto('/ux/2');
  const trigger = page.getByRole('button', {
    name: 'Průběh skenu',
    exact: true,
  });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'Průběh skenu' });
  const rows = dialog.locator('li[data-event-id]');
  const initialCount = await rows.count();
  await expect(dialog).toHaveClass(/ux-study-log/);
  await expect(dialog.getByText('Běh #6 · aktuální')).toBeVisible();
  await expect(dialog.getByText('Chyby: 2', { exact: true })).toBeVisible();
  await expect(
    dialog.getByText('Neúspěšné / vynechané stránky: 3', { exact: true }),
  ).toBeVisible();
  await expect(
    rows.getByText('HTTP 200', { exact: true }).first(),
  ).toBeAttached();
  await expect(
    rows.getByText(/^\d+ (odkaz|odkazy|odkazů)$/).first(),
  ).toBeAttached();
  await expect(rows.getByText('OK', { exact: true })).toHaveCount(0);
  const times = await rows
    .locator('time')
    .evaluateAll((elements) =>
      elements.map((element) => element.getAttribute('datetime')!),
    );
  expect(times).toEqual([...times].sort().reverse());

  const errorsOnly = dialog.getByRole('checkbox', { name: 'Jen chyby' });
  const website = dialog.getByRole('combobox', {
    name: 'Filtrovat log podle webu',
  });
  await errorsOnly.check();
  await expect(rows).toHaveCount(2);
  await expect(rows.getByText('HTTP 404', { exact: true })).toBeAttached();
  const journalErrors = (await rows.allTextContents()).filter((text) =>
    text.includes('journal.example'),
  ).length;
  await website.selectOption('journal');
  await expect(rows).toHaveCount(journalErrors);
  await expect(dialog.getByText('Chyby: 2', { exact: true })).toBeVisible();
  await expect(
    dialog.getByText('Neúspěšné / vynechané stránky: 3', { exact: true }),
  ).toBeVisible();
  await errorsOnly.uncheck();
  expect(await rows.count()).toBeGreaterThan(0);
  const filteredUrls = await rows
    .getByRole('link')
    .evaluateAll((elements) =>
      elements.map((element) => (element as HTMLAnchorElement).href),
    );
  expect(filteredUrls.length).toBeGreaterThan(0);
  expect(
    filteredUrls.every((url) =>
      ['journal.example', 'www.journal.example'].includes(
        new URL(url).hostname,
      ),
    ),
  ).toBe(true);
  await website.selectOption('all');
  await expect(rows).toHaveCount(initialCount);

  const redirect = rows.filter({ hasText: 'http://atlas.example/journal' });
  await expect(redirect).toHaveCount(1);
  await expect(redirect).toContainText('Přesměrování');
  await expect(redirect.getByText('HTTP 301', { exact: true })).toBeAttached();
  for (const url of [
    'http://atlas.example/journal',
    'https://www.atlas.example/journal',
  ]) {
    await expect(redirect.getByText(url, { exact: true })).toBeAttached();
    const external = redirect.getByRole('link', {
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
    await expect(dialog).toBeVisible();
    await expect(rows).toHaveCount(initialCount);
  }

  await page.setViewportSize({ width: 320, height: 640 });
  await expect(
    dialog.getByRole('heading', { name: 'Průběh skenu' }),
  ).toBeInViewport();
  await expect(website).toBeInViewport();
  await expect(errorsOnly).toBeInViewport();
  const scroll = dialog.locator('.ux-study-log-events');
  const widths = await scroll.evaluate((element) => ({
    content: element.scrollWidth,
    viewport: element.clientWidth,
  }));
  expect(widths.content).toBeLessThanOrEqual(widths.viewport);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(320);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test('follows new events but preserves the visible row and fixed controls when reading older events', async ({
  page,
}) => {
  const apiRequests: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/')) {
      apiRequests.push(request.url());
    }
  });
  await page.clock.install({ time: new Date('2026-09-15T10:00:00Z') });
  await page.goto('/ux/2');
  await expect(
    page.getByRole('button', { name: 'Skenovat znovu', exact: true }),
  ).toBeVisible();
  await page.clock.pauseAt(new Date('2026-09-15T10:01:00Z'));
  await page
    .getByRole('button', { name: 'Skenovat znovu', exact: true })
    .click();
  await page.clock.fastForward(4000);
  await page.getByRole('button', { name: 'Průběh skenu', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Průběh skenu' });
  const rows = dialog.locator('li[data-event-id]');
  const scroll = dialog.locator('.ux-study-log-events');
  const latest = dialog.getByRole('button', {
    name: 'K nejnovějším',
    exact: true,
  });
  await expect(dialog.getByText('Běh #7 · aktuální')).toBeVisible();
  const initialCount = await rows.count();
  const originalFirst = await rows.first().getAttribute('data-event-id');
  await page.clock.fastForward(3100);
  await expect(rows).toHaveCount(initialCount + 1);
  await expect(rows.first()).not.toHaveAttribute(
    'data-event-id',
    originalFirst!,
  );
  expect(await scroll.evaluate((element) => element.scrollTop)).toBe(0);
  await expect(latest).toHaveCount(0);

  const fixedControls = [
    dialog.getByRole('heading', { name: 'Průběh skenu' }),
    dialog.getByRole('combobox', { name: 'Filtrovat log podle webu' }),
    dialog.locator('footer'),
  ];
  const controlTops = await Promise.all(
    fixedControls.map(async (control) => (await control.boundingBox())!.y),
  );
  await scroll.evaluate((element) => {
    element.scrollTop = Math.min(
      250,
      (element.scrollHeight - element.clientHeight) / 2,
    );
    element.dispatchEvent(new Event('scroll'));
  });
  expect(await scroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(
    24,
  );
  await expect(latest).toBeVisible();
  const anchor = await scroll.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const row = Array.from(
      element.querySelectorAll<HTMLElement>('li[data-event-id]'),
    ).find((candidate) => candidate.getBoundingClientRect().top >= bounds.top);
    return { id: row!.dataset.eventId!, top: row!.getBoundingClientRect().top };
  });
  const anchoredRow = dialog.locator(`li[data-event-id="${anchor.id}"]`);
  const beforePrepend = await rows.count();
  await page.clock.fastForward(3100);
  await expect(rows).toHaveCount(beforePrepend + 1);
  expect((await anchoredRow.boundingBox())!.y).toBeCloseTo(anchor.top, 0);
  for (const [index, control] of fixedControls.entries()) {
    expect((await control.boundingBox())!.y).toBeCloseTo(controlTops[index], 0);
    await expect(control).toBeInViewport();
  }
  await expect(latest).toBeVisible();
  await latest.click();
  await expect(latest).toHaveCount(0);
  expect(await scroll.evaluate((element) => element.scrollTop)).toBe(0);
  const followingCount = await rows.count();
  await page.clock.fastForward(3100);
  await expect(rows).toHaveCount(followingCount + 1);
  expect(await scroll.evaluate((element) => element.scrollTop)).toBe(0);
  expect(apiRequests).toEqual([]);
});

test('stops live events when paused or completed and resumes the same run', async ({
  page,
}) => {
  await page.clock.install({ time: new Date('2026-09-15T10:00:00Z') });
  await page.goto('/ux/2');
  await expect(
    page.getByRole('button', { name: 'Skenovat znovu', exact: true }),
  ).toBeVisible();
  await page.clock.pauseAt(new Date('2026-09-15T10:01:00Z'));
  await page
    .getByRole('button', { name: 'Skenovat znovu', exact: true })
    .click();
  await page.clock.fastForward(4000);
  await page.getByRole('button', { name: 'Pozastavit', exact: true }).click();
  const trigger = page.getByRole('button', {
    name: 'Průběh skenu',
    exact: true,
  });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'Průběh skenu' });
  const rows = dialog.locator('li[data-event-id]');
  await expect(dialog.getByText('Běh #7 · aktuální')).toBeVisible();
  const pausedCount = await rows.count();
  await page.clock.fastForward(10000);
  await expect(rows).toHaveCount(pausedCount);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Pokračovat', exact: true }).click();
  await trigger.click();
  await expect(dialog.getByText('Běh #7 · aktuální')).toBeVisible();
  const resumedCount = await rows.count();
  await page.clock.fastForward(3100);
  await expect(rows).toHaveCount(resumedCount + 1);
  const complete = dialog.getByRole('button', {
    name: 'Dokončit ukázkový sken',
    exact: true,
  });
  await complete.click();
  await expect(complete).toHaveCount(0);
  const completedCount = await rows.count();
  await page.clock.fastForward(10000);
  await expect(rows).toHaveCount(completedCount);
  await page.keyboard.press('Escape');
  await expect(
    page.getByRole('button', { name: 'Skenovat znovu', exact: true }),
  ).toBeVisible();
});

test('identifies archived logs and keeps them static while the current run is active', async ({
  page,
}) => {
  await page.clock.install({ time: new Date('2026-09-15T10:00:00Z') });
  await page.goto('/ux/2');
  await expect(
    page.getByRole('button', { name: 'Skenovat znovu', exact: true }),
  ).toBeVisible();
  await page.clock.pauseAt(new Date('2026-09-15T10:01:00Z'));
  await page
    .getByRole('button', { name: 'Skenovat znovu', exact: true })
    .click();
  await page.clock.fastForward(4000);
  await page
    .getByRole('navigation', { name: 'Zobrazení mapy' })
    .getByRole('button', { name: /Historie/ })
    .click();
  await page.getByRole('button', { name: /^Sken #3 Archiv/ }).click();
  const trigger = page.getByRole('button', {
    name: 'Průběh skenu',
    exact: true,
  });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'Průběh skenu' });
  const rows = dialog.locator('li[data-event-id]');
  await expect(dialog.getByText('Běh #3 · archiv')).toBeVisible();
  await expect(
    dialog.getByRole('button', { name: 'Dokončit ukázkový sken' }),
  ).toHaveCount(0);
  const archivedIds = await rows.evaluateAll((elements) =>
    elements.map((element) => element.getAttribute('data-event-id')),
  );
  await page.clock.fastForward(15000);
  expect(
    await rows.evaluateAll((elements) =>
      elements.map((element) => element.getAttribute('data-event-id')),
    ),
  ).toEqual(archivedIds);
  await dialog.getByRole('checkbox', { name: 'Jen chyby' }).check();
  await expect(dialog.getByText('Běh #3 · archiv')).toBeVisible();
  await page.keyboard.press('Escape');
  await page
    .getByRole('button', { name: 'Zpět k aktuálnímu', exact: true })
    .click();
  await trigger.click();
  await expect(dialog.getByText('Běh #7 · aktuální')).toBeVisible();
  await expect(
    dialog.getByRole('button', { name: 'Dokončit ukázkový sken' }),
  ).toBeVisible();
});
