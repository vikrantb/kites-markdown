// The reader's place across a new version of the document (js/reading-place.js): the words being read stay at the
// same height, whatever the agent added above them, and folded sections stay folded. Each test edits a real file
// that the test server serves.
import { test, expect } from '@playwright/test';
import { waitForLayoutSettled } from './support/viewer.mjs';
import { collectErrors, servedFile, blockTop, scrollBlockTo, openApp } from './support/live.mjs';

const words = (n, what) => Array.from({ length: n }, (_, i) => `${what}, sentence ${i + 1}.`).join(' ');

// A newest-first agent log: each day has the same three subsections, so markdown-it-anchor numbers them
// (done, done-1, …, notes, notes-1, …) and a day added at the top renumbers every one below it
function log(days) {
  const out = ['# Agent log', ''];
  for (const d of days) {
    out.push(`## 2026-10-${d}`, '', '### Done', '', words(30, `Day ${d} done`), '', '### Next', '', words(20, `Day ${d} next`),
      '', '### Notes', '', `Day ${d} notes: ` + words(40, `Day ${d} notes`), '');
  }
  return out.join('\n');
}
const DAYS = ['08', '07', '06', '05', '04', '03', '02', '01'];

async function expectBlockAt(page, start, y) {
  await expect.poll(async () => Math.round(Math.abs((await blockTop(page, start)) - y)), { timeout: 6000 }).toBeLessThan(4);
}

test('a day added at the top of a log, with headings that repeat, leaves the reader on the words they were reading', async ({ page }, info) => {
  const errors = collectErrors(page);
  const doc = servedFile(info, 'log.md', log(DAYS));
  await page.goto(`markdown-viewer.html?file=${doc.path}`);
  await page.waitForSelector('#mdBody h2');
  await waitForLayoutSettled(page);
  const before = await scrollBlockTo(page, 'Day 04 notes:', 200);
  expect(Math.round(before)).toBe(200);
  doc.write(log(['09', ...DAYS])); // the agent writes a new day at the top
  await expect(page.locator('#mdBody')).toContainText('Day 09 done', { timeout: 10_000 });
  await expectBlockAt(page, 'Day 04 notes:', 200);
  // The section the reader is in is still Day 04's (the old id "notes-4" now names Day 05's notes)
  expect(await page.evaluate(() => document.getElementById('notes-4').nextElementSibling.textContent.trim().slice(0, 13))).toBe('Day 05 notes:');
  expect(errors).toEqual([]);
});

// A handoff where several sections have a "### Details" subsection
function handoff({ extraDetails = false, risksTitle = 'Risks', risksText = 'Risk details: ' + words(60, 'risk detail'), above = '' } = {}) {
  const parts = ['# Handoff: the migration', '', above];
  parts.push('## Plan', '', words(40, 'plan'), '');
  if (extraDetails) parts.push('### Details', '', 'Plan details added by the agent: ' + words(50, 'plan detail'), '');
  parts.push('## Retry policy', '', words(40, 'retry'), '', '### Details', '', 'Retry details: ' + words(60, 'retry detail'), '');
  parts.push(`## ${risksTitle}`, '', words(40, 'risk'), '', '### Details', '', risksText, '', 'Second risk paragraph: ' + words(60, 'more risk'), '');
  parts.push('## Appendix', '', words(200, 'appendix'), '');
  return parts.join('\n');
}

test('when the reader\'s own paragraph changed, the heading above it is found by its words and its section, not by a renumbered id', async ({ page }, info) => {
  const errors = collectErrors(page);
  const doc = servedFile(info, 'handoff.md', handoff());
  await page.goto(`markdown-viewer.html?file=${doc.path}`);
  await page.waitForSelector('#mdBody h2');
  await waitForLayoutSettled(page);
  // The reader is reading the first paragraph of Risks › Details (under the toolbar's edge); its heading is just above,
  // and that paragraph is the one the agent rewrites
  await page.evaluate(() => {
    const h = document.getElementById('details-1'); // Risks › Details (Retry policy's is "details")
    const p = h.nextElementSibling.querySelector('p');
    window.scrollTo({ top: window.scrollY + p.getBoundingClientRect().top - 30, behavior: 'instant' });
  });
  await page.waitForTimeout(150);
  const y = await page.evaluate(() => document.getElementById('details-1').getBoundingClientRect().top);
  // The agent adds a "### Details" to Plan (above) and rewrites the reader's paragraph
  doc.write(handoff({ extraDetails: true, risksText: 'Risk details, rewritten: ' + words(60, 'new risk detail') }));
  await expect(page.locator('#mdBody')).toContainText('Plan details added by the agent', { timeout: 10_000 });
  // Risks › Details is now "details-2"; "details-1" is Retry policy's
  await expect.poll(() => page.evaluate((y) => Math.round(Math.abs(document.getElementById('details-2').getBoundingClientRect().top - y)), y), { timeout: 6000 })
    .toBeLessThan(4);
  expect(errors).toEqual([]);
});

test('text added above and the reader\'s heading renamed: their paragraph keeps its place', async ({ page }, info) => {
  const errors = collectErrors(page);
  const doc = servedFile(info, 'handoff.md', handoff());
  await page.goto(`markdown-viewer.html?file=${doc.path}`);
  await page.waitForSelector('#mdBody h2');
  await waitForLayoutSettled(page);
  await scrollBlockTo(page, 'Second risk paragraph:', 160);
  doc.write(handoff({ risksTitle: 'Risks (updated)', above: 'Status: Done. ' + words(80, 'status') + '\n' }));
  await expect(page.locator('#mdBody')).toContainText('Risks (updated)', { timeout: 10_000 });
  await expectBlockAt(page, 'Second risk paragraph:', 160);
  expect(errors).toEqual([]);
});

test('the sections the reader folded and the <details> they opened stay so across a new version', async ({ page }, info) => {
  const errors = collectErrors(page);
  const body = (extra) => '# Report\n\n## Summary\n\n' + words(30, 'summary') + extra + '\n\n## Costs\n\n' + words(80, 'cost') +
    '\n\n## Timeline\n\n' + words(40, 'timeline') + '\n\n<details><summary>Raw numbers</summary>\n\n' + words(30, 'raw') +
    '\n\n</details>\n\n## Appendix A\n\n' + words(120, 'appendix') + '\n\n### Tables\n\n' + words(40, 'table') + '\n';
  const doc = servedFile(info, 'report.md', body(''));
  await page.goto(`markdown-viewer.html?file=${doc.path}`);
  await page.waitForSelector('#mdBody h2');
  await waitForLayoutSettled(page);
  // Fold "Costs" and "Appendix A" (and with it its "Tables"), open "Raw numbers"
  for (const id of ['costs', 'appendix-a']) await page.locator(`#${id} .section-toggle`).click();
  await page.locator('#mdBody summary', { hasText: 'Raw numbers' }).click();
  const state = () => page.evaluate(() => ({
    folded: [...document.querySelectorAll('#mdBody .section-content.collapsed')]
      .map((c) => document.querySelector(`[aria-controls="${c.id}"]`).closest('h2, h3').getAttribute('aria-label')),
    open: [...document.querySelectorAll('#mdBody details')].map((d) => d.open),
  }));
  const before = await state();
  expect(before).toEqual({ folded: ['Costs', 'Appendix A'], open: [true] });
  doc.write(body(' The agent added this line.'));
  await expect(page.locator('#mdBody')).toContainText('The agent added this line.', { timeout: 10_000 });
  expect(await state()).toEqual(before);
  expect(errors).toEqual([]);
});

test('desktop: the window\'s own file, reloaded by js/host.js, also keeps the reader on their words', async ({ page }) => {
  const doc = { path: '/notes/log.md', name: 'log.md', mtimeMs: 1000, version: 'v-1000', readOnly: null, reason: 'initial', text: log(DAYS) };
  const errors = await openApp(page, { doc });
  await page.waitForSelector('#mdBody h2');
  await waitForLayoutSettled(page);
  await scrollBlockTo(page, 'Day 04 notes:', 200);
  await page.evaluate((d) => window.__shell.emit('mdv://document-changed', d), Object.assign({}, doc, {
    text: log(['09', ...DAYS]), mtimeMs: 3000, version: 'v-3000', reason: 'changed',
  }));
  await expect(page.locator('#mdBody')).toContainText('Day 09 done');
  await expectBlockAt(page, 'Day 04 notes:', 200);
  expect(errors).toEqual([]);
});
