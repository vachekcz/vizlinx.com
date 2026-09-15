import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

async function openAtlas(page: Page, query = '') {
  await page.goto(`/ux/2${query}`);
  await expect(
    page.getByLabel('Interaktivní mapa odkazů mezi weby'),
  ).toHaveAttribute('data-framing-ready', 'true');
  await page
    .getByRole('button', { name: 'Doména atlas.example', exact: true })
    .press('Enter');
  await expect(
    page.getByRole('complementary', { name: 'Detail výběru' }),
  ).toBeVisible();
}

async function sceneGeometry(page: Page) {
  return page.locator('[data-drag-site]').evaluateAll((domains) =>
    domains.map((domain) => {
      const circle = domain.querySelector('circle')!;
      return {
        id: domain.getAttribute('data-drag-site'),
        x: circle.getAttribute('cx'),
        y: circle.getAttribute('cy'),
        radius: circle.getAttribute('r'),
      };
    }),
  );
}

async function touchDrag(
  page: Page,
  target: Locator,
  distance: number,
  cancel = false,
  start?: { x: number; y: number },
) {
  const bounds = (await target.boundingBox())!;
  const x = start?.x ?? bounds.x + bounds.width / 2;
  const y = start?.y ?? bounds.y + bounds.height / 2;
  const endY = Math.max(
    8,
    Math.min(page.viewportSize()!.height - 8, y + distance),
  );
  const session = await page.context().newCDPSession(page);
  try {
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x, y, id: 1 }],
    });
    for (let step = 1; step <= 8; step++) {
      await session.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x, y: y + ((endY - y) * step) / 8, id: 1 }],
      });
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve()),
          ),
      );
    }
    await session.send('Input.dispatchTouchEvent', {
      type: cancel ? 'touchCancel' : 'touchEnd',
      touchPoints: [],
    });
  } finally {
    await session.detach();
  }
}

test.describe('mobile map detail sheet', () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', 'Mobile sheet interaction');
  });

  for (const viewport of [
    { width: 390, height: 844 },
    { width: 320, height: 640 },
  ]) {
    test(`keeps all sheet states and map controls reachable at ${viewport.width} × ${viewport.height}`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      await openAtlas(page, '?hover=pulse');
      const sheet = page.locator('.ux-floating-detail');
      const header = sheet.locator('.ux-mobile-detail-header');
      const body = sheet.locator('.ux-detail');
      const camera = page.getByTestId('graph-camera');
      const cameraBefore = (await camera.getAttribute('transform'))!;
      const geometryBefore = await sceneGeometry(page);
      await expect(sheet).toHaveAttribute('data-sheet-position', 'half');
      await expect(header).toBeVisible();
      await expect(header).toContainText('atlas.example');
      const halfHeight = (await sheet.boundingBox())!.height;
      await header
        .getByRole('button', { name: 'Roztáhnout detail', exact: true })
        .click();
      await expect(sheet).toHaveAttribute('data-sheet-position', 'expanded');
      await expect
        .poll(async () => (await sheet.boundingBox())!.height)
        .toBeGreaterThan(halfHeight);
      const expanded = (await sheet.boundingBox())!;
      expect(expanded.y).toBeGreaterThanOrEqual(15);
      expect(expanded.x).toBeGreaterThanOrEqual(0);
      expect(expanded.x + expanded.width).toBeLessThanOrEqual(viewport.width);
      expect(expanded.y + expanded.height).toBeLessThan(viewport.height);
      for (const name of [
        'Zobrazit celou mapu',
        'Přiblížit mapu',
        'Obnovit rozložení',
      ]) {
        await page
          .getByRole('button', { name, exact: true })
          .click({ trial: true });
      }
      await header
        .getByRole('button', {
          name: 'Zmenšit detail na polovinu',
          exact: true,
        })
        .click();
      await expect(sheet).toHaveAttribute('data-sheet-position', 'half');
      await header
        .getByRole('button', { name: 'Sbalit detail', exact: true })
        .click();
      await expect(sheet).toHaveAttribute('data-sheet-position', 'collapsed');
      await expect(body).toBeHidden();
      await expect(sheet.locator('.ux-mobile-detail-content')).toHaveAttribute(
        'inert',
        '',
      );
      await expect(header).toContainText('atlas.example');
      await expect
        .poll(async () => (await sheet.boundingBox())!.height)
        .toBeLessThan(halfHeight);
      await header
        .getByRole('button', { name: 'Otevřít detail', exact: true })
        .click();
      await expect(sheet).toHaveAttribute('data-sheet-position', 'half');
      await expect(body).toBeVisible();
      await expect(camera).toHaveAttribute('transform', cameraBefore);
      expect(await sceneGeometry(page)).toEqual(geometryBefore);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(viewport.width);
      expect(
        await page.evaluate(() => document.documentElement.scrollHeight),
      ).toBeLessThanOrEqual(viewport.height + 1);
      await header
        .getByRole('button', { name: 'Zavřít detail', exact: true })
        .click();
      await expect(sheet).toHaveCount(0);
      await expect(page.locator('.graph [aria-pressed="true"]')).toHaveCount(0);
    });
  }

  test('keeps the complete detail path usable at half height on a short phone with the comparison bar', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await openAtlas(page, '?hover=pulse');
    const sheet = page.locator('.ux-floating-detail');
    const detail = sheet.locator('.ux-detail');
    const outgoing = detail.getByRole('button', {
      name: '5 odkazů ven: z atlas.example na journal.example',
      exact: true,
    });
    await outgoing.scrollIntoViewIfNeeded();
    const siteScroll = await detail.evaluate((element) => element.scrollTop);
    await outgoing.click();
    await expect(sheet).toHaveAttribute('data-sheet-position', 'half');
    const link = detail.locator('.ux-link-card').last();
    await link.scrollIntoViewIfNeeded();
    const connectionScroll = await detail.evaluate(
      (element) => element.scrollTop,
    );
    expect(connectionScroll).toBeGreaterThan(0);
    await page
      .getByRole('button', { name: 'Zobrazit celou mapu', exact: true })
      .click();
    await expect(sheet).toHaveAttribute('data-sheet-position', 'collapsed');
    await expect(detail).toBeHidden();
    await page
      .getByRole('button', { name: 'Otevřít detail', exact: true })
      .click();
    await expect(sheet).toHaveAttribute('data-sheet-position', 'half');
    await expect
      .poll(() => detail.evaluate((element) => element.scrollTop))
      .toBeCloseTo(connectionScroll, 0);
    await link.click();
    await expect(
      detail.getByRole('heading', { name: 'Odkud a kam', exact: true }),
    ).toBeVisible();
    for (const url of [
      'https://atlas.example/partners',
      'https://journal.example/about',
    ]) {
      await detail
        .getByRole('link', {
          name: `Otevřít ${url} v nové kartě`,
          exact: true,
        })
        .click({ trial: true });
    }
    await detail
      .getByRole('button', { name: 'Zpět na seznam odkazů', exact: true })
      .click();
    await expect(link).toBeFocused();
    await expect
      .poll(() => detail.evaluate((element) => element.scrollTop))
      .toBeCloseTo(connectionScroll, 0);
    await link.click({ trial: true });
    await detail
      .getByRole('button', { name: 'Zpět na atlas.example', exact: true })
      .click();
    await expect(outgoing).toBeFocused();
    await expect
      .poll(() => detail.evaluate((element) => element.scrollTop))
      .toBeCloseTo(siteScroll, 0);
    await outgoing.click({ trial: true });
    await expect(sheet).toHaveAttribute('data-sheet-position', 'half');
  });

  test('starts touch dragging directly on the visible handle on a narrow phone', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 844 });
    await openAtlas(page);
    const sheet = page.locator('.ux-floating-detail');
    const header = (await sheet
      .locator('.ux-mobile-detail-header')
      .boundingBox())!;
    const handle = { x: header.x + header.width / 2, y: header.y + 7.5 };
    expect(
      await page.evaluate(
        ({ x, y }) =>
          Boolean(
            document.elementFromPoint(x, y)?.closest('.ux-mobile-detail-grip'),
          ),
        handle,
      ),
    ).toBe(true);
    const grip = sheet.getByRole('button', {
      name: 'Změnit výšku detailu',
      exact: true,
    });
    await touchDrag(page, grip, -230, false, handle);
    await expect(sheet).toHaveAttribute('data-sheet-position', 'expanded');
  });

  test('keeps the site list and detail navigation usable on a very short phone', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 480 });
    await page.goto('/ux/2?hover=pulse');
    await expect(
      page.getByLabel('Interaktivní mapa odkazů mezi weby'),
    ).toHaveAttribute('data-framing-ready', 'true');
    const toggle = page.getByRole('button', { name: /Skenované weby ·/ });
    await toggle.scrollIntoViewIfNeeded();
    await toggle.click();
    const atlas = page.getByRole('button', {
      name: 'atlas.example',
      exact: true,
    });
    await atlas.click();
    const sheet = page.locator('.ux-floating-detail');
    const detail = sheet.locator('.ux-detail');
    await sheet
      .getByRole('button', { name: 'Roztáhnout detail', exact: true })
      .click();
    await expect(sheet).toHaveAttribute('data-sheet-position', 'expanded');
    await detail
      .getByRole('button', {
        name: '5 odkazů ven: z atlas.example na journal.example',
        exact: true,
      })
      .click();
    await detail.locator('.ux-link-card').last().click();
    await expect(
      detail.getByRole('heading', { name: 'Odkud a kam', exact: true }),
    ).toBeVisible();
    await detail
      .getByRole('button', { name: 'Zpět na seznam odkazů', exact: true })
      .click();
    await expect(detail.locator('.ux-link-card').last()).toBeFocused();
    await sheet
      .getByRole('button', { name: 'Zavřít detail', exact: true })
      .click();
    await expect(sheet).toHaveCount(0);
    await expect(toggle).toBeFocused();
    await toggle.click();
    await atlas.click({ trial: true });
  });

  test('supports continuous touch dragging, cancellation and keyboard size controls without moving the map', async ({
    page,
  }) => {
    await openAtlas(page);
    const sheet = page.locator('.ux-floating-detail');
    const grip = sheet.getByRole('button', {
      name: 'Změnit výšku detailu',
      exact: true,
    });
    const camera = page.getByTestId('graph-camera');
    const cameraBefore = (await camera.getAttribute('transform'))!;
    await touchDrag(page, grip, -230, true);
    await expect(sheet).toHaveAttribute('data-sheet-position', 'half');
    await touchDrag(page, grip, -230);
    await expect(sheet).toHaveAttribute('data-sheet-position', 'expanded');
    await touchDrag(page, grip, 450);
    await expect(sheet).toHaveAttribute('data-sheet-position', 'collapsed');
    await grip.press('ArrowUp');
    await expect(sheet).toHaveAttribute('data-sheet-position', 'half');
    await grip.press('ArrowUp');
    await expect(sheet).toHaveAttribute('data-sheet-position', 'expanded');
    await grip.press('ArrowDown');
    await expect(sheet).toHaveAttribute('data-sheet-position', 'half');
    await grip.press('Home');
    await expect(sheet).toHaveAttribute('data-sheet-position', 'collapsed');
    await grip.press('End');
    await expect(sheet).toHaveAttribute('data-sheet-position', 'expanded');
    await expect(grip).toBeFocused();
    const collapse = sheet.getByRole('button', {
      name: 'Sbalit detail',
      exact: true,
    });
    await collapse.focus();
    await page.keyboard.press('Enter');
    await expect(sheet).toHaveAttribute('data-sheet-position', 'collapsed');
    const reopen = sheet.getByRole('button', {
      name: 'Otevřít detail',
      exact: true,
    });
    await expect(reopen).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(sheet).toHaveAttribute('data-sheet-position', 'half');
    await expect(collapse).toBeFocused();
    await grip.press('End');
    await expect(sheet).toHaveAttribute('data-sheet-position', 'expanded');
    await expect(camera).toHaveAttribute('transform', cameraBefore);
    await page
      .getByRole('button', { name: 'Přiblížit mapu', exact: true })
      .hover();
    await expect(page.getByRole('tooltip')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('tooltip')).toBeHidden();
    await expect(sheet).toHaveAttribute('data-sheet-position', 'expanded');
    await expect(grip).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Doména atlas.example', exact: true }),
    ).toBeFocused();
  });

  test('preserves scroll, selected links and the return path while collapsing and expanding', async ({
    page,
  }) => {
    await openAtlas(page);
    const sheet = page.locator('.ux-floating-detail');
    const header = sheet.locator('.ux-mobile-detail-header');
    const detail = sheet.locator('.ux-detail');
    await detail
      .getByRole('button', {
        name: '5 odkazů ven: z atlas.example na journal.example',
        exact: true,
      })
      .click();
    await expect(sheet).toHaveAttribute('data-sheet-position', 'half');
    const lastLink = detail.locator('.ux-link-card').last();
    await lastLink.scrollIntoViewIfNeeded();
    const connectionScroll = await detail.evaluate(
      (element) => element.scrollTop,
    );
    expect(connectionScroll).toBeGreaterThan(0);
    await header
      .getByRole('button', { name: 'Sbalit detail', exact: true })
      .click();
    await expect(detail).toBeHidden();
    await header
      .getByRole('button', { name: 'Otevřít detail', exact: true })
      .click();
    await expect(detail).toBeVisible();
    await expect
      .poll(() => detail.evaluate((element) => element.scrollTop))
      .toBeCloseTo(connectionScroll, 0);
    await lastLink.click();
    await expect(
      detail.getByRole('heading', { name: 'Odkud a kam', exact: true }),
    ).toBeVisible();
    await expect(sheet).toHaveAttribute('data-sheet-position', 'half');
    await header
      .getByRole('button', { name: 'Roztáhnout detail', exact: true })
      .click();
    for (const url of [
      'https://atlas.example/partners',
      'https://journal.example/about',
    ]) {
      const anchor = detail.getByRole('link', {
        name: `Otevřít ${url} v nové kartě`,
        exact: true,
      });
      await expect(anchor).toHaveAttribute('href', url);
      await expect(anchor).toHaveAttribute('target', '_blank');
      await expect(anchor).toHaveAttribute('rel', 'noopener noreferrer');
    }
    await header
      .getByRole('button', { name: 'Sbalit detail', exact: true })
      .click();
    await expect(sheet).toHaveAttribute('data-sheet-position', 'collapsed');
    await expect(page.locator('.ux-scan-row.is-selected')).toContainText(
      'atlas.example',
    );
    await header
      .getByRole('button', { name: 'Otevřít detail', exact: true })
      .click();
    await header
      .getByRole('button', { name: 'Roztáhnout detail', exact: true })
      .click();
    await detail
      .getByRole('button', { name: 'Zpět na seznam odkazů', exact: true })
      .click();
    await expect(sheet).toHaveAttribute('data-sheet-position', 'expanded');
    await expect(lastLink).toBeFocused();
    await detail
      .getByRole('button', { name: 'Zpět na atlas.example', exact: true })
      .click();
    await expect(sheet).toHaveAttribute('data-sheet-position', 'expanded');
    await expect(
      detail.getByRole('heading', { name: 'atlas.example', exact: true }),
    ).toBeVisible();
  });

  test('scrolls detail content by touch without resizing and excludes collapsed content from keyboard focus', async ({
    page,
  }) => {
    await openAtlas(page);
    const sheet = page.locator('.ux-floating-detail');
    const header = sheet.locator('.ux-mobile-detail-header');
    const detail = sheet.locator('.ux-detail');
    await detail
      .getByRole('button', {
        name: '5 odkazů ven: z atlas.example na journal.example',
        exact: true,
      })
      .click();
    await detail.evaluate((element) => {
      element.scrollTop = 0;
    });
    const boundsBefore = (await sheet.boundingBox())!;
    await touchDrag(page, detail, -100);
    await expect
      .poll(() => detail.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(20);
    await expect(sheet).toHaveAttribute('data-sheet-position', 'half');
    expect((await sheet.boundingBox())!.height).toBeCloseTo(
      boundsBefore.height,
      0,
    );
    await header
      .getByRole('button', { name: 'Sbalit detail', exact: true })
      .click();
    await expect(sheet.locator('.ux-mobile-detail-content')).toHaveAttribute(
      'inert',
      '',
    );
    await header
      .getByRole('button', { name: 'Změnit výšku detailu', exact: true })
      .focus();
    for (let index = 0; index < 12; index++) {
      await page.keyboard.press('Tab');
      expect(
        await detail.evaluate((element) =>
          element.contains(document.activeElement),
        ),
      ).toBe(false);
    }
    await page
      .getByRole('button', { name: 'Doména journal.example', exact: true })
      .press('Enter');
    await expect(sheet).toHaveAttribute('data-sheet-position', 'half');
    await expect(
      detail.getByRole('heading', { name: 'journal.example', exact: true }),
    ).toBeVisible();
    await expect(detail.locator('.ux-detail-back')).toHaveCount(0);
  });

  test('honors reduced motion when changing the sheet size', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openAtlas(page);
    const sheet = page.locator('.ux-floating-detail');
    await sheet
      .getByRole('button', { name: 'Roztáhnout detail', exact: true })
      .click();
    await expect(sheet).toHaveAttribute('data-sheet-position', 'expanded');
    const durations = await sheet.evaluate((element) => {
      const style = getComputedStyle(element);
      return [style.transitionDuration, style.animationDuration];
    });
    for (const duration of durations) {
      for (const part of duration.split(',')) {
        expect(Number.parseFloat(part)).toBeLessThanOrEqual(0.01);
      }
    }
  });
});

test('keeps the desktop detail and site list accessible at the landscape breakpoint', async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'desktop',
    'Desktop breakpoint regression',
  );
  await page.setViewportSize({ width: 740, height: 360 });
  await page.goto('/ux/2?hover=pulse');
  await expect(
    page.getByLabel('Interaktivní mapa odkazů mezi weby'),
  ).toHaveAttribute('data-framing-ready', 'true');
  await expect(page.locator('.ux-mobile-sites-toggle')).toBeHidden();
  const atlas = page.getByRole('button', {
    name: 'atlas.example',
    exact: true,
  });
  await atlas.scrollIntoViewIfNeeded();
  await atlas.click();
  const sheet = page.locator('.ux-floating-detail');
  await expect(sheet.locator('.ux-mobile-detail-header')).toBeHidden();
  await expect(
    page.getByRole('complementary', { name: 'Detail výběru' }),
  ).toBeVisible();
  await sheet
    .getByRole('button', { name: 'Zavřít detail', exact: true })
    .click();
  await expect(sheet).toHaveCount(0);
  await atlas.scrollIntoViewIfNeeded();
  await atlas.click({ trial: true });
  await page
    .getByRole('button', { name: 'journal.example', exact: true })
    .click({ trial: true });
});

test('keeps the desktop detail anchored beside the site list with its original controls', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'Desktop layout regression');
  await openAtlas(page);
  const sheet = page.locator('.ux-floating-detail');
  const detail = page.getByRole('complementary', { name: 'Detail výběru' });
  await expect(sheet.locator('.ux-mobile-detail-header')).toBeHidden();
  await expect(sheet).toHaveAttribute('data-anchored', 'true');
  const panel = (await page.locator('.ux-floating-sites').boundingBox())!;
  const bounds = (await sheet.boundingBox())!;
  expect(bounds.x).toBeGreaterThan(panel.x + panel.width);
  expect(bounds.y).toBeCloseTo(panel.y, 0);
  await detail
    .getByRole('button', { name: 'Zavřít detail', exact: true })
    .click();
  await expect(sheet).toHaveCount(0);
});
