// Link previews (js/link-preview.js): resting on a link fetches nothing, the card shows the file as it is now, a
// modifier key held for a click leaves it, and a link to a section previews that section. Helpers:
// folder-helpers.mjs.
import { test, expect } from '@playwright/test';
import { start, seed, openFolder, expectTitle, openInTree } from './folder-helpers.mjs';

const card = (page) => page.locator('#mdvLinkPreview');

test('resting on a link fetches nothing: no style, background or address from the other file reaches the card', async ({ page }) => {
  const probes = [];
  page.on('request', (r) => { if (/-probe\.png/.test(r.url())) probes.push(new URL(r.url()).pathname); });
  const problems = await start(page);
  await seed(page, {
    'a.md': '# A\n\nSee [the other](b.md).\n',
    'b.md': '# B\n\nHello <span style="background-image:url(/style-probe.png)">styled</span> words '
      + '<span style="background:image-set(\'/imageset-probe.png\' 1x)">set</span> '
      + '<table background="/table-probe.png"><tr><td>cell</td></tr></table> '
      + '<svg width="8" height="8"><image href="/svg-probe.png" width="8" height="8"/></svg> '
      + '<video poster="/poster-probe.png"></video> <input type="image" src="/input-probe.png" alt="i"> end.\n',
  });
  await openFolder(page);
  await openInTree(page, 'a.md', 'A');
  await page.waitForTimeout(300);
  expect(probes).toEqual([]);
  await page.locator('#mdBody a', { hasText: 'the other' }).hover();
  await expect(card(page).locator('.mdv-preview-title')).toHaveText('B');
  await expect(card(page).locator('.mdv-preview-body')).toContainText('Hello styled words set');
  await page.waitForTimeout(800);
  expect(probes).toEqual([]);
  expect(await card(page).locator('[style], [background], [src], [srcset], [href], [poster], svg, img, video, input').count()).toBe(0);
  // The positive control: the same recorder sees the style attributes fetch when the document itself is opened
  // (the page renders the author's styles; the card is what must not).
  await page.mouse.move(5, 5);
  await openInTree(page, 'b.md', 'B');
  await expect.poll(() => probes.slice().sort()).toEqual(expect.arrayContaining(['/imageset-probe.png', '/style-probe.png']));
  expect(problems.filter((p) => !/-probe\.png/.test(p))).toEqual([]);
});

test('a preview shows the linked file as it is now, not as it was a few seconds ago', async ({ page }) => {
  const problems = await start(page);
  await openFolder(page);
  await openInTree(page, 'README.md', 'Project notes');
  const link = page.locator('#mdBody a', { hasText: 'Weekly status' });
  await link.hover();
  await expect(card(page).locator('.mdv-preview-body')).toContainText('The rate limiter shipped on Monday');
  await page.mouse.move(5, 5);
  await expect(card(page)).toBeHidden();
  // An agent rewrites the status while the reader is reading.
  await seed(page, { 'status.md': '---\ntitle: Weekly status, 8 October\n---\n\n# Status\n\nROLLBACK IN PROGRESS: the rate limiter is off again.\n' });
  await link.hover();
  await expect(card(page).locator('.mdv-preview-body')).toContainText('ROLLBACK IN PROGRESS');
  expect(problems).toEqual([]);
});

test('holding Ctrl, Cmd, Shift or Alt for a click leaves the card; any other key hides it', async ({ page }) => {
  const problems = await start(page);
  await openFolder(page);
  await openInTree(page, 'README.md', 'Project notes');
  await page.locator('#mdBody a', { hasText: 'Weekly status' }).hover();
  await expect(card(page)).toBeVisible();
  for (const key of ['Control', 'Meta', 'Shift', 'Alt']) {
    await page.keyboard.down(key);
    await page.waitForTimeout(100);
    await expect(card(page), `${key} held`).toBeVisible();
    await page.keyboard.up(key);
  }
  await page.keyboard.press('j');
  await expect(card(page)).toBeHidden();
  expect(problems).toEqual([]);
});

test('a link to a section previews that section: its heading, its first paragraph and the document it is in', async ({ page }) => {
  const problems = await start(page);
  await seed(page, {
    'plan.md': '# The plan\n\nWhat we will do.\n\n## Risks\n\nThe first risk list.\n\n## Next\n\nThen this.\n\n## Risks\n\nThe second risk list, under a heading of the same name.\n',
    'from.md': '# From\n\nRead [the risks](plan.md#risks), [the later risks](plan.md#risks-1) and [the plan](plan.md#nowhere).\n',
  });
  await openFolder(page);
  await openInTree(page, 'from.md', 'From');
  await page.locator('#mdBody a', { hasText: 'the risks' }).first().hover();
  await expect(card(page).locator('.mdv-preview-title')).toHaveText('Risks');
  await expect(card(page).locator('.mdv-preview-body')).toHaveText('The first risk list.');
  await expect(card(page).locator('.mdv-preview-where')).toHaveText('plan.md · The plan');
  await page.mouse.move(5, 5);
  await expect(card(page)).toBeHidden();
  await page.locator('#mdBody a', { hasText: 'the later risks' }).hover();
  await expect(card(page).locator('.mdv-preview-body')).toHaveText('The second risk list, under a heading of the same name.');
  await page.mouse.move(5, 5);
  await expect(card(page)).toBeHidden();
  // A fragment that names no heading: the document itself.
  await page.locator('#mdBody a', { hasText: 'the plan' }).hover();
  await expect(card(page).locator('.mdv-preview-title')).toHaveText('The plan');
  await expect(card(page).locator('.mdv-preview-body')).toHaveText('What we will do.');
  // The ids the card looked for are the ids the page gives those headings.
  await openInTree(page, 'plan.md', 'The plan');
  expect(await page.locator('#mdBody h2').evaluateAll((els) => els.map((h) => h.id))).toEqual(['risks', 'next', 'risks-1']);
  expect(problems).toEqual([]);
});
