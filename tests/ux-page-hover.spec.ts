import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

async function openExpandedAtlas(page: Page, mobile: boolean, query = '') {
  await page.goto(`/ux/2${query}`);
  if (mobile) {
    await page.getByRole('button', { name: /Skenované weby ·/ }).click();
  }
  await page
    .getByRole('button', { name: 'atlas.example', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Prozkoumat 5 stránek', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Zavřít detail', exact: true })
    .click();
  await page.evaluate(() => document.fonts.ready);
}

for (const query of ['', '?hover=pulse']) {
  test(`previews only the hovered page's links without selecting or moving it (${query || 'default'})`, async ({
    page,
  }, testInfo) => {
    await openExpandedAtlas(page, testInfo.project.name === 'mobile', query);
    const graph = page.locator('.graph');
    const project = graph.getByRole('button', {
      name: 'Stránka atlas.example/projects',
      exact: true,
    });
    const viewBox = await graph.getAttribute('viewBox');
    const camera = await page
      .getByTestId('graph-camera')
      .getAttribute('transform');
    const frame = await project.locator('text').boundingBox();
    await project.hover();
    await expect(project).toHaveAttribute('data-highlight-page', 'atlas-1');
    await expect(project).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('.ux-detail')).toHaveCount(0);
    expect(
      await graph
        .locator('[data-highlight-link]')
        .evaluateAll((elements) =>
          elements
            .map((element) => element.getAttribute('data-highlight-link'))
            .sort(),
        ),
    ).toEqual([
      'atlas-collective-1',
      'atlas-index-1',
      'atlas-journal-1',
      'atlas-objects-1',
      'journal-atlas-0',
    ]);
    await expect(graph.locator('.graph-highlight-travel')).toHaveCount(5);
    for (const path of await graph
      .locator('.page-edge:not([data-highlight-link]) > path[marker-end]')
      .all()) {
      await expect(path).toHaveAttribute('opacity', '0.06');
    }
    await expect(graph).toHaveAttribute('viewBox', viewBox!);
    await expect(page.getByTestId('graph-camera')).toHaveAttribute(
      'transform',
      camera!,
    );
    expect(await project.locator('text').boundingBox()).toEqual(frame);
    await expect(graph.locator('.graph-highlight-halo').first()).toHaveCSS(
      'opacity',
      '0.0425',
    );
    await graph
      .getByRole('button', {
        name: 'Stránka atlas.example/partners',
        exact: true,
      })
      .hover();
    expect(
      await graph
        .locator('[data-highlight-link]')
        .evaluateAll((elements) =>
          elements
            .map((element) => element.getAttribute('data-highlight-link'))
            .sort(),
        ),
    ).toEqual(['atlas-collective-4', 'atlas-journal-4']);
    await graph
      .getByRole('link', {
        name: 'Otevřít https://atlas.example/partners v nové kartě',
        exact: true,
      })
      .hover();
    await expect(graph.locator('[data-highlight-link]')).toHaveCount(0);
    await expect(graph.locator('[data-highlight-page]')).toHaveCount(0);
    await expect(page.locator('.ux-detail')).toHaveCount(0);
    await project.click();
    await expect(project).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.ux-detail h2')).toHaveText('Naše projekty');
    await expect(graph.locator('[data-highlight-link]')).toHaveCount(0);
  });
}

test('restores the selected page after keyboard preview and ignores touch hover', async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openExpandedAtlas(page, testInfo.project.name === 'mobile');
  const graph = page.locator('.graph');
  const project = graph.getByRole('button', {
    name: 'Stránka atlas.example/projects',
    exact: true,
  });
  const about = graph.getByRole('button', {
    name: 'Stránka atlas.example/about',
    exact: true,
  });
  await project.dispatchEvent('pointermove', { pointerType: 'touch' });
  await expect(graph.locator('[data-highlight-page]')).toHaveCount(0);
  await project.click();
  await page.keyboard.press('Tab');
  await about.focus();
  await expect(about).toHaveAttribute('data-highlight-page', 'atlas-2');
  await expect(project).toHaveAttribute('aria-pressed', 'true');
  await expect(about).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.ux-detail h2')).toHaveText('Naše projekty');
  await expect(graph.locator('.graph-highlight-travel').first()).toBeHidden();
  const originalLink = graph
    .getByRole('button', {
      name: 'Odkaz atlas.example/projects → journal.example/stories/atlas',
      exact: true,
    })
    .locator(':scope > path[marker-end]');
  await expect(originalLink).toHaveAttribute('opacity', '0.06');
  await graph
    .getByRole('link', {
      name: 'Otevřít https://atlas.example/about v nové kartě',
      exact: true,
    })
    .focus();
  await expect(graph.locator('[data-highlight-page]')).toHaveCount(0);
  await expect(originalLink).toHaveAttribute('opacity', '1');
  await expect(project).toHaveAttribute('aria-pressed', 'true');
  await about.focus();
  await page.keyboard.press('Enter');
  await expect(about).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.ux-detail h2')).toHaveText('O studiu');
  await expect(graph.locator('[data-highlight-page]')).toHaveCount(0);
});
