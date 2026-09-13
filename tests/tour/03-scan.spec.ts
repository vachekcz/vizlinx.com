import { expect, test } from '@playwright/test';
import { capture } from './capture';

// Section 03: the server-side scanner on /scan in its initial state. The tour
// runs against `wrangler dev` with a fresh local D1, so the saved-maps list is
// empty by construction. No scan is ever started: the gallery must not crawl
// anyone's website.

test('scan workspace before the first map', async ({ page }, testInfo) => {
  await page.goto('/scan?theme=signal');
  await expect(
    page.getByRole('heading', {
      level: 1,
      name: /Objev propojení vlastních webů/,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { level: 2, name: 'Nová mapa' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Spustit sken' }),
  ).toBeEnabled();
  // "Připojuji se k serveru…" is the loader of the saved-maps card; wait for
  // the text that only the ready, empty state renders.
  await expect(page.getByText('Zatím tu nejsou žádné mapy.')).toBeVisible();
  await capture(page, testInfo, '03-scan/01-nova-mapa', {
    title: 'Skener: nová mapa',
    description:
      'Výchozí stav serverového skeneru bez uložených map: formulář pro 1 až 3 weby, interval požadavků, vysvětlení průběhu skenu a prázdný seznam uložených map.',
  });
});
