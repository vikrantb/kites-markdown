// Shared helpers for the comment tests (comments*.spec.mjs). Not a spec file itself.
//
// Saves go to a fake FileSystemFileHandle, to the browser's private file system (OPFS) or to a fake desktop bridge,
// so no real file is ever touched. The pickers are stubbed: Playwright cannot drive a native file dialog.
import { expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

export const KNOWN_NOISE = [/favicon\.ico/i, /fonts\.(googleapis|gstatic)\.com/i];
export const SAMPLE = readFileSync(new URL('../../samples/commented.md', import.meta.url), 'utf8');

// A short plan with sections, inline markup, a wrapped paragraph, a list and a table
export const PLAN = [
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

// Runs in the page before its scripts: test helpers, and optionally a fake desktop bridge, stubbed file pickers or a
// browser without the File System Access API.
function pageHelpers({ desktop, noFsAccess, openPicker, savePicker }) {
  if (noFsAccess) {
    delete window.showOpenFilePicker;
    delete window.showSaveFilePicker;
    delete window.showDirectoryPicker;
  }
  const t = {
    gates: {},
    blocked: 0,
    // One-shot gate: the next operation that passes `name` waits until the returned function is called
    arm(name) { let release; t.gates[name] = new Promise((res) => { release = res; }); return release; },
    async pass(name) { const g = t.gates[name]; if (g) { delete t.gates[name]; t.blocked++; await g; } },
    // A writable file in memory, with the parts of FileSystemFileHandle the viewer uses
    fakeHandle(name, initial) {
      let text = initial;
      let lastModified = 1700000000000;
      let active = 0;
      const h = {
        kind: 'file', name, writes: [], maxActive: 0, perm: 'granted', onClose: null,
        get text() { return text; },
        // Another program edits the file (its time stamp moves)
        external(next) { text = next; lastModified += 7000; },
        // Another program edits the file and its time stamp does not move (a file system that keeps whole seconds)
        externalSameStamp(next) { text = next; },
        // Another program saves it without changing it
        touch() { lastModified += 3000; },
        async getFile() { await t.pass(name + ':getFile'); return new File([text], name, { lastModified, type: 'text/markdown' }); },
        async createWritable() {
          await t.pass(name + ':createWritable');
          active++;
          h.maxActive = Math.max(h.maxActive, active);
          let buf = '';
          return {
            async write(d) { await new Promise((r) => setTimeout(r, 5)); buf += typeof d === 'string' ? d : await new Blob([d]).text(); },
            async close() {
              await new Promise((r) => setTimeout(r, 5));
              text = buf; lastModified += 1000; h.writes.push(buf); active--;
              if (h.onClose) { const f = h.onClose; h.onClose = null; f(); }
            },
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
    },
    reply(threadId, body) {
      const box = document.createElement('textarea');
      box.value = body;
      mdvPostReply(threadId, box);
      return box.value; // empty when the reply was taken
    },
    // Files in the browser's private file system (OPFS): real, storable handles with no picker
    async opfsWrite(name, data) {
      const root = await navigator.storage.getDirectory();
      const fh = await root.getFileHandle(name, { create: true });
      const w = await fh.createWritable();
      await w.write(data);
      await w.close();
      return fh;
    },
    async opfsBytes(name) {
      // A read that overlaps a write is retried: Chrome refuses to read a File snapshot of a file that changed since
      for (let i = 0; ; i++) {
        try {
          const root = await navigator.storage.getDirectory();
          return Array.from(new Uint8Array(await (await (await root.getFileHandle(name)).getFile()).arrayBuffer()));
        } catch (e) {
          if (e.name !== 'NotReadableError' || i > 20) throw e;
          await new Promise((r) => setTimeout(r, 50));
        }
      }
    },
    async opfsText(name) { return new TextDecoder().decode(new Uint8Array(await t.opfsBytes(name))); },
    pickerCalls: { open: 0, save: 0 }
  };
  window.__t = t;
  // The reader picks OPFS file `name` in the Open dialog
  if (openPicker) {
    window.showOpenFilePicker = async () => {
      t.pickerCalls.open++;
      const root = await navigator.storage.getDirectory();
      return [await root.getFileHandle(openPicker.name, { create: true })];
    };
  }
  // The reader picks OPFS file `name` in the Save dialog. With truncate, the stub does what Chrome does to an existing
  // file picked there, before the promise resolves: it empties it (File System Access, showSaveFilePicker step 7.7).
  if (savePicker) {
    window.showSaveFilePicker = async () => {
      t.pickerCalls.save++;
      const root = await navigator.storage.getDirectory();
      const fh = await root.getFileHandle(savePicker.name, { create: true });
      if (savePicker.truncate) { const w = await fh.createWritable(); await w.write(''); await w.close(); }
      return fh;
    };
  }
  if (desktop) {
    // A fake desktop bridge (js/host.js in the app): one window, one file. Like the app, it refuses a save whose
    // expected mtime is not a number equal to the file's.
    const disk = { text: desktop.text || '', mtime: desktop.mtime };
    window.mdvHost = {
      kind: 'desktop', currentPath: desktop.path, currentMtimeMs: desktop.mtime, calls: [], reads: 0, disk,
      external(next) { disk.text = next; disk.mtime += 5000; },
      async saveDocument(path, text, expectedMtimeMs) {
        window.mdvHost.calls.push([path, text, expectedMtimeMs]);
        await t.pass('saveDocument'); // the call is on its way to the app, which has not checked the file yet
        if (!(typeof expectedMtimeMs === 'number' && Math.abs(expectedMtimeMs - disk.mtime) <= 1)) {
          return { ok: false, reason: 'conflict', currentMtimeMs: desktop.omitConflictMtime ? undefined : disk.mtime, message: 'The file changed on disk.' };
        }
        disk.text = text;
        disk.mtime += 1;
        return { ok: true, mtimeMs: disk.mtime };
      },
      async readDocument(path) {
        window.mdvHost.reads++;
        return { path, name: path.split('/').pop(), text: disk.text, mtimeMs: desktop.noReadMtime ? undefined : disk.mtime };
      },
      async openDialog() { window.mdvHost.dialogs = (window.mdvHost.dialogs || 0) + 1; }
    };
  }
}

// Collects page and console errors, answers the web-font request locally, and installs the page helpers.
// opts.fontDelayMs answers the fonts late; opts.holdLoad (a promise) keeps the page's load event waiting until it resolves.
export async function setup(page, opts = {}) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const where = `${m.text()} ${(m.location() && m.location().url) || ''}`;
    if (!KNOWN_NOISE.some((r) => r.test(where))) errors.push(`console: ${where.trim()}`);
  });
  await page.route(/fonts\.(googleapis|gstatic)\.com/, async (route) => {
    if (opts.fontDelayMs) await new Promise((r) => setTimeout(r, opts.fontDelayMs));
    // no-store: a cached answer would let a later page load skip the delay
    await route.fulfill({ status: 200, contentType: 'text/css', body: '', headers: { 'Cache-Control': 'no-store' } });
  });
  if (opts.holdLoad) {
    // An image that is still loading delays the window's load event, as a slow image or font would
    await page.route(/__hold-load\.svg/, async (route) => {
      await opts.holdLoad;
      await route.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg"/>', headers: { 'Cache-Control': 'no-store' } });
    });
    await page.addInitScript(() => {
      document.addEventListener('DOMContentLoaded', () => {
        const img = document.createElement('img');
        img.src = '__hold-load.svg?' + Date.now();
        img.alt = '';
        img.style.display = 'none';
        document.body.appendChild(img);
      });
    });
  }
  await page.addInitScript(pageHelpers, {
    desktop: opts.desktop || null, noFsAccess: !!opts.noFsAccess, openPicker: opts.openPicker || null, savePicker: opts.savePicker || null
  });
  return errors;
}

export async function openViewer(page, opts = {}) {
  const errors = await setup(page, opts);
  await page.goto('markdown-viewer.html');
  await page.waitForFunction(() => typeof mdvParseFile === 'function' && typeof window.__t === 'object');
  return errors;
}

// Waits for the comment sidebar to show `n` threads (it redraws shortly after each render)
export async function threads(page, n) {
  await expect(page.locator('#mdvThreadList .mdv-thread')).toHaveCount(n);
}

// The last-opened file is remembered as a handle in IndexedDB. A file in OPFS gives a real, storable handle.
export async function rememberAFile(page) {
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
