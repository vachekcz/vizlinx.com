import { expect, test } from '@playwright/test';

const label = (url: string) => `Otevřít ${url} v nové kartě`;

test('opens map and inspector URLs in a new tab without selecting or dragging', async ({
  page,
  context,
}) => {
  await context.route('https://*.example/**', (route) =>
    route.fulfill({ body: 'Destination page' }),
  );
  await page.goto('/');
  const inspector = page.getByRole('complementary', { name: 'Detail výběru' });
  await inspector.getByRole('button', { name: 'Prozkoumat 6 stránek' }).click();
  const graph = page.getByLabel('Interaktivní mapa odkazů mezi weby');
  const mapLink = graph.getByRole('link', {
    name: label('https://atlas.example/projects'),
    exact: true,
  });
  await expect(mapLink).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  const frame = await graph.getAttribute('viewBox');
  const camera = await page
    .getByTestId('graph-camera')
    .getAttribute('transform');
  const initialUrl = page.url();
  const popupPromise = page.waitForEvent('popup');
  await mapLink.click();
  const popup = await popupPromise;
  await popup.waitForLoadState();
  expect(popup.url()).toBe('https://atlas.example/projects');
  expect(await popup.evaluate(() => window.opener === null)).toBe(true);
  await popup.close();
  expect(page.url()).toBe(initialUrl);
  await expect(
    inspector.getByRole('heading', { name: 'atlas.example', exact: true }),
  ).toBeVisible();
  await expect(graph).toHaveAttribute('viewBox', frame!);
  await expect(page.getByTestId('graph-camera')).toHaveAttribute(
    'transform',
    camera!,
  );
  await expect(graph).not.toHaveClass(/is-dragging/);

  await graph
    .getByRole('button', {
      name: 'Stránka atlas.example/projects',
      exact: true,
    })
    .press('Enter');
  const inspectorLink = inspector
    .getByRole('link', {
      name: label('https://atlas.example/projects'),
      exact: true,
    })
    .first();
  await expect(inspectorLink).toBeVisible();
  await inspectorLink.focus();
  const keyboardPopupPromise = page.waitForEvent('popup');
  await inspectorLink.press('Enter');
  const keyboardPopup = await keyboardPopupPromise;
  await keyboardPopup.waitForLoadState();
  expect(keyboardPopup.url()).toBe('https://atlas.example/projects');
  await keyboardPopup.close();
  await expect(
    graph.getByRole('button', {
      name: 'Stránka atlas.example/projects',
      exact: true,
    }),
  ).toHaveAttribute('aria-pressed', 'true');
});

test('exposes both endpoints in lists, link details and the table', async ({
  page,
}) => {
  await page.goto('/');
  const inspector = page.getByRole('complementary', { name: 'Detail výběru' });
  await expect(
    inspector.getByRole('link', {
      name: label('https://atlas.example'),
      exact: true,
    }),
  ).toHaveAttribute('href', 'https://atlas.example/');
  await page
    .getByRole('button', {
      name: 'Propojení atlas.example → journal.example, 5 vazeb',
      exact: true,
    })
    .press('Enter');
  const row = inspector.locator('.detail-link-row').first();
  const source = row.getByRole('link').first();
  const target = row.getByRole('link').last();
  const sourceUrl = await source.getAttribute('href');
  const targetUrl = await target.getAttribute('href');
  expect(sourceUrl).toContain('atlas.example');
  expect(targetUrl).toContain('journal.example');
  await row.getByRole('button', { name: /^Detail odkazu/ }).click();
  await expect(inspector.locator('.url-stop a')).toHaveCount(2);
  await expect(inspector.locator('.url-stop a').first()).toHaveAttribute(
    'href',
    sourceUrl!,
  );
  await expect(inspector.locator('.url-stop a').last()).toHaveAttribute(
    'href',
    targetUrl!,
  );
  await page
    .getByRole('button', { name: 'Zobrazit tabulku', exact: true })
    .click();
  await expect(page.locator('tbody tr').first().getByRole('link')).toHaveCount(
    2,
  );
  expect(
    await page.locator('button a, a button, [role="button"] a').count(),
  ).toBe(0);
  for (const link of await page.locator('a.external-link').all()) {
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  }
});

test('opens touch links from the enlarged target without covering adjacent pages', async ({
  page,
  context,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'Touch target interaction');
  await context.route('https://*.example/**', (route) =>
    route.fulfill({ body: 'Destination page' }),
  );
  await page.goto('/');
  await page.getByRole('button', { name: 'Prozkoumat 6 stránek' }).click();
  const graph = page.getByLabel('Interaktivní mapa odkazů mezi weby');
  for (const zoom of [false, true]) {
    if (zoom)
      await page
        .getByRole('button', { name: 'Přiblížit mapu', exact: true })
        .click();
    const mapLink = graph.getByRole('link', {
      name: label('https://atlas.example/projects'),
      exact: true,
    });
    await mapLink.scrollIntoViewIfNeeded();
    const hit = (await mapLink.locator('.graph-external-hit').boundingBox())!;
    const visual = (await mapLink
      .locator('.graph-external-background')
      .boundingBox())!;
    const tap = { x: hit.x + hit.width / 2, y: hit.y + hit.height * 0.12 };
    expect(tap.y).toBeLessThan(visual.y);
    const overlaps = await graph.locator('.page-node').evaluateAll((nodes) => {
      return nodes.some((node, index) => {
        const hit = node
          .parentElement!.querySelector('.graph-external-hit')!
          .getBoundingClientRect();
        return nodes.some((other, otherIndex) => {
          if (otherIndex === index) return false;
          const box = other.getBoundingClientRect();
          return (
            hit.left < box.right &&
            hit.right > box.left &&
            hit.top < box.bottom &&
            hit.bottom > box.top
          );
        });
      });
    });
    expect(overlaps).toBe(false);
    const popupPromise = page.waitForEvent('popup');
    await page.touchscreen.tap(tap.x, tap.y);
    const popup = await popupPromise;
    await popup.waitForLoadState();
    expect(popup.url()).toBe('https://atlas.example/projects');
    await popup.close();
    await expect(
      page
        .getByRole('complementary', { name: 'Detail výběru' })
        .getByRole('heading', { name: 'atlas.example', exact: true }),
    ).toBeVisible();
    await expect(graph).not.toHaveClass(/is-dragging/);
  }
});
