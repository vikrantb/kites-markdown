// Saving comments into files: which file a document may be written to, which version of it, and what happens when a
// read, a render or a save fails. Each test reproduces a defect found in review of the comment data-safety change and
// proves it fixed; the ones marked "control" pass before and after and show the probe works.
import { test, expect } from '@playwright/test';
import { PLAN, SAMPLE, openViewer, threads } from './comment-helpers.mjs';

const EXT = PLAN + '\nA line written in another editor.\n';

// Every notice the reader has, with the text each one keeps
const notices = (page) => page.evaluate(() => mdvNotices.map((n) => ({ kind: n.kind, text: n.text || '' })));
const keptAnywhere = (page, needle, disk) => page.evaluate(({ needle, disk }) => {
  const onDisk = disk === 'desktop' ? window.mdvHost.disk.text : (window[disk] ? window[disk].text : '');
  return onDisk.includes(needle) || rawMarkdown.includes(needle) || mdvNotices.some((n) => (n.text || '').includes(needle));
}, { needle, disk });

function paste(page, text) {
  return page.evaluate((t) => {
    const dt = new DataTransfer();
    dt.setData('text/plain', t);
    document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, text);
}

// ---------------------------------------------------------------------------------------------------------------
// Bytes: a file that is not UTF-8, and the byte order mark
// ---------------------------------------------------------------------------------------------------------------

const CP1252 = [...Buffer.from('# Caf'), 0xE9, ...Buffer.from('\n\nA paragraph about the caf'), 0xE9, ...Buffer.from(' and its prices.\n')];

test('a file that is not UTF-8 is never rewritten, and comments are read-only for it', async ({ page }) => {
  const errors = await openViewer(page);
  const out = await page.evaluate(async (bytes) => {
    const fh = await window.__t.opfsWrite('cafe.md', new Uint8Array(bytes));
    await mdvOpenWithHandle(fh, { prompt: false });
    let added = 'added';
    try { await mdvAddComment(window.__t.para('A paragraph about'), null, 'note'); } catch (e) { added = 'refused'; }
    await mdvSaveFile({ allowPrompt: false });
    await mdvFlushWrites();
    return { bytes: await window.__t.opfsBytes('cafe.md'), lock: mdvLockReason, added };
  }, CP1252);
  expect(out.bytes, 'every byte of the file is unchanged').toEqual(CP1252);
  expect(out.added).toBe('refused');
  expect(out.lock).toMatch(/UTF-8/);
  await expect(page.locator('#mdvNotices .mdv-notice-locked')).toContainText('UTF-8');
  expect(errors).toEqual([]);
});

test('a dropped file that is not UTF-8 is never rewritten when it is linked for saving', async ({ page }) => {
  await openViewer(page, { openPicker: { name: 'cafe.md' }, savePicker: { name: 'cafe.md' } });
  await page.evaluate((bytes) => window.__t.opfsWrite('cafe.md', new Uint8Array(bytes)), CP1252);
  await page.locator('#fileInput').setInputFiles({ name: 'cafe.md', mimeType: 'text/markdown', buffer: Buffer.from(CP1252) });
  await expect(page.locator('#mdBody')).toContainText('A paragraph about');
  await page.waitForTimeout(200);
  await page.evaluate(async () => {
    await mdvAddComment(window.__t.para('A paragraph about'), null, 'note');
  });
  await page.locator('#mdBody h1').click(); // a user gesture for the dialog
  await page.keyboard.press('ControlOrMeta+s');
  await expect.poll(() => page.evaluate(() => window.__t.pickerCalls.open + window.__t.pickerCalls.save)).toBe(1);
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => window.__t.opfsBytes('cafe.md')), 'every byte of the file is unchanged').toEqual(CP1252);
  await expect(page.locator('#mdvNotices .mdv-notice')).toContainText('UTF-8');
});

test('a UTF-8 byte order mark is kept when a comment is saved', async ({ page }) => {
  const errors = await openViewer(page);
  const bytes = [0xEF, 0xBB, 0xBF, ...Buffer.from('# Title\n\nA paragraph in a file with a byte order mark.\n')];
  const out = await page.evaluate(async (b) => {
    const fh = await window.__t.opfsWrite('bom.md', new Uint8Array(b));
    await mdvOpenWithHandle(fh, { prompt: false });
    await mdvAddComment(window.__t.para('A paragraph in a file'), null, 'note on a BOM file');
    await mdvFlushWrites();
    return { bytes: await window.__t.opfsBytes('bom.md'), text: await window.__t.opfsText('bom.md') };
  }, bytes);
  expect(out.bytes.slice(0, 3), 'the byte order mark is still first').toEqual([0xEF, 0xBB, 0xBF]);
  expect(out.text).toContain('note on a BOM file');
  expect(out.bytes.slice(3, 10)).toEqual([...Buffer.from('# Title')]);
  expect(errors).toEqual([]);
});

test('two different files that are not UTF-8 are never linked as the same file', async ({ page }) => {
  const errors = await openViewer(page);
  const workspaceBytes = [...Buffer.from('Prix: 5 '), 0xE9, ...Buffer.from('cus par mois.\n')];
  const droppedBytes = [...Buffer.from('Prix: 5 '), 0xE8, ...Buffer.from('cus par mois.\n')];
  await page.evaluate(async (b) => {
    const root = await navigator.storage.getDirectory();
    const ws = await root.getDirectoryHandle('ws-enc', { create: true });
    const fh = await ws.getFileHandle('note.md', { create: true });
    const w = await fh.createWritable();
    await w.write(new Uint8Array(b));
    await w.close();
    mdvWorkspaceDir = ws;
    window.readWs = async () => Array.from(new Uint8Array(await (await (await ws.getFileHandle('note.md')).getFile()).arrayBuffer()));
  }, workspaceBytes);
  await page.locator('#fileInput').setInputFiles({ name: 'note.md', mimeType: 'text/markdown', buffer: Buffer.from(droppedBytes) });
  await expect(page.locator('#mdBody')).toContainText('Prix');
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => mdvFileHandle === null), 'not linked').toBe(true);
  await page.evaluate(async () => {
    await mdvAddComment(window.__t.para('Prix'), null, 'never into the workspace file');
    await mdvSaveFile({ allowPrompt: false });
    await mdvFlushWrites();
  });
  expect(await page.evaluate(() => window.readWs())).toEqual(workspaceBytes);
  expect(errors).toEqual([]);
});

// ---------------------------------------------------------------------------------------------------------------
// Linking a document that has no file handle (drag-and-drop, the Open button, a ?file= link)
// ---------------------------------------------------------------------------------------------------------------

const LOCKED = '# Locked\n\nSome text worth keeping.\n\n<!-- MDV-COMMENTS:v1\n{"version":1,"comments":[{"id":"cm_1","parent_id":null,"body_md":"kept",}]}\nMDV-COMMENTS:end -->\n';
const READABLE = '# Readable\n\nSome text worth keeping.\n';

for (const [label, doc] of [['a file whose comments are read-only', LOCKED], ['control: a readable file', READABLE]]) {
  test(`the save-location button leaves ${label} holding every character`, async ({ page }) => {
    // The Save dialog stub empties a picked file, as Chrome does; the Open dialog stub does not
    await openViewer(page, { savePicker: { name: 'doc.md', truncate: true }, openPicker: { name: 'doc.md' } });
    await page.evaluate((t) => window.__t.opfsWrite('doc.md', t), doc);
    await page.locator('#fileInput').setInputFiles({ name: 'doc.md', mimeType: 'text/markdown', buffer: Buffer.from(doc) });
    await expect(page.locator('#mdBody')).toContainText('Some text worth keeping');
    await page.waitForTimeout(300);
    await page.locator('#mdvOpenBtn').click();
    await expect.poll(() => page.evaluate(() => window.__t.pickerCalls.open + window.__t.pickerCalls.save)).toBe(1);
    await page.waitForTimeout(800);
    const r = await page.evaluate(async () => ({ file: await window.__t.opfsText('doc.md'), save: window.__t.pickerCalls.save }));
    expect(r.file, 'the file on disk').toBe(doc);
    if (doc === LOCKED) expect(r.save, 'the Save dialog, which empties the file it is given, is never opened for it').toBe(0);
  });
}

test('control: after the save-location button links a readable file, a comment saves into it', async ({ page }) => {
  await openViewer(page, { openPicker: { name: 'linked.md' }, savePicker: { name: 'linked.md', truncate: true } });
  await page.evaluate((t) => window.__t.opfsWrite('linked.md', t), READABLE);
  await page.locator('#fileInput').setInputFiles({ name: 'linked.md', mimeType: 'text/markdown', buffer: Buffer.from(READABLE) });
  await expect(page.locator('#mdBody')).toContainText('Some text worth keeping');
  await page.locator('#mdvOpenBtn').click();
  await expect.poll(() => page.evaluate(() => mdvFileHandle !== null)).toBe(true);
  await page.evaluate(() => mdvAddComment(window.__t.para('Some text'), null, 'Saved into the linked file'));
  await expect.poll(() => page.evaluate(() => window.__t.opfsText('linked.md')), { timeout: 5000 }).toContain('Saved into the linked file');
});

const V1 = '# Notes\n\nThe first paragraph of the notes.\n\nA second paragraph.\n';
const V2 = V1 + '\nA paragraph added later in another editor.\n';

test('a dropped file changed in another editor is never overwritten by the first comment', async ({ page }) => {
  const errors = await openViewer(page, { savePicker: { name: 'notes.md', truncate: true }, openPicker: { name: 'notes.md' } });
  await page.evaluate((t) => window.__t.opfsWrite('notes.md', t), V1);
  await page.locator('#fileInput').setInputFiles({ name: 'notes.md', mimeType: 'text/markdown', buffer: Buffer.from(V1) });
  await expect(page.locator('#mdBody')).toContainText('The first paragraph');
  await page.waitForTimeout(300);
  await page.evaluate((t) => window.__t.opfsWrite('notes.md', t), V2); // another program saves the file
  // Through the real UI: right-click, type, Save; the reader picks the file in the dialog that opens
  await page.locator('#mdBody p', { hasText: 'The first paragraph' }).click({ button: 'right' });
  await page.locator('.mdv-ctx-menu button').click();
  await page.locator('.mdv-add-popup textarea').fill('My comment');
  await page.locator('.mdv-add-popup .mdv-add-save').click();
  await expect.poll(() => page.evaluate(() => window.__t.pickerCalls.open + window.__t.pickerCalls.save)).toBe(1);
  const notice = page.locator('#mdvNotices .mdv-notice-conflict');
  await expect(notice).toBeVisible();
  const r = await page.evaluate(async () => ({ file: await window.__t.opfsText('notes.md'), save: window.__t.pickerCalls.save,
    kept: rawMarkdown.includes('My comment') }));
  expect(r.file, 'the other editor\'s version is still on disk').toBe(V2);
  expect(r.save).toBe(0);
  expect(r.kept, 'the comment is kept on screen and in the notice').toBe(true);
  await expect(notice.getByRole('button', { name: 'Overwrite the file' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('control: a pasted document still gets a new file from the Save dialog', async ({ page }) => {
  await openViewer(page, { savePicker: { name: 'pasted.md', truncate: true } });
  await page.locator('#mdBody').waitFor({ state: 'attached' });
  await paste(page, '# Pasted notes\n\nA pasted paragraph to comment on.\n');
  await expect(page.locator('#mdBody')).toContainText('A pasted paragraph');
  await page.locator('#mdBody p', { hasText: 'A pasted paragraph' }).click({ button: 'right' });
  await page.locator('.mdv-ctx-menu button').click();
  await page.locator('.mdv-add-popup textarea').fill('Saved into a new file');
  await page.locator('.mdv-add-popup .mdv-add-save').click();
  await expect.poll(() => page.evaluate(() => window.__t.opfsText('pasted.md')), { timeout: 5000 }).toContain('Saved into a new file');
  expect(await page.evaluate(() => window.__t.pickerCalls.save)).toBe(1);
});

test('the save-location button writes a pasted document into the new file picked for it', async ({ page }) => {
  await openViewer(page, { savePicker: { name: 'from-paste.md', truncate: true } });
  await page.evaluate((t) => window.__t.opfsWrite('from-paste.md', t), '# An older file that the reader chose to replace\n');
  await page.locator('#mdBody').waitFor({ state: 'attached' });
  await paste(page, '# Pasted notes\n\nA pasted paragraph, not commented yet.\n');
  await expect(page.locator('#mdBody')).toContainText('A pasted paragraph');
  await page.locator('#mdvOpenBtn').click();
  await expect.poll(() => page.evaluate(() => window.__t.opfsText('from-paste.md')), { timeout: 5000 })
    .toBe('# Pasted notes\n\nA pasted paragraph, not commented yet.\n');
});

test('the add-comment popup never links a file for a document that is no longer on screen', async ({ page }) => {
  await openViewer(page, { savePicker: { name: 'a.md' }, openPicker: { name: 'a.md' } });
  const A = '# A\n\nA paragraph of document A.\n';
  const B = '# B\n\nA paragraph of document B.\n';
  await page.evaluate((t) => window.__t.opfsWrite('a.md', t), A);
  await page.locator('#fileInput').setInputFiles({ name: 'a.md', mimeType: 'text/markdown', buffer: Buffer.from(A) });
  await expect(page.locator('#mdBody')).toContainText('document A');
  await page.locator('#mdBody p', { hasText: 'document A' }).click({ button: 'right' });
  await page.locator('.mdv-ctx-menu button').click();
  await page.locator('.mdv-add-popup textarea').fill('Comment meant for A');
  // Another document is opened while the popup is still open
  await page.locator('#fileInput').setInputFiles({ name: 'b.md', mimeType: 'text/markdown', buffer: Buffer.from(B) });
  await expect(page.locator('#mdBody')).toContainText('document B');
  await page.locator('.mdv-add-popup .mdv-add-save').click();
  await page.waitForTimeout(500);
  await expect(page.locator('.mdv-add-popup textarea'), 'the typed text stays in the box').toHaveValue('Comment meant for A');
  // A comment on B: it must not reach a.md
  await page.evaluate(async () => { await mdvAddComment(window.__t.para('A paragraph of document B'), null, 'On B'); await mdvFlushWrites(); });
  const r = await page.evaluate(async () => ({ a: await window.__t.opfsText('a.md'), linked: mdvFileHandle !== null,
    pickers: window.__t.pickerCalls.open + window.__t.pickerCalls.save }));
  expect(r.pickers, 'no dialog opened for a document that is gone').toBe(0);
  expect(r.linked).toBe(false);
  expect(r.a).toBe(A);
});

test('the file-plus button opens a file chooser, never a download, when the browser cannot write files and a document is open', async ({ page }) => {
  const errors = await openViewer(page, { noFsAccess: true });
  await page.evaluate((plan) => window.__t.open(plan, 'plan.md', null), PLAN);
  const downloads = [];
  page.on('download', (d) => downloads.push(d));
  const chooser = page.waitForEvent('filechooser', { timeout: 5000 });
  await page.locator('#mdvOpenBtn').click();
  await chooser;
  await page.waitForTimeout(300);
  expect(downloads.length).toBe(0);
  expect(errors).toEqual([]);
});

// ---------------------------------------------------------------------------------------------------------------
// Which version of the file a save may replace
// ---------------------------------------------------------------------------------------------------------------

test('a save queued before "Reload from disk" never writes over the reloaded file', async ({ page }) => {
  const errors = await openViewer(page);
  page.on('dialog', (d) => d.accept());
  await page.evaluate(async ({ plan, ext }) => {
    window.h = window.__t.fakeHandle('plan.md', plan);
    await mdvOpenWithHandle(window.h, { prompt: false });
    window.h.external(ext);
    await mdvAddComment(window.__t.para('The first paragraph'), null, 'c1');
  }, { plan: PLAN, ext: EXT });
  const notice = page.locator('#mdvNotices .mdv-notice-conflict');
  await expect(notice).toBeVisible();
  // Two quick replies: the first one's save is still reading the file (a large file, a slow or network disk)
  await page.evaluate(() => {
    window.release = window.__t.arm('plan.md:getFile');
    window.root = mdvComments.find((c) => c && !c.parent_id).id;
    window.__t.reply(window.root, 'r2');
  });
  await expect.poll(() => page.evaluate(() => window.__t.blocked)).toBe(1);
  await page.evaluate(() => window.__t.reply(window.root, 'r3'));
  // The reader discards their comment changes and asks for the file's version
  await notice.getByRole('button', { name: 'Reload from disk' }).click();
  await expect.poll(() => page.evaluate(() => rawMarkdown)).toBe(EXT);
  await page.evaluate(() => window.release());
  await page.evaluate(() => mdvFlushWrites());
  await page.waitForTimeout(300);
  const r = await page.evaluate(() => ({ disk: window.h.text, writes: window.h.writes.length }));
  expect(r.disk, 'the reloaded (newer) file is still on disk').toBe(EXT);
  expect(r.writes).toBe(0);
  expect(await notices(page), 'the changes the reader discarded do not come back as notices').toEqual([]);
  expect(errors).toEqual([]);
});

test('control: "Reload from disk" that cannot read the file keeps the comment changes protected', async ({ page }) => {
  await openViewer(page);
  page.on('dialog', (d) => d.accept());
  await page.evaluate(async ({ plan, ext }) => {
    window.h = window.__t.fakeHandle('plan.md', plan);
    await mdvOpenWithHandle(window.h, { prompt: false });
    window.h.external(ext);
    await mdvAddComment(window.__t.para('The first paragraph'), null, 'kept through a failed reload');
    await mdvFlushWrites();
  }, { plan: PLAN, ext: EXT });
  await expect(page.locator('#mdvNotices .mdv-notice-conflict')).toBeVisible();
  // The other program moved the file away: it can no longer be read
  await page.evaluate(() => { window.h.getFile = async () => { throw new DOMException('The file was moved.', 'NotFoundError'); }; });
  await page.locator('#mdvNotices .mdv-notice-conflict').getByRole('button', { name: 'Reload from disk' }).click();
  await page.waitForTimeout(300);
  const r = await page.evaluate(() => ({ dirty: mdvDirty, unsaved: mdvHasUnsavedWork(),
    kept: mdvNotices.filter((n) => n.kind === 'conflict' && n.text.includes('kept through a failed reload')).length,
    onScreen: rawMarkdown.includes('kept through a failed reload') }));
  expect(r).toEqual({ dirty: true, unsaved: true, kept: 1, onScreen: true });
});

test('a reload whose new version fails to render keeps the comment in its notice, and the next save does not settle it', async ({ page }) => {
  await openViewer(page);
  page.on('dialog', (d) => d.accept());
  await page.evaluate(async ({ plan }) => {
    window.h = window.__t.fakeHandle('plan.md', plan);
    await mdvOpenWithHandle(window.h, { prompt: false });
    window.h.external('---\nstatus: draft\n---\n' + plan);
    await mdvAddComment(window.__t.para('The first paragraph'), null, 'MY COMMENT');
  }, { plan: PLAN });
  await expect(page.locator('#mdvNotices .mdv-notice-conflict')).toBeVisible();
  // The other version cannot be shown (a renderer error, as with roadmap issue 17)
  // The other version cannot be shown. Since stream S a frontmatter-dashboard error is caught and the page still
  // renders, so the failure goes into the render pipeline itself (renderMarkdown would show it in place).
  await page.evaluate(() => { window.__realParse = window.parseFrontmatter; window.parseFrontmatter = (src) => { if (src.startsWith('---')) throw new TypeError('the renderer failed'); return window.__realParse(src); }; });
  await page.locator('#mdvNotices .mdv-notice-conflict').getByRole('button', { name: 'Reload from disk' }).click();
  await page.waitForTimeout(300);
  await page.evaluate(() => { window.parseFrontmatter = window.__realParse; });
  // One more comment. The file on disk is still the other version, which could not be shown, so this save must not
  // write over it either: before stream S's renderer kept a failed page in place, a failed reload made that version
  // the base, and this save silently replaced the other program's edit with the old text plus this comment.
  await page.evaluate(async () => {
    await mdvAddComment(window.__t.para('The last paragraph'), null, 'SECOND');
    await mdvFlushWrites();
  });
  expect(await page.evaluate(() => window.h.text), 'the other program\'s version is never written over').toContain('status: draft');
  expect(await keptAnywhere(page, 'SECOND', 'h'), 'the second comment is somewhere: disk, screen or a notice').toBe(true);
  expect(await keptAnywhere(page, 'MY COMMENT', 'h'), 'the first comment is still somewhere: disk, screen or a notice').toBe(true);
  expect(await page.evaluate(() => mdvHasUnsavedWork())).toBe(true);
});

test('reading the same file again during a conflict, then another comment: the first comment survives', async ({ page }) => {
  await openViewer(page);
  await page.evaluate(async ({ plan, ext }) => {
    window.h = window.__t.fakeHandle('plan.md', plan);
    await mdvOpenWithHandle(window.h, { prompt: false });
    window.h.external(ext);
    await mdvAddComment(window.__t.para('The first paragraph'), null, 'FIRST');
  }, { plan: PLAN, ext: EXT });
  await expect(page.locator('#mdvNotices .mdv-notice-conflict')).toBeVisible();
  // A live reload of the same file, then one more comment, which saves
  await page.evaluate(async () => {
    await mdvOpenWithHandle(window.h, { prompt: false });
    await mdvAddComment(window.__t.para('The last paragraph'), null, 'SECOND');
    await mdvFlushWrites();
  });
  expect(await page.evaluate(() => window.h.text)).toContain('SECOND');
  expect(await keptAnywhere(page, 'FIRST', 'h')).toBe(true);
});

test('"Overwrite the file" replaces only the version the reader was shown', async ({ page }) => {
  await openViewer(page);
  page.on('dialog', (d) => d.accept());
  await page.evaluate(async (plan) => {
    window.h = window.__t.fakeHandle('plan.md', plan);
    await mdvOpenWithHandle(window.h, { prompt: false });
    window.h.external(plan + '\nEdit one.\n');
    await mdvAddComment(window.__t.para('The first paragraph'), null, 'Mine');
  }, PLAN);
  const notice = page.locator('#mdvNotices .mdv-notice-conflict');
  await expect(notice).toBeVisible();
  const editTwo = PLAN + '\nEdit two, made after the notice appeared.\n';
  await page.evaluate((t) => window.h.external(t), editTwo);
  await notice.getByRole('button', { name: 'Overwrite the file' }).click();
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => window.h.text), 'the newer edit is not overwritten').toBe(editTwo);
  await expect(page.locator('#mdvNotices .mdv-notice-conflict'), 'the reader is asked again, about the newer version').toHaveCount(1);
  // Overwriting the version now shown does write
  await page.locator('#mdvNotices .mdv-notice-conflict').getByRole('button', { name: 'Overwrite the file' }).click();
  await expect.poll(() => page.evaluate(() => window.h.text)).toContain('Mine');
});

test('an edit of the same size, with the same time stamp, is never overwritten', async ({ page }) => {
  await openViewer(page);
  await page.evaluate(async (plan) => {
    window.h = window.__t.fakeHandle('plan.md', plan);
    await mdvOpenWithHandle(window.h, { prompt: false });
    // A file system that keeps whole seconds: an edit of the same length within the same second
    window.h.externalSameStamp(plan.replace('item alpha', 'item ALPHA'));
    await mdvAddComment(window.__t.para('The first paragraph'), null, 'Must not overwrite');
    await mdvFlushWrites();
  }, PLAN);
  const r = await page.evaluate(() => ({ text: window.h.text, writes: window.h.writes.length }));
  expect(r.text).toContain('item ALPHA');
  expect(r.writes).toBe(0);
  await expect(page.locator('#mdvNotices .mdv-notice-conflict')).toBeVisible();
});

test('an edit made right after the viewer\'s own save is never absorbed and overwritten', async ({ page }) => {
  await openViewer(page);
  await page.evaluate(async (plan) => {
    window.h = window.__t.fakeHandle('plan.md', plan);
    await mdvOpenWithHandle(window.h, { prompt: false });
    window.h.onClose = () => window.h.external(window.h.text + '\nAn edit that landed right after the viewer saved.\n');
    await mdvAddComment(window.__t.para('The first paragraph'), null, 'first');
    await mdvFlushWrites();
    await mdvAddComment(window.__t.para('The last paragraph'), null, 'second');
    await mdvFlushWrites();
  }, PLAN);
  const r = await page.evaluate(() => ({ text: window.h.text, writes: window.h.writes.length }));
  expect(r.text).toContain('An edit that landed right after the viewer saved.');
  expect(r.writes).toBe(1);
  await expect(page.locator('#mdvNotices .mdv-notice-conflict')).toBeVisible();
});

test('a file changed while the viewer is writing it keeps the other program\'s change', async ({ page }) => {
  await openViewer(page);
  await page.evaluate(async (plan) => {
    window.h = window.__t.fakeHandle('plan.md', plan);
    await mdvOpenWithHandle(window.h, { prompt: false });
    // Another program saves the file after the viewer checked it, while the viewer's write is still open
    window.h.onWrite = () => window.h.external(window.h.text + '\nWritten by another program during the save.\n');
    await mdvAddComment(window.__t.para('The first paragraph'), null, 'Mine');
    await mdvFlushWrites();
  }, PLAN);
  const r = await page.evaluate(() => ({ text: window.h.text, writes: window.h.writes.length }));
  expect(r.text).toContain('Written by another program during the save.');
  expect(r.writes).toBe(0);
  await expect(page.locator('#mdvNotices .mdv-notice-conflict')).toBeVisible();
});

test('a comment change made while another document is being opened is refused, never mixed into it', async ({ page }) => {
  await openViewer(page);
  await page.evaluate((sample) => window.__t.open(sample, 'commented.md', null), SAMPLE);
  await threads(page, 2);
  // A workspace folder that answers slowly keeps the next document's loader waiting before it renders
  await page.evaluate(() => {
    mdvWorkspaceDir = {
      name: 'slow', async queryPermission() { return 'granted'; },
      async getFileHandle() { await new Promise((r) => setTimeout(r, 1500)); throw new DOMException('none', 'NotFoundError'); }
    };
  });
  const other = await page.evaluate(() => mdvSerialize('# Other\n\nThe other document.\n', [window.__t.comment('the other document\'s own comment')]));
  await page.locator('#fileInput').setInputFiles({ name: 'other.md', mimeType: 'text/markdown', buffer: Buffer.from(other) });
  await page.waitForTimeout(300); // the loader is now waiting on the folder; commented.md is still on screen
  const left = await page.evaluate(() => window.__t.reply(mdvComments.find((c) => !c.parent_id).id, 'reply in the window'));
  await expect(page.locator('#mdBody')).toContainText('The other document.');
  await page.waitForTimeout(200);
  const r = await page.evaluate(() => ({ raw: rawMarkdown, comments: mdvComments.map((c) => c.body_md) }));
  expect(left, 'the reply stays in its box').toBe('reply in the window');
  expect(r.raw).not.toContain('reply in the window');
  expect(r.comments).toEqual(['the other document\'s own comment']);
});

test('a file stays linked only to the document that was read from it', async ({ page }) => {
  await openViewer(page);
  await page.evaluate(async (plan) => {
    window.h = window.__t.fakeHandle('plan.md', plan);
    window.__t.open(plan, 'plan.md', window.h);
    // A loader that replaces the document and leaves the file linked
    window.__t.open('# Something else\n\nA different document.\n', 'plan.md', window.h);
  }, PLAN);
  expect(await page.evaluate(() => mdvFileHandle === null), 'the file is unlinked').toBe(true);
  await page.evaluate(async () => {
    await mdvAddComment(window.__t.para('A different document'), null, 'Not for plan.md');
    await mdvSaveFile({ allowPrompt: false });
    await mdvFlushWrites();
  });
  const r = await page.evaluate(() => ({ text: window.h.text, writes: window.h.writes.length }));
  expect(r).toEqual({ text: PLAN, writes: 0 });
});

// ---------------------------------------------------------------------------------------------------------------
// The desktop app: the same seam, through mdvHost
// ---------------------------------------------------------------------------------------------------------------

const DESKTOP = { path: '/docs/plan.md', mtime: 500, text: PLAN };

test('desktop: a document pasted into the window is never written over the window\'s file', async ({ page }) => {
  await openViewer(page, { desktop: DESKTOP });
  await page.evaluate((plan) => window.__t.open(plan, 'plan.md', null), PLAN);
  await paste(page, '# Pasted\n\nA pasted paragraph that is not the file.\n');
  await expect(page.locator('#mdBody')).toContainText('A pasted paragraph');
  // Cmd/Ctrl+S with no comment at all, then a comment
  await page.locator('#mdBody h1').click();
  await page.keyboard.press('ControlOrMeta+s');
  await page.evaluate(() => mdvFlushWrites());
  const afterSave = await page.evaluate(() => ({ disk: window.mdvHost.disk.text, sent: window.mdvHost.calls.length }));
  expect(afterSave.disk, 'Cmd/Ctrl+S leaves the window\'s file unchanged').toBe(PLAN);
  await page.evaluate(async () => { await mdvAddComment(window.__t.para('A pasted paragraph'), null, 'on pasted text'); await mdvFlushWrites(); });
  const r = await page.evaluate(() => ({ disk: window.mdvHost.disk.text, sent: window.mdvHost.calls.length }));
  expect(r.disk, 'the window\'s file is unchanged').toBe(PLAN);
  expect(r.sent).toBe(0);
});

test('desktop: a different file opened in the window is never written over the window\'s file', async ({ page }) => {
  await openViewer(page, { desktop: DESKTOP });
  await page.evaluate((plan) => window.__t.open(plan, 'plan.md', null), PLAN);
  await page.locator('#fileInput').setInputFiles({ name: 'other.md', mimeType: 'text/markdown', buffer: Buffer.from('# Other\n\nA different file.\n') });
  await expect(page.locator('#mdBody')).toContainText('A different file.');
  await page.evaluate(async () => { await mdvAddComment(window.__t.para('A different file'), null, 'on the other file'); await mdvFlushWrites(); });
  const r = await page.evaluate(() => ({ disk: window.mdvHost.disk.text, sent: window.mdvHost.calls.length }));
  expect(r.disk).toBe(PLAN);
  expect(r.sent).toBe(0);
});

async function desktopConflict(page, ext, body) {
  await page.evaluate(async ({ plan, ext, body }) => {
    window.__t.open(plan, 'plan.md', null);
    window.mdvHost.external(ext);
    await mdvAddComment(window.__t.para('The first paragraph'), null, body);
  }, { plan: PLAN, ext, body });
  await expect(page.locator('#mdvNotices .mdv-notice-conflict')).toBeVisible();
}

test('desktop: a failed "Reload from disk" keeps the comment changes protected', async ({ page }) => {
  const errors = await openViewer(page, { desktop: DESKTOP });
  page.on('dialog', (d) => d.accept());
  await desktopConflict(page, PLAN + '\nEdited elsewhere.\n', 'DESKTOP');
  // The other program moved the file: the app's read is refused
  await page.evaluate(() => { window.mdvHost.readDocument = async () => { throw { code: 'NotFound', message: 'gone' }; }; });
  await page.locator('#mdvNotices .mdv-notice-conflict').getByRole('button', { name: 'Reload from disk' }).click();
  await page.waitForTimeout(300);
  const r = await page.evaluate(() => ({ unsaved: mdvHasUnsavedWork(), dirty: mdvDirty,
    kept: mdvNotices.filter((n) => n.kind === 'conflict' && n.text.includes('DESKTOP')).length }));
  expect(r).toEqual({ unsaved: true, dirty: true, kept: 1 });
  expect(errors).toEqual([]);
});

test('desktop: a reload whose new version fails to render keeps the comment in its notice', async ({ page }) => {
  await openViewer(page, { desktop: DESKTOP });
  page.on('dialog', (d) => d.accept());
  await desktopConflict(page, '---\nstatus: draft\n---\n' + PLAN, 'DESKTOP');
  // The other version cannot be shown. Since stream S a frontmatter-dashboard error is caught and the page still
  // renders, so the failure goes into the render pipeline itself (renderMarkdown would show it in place).
  await page.evaluate(() => { window.__realParse = window.parseFrontmatter; window.parseFrontmatter = (src) => { if (src.startsWith('---')) throw new TypeError('the renderer failed'); return window.__realParse(src); }; });
  await page.locator('#mdvNotices .mdv-notice-conflict').getByRole('button', { name: 'Reload from disk' }).click();
  await page.waitForTimeout(300);
  await page.evaluate(() => { window.parseFrontmatter = window.__realParse; });
  expect(await page.evaluate(() => mdvNotices.some((n) => (n.text || '').includes('DESKTOP')))).toBe(true);
  expect(await page.evaluate(() => mdvHasUnsavedWork())).toBe(true);
  // The page the comments sit on is still the one on screen: the version that could not be shown never replaced it
  expect(await page.evaluate(() => rawMarkdown.includes('status: draft')), 'the unrenderable version never became the document').toBe(false);
  await expect(page.locator('#mdBody')).toContainText('The first paragraph');
});

for (const takesNewMtime of [true, false]) {
  test(`desktop: after a live reload${takesNewMtime ? '' : ' that keeps the old mtime'}, a save never settles a notice holding other comments`, async ({ page }) => {
    await openViewer(page, { desktop: DESKTOP });
    await desktopConflict(page, PLAN + '\nEdited elsewhere.\n', 'Comment A');
    // A live reload, as the app does it on mdv://document-changed: the version on disk is shown
    await page.evaluate((newMtime) => {
      const h = window.mdvHost;
      if (newMtime) h.currentMtimeMs = h.disk.mtime;
      rawMarkdown = h.disk.text;
      renderMarkdown(h.disk.text, 'plan.md');
    }, takesNewMtime);
    await page.evaluate(async () => { await mdvAddComment(window.__t.para('The last paragraph'), null, 'Comment B'); await mdvFlushWrites(); });
    expect(await keptAnywhere(page, 'Comment A', 'desktop'), 'Comment A is still somewhere').toBe(true);
    expect(await keptAnywhere(page, 'Comment B', 'desktop')).toBe(true);
    expect(await page.evaluate(() => mdvHasUnsavedWork())).toBe(true);
  });
}

test('desktop: "Overwrite the file" writes even when the app\'s conflict answer has no mtime', async ({ page }) => {
  await openViewer(page, { desktop: Object.assign({ omitConflictMtime: true }, DESKTOP) });
  page.on('dialog', (d) => d.accept());
  await page.evaluate(async (plan) => {
    window.__t.open(plan, 'plan.md', null);
    await mdvAddComment(window.__t.para('The first paragraph'), null, 'saved first');
    await mdvFlushWrites();
    window.mdvHost.external(window.mdvHost.disk.text + '\nEdited elsewhere.\n');
    await mdvAddComment(window.__t.para('The last paragraph'), null, 'Mine');
    await mdvFlushWrites();
  }, PLAN);
  const notice = page.locator('#mdvNotices .mdv-notice-conflict');
  await expect(notice).toBeVisible();
  await notice.getByRole('button', { name: 'Overwrite the file' }).click();
  await expect.poll(() => page.evaluate(() => window.mdvHost.disk.text)).toContain('Mine');
  await expect(page.locator('#mdvNotices .mdv-notice')).toHaveCount(0);
});

test('desktop: a save queued before "Reload from disk" never writes over the reloaded file', async ({ page }) => {
  const errors = await openViewer(page, { desktop: DESKTOP });
  page.on('dialog', (d) => d.accept());
  const ext = PLAN + '\nEdited elsewhere.\n';
  await desktopConflict(page, ext, 'c1');
  await page.evaluate(() => {
    window.release = window.__t.arm('desktop-io');
    window.root = mdvComments.find((c) => c && !c.parent_id).id;
    window.__t.reply(window.root, 'r2');
  });
  await expect.poll(() => page.evaluate(() => window.__t.blocked)).toBe(1); // r2's save is on its way to the app
  await page.evaluate(() => window.__t.reply(window.root, 'r3'));          // r3's save waits behind it
  await page.locator('#mdvNotices .mdv-notice-conflict').getByRole('button', { name: 'Reload from disk' }).click();
  await expect.poll(() => page.evaluate(() => rawMarkdown)).toBe(ext);
  await page.evaluate(() => window.release());
  await page.evaluate(() => mdvFlushWrites());
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.mdvHost.disk.text), 'the reloaded (newer) file is still on disk').toBe(ext);
  expect(await notices(page)).toEqual([]);
  expect(errors).toEqual([]);
});

test('desktop: a save is never sent without a known mtime', async ({ page }) => {
  await openViewer(page, { desktop: Object.assign({ noReadMtime: true }, DESKTOP) });
  await page.evaluate(async (plan) => {
    window.mdvHost.currentMtimeMs = undefined; // an app that did not say which version it read
    window.__t.open(plan, 'plan.md', null);
    await mdvAddComment(window.__t.para('The first paragraph'), null, 'Not without a version');
    await mdvFlushWrites();
  }, PLAN);
  const r = await page.evaluate(() => ({ sent: window.mdvHost.calls.map((c) => c[2]), disk: window.mdvHost.disk.text }));
  expect(r.sent, 'no save was sent with an unknown mtime').toHaveLength(0);
  expect(r.disk).toBe(PLAN);
  await expect(page.locator('#mdvSaveStatus')).toContainText('Not saved');
});
