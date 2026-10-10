// The desktop bridge (js/host.js), checked in a browser.
//
// In a browser the bridge must change nothing. For the desktop behaviour, a stand-in for the shell
// provides just enough of Tauri's injected API (window.__TAURI__ and window.__TAURI_INTERNALS__) and
// records every command the page sends, so the tests assert on what the page asked the shell to do.
// The real shell is tested by the app's own self-test (desktop/scripts/run-self-test.mjs), on macOS and
// Windows in CI.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repo = (p) => fileURLToPath(new URL(`../../${p}`, import.meta.url));
const FIXTURE_DIR = '/desktop/tests/fixtures/linked';
const FIXTURE = readFileSync(repo('desktop/tests/fixtures/linked/doc.md'), 'utf8');

function longDocument(extra = '') {
  const sections = [];
  for (let i = 1; i <= 12; i++) {
    const paragraphs = Array.from({ length: 4 }, (_, j) => `Paragraph ${j + 1} of section ${i}. ` + 'Words to read. '.repeat(24)).join('\n\n');
    sections.push(`## Section ${i}\n\n${i === 1 ? extra : ''}${paragraphs}`);
  }
  return `# A long document\n\n${sections.join('\n\n')}\n`;
}

// Installs the stand-in shell before any page script runs.
async function withShell(page, { doc = null, theme = 'light', selfTest = false } = {}) {
  await page.addInitScript(({ doc, theme, selfTest }) => {
    try { localStorage.setItem('mdv-theme', theme); } catch (_) { /* default theme */ }
    const calls = [];
    const listeners = {};
    let release = null;
    const refuse = (code, message) => Promise.reject({ code, message });
    window.__shell = {
      calls,
      report: null,
      holdSaves: false,
      releaseSave: () => release && release(),
      emit(event, payload) { for (const h of listeners[event] || []) h({ event, payload }); },
      commands: () => calls.map((c) => c.cmd),
    };
    window.__TAURI_INTERNALS__ = { metadata: { currentWindow: { label: 'doc-1' }, currentWebview: { label: 'doc-1' } } };
    window.__TAURI__ = {
      core: {
        convertFileSrc: (path) => location.origin + path.split('/').map(encodeURIComponent).join('/'),
        async invoke(cmd, args) {
          calls.push({ cmd, args: args || {} });
          switch (cmd) {
            case 'mdv_initial_document': return doc;
            case 'mdv_self_test_requested': return selfTest;
            case 'mdv_self_test_options': return selfTest ? { saveProbe: false } : null;
            case 'mdv_self_test_report': window.__shell.report = args.stats; return null;
            case 'mdv_read_document':
              if (doc && args.path === doc.path) return Object.assign({}, doc, { reason: 'reload' });
              return refuse('not-markdown', 'not a Markdown file');
            case 'mdv_save_document':
              if (!doc || args.path !== doc.path) return { ok: false, reason: 'not-allowed', message: 'A window saves only into the file it opened.' };
              if (window.__shell.holdSaves) await new Promise((r) => { release = r; });
              return { ok: true, mtimeMs: args.expectedMtimeMs + 1000 };
            case 'mdv_open_path':
              return /\.(md|markdown)$/i.test(args.path) ? null : refuse('not-markdown', 'not a Markdown file');
            case 'mdv_open_external':
              return /^(https?|mailto):/i.test(args.url) ? null : refuse('not-allowed', 'links of that kind are not opened');
            case 'mdv_make_default': return { ok: true, message: 'Markdown files now open in Kites Markdown.' };
            default: return null;
          }
        },
      },
      event: {
        async listen(event, handler, options) {
          (listeners[event] = listeners[event] || []).push(handler);
          calls.push({ cmd: 'listen', args: { event, target: options && options.target } });
          return () => {};
        },
      },
    };
  }, { doc, theme, selfTest });
}

const fixtureDoc = { path: `${FIXTURE_DIR}/doc.md`, name: 'doc.md', text: FIXTURE, mtimeMs: 1000, readOnly: null, reason: 'initial' };

async function openApp(page, options) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await withShell(page, options);
  await page.goto('markdown-viewer.html');
  return errors;
}

const callsTo = (page, cmd) => page.evaluate((c) => window.__shell.calls.filter((x) => x.cmd === c).map((x) => x.args), cmd);

test.describe('in a browser', () => {
  test('the bridge is a no-op and the viewer is unchanged', async ({ page }) => {
    await page.goto('markdown-viewer.html');
    const h = await page.evaluate(async () => ({
      kind: mdvHost.kind,
      path: mdvHost.currentPath,
      initial: await mdvHost.initialDocument(),
      save: await mdvHost.saveDocument('/a.md', 'x', 1),
      resource: mdvHost.resourceUrl('/a.png'),
      selfTest: await mdvHost.selfTestRequested(),
      pickers: 'showOpenFilePicker' in window,
    }));
    expect(h).toEqual({ kind: 'browser', path: null, initial: null, save: null, resource: null, selfTest: null, pickers: true });
    await expect(page.locator('#mdvOpenBtn')).toBeVisible();
    // The Open button still opens the browser's own file chooser.
    const chooser = page.waitForEvent('filechooser', { timeout: 5000 });
    await page.locator('#dropZone .drop-btn').click();
    await chooser;
  });
});

test.describe('in the desktop app (stand-in shell)', () => {
  test("the window's document renders at start, with the app's controls", async ({ page }) => {
    const errors = await openApp(page, { doc: fixtureDoc });
    await expect(page.locator('#mdBody h1')).toHaveText(/Linked document/);
    const state = await page.evaluate(() => ({
      kind: mdvHost.kind, path: mdvHost.currentPath, mtime: mdvHost.currentMtimeMs, title: document.title,
      raw: rawMarkdown.length, file: currentFileName, pickers: 'showOpenFilePicker' in window || 'showSaveFilePicker' in window,
    }));
    expect(state).toMatchObject({ kind: 'desktop', path: fixtureDoc.path, mtime: 1000, title: 'doc.md', raw: FIXTURE.length, file: 'doc.md', pickers: false });
    await expect(page.locator('#mdvOpenBtn')).toBeHidden();
    await expect(page.locator('#mdvWorkspaceBtn')).toBeHidden();
    // Every event listener is scoped to this window.
    const listens = await callsTo(page, 'listen');
    expect(listens.map((l) => l.event)).toEqual(expect.arrayContaining(['mdv://document-changed', 'mdv://open-document', 'mdv://notice']));
    expect(listens.every((l) => l.target === 'doc-1')).toBe(true);
    expect(errors).toEqual([]);
  });

  test('relative images load through the asset protocol; others are untouched', async ({ page }, info) => {
    await openApp(page, { doc: fixtureDoc });
    await page.waitForFunction(() => [...document.querySelectorAll('#mdBody img')].every((i) => i.complete));
    const imgs = await page.evaluate(() => [...document.querySelectorAll('#mdBody img')].map((i) => ({
      original: i.dataset.mdvSrc || null, src: i.getAttribute('src'), loaded: i.naturalWidth > 0,
    })));
    expect(imgs).toEqual([
      { original: 'images/figure.png', src: expect.stringMatching(/\/desktop\/tests\/fixtures\/linked\/images\/figure\.png$/), loaded: true },
      { original: 'figure.svg', src: expect.stringMatching(/\/desktop\/tests\/fixtures\/linked\/figure\.svg$/), loaded: true },
      // Resolved the same way; in the app the asset scope refuses it (the self-test checks that).
      { original: '../outside.png', src: expect.stringMatching(/\/desktop\/tests\/fixtures\/outside\.png$/), loaded: true },
    ]);
    await page.screenshot({ path: info.outputPath('desktop-document-light.png'), fullPage: true });
  });

  test('links open the right way, and the page never navigates away', async ({ page, context }) => {
    const doc = Object.assign({}, fixtureDoc, {
      text: FIXTURE + '\n<a href="ftp://example.com/file.md">An FTP link</a>\n\n[A card for a file](notes/plan.md)\n',
    });
    await openApp(page, { doc });
    const popups = [];
    context.on('page', (p) => popups.push(p.url()));
    const start = new URL(page.url());
    const link = (text) => page.locator('#mdBody a', { hasText: text }).first();

    await link('Another Markdown file').click();
    await link('A web page').click();
    await link('An email address').click();
    await link('A web page').click({ modifiers: ['Meta'] });
    await link('A web page').click({ button: 'middle' });
    await link('A file that is not Markdown').click();
    await expect(page.locator('#mdvHostNotices')).toContainText('opens only Markdown files, so notes.txt');
    await link('An FTP link').click();
    await expect(page.locator('#mdvHostNotices')).toContainText('ftp: links are not opened');
    await link('The same file, at a heading').click();
    await link('A heading on this page').click();

    expect(await callsTo(page, 'mdv_open_path')).toEqual([{ path: `${FIXTURE_DIR}/other.md` }]);
    expect(await callsTo(page, 'mdv_open_external')).toEqual([
      { url: 'https://example.com/' },
      { url: 'mailto:someone@example.com' },
      { url: 'https://example.com/' },
      { url: 'https://example.com/' },
    ]);
    const now = new URL(page.url());
    expect(now.origin + now.pathname).toBe(start.origin + start.pathname);
    expect(popups).toEqual([]);
    // The in-page links scrolled (smoothly) until the heading is in view; the fixture is short, so it
    // cannot reach the very top.
    await expect.poll(() => page.evaluate(() => {
      const top = document.getElementById('section-two').getBoundingClientRect().top;
      return top >= 0 && top < window.innerHeight;
    })).toBe(true);
    // A standalone link becomes a card; for a file it shows the path as written.
    await expect(page.locator('#mdBody a.link-chip', { hasText: 'A card for a file' }).locator('.link-chip-url')).toHaveText('notes/plan.md');
  });

  test('Open uses the native Open panel, never the browser file chooser', async ({ page }) => {
    await openApp(page, { doc: null });
    let chooserOpened = false;
    page.on('filechooser', () => { chooserOpened = true; });
    await page.locator('#dropZone .drop-btn').click();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+o' : 'Control+o');
    await expect.poll(() => callsTo(page, 'mdv_open_dialog').then((c) => c.length)).toBe(2);
    expect(chooserOpened).toBe(false);
  });

  test('a live reload keeps the reading position', async ({ page }) => {
    const doc = { path: '/notes/long.md', name: 'long.md', text: longDocument(), mtimeMs: 1000, readOnly: null, reason: 'initial' };
    await openApp(page, { doc });
    await page.waitForSelector('#section-6');
    await page.evaluate(() => {
      const h = document.getElementById('section-6');
      window.scrollTo({ top: window.scrollY + h.getBoundingClientRect().top - 120, behavior: 'instant' });
    });
    await page.waitForTimeout(200);
    const before = await page.evaluate(() => document.getElementById('section-6').getBoundingClientRect().top);
    // Another program inserts text near the top, pushing section 6 down the page.
    const changed = longDocument('A paragraph added by another program. '.repeat(40) + '\n\n');
    await page.evaluate((text) => window.__shell.emit('mdv://document-changed', { path: '/notes/long.md', name: 'long.md', text, mtimeMs: 2000, readOnly: null, reason: 'changed' }), changed);
    await expect(page.locator('#mdBody')).toContainText('A paragraph added by another program.');
    await page.waitForTimeout(400);
    const after = await page.evaluate(() => ({ top: document.getElementById('section-6').getBoundingClientRect().top, mtime: mdvHost.currentMtimeMs, raw: rawMarkdown.length }));
    expect(Math.abs(after.top - before)).toBeLessThan(4);
    expect(after.mtime).toBe(2000);
    expect(after.raw).toBe(changed.length);
  });

  test('changes to another file are ignored; an unchanged text only updates the time', async ({ page }) => {
    await openApp(page, { doc: fixtureDoc });
    await page.waitForSelector('#mdBody h1');
    await page.evaluate(() => window.__shell.emit('mdv://document-changed', { path: '/elsewhere/doc.md', name: 'doc.md', text: '# Not this one', mtimeMs: 5000, reason: 'changed' }));
    await page.evaluate((text) => window.__shell.emit('mdv://document-changed', { path: '/desktop/tests/fixtures/linked/doc.md', name: 'doc.md', text, mtimeMs: 3000, reason: 'changed' }), FIXTURE);
    await expect(page.locator('#mdBody h1')).toHaveText(/Linked document/);
    expect(await page.evaluate(() => mdvHost.currentMtimeMs)).toBe(3000);
  });

  test('a change that arrives during a save waits for the person', async ({ page }) => {
    await openApp(page, { doc: fixtureDoc });
    await page.waitForSelector('#mdBody h1');
    await page.evaluate(() => { window.__shell.holdSaves = true; window.__pending = mdvHost.saveDocument(mdvHost.currentPath, rawMarkdown, mdvHost.currentMtimeMs); });
    await page.evaluate(() => window.__shell.emit('mdv://document-changed', { path: mdvHost.currentPath, name: 'doc.md', text: '# Edited elsewhere\n', mtimeMs: 4000, reason: 'changed' }));
    const notices = page.locator('#mdvHostNotices');
    await expect(notices).toContainText('doc.md changed on disk.');
    await expect(page.locator('#mdBody h1')).toHaveText(/Linked document/);
    await page.evaluate(() => { window.__shell.releaseSave(); return window.__pending; });
    await notices.getByRole('button', { name: 'Reload' }).click();
    await expect(page.locator('#mdBody h1')).toHaveText(/Edited elsewhere/);
    expect(await page.evaluate(() => mdvHost.currentMtimeMs)).toBe(4000);
  });

  test("a paste does not replace the window's document", async ({ page }) => {
    await openApp(page, { doc: fixtureDoc });
    await page.waitForSelector('#mdBody h1');
    await page.evaluate(() => {
      const data = new DataTransfer();
      data.setData('text', '# Pasted over the file\n\nThis must not replace the window\'s document.');
      document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true }));
    });
    await expect(page.locator('#mdvHostNotices')).toContainText('To read pasted Markdown, open a new window');
    await expect(page.locator('#mdBody h1')).toHaveText(/Linked document/);
    expect(await page.evaluate(() => mdvHost.currentPath)).toBe(fixtureDoc.path);
  });

  test('saving goes through the shell and moves the known version forward', async ({ page }) => {
    await openApp(page, { doc: fixtureDoc });
    await page.waitForSelector('#mdBody h1');
    const results = await page.evaluate(async () => [
      await mdvHost.saveDocument(mdvHost.currentPath, rawMarkdown + '\n', mdvHost.currentMtimeMs),
      mdvHost.currentMtimeMs,
      await mdvHost.saveDocument('/somewhere/else.md', 'x', 1),
      mdvHost.currentMtimeMs,
    ]);
    expect(results).toEqual([{ ok: true, mtimeMs: 2000 }, 2000, { ok: false, reason: 'not-allowed', message: 'A window saves only into the file it opened.' }, 2000]);
    expect((await callsTo(page, 'mdv_save_document'))[0]).toEqual({ path: fixtureDoc.path, text: FIXTURE + '\n', expectedMtimeMs: 1000 });
  });

  test('paths resolve for POSIX and Windows documents', async ({ page }) => {
    await openApp(page, { doc: null });
    const r = await page.evaluate(() => {
      const at = (base, target) => { mdvHost.currentPath = base; return mdvHost.resolvePath(target); };
      return [
        at('/Users/a/notes/today.md', 'img/x.png'),
        at('/Users/a/notes/today.md', '../other.md'),
        at('/Users/a/notes/today.md', './deep/../same.md'),
        at('/Users/a/notes/today.md', '../../../../../top.md'),
        at('/Users/a/notes/today.md', '/etc/abs.md'),
        at('C:\\Users\\a\\notes\\today.md', 'img/x.png'),
        at('C:\\Users\\a\\notes\\today.md', '..\\other.md'),
        at('C:\\Users\\a\\notes\\today.md', '/root.md'),
        at('C:\\Users\\a\\notes\\today.md', 'D:/elsewhere/x.md'),
        at('\\\\server\\share\\docs\\a.md', '../b.md'),
        at(null, 'img/x.png'),
      ];
    });
    expect(r).toEqual([
      '/Users/a/notes/img/x.png',
      '/Users/a/other.md',
      '/Users/a/notes/same.md',
      '/top.md',
      '/etc/abs.md',
      'C:\\Users\\a\\notes\\img\\x.png',
      'C:\\Users\\a\\other.md',
      'C:\\root.md',
      'D:\\elsewhere\\x.md',
      '\\\\server\\share\\b.md',
      null,
    ]);
  });

  for (const theme of ['light', 'dark']) {
    test(`the welcome screen offers to become the default app (${theme})`, async ({ page }, info) => {
      await openApp(page, { doc: null, theme });
      await expect(page.locator('#dropZone .drop-zone-sub')).toHaveText('Drag a Markdown file here, or choose one.');
      await expect(page.locator('#dropZone .drop-btn')).toContainText('Open a file…');
      const offer = page.locator('#mdvDefaultApp button');
      await expect(offer).toHaveText('Make Kites Markdown the default');
      await page.screenshot({ path: info.outputPath(`desktop-welcome-${theme}.png`) });
      await offer.click();
      await expect(page.locator('#mdvHostNotices')).toContainText('Markdown files now open in Kites Markdown.');
      expect((await callsTo(page, 'mdv_make_default')).length).toBe(1);
      await page.screenshot({ path: info.outputPath(`desktop-welcome-notice-${theme}.png`) });
    });
  }

  test('the self-test detects script that runs (its positive control)', async ({ page }) => {
    // Without the app's CSP (this is a plain browser page), the probe's inline handler runs, and the
    // self-test must say so. In the app the same probe must report that nothing ran.
    const text = readFileSync(repo('samples/kitchen-sink.md'), 'utf8');
    await page.addInitScript({ path: repo('desktop/src-tauri/src/self-test.js') });
    await openApp(page, { doc: { path: '/samples/kitchen-sink.md', name: 'kitchen-sink.md', text, mtimeMs: 1000, readOnly: null, reason: 'initial' }, selfTest: true });
    const report = await page.waitForFunction(() => window.__shell && window.__shell.report, null, { timeout: 60_000 }).then((h) => h.jsonValue());
    const fences = (text.match(/^```mermaid\s*$/gm) || []).length;
    expect(report.counts.mermaidBlocks).toBe(fences);
    expect(report.counts.mermaidSvgs).toBe(fences);
    expect(report.counts.h2).toBeGreaterThan(5);
    expect(report.sanitization.rawErrorFired).toBe(true);
    expect(report.sanitization.viaRawHtml).toBeGreaterThan(0);
    expect(report.sanitization.executed).toBe(true);
    expect(report.ok).toBe(false);
    expect(report.failures).toContain('script in a document ran');
    expect(report.bridge.allRefused).toBe(true);
  });
});
