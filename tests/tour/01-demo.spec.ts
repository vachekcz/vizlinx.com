import { expect, test, type Page } from '@playwright/test';
import { capture } from './capture';

// Section 01: the graphical demo on `/`. Every state is reached through URL
// parameters, so nothing is clicked and the cursor never hovers a node.

async function expectMapRendered(page: Page, theme: 'signal' | 'midnight') {
  await expect(
    page.getByRole('heading', { name: 'Mapa souvislostí.' }),
  ).toBeVisible();
  await expect(page.locator('.app-shell')).toHaveAttribute('data-theme', theme);
  // The SVG edges paint last; a rendered connection proves the map itself is
  // on screen, not just the app shell around it.
  await expect(page.locator('[data-connection]').first()).toBeVisible();
}

test('demo map in both themes, an expanded domain and strong connections', async ({
  page,
}, testInfo) => {
  await page.goto('/?theme=signal');
  await expectMapRendered(page, 'signal');
  await expect(page.getByTestId('link-count')).toHaveText('51');
  await expect(
    page.locator('[data-connection="atlas:journal"] [data-fine-style="silk"]'),
  ).toBeVisible();
  await capture(page, testInfo, '01-demo/01-denni-rezim', {
    title: 'Demo v denním režimu (Signal)',
    description:
      'Úvodní mapa souvislostí: pět ukázkových webů Studia Atlas, jeden neprozkoumaný externí cíl a 51 směrových vazeb. Spojnice ve výchozím stylu Hedvábí.',
  });

  await page.goto('/?theme=midnight');
  await expectMapRendered(page, 'midnight');
  await expect(page.getByTestId('link-count')).toHaveText('51');
  await capture(page, testInfo, '01-demo/02-nocni-rezim', {
    title: 'Demo v nočním režimu (Midnight)',
    description:
      'Stejná mapa v tmavém vzhledu Midnight. Přepínač měsíce/slunce v hlavičce ukládá volbu v prohlížeči; bez ní vzhled sleduje nastavení systému.',
  });

  await page.goto('/?theme=midnight&detail=index');
  await expectMapRendered(page, 'midnight');
  await expect(
    page.getByRole('button', { name: /^Stránka index.example/ }),
  ).toHaveCount(20);
  await capture(page, testInfo, '01-demo/03-rozbalena-domena', {
    title: 'Rozbalená doména se 20 stránkami',
    description:
      'Noční režim s otevřeným clusterem index.example: 20 konkrétních stránek na pozici domény a jejich vazby na ostatní weby.',
  });

  await page.goto('/?theme=signal&density=scale');
  await expectMapRendered(page, 'signal');
  await expect(page.getByTestId('link-count')).toHaveText('230');
  await capture(page, testInfo, '01-demo/04-silne-vazby', {
    title: 'Ukázka silných vazeb',
    description:
      'Režim density=scale: 230 unikátních dvojic stránek, nejsilnější propojení má 120 vazeb. Svazky spojnic rostou po prazích 5+, 10+, 25+, 50+ a 100+.',
  });
});
