import { expect, test, type Page } from '@playwright/test';
import { capture } from './capture';

// Section 02: design studies — two static archive pages from public/ and the
// interactive connection lab. The archives are only "rendered" once every
// mockup image has decoded, so wait for that before capturing.

async function expectImagesLoaded(page: Page, count: number) {
  await expect(page.locator('img')).toHaveCount(count);
  await expect
    .poll(() =>
      page
        .locator('img')
        .evaluateAll((images) =>
          images.every(
            (image) =>
              image instanceof HTMLImageElement &&
              image.complete &&
              image.naturalWidth > 0,
          ),
        ),
    )
    .toBe(true);
}

test('palette archive, connection archive and the connection lab', async ({
  page,
}, testInfo) => {
  await page.goto('/palettes/');
  await expect(
    page.getByRole('heading', { level: 1, name: /Pět směrů/ }),
  ).toBeVisible();
  await expect(page.locator('article')).toHaveCount(5);
  await expectImagesLoaded(page, 5);
  await capture(page, testInfo, '02-studie/01-barevne-palety', {
    title: 'Pět barevných variant',
    description:
      'Archiv původních mockupů Signal, Carbon, Midnight, Electric a Editorial. Do dema se dostaly Signal (den) a Midnight (noc).',
  });

  await page.goto('/connections/');
  await expect(
    page.getByRole('heading', {
      level: 1,
      name: /Jak silně jsou weby propojené/,
    }),
  ).toBeVisible();
  await expect(page.locator('article')).toHaveCount(8);
  await expectImagesLoaded(page, 8);
  await capture(page, testInfo, '02-studie/02-styly-spojnic', {
    title: 'Osm způsobů zobrazení vazeb',
    description:
      'Archiv návrhů spojnic od Hedvábí po Metro. Výchozí mapa používá Hedvábí; ostatní styly se zobrazí jen při otevření konkrétního návrhu z archivu.',
  });

  await page.goto('/connections/lab/?theme=signal');
  await expect(
    page.getByRole('heading', {
      level: 1,
      name: 'Od vlákna k dominantní vazbě.',
    }),
  ).toBeVisible();
  await expect(page.getByRole('table')).toBeVisible();
  await capture(page, testInfo, '02-studie/03-laborator-spojnic', {
    title: 'Laboratoř spojnic',
    description:
      'Samostatná studie: jak se vybrané styly spojnic mění s rostoucím počtem vazeb, v matici pevných hodnot i s plynulým posuvníkem.',
  });
});
