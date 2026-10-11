// The comment format in real documents: where the comment block is, what a save keeps, and where a thread is shown.
// Each test reproduces a defect found in review of the comment data-safety change and proves it fixed.
import { test, expect } from '@playwright/test';
import { PLAN, SAMPLE, openViewer, threads } from './comment-helpers.mjs';

const BLOCK_OPEN = '<!-- MDV-COMMENTS:v1';

test('a comment block followed by text typed later in another editor is still read, and a save moves it to the end', async ({ page }) => {
  const errors = await openViewer(page);
  const appended = SAMPLE + '\n## Added later\n\nA paragraph typed below the comment block in another editor.\n';
  const r = await page.evaluate((doc) => {
    const parsed = mdvParseFile(doc);
    const out = mdvSerialize(doc, parsed.comments.concat([window.__t.comment('A fourth comment')]));
    const blockAt = out.indexOf('<!-- MDV-COMMENTS:v1');
    return {
      read: parsed.comments.length, error: parsed.parseError,
      blocks: out.split('<!-- MDV-COMMENTS:v1').length - 1,
      afterSave: mdvParseFile(out).comments.length,
      keepsAppended: out.slice(0, blockAt).includes('## Added later\n\nA paragraph typed below the comment block in another editor.'),
      keepsStart: out.startsWith(doc.slice(0, doc.indexOf('<!-- MDV-COMMENTS:v1')).replace(/\n+$/, '')),
      blockEndsFile: /MDV-COMMENTS:end -->\n$/.test(out)
    };
  }, appended);
  expect(r.error).toBeNull();
  expect(r.read, 'the three comments are still read').toBe(3);
  expect(r.blocks, 'a save writes one block, not a second one').toBe(1);
  expect(r.afterSave).toBe(4);
  expect(r.keepsAppended, 'the text typed below the block is kept, above it').toBe(true);
  expect(r.keepsStart).toBe(true);
  expect(r.blockEndsFile).toBe(true);
  // The reader sees the threads, too
  await page.evaluate((doc) => window.__t.open(doc, 'commented.md', null), appended);
  await threads(page, 2);
  expect(errors).toEqual([]);
});

test('an example of the comment block inside a list item is document text, never the comment block', async ({ page }) => {
  await openViewer(page);
  const doc = [
    '# How comments are stored',
    '',
    '- The viewer appends a block like this one:',
    '',
    '  <!-- MDV-COMMENTS:v1',
    '  {"version":1,"comments":[{"id":"cm_example","parent_id":null,"body_md":"an example","status":"open"}]}',
    '  MDV-COMMENTS:end -->',
    ''
  ].join('\n');
  const r = await page.evaluate((d) => {
    const parsed = mdvParseFile(d);
    const out = mdvSerialize(d, [window.__t.comment('real')]);
    return { read: parsed.comments.length, error: parsed.parseError, keepsExample: out.startsWith(d.replace(/\n+$/, '')),
      back: mdvParseFile(out).comments.map((c) => c.body_md), removed: mdvSerialize(out, []) === d };
  }, doc);
  expect(r.read, 'the example is not read as comments').toBe(0);
  expect(r.error).toBeNull();
  expect(r.keepsExample, 'the example is kept, character for character').toBe(true);
  expect(r.back).toEqual(['real']);
  expect(r.removed).toBe(true);
});

test('a document that ends inside an unclosed code fence refuses to store comments rather than hide them in the code', async ({ page }) => {
  await openViewer(page);
  const doc = '# Notes\n\nSome text.\n\n```js\nconst unfinished = true;\n';
  const r = await page.evaluate((d) => {
    let error = null;
    let out = null;
    try { out = mdvSerialize(d, [window.__t.comment('hidden?')]); } catch (e) { error = e.message; }
    return { error, out };
  }, doc);
  expect(r.out, 'nothing is written that would not be read back').toBeNull();
  expect(r.error).toMatch(/could not be stored/);
});

test('deleting the last thread keeps the comment block\'s other fields', async ({ page }) => {
  const errors = await openViewer(page);
  page.on('dialog', (d) => d.accept());
  const doc = '# Review\n\n<!-- MDV-ANCHOR id="c_aaaa" -->\nThe paragraph under review.\n\n' + BLOCK_OPEN + '\n' +
    '{"version":1,"generator":"mdv-viewer","comments":[{"id":"cm_1","parent_id":null,"anchor":{"id":"c_aaaa"},"author":{"name":"A","kind":"human"},' +
    '"body_md":"Only thread","created_at":"2026-10-01T00:00:00.000Z","status":"open"}],"x-review":{"due":"2026-11-01","state":"in progress"}}\n' +
    'MDV-COMMENTS:end -->\n';
  await page.evaluate((d) => { window.h = window.__t.fakeHandle('review.md', d); window.__t.open(d, 'review.md', window.h); }, doc);
  await threads(page, 1);
  await page.evaluate(() => mdvDeleteThread('cm_1'));
  await expect.poll(() => page.evaluate(() => window.h.writes.length), { timeout: 5000 }).toBe(1);
  const saved = await page.evaluate(() => window.h.text);
  expect(saved, 'the x-review field survives').toContain('"x-review":{"due":"2026-11-01","state":"in progress"}');
  expect(saved).not.toContain('Only thread');
  expect(saved, 'the marker of the deleted thread is gone').not.toContain('c_aaaa');
  const reread = await page.evaluate((s) => { const p = mdvParseFile(s); return { n: p.comments.length, error: p.parseError }; }, saved);
  expect(reread).toEqual({ n: 0, error: null });
  // Without other fields, deleting the last thread still removes the whole block
  const plain = await page.evaluate(() => mdvSerialize('# T\n\nText.\n\n<!-- MDV-COMMENTS:v1\n{"version":1,"comments":[]}\nMDV-COMMENTS:end -->\n', []));
  expect(plain).toBe('# T\n\nText.\n');
  expect(errors).toEqual([]);
});

test('deleting a thread leaves an inline-code mention of its marker alone', async ({ page }) => {
  await openViewer(page);
  const out = await page.evaluate(() => {
    const doc = 'The marker looks like `<!-- MDV-ANCHOR id="c_demo123" -->` in the source.\n\n' +
      '<!-- MDV-ANCHOR id="c_demo123" -->\nA paragraph with a thread.\n\n' +
      '```html\n<!-- MDV-ANCHOR id="c_demo123" -->\n```\n';
    return mdvRemoveMarkers(doc, new Set(['c_demo123']));
  });
  expect(out).toBe('The marker looks like `<!-- MDV-ANCHOR id="c_demo123" -->` in the source.\n\n' +
    'A paragraph with a thread.\n\n```html\n<!-- MDV-ANCHOR id="c_demo123" -->\n```\n');
});

test('a thread whose anchor id names a built-in object property cannot break the sidebar', async ({ page }) => {
  const errors = await openViewer(page);
  await page.evaluate(() => {
    const doc = mdvSerialize('# Title\n\n<!-- MDV-ANCHOR id="c_valid" -->\nA paragraph with a thread.\n\nAnother paragraph.\n', [
      window.__t.comment('On a strange anchor', { id: 'cm_odd', anchor: { id: 'constructor', blockKind: 'p' } }),
      window.__t.comment('A normal thread', { id: 'cm_ok', anchor: { id: 'c_valid', blockKind: 'p' } }),
      window.__t.comment('A reply whose thread id is special', { id: '__proto__', parent_id: 'cm_ok' })
    ]);
    window.__t.open(doc, 'odd.md', null);
  });
  await threads(page, 2);
  await expect(page.locator('#mdBody .mdv-chip')).toHaveCount(1);
  await expect(page.locator('#mdBody .mdv-chip'), 'the thread and its reply').toHaveText('💬 2');
  await expect(page.locator('#mdvThreadList .mdv-orphan')).toHaveCount(1);
  expect(errors).toEqual([]);
});

const RAW_HTML_DOC = (top) => [
  top,
  '',
  'Intro paragraph.',
  '',
  '## Pricing',
  '',
  '<table>',
  '<tr><th>Plan</th><th>Price</th></tr>',
  '<tr><td>Starter plan</td><td>Free</td></tr>',
  '</table>',
  '',
  '## Support',
  '',
  'Write to the team.',
  ''
].join('\n');

for (const top of ['Intro without a top heading.', '# Product sheet']) {
  test(`a thread on a cell of a raw HTML table stays on that cell (${top.startsWith('#') ? 'h1 at the top' : 'no top heading'})`, async ({ page }) => {
    const errors = await openViewer(page);
    const doc = RAW_HTML_DOC(top);
    await page.evaluate((d) => { window.h = window.__t.fakeHandle('sheet.md', d); window.__t.open(d, 'sheet.md', window.h); }, doc);
    // Through the real UI: right-click the cell, type, save
    await page.locator('#mdBody td', { hasText: 'Starter plan' }).click({ button: 'right' });
    await page.locator('.mdv-ctx-menu button').click();
    await page.locator('.mdv-add-popup textarea').fill('Is the starter plan still free?');
    await page.locator('.mdv-add-popup .mdv-add-save').click();
    await expect.poll(() => page.evaluate(() => window.h.text), { timeout: 5000 }).toContain('Is the starter plan still free?');
    const where = () => page.evaluate(() => ({
      chips: [...document.querySelectorAll('#mdBody .mdv-chip')].map((c) => c.parentElement.tagName + ' ' + c.parentElement.textContent.replace(/💬 \d+/g, '').trim()),
      quotes: [...document.querySelectorAll('#mdvThreadList .mdv-quote')].map((q) => q.textContent),
      orphans: document.querySelectorAll('#mdvThreadList .mdv-orphan').length
    }));
    await expect.poll(where).toEqual({ chips: ['TD Starter plan'], quotes: ['Starter plan'], orphans: 0 });
    // The marker sits before the table in the file, and reopening the file shows the thread in the same place
    const saved = await page.evaluate(() => window.h.text);
    expect(saved).toMatch(/<!-- MDV-ANCHOR id="c_[a-z0-9]+" -->\n<table>/);
    await page.evaluate(() => window.__t.open(window.h.text, 'sheet.md', null));
    await threads(page, 1);
    await expect.poll(where).toEqual({ chips: ['TD Starter plan'], quotes: ['Starter plan'], orphans: 0 });
    expect(errors).toEqual([]);
  });
}

test('the commented sample and the plan still round-trip byte for byte', async ({ page }) => {
  await openViewer(page);
  const r = await page.evaluate(({ sample, plan }) => {
    const s = mdvParseFile(sample);
    const withOne = mdvSerialize(plan, [window.__t.comment('x')]);
    return { sample: mdvSerialize(sample, s.comments) === sample, plan: mdvSerialize(withOne, []) === plan };
  }, { sample: SAMPLE, plan: PLAN });
  expect(r).toEqual({ sample: true, plan: true });
});
