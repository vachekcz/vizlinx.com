import { expect, test } from '@playwright/test';

test('starts blank, counts filled fields and validates individual domains with keyboard focus', async ({
  page,
}) => {
  await page.goto('/ux/2');
  await page.getByRole('button', { name: 'Nová mapa', exact: true }).click();
  const form = page.locator('.ux-new-map form');
  const count = form.locator('.ux-form-heading > span');
  const submit = form.getByRole('button', {
    name: 'Vytvořit mapu a spustit sken',
    exact: true,
  });
  const first = form.getByRole('textbox', { name: 'Web 1', exact: true });
  await expect(form.getByRole('textbox')).toHaveCount(1);
  await expect(first).toHaveValue('');
  await expect(first).toBeFocused();
  await expect(count).toHaveText('0 ze 3 webů');
  await submit.click();
  await expect(first).toHaveAttribute('aria-invalid', 'true');
  await expect(first).toHaveAccessibleDescription('Zadej alespoň jeden web.');
  await expect(first).toBeFocused();
  await first.fill(' https://atlas.example/journal ');
  await expect(first).toHaveAttribute('aria-invalid', 'false');
  await expect(count).toHaveText('1 ze 3 webů');
  await form
    .getByRole('button', { name: 'Přidat další web', exact: true })
    .click();
  const second = form.getByRole('textbox', { name: 'Web 2', exact: true });
  await expect(second).toBeFocused();
  await form
    .getByRole('button', { name: 'Přidat další web', exact: true })
    .click();
  const third = form.getByRole('textbox', { name: 'Web 3', exact: true });
  await expect(third).toBeFocused();
  await expect(count).toHaveText('1 ze 3 webů');
  await expect(
    form.getByRole('button', { name: 'Přidat další web', exact: true }),
  ).toHaveCount(0);
  await second.fill('not-a-web');
  await third.fill('another.example');
  await expect(count).toHaveText('3 ze 3 webů');
  await submit.click();
  await expect(second).toHaveAccessibleDescription('Zkontroluj adresu webu.');
  await expect(second).toBeFocused();
  await expect(third).toHaveAttribute('aria-invalid', 'false');
  await second.fill('ATLAS.example');
  await expect(second).toHaveAccessibleDescription('Tento web už máš zadaný.');
  await submit.click();
  await expect(second).toBeFocused();
  await form
    .getByRole('button', { name: 'Odebrat web 1', exact: true })
    .click();
  await expect(first).toHaveValue('ATLAS.example');
  await expect(first).toBeFocused();
  await expect(form.getByRole('alert')).toHaveCount(0);
  await expect(count).toHaveText('2 ze 3 webů');
  await form
    .getByRole('button', { name: 'Odebrat web 2', exact: true })
    .click();
  await expect(count).toHaveText('1 ze 3 webů');
  await expect(form.getByRole('button', { name: /^Odebrat web/ })).toHaveCount(
    0,
  );
  await page.getByRole('button', { name: 'Zpět k mapě', exact: true }).click();
  await expect(page.locator('.ux-scan-row')).toHaveCount(2);
  await expect(page.locator('.ux-scan-row').first()).toContainText(
    'atlas.example',
  );
  await expect(page.locator('.ux-scan-row').last()).toContainText(
    'journal.example',
  );
});

test('creates a demo map from filled fields without crawling and starts the next form blank', async ({
  page,
}, testInfo) => {
  const unexpectedRequests: string[] = [];
  const appOrigin = new URL(testInfo.project.use.baseURL!).origin;
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin !== appOrigin || url.pathname.startsWith('/api/')) {
      unexpectedRequests.push(request.url());
    }
  });
  await page.goto('/ux/2');
  await page.getByRole('button', { name: 'Nová mapa', exact: true }).click();
  const form = page.locator('.ux-new-map form');
  await expect(
    form.getByText('Bez účtu. Sken pokračuje i po zavření karty.', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    form.getByText('Nejvýše 100 stránek na web.', { exact: false }),
  ).toBeVisible();
  await expect(
    form.getByText('Procházíme veřejné HTML;', { exact: false }),
  ).toBeVisible();
  await expect(
    form.getByText('V této studii se zobrazí ukázková data.', { exact: false }),
  ).toBeVisible();
  await form
    .getByRole('button', { name: 'Přidat další web', exact: true })
    .click();
  await form
    .getByRole('textbox', { name: 'Web 2', exact: true })
    .fill(' https://NEW.example/resources ');
  await form
    .getByRole('button', { name: 'Přidat další web', exact: true })
    .click();
  await expect(form.locator('.ux-form-heading > span')).toHaveText(
    '1 ze 3 webů',
  );
  await form
    .getByRole('button', { name: 'Vytvořit mapu a spustit sken', exact: true })
    .click();
  await expect(form).toHaveCount(0);
  await expect(page.locator('.ux-scan-row')).toHaveCount(1);
  await expect(page.locator('.ux-scan-row')).toContainText('new.example');
  await expect(page.locator('.ux-status')).toContainText('Skenování probíhá');
  await expect(
    page.getByRole('status').filter({ hasText: 'Ukázková mapa vytvořena' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Nová mapa', exact: true }).click();
  await expect(form.getByRole('textbox')).toHaveCount(1);
  await expect(form.getByRole('textbox')).toHaveValue('');
  await expect(form.getByRole('alert')).toHaveCount(0);
  await expect(form.locator('.ux-form-heading > span')).toHaveText(
    '0 ze 3 webů',
  );
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(page.viewportSize()!.width);
  expect(unexpectedRequests).toEqual([]);
});
