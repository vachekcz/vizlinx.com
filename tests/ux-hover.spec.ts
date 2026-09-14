import { expect, test } from '@playwright/test';

for (const mode of ['pulse', 'quiet', 'focus']) {
  test(`${mode} previews the exact site and direction without changing the selection or layout`, async ({
    page,
  }, testInfo) => {
    await page.goto(`/ux/2?hover=${mode}`);
    if (testInfo.project.name === 'mobile') {
      await page.getByRole('button', { name: /Skenované weby ·/ }).click();
    }
    const graph = page.locator('.graph');
    const viewBox = await graph.getAttribute('viewBox');
    const camera = await page
      .getByTestId('graph-camera')
      .getAttribute('transform');
    const circle = graph.locator('.cluster-fill[data-site="atlas"]');
    const radius = await circle.getAttribute('r');
    const atlas = page.getByRole('button', {
      name: 'atlas.example',
      exact: true,
    });
    await atlas.hover();
    await expect(graph.locator('[data-highlight-site="atlas"]')).toHaveCount(1);
    await expect(page.locator('.ux-detail')).toHaveCount(0);
    await expect(
      graph.getByRole('button', { name: 'Doména atlas.example', exact: true }),
    ).toHaveAttribute('aria-pressed', 'false');
    await expect(circle).toHaveAttribute('r', radius!);
    await expect(graph).toHaveAttribute('viewBox', viewBox!);
    await expect(page.getByTestId('graph-camera')).toHaveAttribute(
      'transform',
      camera!,
    );
    if (mode === 'focus') {
      await expect
        .poll(() =>
          graph
            .locator('.graph-preview-muted')
            .first()
            .evaluate((element) => getComputedStyle(element).opacity),
        )
        .toBe('0.2');
    } else {
      await expect(graph.locator('.graph-preview-muted')).toHaveCount(0);
    }
    await page
      .locator('.ux-scan-row')
      .first()
      .locator('.external-link')
      .hover();
    await expect(graph.locator('[data-highlight-site]')).toHaveCount(0);
    await atlas.click();
    const detail = page.getByRole('complementary', { name: 'Detail výběru' });
    const outgoing = detail.getByRole('button', {
      name: 'journal.example 5 odkazů z atlas.example',
      exact: true,
    });
    const incoming = detail.getByRole('button', {
      name: 'journal.example 3 odkazy na atlas.example',
      exact: true,
    });
    await outgoing.hover();
    await expect(graph.locator('[data-highlight-connection]')).toHaveAttribute(
      'data-highlight-connection',
      'atlas:journal',
    );
    await expect(graph.locator('[data-highlight-site]')).toHaveCount(2);
    await expect(
      detail.getByRole('heading', { name: 'atlas.example', exact: true }),
    ).toBeVisible();
    await expect(page.locator('.ux-scan-row.is-selected')).toContainText(
      'atlas.example',
    );
    await expect(graph.locator('.graph-highlight-travel')).toHaveCount(
      mode === 'pulse' ? 1 : 0,
    );
    await incoming.hover();
    await expect(graph.locator('[data-highlight-connection]')).toHaveAttribute(
      'data-highlight-connection',
      'journal:atlas',
    );
    await page
      .getByRole('heading', { name: 'Studio Atlas', exact: true })
      .hover();
    await expect(graph.locator('[data-highlight-connection]')).toHaveCount(0);
    await expect(graph.locator('.graph-preview-muted')).toHaveCount(0);
    await detail
      .getByRole('button', { name: 'Prozkoumat 5 stránek', exact: true })
      .click();
    await outgoing.hover();
    await expect(
      graph.locator(
        '[data-highlight-connection="atlas:journal"] .page-edge .graph-highlight-path',
      ),
    ).toHaveCount(5);
  });
}

test('switches replay variants and restores the detail after a mobile demo', async ({
  page,
}, testInfo) => {
  await page.goto('/ux/2?hover=pulse');
  if (testInfo.project.name === 'mobile') {
    await page.getByRole('button', { name: /Skenované weby ·/ }).click();
  }
  await page
    .getByRole('button', { name: 'atlas.example', exact: true })
    .click();
  for (const [label, mode] of [
    ['2 · Klid', 'quiet'],
    ['3 · Soustředění', 'focus'],
    ['1 · Puls', 'pulse'],
  ]) {
    await page.getByRole('button', { name: label, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`hover=${mode}`));
    await page
      .getByRole('button', { name: 'Ukázka propojení', exact: true })
      .click();
    await expect(page.locator('.graph')).toHaveAttribute(
      'data-highlight-style',
      mode,
    );
    await expect(
      page.locator('[data-highlight-connection="atlas:journal"]'),
    ).toHaveCount(1);
    if (testInfo.project.name === 'mobile') {
      await expect(page.locator('.ux-floating-detail')).toBeHidden();
    }
    await expect(page.locator('.ux-scan-row.is-selected')).toContainText(
      'atlas.example',
    );
  }
  await expect(page.locator('[data-highlight-connection]')).toHaveCount(0, {
    timeout: 5000,
  });
  await expect(page.locator('.ux-floating-detail')).toBeVisible();
  await expect(page.locator('.ux-detail h2')).toHaveText('atlas.example');
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(page.viewportSize()!.width);
  await page
    .getByRole('button', { name: 'Zavřít porovnání', exact: true })
    .click();
  await expect(page).not.toHaveURL(/hover=/);
  await expect(
    page.getByRole('region', { name: 'Porovnání hover efektů' }),
  ).toHaveCount(0);
});

test('supports keyboard preview and reduced motion without losing navigation', async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/ux/2?hover=pulse');
  if (testInfo.project.name === 'mobile') {
    await page.getByRole('button', { name: /Skenované weby ·/ }).click();
  }
  await page.keyboard.press('Tab');
  await page
    .getByRole('button', { name: 'atlas.example', exact: true })
    .focus();
  await expect(page.locator('[data-highlight-site="atlas"]')).toHaveCount(1);
  await expect(page.locator('.graph-highlight-pulse')).toBeHidden();
  await page.keyboard.press('Enter');
  const outgoing = page.getByRole('button', {
    name: 'journal.example 5 odkazů z atlas.example',
    exact: true,
  });
  await outgoing.focus();
  await expect(
    page.locator('[data-highlight-connection="atlas:journal"]'),
  ).toHaveCount(1);
  await expect(page.locator('.graph-highlight-travel')).toBeHidden();
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('button', { name: 'Zpět na atlas.example', exact: true }),
  ).toBeFocused();
  await expect(page.locator('[data-highlight-connection]')).toHaveCount(0);
  await page.keyboard.press('Enter');
  await expect(outgoing).toBeFocused();
  await expect(
    page.locator('[data-highlight-connection="atlas:journal"]'),
  ).toHaveCount(1);
});
