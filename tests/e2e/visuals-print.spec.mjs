// Printing and "Save as PDF": every row of a long table reaches the paper, and every theme prints dark text on
// white, with code and callouts still readable. Run with emulateMedia({ media: 'print' }) and, for tables, a
// real PDF from the browser's own print path.
import { test, expect } from '@playwright/test';
import { THEMES, open, renderSource } from './visuals-helpers.mjs';

test('a long table prints every row, across pages', async ({ page }) => {
  await open(page, 'kitchen-sink.md');
  const rows = Array.from({ length: 60 }, (_, i) => `| row ${i + 1} | value ${i + 1} |`).join('\n');
  await renderSource(page, `# Print\n\nIntro.\n\n| Name | Value |\n|---|---|\n${rows}\n\nAfter the table.\n`);
  await page.emulateMedia({ media: 'print' });
  const box = await page.evaluate(() => {
    const table = document.querySelector('#mdBody table');
    const last = table.querySelector('tbody tr:last-child');
    return {
      maxHeight: getComputedStyle(table).maxHeight,
      lastRowBottom: last.getBoundingClientRect().bottom,
      tableBottom: table.getBoundingClientRect().bottom,
    };
  });
  expect(box.maxHeight).toBe('none');
  expect(box.lastRowBottom).toBeLessThanOrEqual(box.tableBottom + 1); // the last row is inside the box, not scrolled away
  // The browser's own PDF: 60 rows do not fit on one A4 page, so a table that prints whole needs more than one.
  const pdf = await page.pdf({ format: 'A4' });
  const pages = (pdf.toString('latin1').match(/\/Type\s*\/Page(?!s)/g) || []).length;
  expect(pages).toBeGreaterThanOrEqual(2);
});

const PRINTED_TEXT = [
  '#mdBody p', '#mdBody li', '#mdBody a[href^="http"]', '#mdBody .callout-title', '#mdBody td',
  '#mdBody :not(pre) > code', '#mdBody pre code .hljs-keyword', '#mdBody pre code .hljs-string', '#mdBody .fm-metric-label',
];

for (const theme of THEMES) {
  test(`printing from the ${theme} theme gives dark text on white, with readable code and callouts`, async ({ page }) => {
    await open(page, 'kitchen-sink.md', theme);
    await page.emulateMedia({ media: 'print' });
    const result = await page.evaluate((selectors) => {
      const C = window.mdvTestColor;
      const cs = getComputedStyle(document.documentElement);
      const tok = (n) => cs.getPropertyValue(n).trim();
      const failures = [];
      for (const n of ['keyword', 'string', 'number', 'title', 'type', 'attr', 'comment', 'meta', 'addition', 'deletion']) {
        const r = C.contrast(tok('--syntax-' + n), tok('--bg-code-block'));
        if (r < 4.5) failures.push(`--syntax-${n} on the printed code background: ${r.toFixed(2)}`);
      }
      // Text against what it is printed on: its CSS background (printed with background graphics) and white paper
      // (the browser default, without them). The background is the first ancestor with an opaque colour.
      const bgOf = (el) => {
        for (let e = el; e; e = e.parentElement) {
          const bg = getComputedStyle(e).backgroundColor;
          if (bg && bg !== 'transparent' && !/^rgba\(.*,\s*0\)$/.test(bg)) return bg;
        }
        return '#ffffff';
      };
      for (const sel of selectors) {
        const els = [...document.querySelectorAll(sel)].filter((el) => el.getClientRects().length);
        if (!els.length) { failures.push(`${sel}: none found`); continue; }
        for (const el of els.slice(0, 6)) {
          const fg = getComputedStyle(el).color;
          for (const [where, bg] of [['its background', bgOf(el)], ['paper', '#ffffff']]) {
            const r = C.contrast(fg, bg);
            if (r < 4.5) failures.push(`${sel} on ${where}: ${r.toFixed(2)} (${fg} on ${bg})`);
          }
        }
      }
      return { page: C.rgb(tok('--bg-primary')), paragraph: C.rgb(getComputedStyle(document.querySelector('#mdBody p')).color), scheme: cs.colorScheme, failures };
    }, PRINTED_TEXT);
    expect(result.page).toEqual([255, 255, 255]);
    expect(result.paragraph).toEqual([17, 17, 17]);
    expect(result.scheme).toBe('light');
    expect(result.failures).toEqual([]);
  });
}

test('a diagram drawn in the dark theme prints on its own card, so its text stays readable', async ({ page }) => {
  await open(page, 'kitchen-sink.md', 'dark');
  await page.emulateMedia({ media: 'print' });
  const card = await page.evaluate(() => {
    const C = window.mdvTestColor;
    const wrapper = document.querySelector('#mdBody .mermaid-wrapper');
    const cs = getComputedStyle(wrapper);
    const text = document.querySelector('#mdBody .mermaid svg[aria-roledescription="sequence"] .messageText');
    return {
      adjust: cs.printColorAdjust || cs.webkitPrintColorAdjust,
      background: C.rgb(cs.backgroundColor),
      drawnOn: C.rgb(getComputedStyle(document.documentElement).getPropertyValue('--diagram-bg')),
      textContrast: C.contrast(getComputedStyle(text).fill, cs.backgroundColor),
    };
  });
  expect(card.adjust).toBe('exact'); // the card is printed even with "background graphics" off
  expect(card.background).toEqual(card.drawnOn); // the card the diagram was drawn for, not white paper
  expect(card.textContrast).toBeGreaterThanOrEqual(4.5);
});
