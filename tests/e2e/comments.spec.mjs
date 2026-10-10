// Comment data safety. Each test reproduces a bug the comment feature had (docs/roadmap.md, known issues 1-6, the
// file-plus button and the startup restore) and proves it fixed. Saves go to a fake FileSystemFileHandle, to the
// browser's private file system (OPFS) or to a fake desktop bridge, so no real file is ever touched.
//
// The tests drive the page's own functions (mdvParseFile, mdvSerialize, mdvAddComment, mdvDeleteThread, mdvSaveFile,
// mdvWriteDocument) and the real UI. They wait on effects (what reached the file) rather than on timers, so the same
// file also runs against the code before the fix and shows each bug there.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const KNOWN_NOISE = [/favicon\.ico/i, /fonts\.(googleapis|gstatic)\.com/i];
const SAMPLE = readFileSync(new URL('../../samples/commented.md', import.meta.url), 'utf8');

// A short plan with sections, inline markup, a wrapped paragraph, a list and a table
const PLAN = [
  '# Plan',
  '',
  'The first paragraph of the plan.',
  '',
  '## Details',
  '',
  'A paragraph with **bold** text and a [link](https://example.com)',
  'that continues on a second line.',
  '',
  '- item alpha',
  '- item beta with *emphasis*',
  '- item gamma',
  '',
  '| Step | Owner |',
  '|------|-------|',
  '| cell one | cell two |',
  '| cell three | cell four |',
  '',
  '## Last section',
  '',
  'The last paragraph.',
  ''
].join('\n');

// Runs in the page before its scripts: test helpers, and optionally a fake desktop bridge or a browser without the
// File System Access API.
function pageHelpers({ desktop, noFsAccess }) {
  if (noFsAccess) {
    delete window.showOpenFilePicker;
    delete window.showSaveFilePicker;
    delete window.showDirectoryPicker;
  }
  window.__t = {
    // A writable file in memory, with the parts of FileSystemFileHandle the viewer uses
    fakeHandle(name, initial) {
      let text = initial;
      let lastModified = 1700000000000;
      let active = 0;
      const h = {
        kind: 'file', name, writes: [], maxActive: 0, perm: 'granted',
        get text() { return text; },
        // Another program edits the file (its time stamp moves)
        external(next) { text = next; lastModified += 7000; },
        // Another program saves it without changing it
        touch() { lastModified += 3000; },
        async getFile() { return new File([text], name, { lastModified, type: 'text/markdown' }); },
        async createWritable() {
          active++;
          h.maxActive = Math.max(h.maxActive, active);
          let buf = '';
          return {
            async write(d) { await new Promise((r) => setTimeout(r, 5)); buf += typeof d === 'string' ? d : await new Blob([d]).text(); },
            async close() { await new Promise((r) => setTimeout(r, 5)); text = buf; lastModified += 1000; h.writes.push(buf); active--; },
            async abort() { active--; }
          };
        },
        async queryPermission() { return h.perm; },
        async requestPermission() { return h.perm; }
      };
      return h;
    },
    // Opens `text` the way every loader does: set the document globals, then render
    open(text, name, handle) {
      rawMarkdown = text;
      currentFileName = name;
      mdvFileHandle = handle || null;
      renderMarkdown(text, name);
    },
    para(start) { return [...document.querySelectorAll('#mdBody p')].find((p) => p.textContent.trim().startsWith(start)); },
    item(sel, text) { return [...document.querySelectorAll('#mdBody ' + sel)].find((e) => e.textContent.includes(text)); },
    comment(body, extra) {
      return Object.assign({ id: 'cm_' + Math.random().toString(36).slice(2, 10), parent_id: null, author: { name: 'Tester', kind: 'human' },
        body_md: body, created_at: '2026-10-10T10:00:00.000Z', updated_at: '2026-10-10T10:00:00.000Z', status: 'open' }, extra || {});
    }
  };
  if (desktop) {
    // A fake desktop bridge (js/host.js in the app): one window, one file, saves checked against the file's mtime
    const disk = { text: desktop.text || '', mtime: desktop.mtime };
    window.mdvHost = {
      kind: 'desktop', currentPath: desktop.path, currentMtimeMs: desktop.mtime, calls: [], disk,
      external(next) { disk.text = next; disk.mtime += 5000; },
      async saveDocument(path, text, expectedMtimeMs) {
        window.mdvHost.calls.push([path, text, expectedMtimeMs]);
        if (Math.abs(expectedMtimeMs - disk.mtime) > 1) {
          return { ok: false, reason: 'conflict', currentMtimeMs: disk.mtime, message: 'The file changed on disk.' };
        }
        disk.text = text;
        disk.mtime += 1;
        return { ok: true, mtimeMs: disk.mtime };
      },
      async readDocument(path) { return { path, name: path.split('/').pop(), text: disk.text, mtimeMs: disk.mtime }; },
      async openDialog() { window.mdvHost.dialogs = (window.mdvHost.dialogs || 0) + 1; }
    };
  }
}

async function setup(page, opts = {}) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const where = `${m.text()} ${(m.location() && m.location().url) || ''}`;
    if (!KNOWN_NOISE.some((r) => r.test(where))) errors.push(`console: ${where.trim()}`);
  });
  // The web fonts are a network request: answer it locally (optionally late, which delays the page's load event)
  await page.route(/fonts\.(googleapis|gstatic)\.com/, async (route) => {
    if (opts.fontDelayMs) await new Promise((r) => setTimeout(r, opts.fontDelayMs));
    // no-store: a cached answer would let a later page load skip the delay
    await route.fulfill({ status: 200, contentType: 'text/css', body: '', headers: { 'Cache-Control': 'no-store' } });
  });
  await page.addInitScript(pageHelpers, { desktop: opts.desktop || null, noFsAccess: !!opts.noFsAccess });
  return errors;
}

async function openViewer(page, opts = {}) {
  const errors = await setup(page, opts);
  await page.goto('markdown-viewer.html');
  await page.waitForFunction(() => typeof mdvParseFile === 'function' && typeof window.__t === 'object');
  return errors;
}

// Waits for the comment sidebar to show `n` threads (it redraws shortly after each render)
async function threads(page, n) {
  await expect(page.locator('#mdvThreadList .mdv-thread')).toHaveCount(n);
}

// ---------------------------------------------------------------------------------------------------------------
// The format: parse and serialize
// ---------------------------------------------------------------------------------------------------------------

test('issue 3: a document that mentions the comment tokens, even in code, keeps every character', async ({ page }) => {
  await openViewer(page);
  const r = await page.evaluate(() => {
    const doc = [
      '# Notes on the comment format',
      '',
      'The opening token is `<!-- MDV-COMMENTS:v1`.',
      '',
      'This paragraph sits between the two mentions and must survive a save.',
      '',
      'The closing token is `MDV-COMMENTS:end -->`.',
      ''
    ].join('\n');
    const parsed = mdvParseFile(doc);
    let out = null;
    let error = null;
    try { out = mdvSerialize(doc, [window.__t.comment('hello')]); } catch (e) { error = e.message; }
    const kept = out ? out.split('\n\n<!-- MDV-COMMENTS:v1\n')[0] : '';
    // The same document with a real comment block after it: the block is read, the mentions stay text
    const withBlock = doc + '\n<!-- MDV-COMMENTS:v1\n{"version":1,"generator":"mdv-viewer","comments":[{"id":"cm_a","parent_id":null,"body_md":"real","status":"open"}]}\nMDV-COMMENTS:end -->\n';
    const parsedBlock = mdvParseFile(withBlock);
    let outBlock = null;
    try { outBlock = mdvSerialize(withBlock, parsedBlock.comments.concat([window.__t.comment('second')])); } catch (e) { /* reported below */ }
    return {
      parseError: parsed.parseError, count: parsed.comments.length, error,
      charsLost: doc.replace(/\n+$/, '').length - kept.length,
      keepsText: kept === doc.replace(/\n+$/, ''),
      reparsed: out ? mdvParseFile(out).comments.map((c) => c.body_md) : null,
      removedAgain: out ? mdvSerialize(out, []) === doc : null,
      blockComments: parsedBlock.comments.map((c) => c.body_md), blockError: parsedBlock.parseError,
      blockKeepsText: !!outBlock && outBlock.startsWith(doc.replace(/\n+$/, ''))
    };
  });
  expect(r.parseError, 'a mention is not a comment block').toBeNull();
  expect(r.count).toBe(0);
  expect(r.error).toBeNull();
  expect(r.charsLost, 'characters of the document lost by a save').toBe(0);
  expect(r.keepsText).toBe(true);
  expect(r.reparsed).toEqual(['hello']);
  expect(r.removedAgain, 'removing the comments gives back the document').toBe(true);
  expect(r.blockError).toBeNull();
  expect(r.blockComments).toEqual(['real']);
  expect(r.blockKeepsText).toBe(true);
});

test('issue 4: comment text containing the escape sequences themselves round-trips through the file', async ({ page }) => {
  await openViewer(page);
  const r = await page.evaluate(() => {
    const bs = String.fromCharCode(92); // a backslash
    const tricky = 'Literal ' + bs + 'u003c and ' + bs + 'u002d, a real < and -- and --> and <!-- and ' + bs + bs + ' too';
    const out = mdvSerialize('# Title\n\nText.\n', [window.__t.comment(tricky)]);
    const parsed = mdvParseFile(out);
    const payload = out.slice(out.indexOf('<!-- MDV-COMMENTS:v1') + 20, out.lastIndexOf('MDV-COMMENTS:end'));
    return { error: parsed.parseError, body: parsed.comments.length ? parsed.comments[0].body_md : null, tricky,
      payloadIsInert: payload.indexOf('--') === -1 && payload.indexOf('<') === -1 };
  });
  expect(r.error).toBeNull();
  expect(r.body).toBe(r.tricky);
  expect(r.payloadIsInert, 'the payload can never end the HTML comment early').toBe(true);
});

test('issue 4: an unreadable comment block is never rewritten, and comments become read-only', async ({ page }) => {
  const errors = await openViewer(page);
  const broken = '# Title\n\nSome text worth keeping.\n\n<!-- MDV-COMMENTS:v1\n{"version":1,"comments":[{"id":"cm_1","body_md":"kept",}]}\nMDV-COMMENTS:end -->\n';
  await page.evaluate((doc) => {
    window.h = window.__t.fakeHandle('broken.md', doc);
    window.__t.open(doc, 'broken.md', window.h);
  }, broken);
  // Every way of changing or saving the comments
  const tried = await page.evaluate(async () => {
    const out = [];
    try { await mdvAddComment(window.__t.para('Some text'), null, 'new comment'); out.push('added'); } catch (e) { out.push('add refused'); }
    try { await mdvSaveFile({ allowPrompt: false }); out.push('saved'); } catch (e) { out.push('save threw'); }
    let threw = false;
    try { mdvSerialize(window.h.text, []); } catch (e) { threw = true; }
    out.push(threw ? 'serialize refused' : 'serialize dropped the block');
    return out;
  });
  await page.waitForTimeout(2000); // longer than the old 1.5 s auto-save
  const file = await page.evaluate(() => ({ text: window.h.text, writes: window.h.writes.length }));
  expect(file.writes, `nothing may be written (${tried.join(', ')})`).toBe(0);
  expect(file.text).toBe(broken);
  expect(tried).toContain('serialize refused');
  await expect(page.locator('#mdvNotices .mdv-notice-locked')).toContainText('read-only');
  // A block from a newer format version is not read as v1 and rewritten either
  const v2 = await page.evaluate(() => {
    const doc = '# T\n\n<!-- MDV-COMMENTS:v2\n{"version":2,"comments":[],"threads":{}}\nMDV-COMMENTS:end -->\n';
    let threw = false;
    try { mdvSerialize(doc, [window.__t.comment('x')]); } catch (e) { threw = true; }
    return { error: mdvParseFile(doc).parseError, threw };
  });
  expect(v2.error, 'a v2 block is not read as v1').not.toBeNull();
  expect(v2.threw, 'a v2 block is never rewritten as v1').toBe(true);
  expect(errors).toEqual([]);
});

test('the commented sample round-trips byte for byte, and its stored hash is reproduced', async ({ page }) => {
  await openViewer(page);
  const r = await page.evaluate(async (src) => {
    const parsed = mdvParseFile(src);
    return { same: mdvSerialize(src, parsed.comments) === src, count: parsed.comments.length, error: parsed.parseError,
      // blockHash of the first thread: SHA-256 of the normalized paragraph (a positive control for mdvHash)
      hash: String(await mdvHash('status: draft for review by the platform team, last updated on 3 october 2026.')),
      stored: parsed.comments[0].anchor.blockHash };
  }, SAMPLE);
  expect(r.error).toBeNull();
  expect(r.count).toBe(3);
  expect(r.same).toBe(true);
  expect(r.hash).toBe(r.stored);
});

test('a Windows (CRLF) file keeps CRLF line endings when comments are added and removed', async ({ page }) => {
  await openViewer(page);
  const r = await page.evaluate(() => {
    const doc = '# Title\r\n\r\nParagraph one.\r\n';
    const out = mdvSerialize(doc, [window.__t.comment('crlf')]);
    return { bareLf: /[^\r]\n/.test(out), count: mdvParseFile(out).comments.length, back: mdvSerialize(out, []) === doc };
  });
  expect(r.bareLf, 'no line ends in a bare LF').toBe(false);
  expect(r.count).toBe(1);
  expect(r.back).toBe(true);
});

// ---------------------------------------------------------------------------------------------------------------
// Saving: new threads, deletes, anchors
// ---------------------------------------------------------------------------------------------------------------

test('issue 1: a new thread is saved into the file, on the block it was started on', async ({ page }) => {
  const errors = await openViewer(page);
  await page.evaluate((doc) => {
    window.h = window.__t.fakeHandle('plan.md', doc);
    window.__t.open(doc, 'plan.md', window.h);
  }, PLAN);
  await page.evaluate(async () => {
    // A paragraph inside a section, with inline markup, written over two source lines
    await mdvAddComment(window.__t.para('A paragraph with'), null, 'New thread body');
    await mdvSaveFile({ allowPrompt: false });
  });
  await expect.poll(() => page.evaluate(() => window.h.text), { timeout: 5000 }).toContain('New thread body');
  // Reopen what was saved, as a reload would
  const r = await page.evaluate(() => {
    const saved = window.h.text;
    window.__t.open(saved, 'plan.md', null);
    const lines = saved.split('\n');
    const at = lines.indexOf('A paragraph with **bold** text and a [link](https://example.com)');
    return { markerBefore: /^<!-- MDV-ANCHOR id="c_[a-z0-9]+" -->$/.test(lines[at - 1] || ''), comments: mdvComments.length };
  });
  expect(r.markerBefore, 'the marker sits on the line before the paragraph').toBe(true);
  expect(r.comments).toBe(1);
  await expect(page.locator('#mdBody .mdv-chip')).toHaveCount(1);
  await threads(page, 1);
  await expect(page.locator('#mdvThreadList .mdv-orphan')).toHaveCount(0);
  const chipOn = await page.evaluate(() => {
    const chip = document.querySelector('#mdBody .mdv-chip');
    return chip ? chip.parentElement.textContent.slice(0, 16) : null;
  });
  expect(chipOn).toBe('A paragraph with');
  expect(errors).toEqual([]);
});

test('issue 2: a deleted thread stays deleted, and its marker goes with it', async ({ page }) => {
  const errors = await openViewer(page);
  page.on('dialog', (d) => d.accept());
  await page.evaluate((doc) => {
    window.h = window.__t.fakeHandle('commented.md', doc);
    window.__t.open(doc, 'commented.md', window.h);
  }, SAMPLE);
  await threads(page, 2);
  const gone = await page.evaluate(async () => {
    const root = mdvComments.find((c) => !c.parent_id && c.status !== 'resolved');
    mdvDeleteThread(root.id);
    await mdvSaveFile({ allowPrompt: false });
    return { id: root.id, anchor: root.anchor.id };
  });
  await expect.poll(() => page.evaluate(() => window.h.writes.length), { timeout: 5000 }).toBeGreaterThan(0);
  const saved = await page.evaluate(() => window.h.text);
  expect(saved).not.toContain(gone.id);
  expect(saved).not.toContain(gone.anchor);
  const roots = await page.evaluate(() => {
    window.__t.open(window.h.text, 'commented.md', null);
    return mdvComments.filter((c) => !c.parent_id).length;
  });
  expect(roots).toBe(1);
  expect(errors).toEqual([]);
});

test('starting a thread on a list item or a table cell keeps the list and table intact and marks that item', async ({ page }) => {
  const errors = await openViewer(page);
  await page.evaluate((doc) => {
    window.h = window.__t.fakeHandle('plan.md', doc);
    window.__t.open(doc, 'plan.md', window.h);
  }, PLAN);
  const before = await page.evaluate(() => ({ li: document.querySelectorAll('#mdBody li').length, tr: document.querySelectorAll('#mdBody tr').length }));
  await page.evaluate(async () => {
    await mdvAddComment(window.__t.item('li', 'item beta'), null, 'On the list item');
    await mdvAddComment(window.__t.item('td', 'cell three'), null, 'On the table cell');
    await mdvSaveFile({ allowPrompt: false });
  });
  await expect.poll(() => page.evaluate(() => window.h.writes.length), { timeout: 5000 }).toBeGreaterThan(0);
  await page.evaluate(() => window.__t.open(window.h.text, 'plan.md', null));
  const after = await page.evaluate(() => ({ li: document.querySelectorAll('#mdBody li').length, tr: document.querySelectorAll('#mdBody tr').length }));
  expect(after.li, 'the list keeps its items').toBe(before.li);
  expect(after.tr, 'the table keeps its rows').toBe(before.tr);
  expect(await page.evaluate(() => window.h.text)).toContain('On the table cell');
  await expect(page.locator('#mdBody .mdv-chip')).toHaveCount(2);
  await expect(page.locator('#mdvThreadList .mdv-orphan')).toHaveCount(0);
  const chips = await page.evaluate(() => [...document.querySelectorAll('#mdBody .mdv-chip')]
    .map((c) => c.parentElement.tagName + ' ' + c.parentElement.textContent.replace(/💬 \d+/g, '').trim()));
  expect(chips.sort()).toEqual(['LI item beta with emphasis', 'TD cell three']);
  expect(errors).toEqual([]);
});

test('the add-comment popup saves a thread end to end and keeps the reader in place', async ({ page }) => {
  const errors = await openViewer(page);
  await page.setViewportSize({ width: 1366, height: 500 });
  await page.evaluate((doc) => {
    window.h = window.__t.fakeHandle('commented.md', doc);
    window.__t.open(doc, 'commented.md', window.h);
  }, SAMPLE);
  await threads(page, 2);
  const target = page.locator('#mdBody p', { hasText: 'If an upload fails twice in a row' });
  await target.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => window.scrollY), 'the paragraph is far enough down to show a jump').toBeGreaterThan(200);
  await target.click({ button: 'right' });
  await page.locator('.mdv-ctx-menu button').click();
  await expect(page.locator('.mdv-add-popup'), 'the popup opens on screen, next to the paragraph').toBeInViewport();
  await page.locator('.mdv-add-popup textarea').fill('Who owns the paging rule?');
  await expect(target).toBeInViewport();
  await page.locator('.mdv-add-popup .mdv-add-save').click();
  await expect(page.locator('.mdv-add-popup')).toHaveCount(0);
  await threads(page, 3);
  await expect.poll(() => page.evaluate(() => window.h.text), { timeout: 5000 }).toContain('Who owns the paging rule?');
  await expect(target.locator('.mdv-chip')).toHaveCount(1);
  await expect(page.locator('#mdvThreadList .mdv-orphan')).toHaveCount(0);
  await expect(target, 'the paragraph commented on is still on screen').toBeInViewport();
  expect(errors).toEqual([]);
});

test('a typed comment stays in its box when adding it fails', async ({ page }) => {
  await openViewer(page);
  await page.evaluate((doc) => {
    window.h = window.__t.fakeHandle('plan.md', doc);
    window.__t.open(doc, 'plan.md', window.h);
  }, PLAN);
  await page.locator('#mdBody p', { hasText: 'The first paragraph' }).click({ button: 'right' });
  await page.locator('.mdv-ctx-menu button').click();
  await page.locator('.mdv-add-popup textarea').fill('A draft that must not vanish');
  // The document is reloaded while the reader types, so the block the popup points at is gone
  await page.evaluate(() => window.__t.open(window.h.text, 'plan.md', window.h));
  await page.locator('.mdv-add-popup .mdv-add-save').click();
  await expect(page.locator('.mdv-add-popup textarea')).toHaveValue('A draft that must not vanish');
});

test('a reply being typed survives the sidebar redrawing for another thread', async ({ page }) => {
  await openViewer(page);
  await page.evaluate((doc) => {
    window.h = window.__t.fakeHandle('commented.md', doc);
    window.__t.open(doc, 'commented.md', window.h);
  }, SAMPLE);
  await threads(page, 2);
  await page.evaluate(() => mdvToggleSidebar(true));
  // Reopen the resolved thread so both have a reply box
  await page.locator('#mdvThreadList .mdv-thread.mdv-resolved .mdv-resolve-btn').click();
  await expect(page.locator('#mdvThreadList .mdv-reply-input')).toHaveCount(2);
  await page.locator('#mdvThreadList .mdv-reply-input').nth(1).fill('Half-written reply');
  await page.locator('#mdvThreadList .mdv-resolve-btn').first().click();
  await expect(page.locator('#mdvThreadList .mdv-reply-input').last()).toHaveValue('Half-written reply');
});

test('thread cards keep their reply box and buttons visible when the sidebar is full', async ({ page }) => {
  await openViewer(page);
  await page.setViewportSize({ width: 1366, height: 600 });
  await page.evaluate((sample) => {
    // The sample's two threads, both open, with enough replies to outgrow the sidebar
    const comments = mdvParseFile(sample).comments.map((c) => Object.assign({}, c, { status: 'open' }));
    const root = comments.find((c) => !c.parent_id).id;
    for (let i = 1; i <= 3; i++) comments.push(window.__t.comment('Reply number ' + i + ' in a long discussion.', { parent_id: root }));
    window.__t.open(mdvSerialize(sample, comments), 'commented.md', null);
    mdvToggleSidebar(true);
  }, SAMPLE);
  await threads(page, 2);
  const clipped = await page.evaluate(() => [...document.querySelectorAll('#mdvThreadList .mdv-thread')]
    .filter((c) => c.scrollHeight > c.clientHeight + 1).length);
  expect(clipped, 'cards whose content is cut off').toBe(0);
});

test('comment data from a file cannot inject markup into the sidebar', async ({ page }) => {
  const errors = await openViewer(page);
  await page.evaluate(() => {
    const evil = window.__t.comment('<b>not bold</b>', {
      id: 'x" onmouseover="window.__pwned=1" data-x="',
      author: { name: '<img src=x onerror="window.__pwned=2">', kind: 'human" onclick="window.__pwned=3' }
    });
    const doc = mdvSerialize('# Evil\n\nSome text.\n', [evil]);
    window.__t.open(doc, 'evil.md', null);
  });
  await threads(page, 1);
  await page.evaluate(() => mdvToggleSidebar(true));
  await page.locator('#mdvThreadList .mdv-comment').hover();
  await page.locator('#mdvThreadList .mdv-comment').click();
  const r = await page.evaluate(() => ({
    handlers: document.querySelectorAll('#mdvThreadList [onmouseover], #mdvThreadList [onclick], #mdvThreadList [onerror]').length,
    images: document.querySelectorAll('#mdvThreadList img').length,
    pwned: window.__pwned === undefined ? null : window.__pwned,
    author: document.querySelector('#mdvThreadList .mdv-author-name').textContent
  }));
  expect(r.handlers).toBe(0);
  expect(r.images).toBe(0);
  expect(r.pwned).toBeNull();
  expect(r.author).toBe('<img src=x onerror="window.__pwned=2">');
  expect(errors).toEqual([]);
});

// ---------------------------------------------------------------------------------------------------------------
// Conflicts and the single save seam (issue 6)
// ---------------------------------------------------------------------------------------------------------------

test('issue 6: a file changed by another program is never overwritten; the change is kept and the reader decides', async ({ page }) => {
  const errors = await openViewer(page);
  page.on('dialog', (d) => d.accept());
  await page.evaluate((doc) => {
    window.h = window.__t.fakeHandle('plan.md', doc);
    window.__t.open(doc, 'plan.md', window.h);
  }, PLAN);
  const external = PLAN + '\nA line written in another editor.\n';
  await page.evaluate(async (ext) => {
    window.h.external(ext);
    await mdvAddComment(window.__t.para('The first paragraph'), null, 'Comment made while the file changed');
    await mdvSaveFile({ allowPrompt: false });
  }, external);
  await page.waitForTimeout(2000); // longer than the old 1.5 s auto-save
  const file = await page.evaluate(() => ({ text: window.h.text, writes: window.h.writes.length }));
  expect(file.text, 'the other program\'s edit is still in the file').toBe(external);
  expect(file.writes).toBe(0);
  // The reader is told, and the comment is kept in memory
  const notice = page.locator('#mdvNotices .mdv-notice-conflict');
  await expect(notice).toContainText('changed on disk');
  await expect(page.locator('#mdvSaveStatus')).toContainText('Not saved');
  expect(await page.evaluate(() => rawMarkdown.includes('Comment made while the file changed'))).toBe(true);
  // "Download my version" hands over everything
  const download = page.waitForEvent('download');
  await notice.getByRole('button', { name: 'Download my version' }).click();
  const file2 = await (await download).path();
  expect(readFileSync(file2, 'utf8')).toContain('Comment made while the file changed');
  // "Reload from disk" shows the other program's version
  await notice.getByRole('button', { name: 'Reload from disk' }).click();
  await expect.poll(() => page.evaluate(() => rawMarkdown)).toBe(external);
  await expect(page.locator('#mdvNotices .mdv-notice')).toHaveCount(0);
  expect(await page.evaluate(() => window.h.writes.length)).toBe(0);
  expect(errors).toEqual([]);
});

test('issue 6: after a conflict, "Overwrite the file" is the reader\'s explicit choice and then saves', async ({ page }) => {
  await openViewer(page);
  page.on('dialog', (d) => d.accept());
  await page.evaluate((doc) => {
    window.h = window.__t.fakeHandle('plan.md', doc);
    window.__t.open(doc, 'plan.md', window.h);
    window.h.external(doc + '\nOther edit.\n');
  }, PLAN);
  await page.evaluate(() => mdvAddComment(window.__t.para('The last paragraph'), null, 'Mine wins'));
  const notice = page.locator('#mdvNotices .mdv-notice-conflict');
  await expect(notice).toBeVisible();
  await notice.getByRole('button', { name: 'Overwrite the file' }).click();
  await expect.poll(() => page.evaluate(() => window.h.text)).toContain('Mine wins');
  await expect(page.locator('#mdvNotices .mdv-notice')).toHaveCount(0);
  // Later saves work normally again
  await page.evaluate(() => mdvAddComment(window.__t.para('The first paragraph'), null, 'And this one'));
  await expect.poll(() => page.evaluate(() => window.h.text)).toContain('And this one');
});

test('a file that was only touched (same contents, new time stamp) still saves: no false conflict', async ({ page }) => {
  await openViewer(page);
  await page.evaluate((doc) => {
    window.h = window.__t.fakeHandle('commented.md', doc);
    window.__t.open(doc, 'commented.md', window.h);
  }, SAMPLE);
  await threads(page, 2);
  await page.evaluate(() => {
    window.h.touch();
    const box = document.createElement('textarea');
    box.value = 'A reply after a touch';
    mdvPostReply(mdvComments.find((c) => !c.parent_id).id, box);
  });
  await expect.poll(() => page.evaluate(() => window.h.text), { timeout: 5000 }).toContain('A reply after a touch');
  await expect(page.locator('#mdvNotices .mdv-notice')).toHaveCount(0);
});

test('saves never overlap, and the file ends with the newest text', async ({ page }) => {
  await openViewer(page);
  await page.evaluate((doc) => {
    window.h = window.__t.fakeHandle('commented.md', doc);
    window.__t.open(doc, 'commented.md', window.h);
  }, SAMPLE);
  await threads(page, 2);
  await page.evaluate(() => {
    const root = mdvComments.find((c) => !c.parent_id).id;
    for (let i = 1; i <= 5; i++) {
      const box = document.createElement('textarea');
      box.value = 'Quick reply ' + i;
      mdvPostReply(root, box);
    }
  });
  await expect.poll(() => page.evaluate(() => window.h.text), { timeout: 5000 }).toContain('Quick reply 5');
  await page.waitForTimeout(300);
  const r = await page.evaluate(() => ({ text: window.h.text, maxActive: window.h.maxActive, same: window.h.text === rawMarkdown }));
  expect(r.same, 'the file holds exactly what the viewer holds').toBe(true);
  expect(r.maxActive, 'at most one write at a time').toBe(1);
  for (let i = 1; i <= 5; i++) expect(r.text).toContain('Quick reply ' + i);
});

test('a save still running when another document opens goes to its own file', async ({ page }) => {
  const errors = await openViewer(page);
  const other = '# Another document\n\nNothing to see.\n';
  await page.evaluate(async ({ plan, other }) => {
    window.hA = window.__t.fakeHandle('plan.md', plan);
    window.hB = window.__t.fakeHandle('other.md', other);
    window.__t.open(plan, 'plan.md', window.hA);
    await mdvAddComment(window.__t.para('The first paragraph'), null, 'Belongs to the plan');
    window.__t.open(other, 'other.md', window.hB); // the save of the plan is still in flight
  }, { plan: PLAN, other });
  await expect.poll(() => page.evaluate(() => window.hA.text), { timeout: 5000 }).toContain('Belongs to the plan');
  await page.waitForTimeout(2000);
  const b = await page.evaluate(() => ({ text: window.hB.text, writes: window.hB.writes.length }));
  expect(b.writes, 'the other document was not written').toBe(0);
  expect(b.text).toBe(other);
  expect(errors).toEqual([]);
});

test('comment changes that never reached a file are kept when another document is opened', async ({ page }) => {
  await openViewer(page);
  await page.evaluate(async (plan) => {
    window.__t.open(plan, 'plan.md', null); // opened without a writable file (drag-and-drop, paste, a link)
    await mdvAddComment(window.__t.para('The first paragraph'), null, 'Only in memory');
    window.__t.open('# Next\n\nSomething else.\n', 'next.md', null);
  }, PLAN);
  const notice = page.locator('#mdvNotices .mdv-notice-unsaved');
  await expect(notice).toContainText('plan.md');
  const download = page.waitForEvent('download');
  await notice.getByRole('button', { name: 'Download plan.md' }).click();
  const d = await download;
  expect(d.suggestedFilename()).toBe('plan.md');
  expect(readFileSync(await d.path(), 'utf8')).toContain('Only in memory');
});

test('leaving the page with unsaved comment changes asks first', async ({ page }) => {
  await openViewer(page);
  await page.evaluate(async (plan) => {
    window.__t.open(plan, 'plan.md', null);
    await mdvAddComment(window.__t.para('The first paragraph'), null, 'Not saved anywhere yet');
  }, PLAN);
  await page.locator('#mdBody h1').click(); // a user gesture, which browsers require before they ask
  let asked = null;
  page.on('dialog', (d) => { asked = d.type(); d.dismiss(); });
  await page.close({ runBeforeUnload: true });
  await expect.poll(() => asked).toBe('beforeunload');
});

// ---------------------------------------------------------------------------------------------------------------
// The desktop bridge: the same seam, through mdvHost.saveDocument
// ---------------------------------------------------------------------------------------------------------------

test('in the desktop app every save goes through mdvHost.saveDocument with the mtime that was read', async ({ page }) => {
  const errors = await openViewer(page, { desktop: { path: '/docs/plan.md', mtime: 111, text: PLAN } });
  await page.evaluate((doc) => {
    window.pickerCalls = 0;
    window.showSaveFilePicker = async () => { window.pickerCalls++; throw new DOMException('no', 'AbortError'); };
    window.__t.open(doc, 'plan.md', null); // what the desktop boot does with initialDocument()
  }, PLAN);
  // Through the real UI: right-click, type, save
  await page.locator('#mdBody p', { hasText: 'The first paragraph' }).click({ button: 'right' });
  await page.locator('.mdv-ctx-menu button').click();
  await page.locator('.mdv-add-popup textarea').fill('Desktop thread');
  await page.locator('.mdv-add-popup .mdv-add-save').click();
  await expect.poll(() => page.evaluate(() => window.mdvHost.calls.length), { timeout: 5000 }).toBe(1);
  const first = await page.evaluate(() => window.mdvHost.calls[0]);
  expect(first[0]).toBe('/docs/plan.md');
  expect(first[1]).toContain('Desktop thread');
  expect(first[2]).toBe(111);
  expect(await page.evaluate(() => window.mdvHost.currentMtimeMs), 'the new mtime is kept for the next save').toBe(112);
  // A second change saves against the new mtime, and no browser Save dialog is ever opened
  await page.evaluate(() => {
    const box = document.createElement('textarea');
    box.value = 'Second change';
    mdvPostReply(mdvComments[0].id, box);
  });
  await expect.poll(() => page.evaluate(() => window.mdvHost.calls.length), { timeout: 5000 }).toBe(2);
  expect(await page.evaluate(() => window.mdvHost.calls[1][2])).toBe(112);
  expect(await page.evaluate(() => window.mdvHost.disk.text)).toContain('Second change');
  expect(await page.evaluate(() => window.pickerCalls)).toBe(0);
  // mdvWriteDocument is the seam itself
  const direct = await page.evaluate(() => mdvWriteDocument(rawMarkdown));
  expect(direct.ok).toBe(true);
  expect(errors).toEqual([]);
});

test('in the desktop app a conflict is never written over; the edit is kept until the reader chooses', async ({ page }) => {
  const errors = await openViewer(page, { desktop: { path: '/docs/plan.md', mtime: 500, text: PLAN } });
  page.on('dialog', (d) => d.accept());
  await page.evaluate(async (doc) => {
    window.__t.open(doc, 'plan.md', null);
    window.mdvHost.external(doc + '\nEdited elsewhere.\n');
    await mdvAddComment(window.__t.para('The first paragraph'), null, 'Kept through the conflict');
  }, PLAN);
  const notice = page.locator('#mdvNotices .mdv-notice-conflict');
  await expect(notice).toBeVisible();
  expect(await page.evaluate(() => window.mdvHost.disk.text)).toContain('Edited elsewhere.');
  const diskMtime = await page.evaluate(() => window.mdvHost.disk.mtime);
  expect(await page.evaluate(() => rawMarkdown.includes('Kept through the conflict'))).toBe(true);
  await notice.getByRole('button', { name: 'Overwrite the file' }).click();
  await expect.poll(() => page.evaluate(() => window.mdvHost.disk.text)).toContain('Kept through the conflict');
  const last = await page.evaluate(() => window.mdvHost.calls[window.mdvHost.calls.length - 1]);
  expect(last[2], 'the overwrite names the mtime the file had at the conflict').toBe(diskMtime);
  expect(errors).toEqual([]);
});

// ---------------------------------------------------------------------------------------------------------------
// Opening files: the workspace match (issue 5), the file-plus button, the startup restore
// ---------------------------------------------------------------------------------------------------------------

test('issue 5: a dropped file links to the workspace file of the same name only when the contents match', async ({ page }) => {
  const errors = await openViewer(page);
  const onDisk = '# Note\n\nThe version in the workspace folder.\n';
  await page.evaluate(async (text) => {
    const root = await navigator.storage.getDirectory();
    const ws = await root.getDirectoryHandle('workspace', { create: true });
    const fh = await ws.getFileHandle('note.md', { create: true });
    const w = await fh.createWritable();
    await w.write(text);
    await w.close();
    mdvWorkspaceDir = ws;
    // Reads the workspace file; a read that overlaps the viewer's write is retried (Chrome refuses to read a
    // File snapshot of a file that changed after the snapshot was taken)
    window.readNote = async () => {
      for (let i = 0; ; i++) {
        try { return await (await (await ws.getFileHandle('note.md')).getFile()).text(); } catch (e) {
          if (e.name !== 'NotReadableError' || i > 10) throw e;
          await new Promise((r) => setTimeout(r, 50));
        }
      }
    };
  }, onDisk);
  // A different file that happens to have the same name
  await page.locator('#fileInput').setInputFiles({ name: 'note.md', mimeType: 'text/markdown', buffer: Buffer.from('# Note\n\nA different file from another folder.\n') });
  await expect(page.locator('#mdBody')).toContainText('A different file');
  await page.waitForTimeout(300);
  await page.evaluate(async () => {
    await mdvAddComment(window.__t.para('A different file'), null, 'Should never reach the workspace file');
    await mdvSaveFile({ allowPrompt: false });
  });
  await page.waitForTimeout(2000);
  expect(await page.evaluate(() => window.readNote()), 'the workspace file is untouched').toBe(onDisk);
  expect(await page.evaluate(() => mdvFileHandle === null)).toBe(true);
  // The same file (same contents) does link, and saves into the workspace (the positive control)
  await page.locator('#fileInput').setInputFiles({ name: 'note.md', mimeType: 'text/markdown', buffer: Buffer.from(onDisk) });
  await expect(page.locator('#mdBody')).toContainText('The version in the workspace folder');
  await expect.poll(() => page.evaluate(() => mdvFileHandle !== null)).toBe(true);
  await page.evaluate(() => mdvAddComment(window.__t.para('The version in'), null, 'Saved into the workspace'));
  await expect.poll(() => page.evaluate(() => window.readNote()), { timeout: 5000 }).toContain('Saved into the workspace');
  expect(errors).toEqual([]);
});

test('the file-plus button opens the file chooser in browsers without the File System Access API', async ({ page }) => {
  const errors = await openViewer(page, { noFsAccess: true });
  expect(await page.evaluate(() => 'showOpenFilePicker' in window)).toBe(false);
  const chooser = page.waitForEvent('filechooser', { timeout: 5000 });
  await page.locator('#mdvOpenBtn').click();
  await chooser;
  expect(errors).toEqual([]);
});

test('without the File System Access API a comment change never downloads by itself; Cmd/Ctrl+S downloads one copy', async ({ page }) => {
  await openViewer(page, { noFsAccess: true });
  const downloads = [];
  page.on('download', (d) => downloads.push(d));
  await page.evaluate(async (plan) => {
    window.__t.open(plan, 'plan.md', null);
    await mdvAddComment(window.__t.para('The first paragraph'), null, 'Downloaded only on request');
  }, PLAN);
  await page.waitForTimeout(2500); // longer than the old 1.5 s auto-save, which downloaded on every change
  expect(downloads.length, 'no download without asking').toBe(0);
  await expect(page.locator('#mdvSaveStatus')).toContainText('Cmd/Ctrl+S');
  await page.locator('#mdBody h1').click();
  await page.keyboard.press('ControlOrMeta+s');
  await expect.poll(() => downloads.length).toBe(1);
  expect(downloads[0].suggestedFilename()).toBe('plan.md');
  expect(readFileSync(await downloads[0].path(), 'utf8')).toContain('Downloaded only on request');
});

// The last-opened file is remembered as a handle in IndexedDB. A file in the browser's private file system (OPFS)
// gives a real, storable handle with no picker.
async function rememberAFile(page) {
  await page.goto('markdown-viewer.html');
  await page.waitForFunction(() => typeof mdvPutHandle === 'function');
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const fh = await root.getFileHandle('restored.md', { create: true });
    const w = await fh.createWritable();
    await w.write('# Restored file\n\nThe last file opened in the viewer.\n');
    await w.close();
    await mdvPutHandle('current', fh);
  });
}

test('control: with no link, the last-opened file is restored at startup', async ({ page }) => {
  await setup(page);
  await rememberAFile(page);
  await page.goto('markdown-viewer.html');
  await expect(page.locator('#mdBody h1')).toHaveText(/Restored file/);
});

test('the startup restore never overrides an explicit ?file= link, even when it finishes last', async ({ page }) => {
  // The fonts answer late, so the page's load event (which starts the restore) comes after the link has loaded
  await setup(page, { fontDelayMs: 1500 });
  await rememberAFile(page);
  await page.goto('markdown-viewer.html?file=samples/commented.md');
  await page.waitForSelector('#mdBody h2');
  await page.waitForFunction(() => document.readyState === 'complete');
  await page.waitForTimeout(1000); // time for a late restore to render, if it were going to
  expect(await page.locator('#titleText').textContent()).toBe('commented.md');
  expect(await page.evaluate(() => rawMarkdown.includes('Restored file'))).toBe(false);
});

test('the desktop app never restores the last browser file', async ({ page }) => {
  await setup(page);
  await rememberAFile(page);
  await page.addInitScript(() => { window.mdvHost = { kind: 'desktop', currentPath: null, currentMtimeMs: null }; });
  await page.goto('markdown-viewer.html');
  await page.waitForFunction(() => document.readyState === 'complete');
  await page.waitForTimeout(1000);
  expect(await page.evaluate(() => rawMarkdown)).toBe('');
  await expect(page.locator('#welcomeScreen')).toBeVisible();
});
