import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { links, strengthLinks } from '../src/data';

for (const fixture of [
  { name: 'standard', path: '/', links },
  { name: 'strength', path: '/?density=scale', links: strengthLinks },
]) {
  test(`exports observation times matching the ${fixture.name} link inspector`, async ({
    page,
  }) => {
    await page.goto(fixture.path);
    await page.getByRole('button', { name: 'Zobrazit tabulku' }).click();
    const downloadPromise = page.waitForEvent('download');
    await page
      .getByRole('button', { name: 'Exportovat zobrazené odkazy do CSV' })
      .click();
    const download = await downloadPromise;
    const contents = await readFile((await download.path())!, 'utf8');
    const [header, ...rows] = contents
      .replace(/^\uFEFF/, '')
      .split('\r\n')
      .map((row) => row.slice(1, -1).split('\",\"'));
    const observedAtColumn = header.indexOf('observed_at');
    expect(observedAtColumn).toBeGreaterThanOrEqual(0);
    for (const row of rows) {
      expect(row[observedAtColumn]).toMatch(
        /^2026-09-11T\d{2}:\d{2}:00\.000Z$/,
      );
    }
    const inspectedIndex = 3;
    const observedAt = fixture.links[inspectedIndex].observedAt;
    expect(rows[inspectedIndex][observedAtColumn]).toBe(observedAt);
    await page
      .locator('tbody tr')
      .nth(inspectedIndex)
      .getByRole('button')
      .click();
    const timestamp = page
      .getByRole('complementary', { name: 'Detail výběru' })
      .locator('time');
    await expect(timestamp).toHaveAttribute('datetime', observedAt);
    await expect(timestamp).toHaveText(
      new Intl.DateTimeFormat('cs-CZ', {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: 'Europe/Prague',
      }).format(new Date(observedAt)),
    );
    expect(
      new Set(fixture.links.map((link) => link.observedAt)).size,
    ).toBeGreaterThan(1);
  });
}

test('describes external pages as known target URLs when expanding and collapsing', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByLabel('Další odkazované weby').check();
  await page
    .getByRole('button', { name: 'Doména archive.example', exact: true })
    .click();
  const inspector = page.getByRole('complementary', { name: 'Detail výběru' });
  await expect(
    inspector.getByRole('button', { name: /Prozkoumat/ }),
  ).toHaveCount(0);
  await inspector
    .getByRole('button', { name: 'Zobrazit známé cílové URL' })
    .click();
  await expect(
    page.getByRole('button', { name: /^Stránka archive.example/ }),
  ).toHaveCount(2);
  await inspector
    .getByRole('button', { name: 'Sbalit známé cílové URL' })
    .click();
  await expect(
    page.getByRole('button', { name: /^Stránka archive.example/ }),
  ).toHaveCount(0);
});

test('explains the empty connection list until the simulation discovers links', async ({
  page,
}) => {
  await page.clock.install();
  await page.goto('/');
  await page.getByRole('button', { name: 'Přehrát demo', exact: true }).click();
  const connections = page
    .getByRole('complementary', { name: 'Detail výběru' })
    .locator('.connection-list');
  await expect(connections).toHaveText(
    'Zatím žádné vazby. Objeví se v průběhu simulace.',
  );
  await page.clock.fastForward(3000);
  await expect(connections.locator('.empty-note')).toHaveCount(0);
  await expect(connections.getByRole('button').first()).toBeVisible();
});
