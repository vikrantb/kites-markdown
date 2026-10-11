// Reading-surface details: figures, tables, task lists, highlights, diffs, callouts and the dashboard.
import { test, expect } from '@playwright/test';
import { THEMES, open, renderSource } from './visuals-helpers.mjs';

const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

test("a figure's caption is drawn, never added to the paragraph's text, so a comment on it is not misplaced", async ({ page }) => {
  await open(page, 'kitchen-sink.md');
  const doc = `# Doc\n\n## System overview\n\nIntro text.\n\n## Details\n\nMore text.\n\n![System overview](${PIXEL})\n`;
  await renderSource(page, doc);
  const figure = page.locator('#mdBody p.mdv-figure');
  await expect(figure.locator('.mdv-figcaption')).toHaveAttribute('data-caption', 'System overview');
  const shown = await figure.evaluate((p) => ({
    text: p.innerText.trim(),
    caption: getComputedStyle(p.querySelector('.mdv-figcaption'), '::before').content,
    captionHeight: p.querySelector('.mdv-figcaption').getBoundingClientRect().height,
  }));
  expect(shown.text).toBe(''); // what comments.js anchors by: the caption is not part of it
  expect(shown.caption).toContain('System overview');
  expect(shown.captionHeight).toBeGreaterThan(12); // and it is drawn under the image

  // The real comment path (comments.js): the anchor marker must not land before the heading with the same words.
  await page.evaluate(async () => {
    window.mdvScheduleSave = () => {}; // no file to save to in this test
    await mdvAddComment(document.querySelector('#mdBody p.mdv-figure'), null, 'A note on the image');
  });
  const source = await page.evaluate(() => rawMarkdown);
  expect(source.slice(0, source.indexOf('## System overview'))).not.toContain('MDV-ANCHOR');
});
