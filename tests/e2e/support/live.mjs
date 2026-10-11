// Helpers for the live reload, Back/Forward and links specs (live*.spec.mjs).
//
// Files "on disk" are real files: each test writes its documents into its own output folder, which the test server
// serves, and edits them there, as another program would. The desktop app is a stand-in shell (Tauri's injected API,
// with the app's own Content Security Policy), as desktop.spec.mjs uses.
import { expect } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
export const ALT_LEFT = process.platform === 'darwin' ? '⌥←' : 'Alt+←';
const KNOWN_NOISE = [/favicon\.ico/i, /fonts\.(googleapis|gstatic)\.com/i];
export const APP_CSP = Object.entries(JSON.parse(readFileSync(new URL('../../../desktop/src-tauri/tauri.conf.json', import.meta.url), 'utf8')).app.security.csp)
  .map(([directive, value]) => `${directive} ${value}`)
  .join('; ');

export function collectErrors(page, allow = []) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const where = `${m.text()} ${(m.location() && m.location().url) || ''}`;
    if (![...KNOWN_NOISE, ...allow].some((r) => r.test(where))) errors.push(`console: ${where.trim()}`);
  });
  return errors;
}

// A document the test server serves from this test's own output folder. `path` is its ?file= value; write()
// changes it on disk, as another program saving it would, and remove() deletes it.
export function servedFile(info, name, text) {
  const file = info.outputPath(name);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  return {
    file,
    path: relative(ROOT, file).split(sep).join('/'),
    write: (t) => writeFileSync(file, t),
    remove: () => rmSync(file, { force: true }),
  };
}

// Twelve sections of four paragraphs; `extra` goes at the top of section 1, `links[n]` at the top of section n
export function longDocument(title, extra = '', links = {}) {
  const sections = [];
  for (let i = 1; i <= 12; i++) {
    const paragraphs = Array.from({ length: 4 }, (_, j) => `Paragraph ${j + 1} of section ${i}. ` + 'Words to read. '.repeat(24)).join('\n\n');
    sections.push(`## Section ${i}\n\n${links[i] || ''}${i === 1 ? extra : ''}${paragraphs}`);
  }
  return `# ${title}\n\n${sections.join('\n\n')}\n`;
}

export const ADDED = 'A paragraph that another program added near the top. '.repeat(30) + '\n\n';

export async function scrollHeadingTo(page, id, y) {
  await page.evaluate(([id, y]) => {
    const h = document.getElementById(id);
    window.scrollTo({ top: window.scrollY + h.getBoundingClientRect().top - y, behavior: 'instant' });
  }, [id, y]);
  await page.waitForTimeout(150);
  return headingTop(page, id);
}
export const headingTop = (page, id) => page.evaluate((id) => document.getElementById(id).getBoundingClientRect().top, id);
export async function expectHeadingAt(page, id, top) {
  await expect.poll(async () => Math.round(Math.abs((await headingTop(page, id)) - top)), { timeout: 5000 }).toBeLessThan(4);
}

// The block of the document whose own text starts with `start`: its top on screen, or null
export const blockTop = (page, start) => page.evaluate((start) => {
  const el = [...document.querySelectorAll('#mdBody p, #mdBody li, #mdBody h1, #mdBody h2, #mdBody h3, #mdBody h4')]
    .find((e) => e.textContent.trim().startsWith(start));
  return el ? el.getBoundingClientRect().top : null;
}, start);
export async function scrollBlockTo(page, start, y) {
  await page.evaluate(([start, y]) => {
    const el = [...document.querySelectorAll('#mdBody p, #mdBody li, #mdBody h1, #mdBody h2, #mdBody h3, #mdBody h4')]
      .find((e) => e.textContent.trim().startsWith(start));
    window.scrollTo({ top: window.scrollY + el.getBoundingClientRect().top - y, behavior: 'instant' });
  }, [start, y]);
  await page.waitForTimeout(150);
  return blockTop(page, start);
}

// The page's own record of what it showed, and how (first, open, reload, history)
export async function recordOpens(page) {
  await page.addInitScript(() => {
    window.__opens = [];
    document.addEventListener('DOMContentLoaded', () => mdvOnDocumentOpened((e) => window.__opens.push({ kind: e.kind, name: e.doc.name, length: e.doc.text.length, text: e.doc.text })));
  });
}

export async function setVisibility(page, state) {
  await page.evaluate((s) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => s });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => s === 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  }, state);
}

// A file in the browser's private file system (OPFS), opened through its handle as the writable open does
export async function openHandleFile(page, name, text) {
  await page.evaluate(async ([name, text]) => {
    const root = await navigator.storage.getDirectory();
    const fh = await root.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(text);
    await w.close();
    window.__fh = fh;
    await mdvOpenWithHandle(fh, { prompt: false });
  }, [name, text]);
}
export async function writeHandleFile(page, text) {
  await page.evaluate(async (text) => {
    const w = await window.__fh.createWritable();
    await w.write(text);
    await w.close();
  }, text);
}

// ---------------------------------------------------------------------------------------------------------------
// The desktop app: a stand-in shell, with the app's Content Security Policy
// ---------------------------------------------------------------------------------------------------------------
export async function openApp(page, { doc, disk = {} }, allow = []) {
  const errors = collectErrors(page, allow);
  await page.route('**/markdown-viewer.html', async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, headers: Object.assign({}, response.headers(), { 'content-security-policy': APP_CSP }) });
  });
  await page.addInitScript(({ doc, disk }) => {
    const calls = [];
    const listeners = {};
    const files = Object.assign({}, disk);
    if (doc) files[doc.path] = Object.assign({}, doc);
    let saved = 0;
    window.__shell = {
      calls,
      disk: files,
      delay: {},  // path → ms: reads of that file take this long
      emit(event, payload) { for (const h of listeners[event] || []) h({ event, payload }); },
    };
    window.__TAURI_INTERNALS__ = { metadata: { currentWindow: { label: 'doc-1' }, currentWebview: { label: 'doc-1' } } };
    window.__TAURI__ = {
      core: {
        convertFileSrc: (path) => location.origin + path.split('/').map(encodeURIComponent).join('/'),
        async invoke(cmd, args) {
          calls.push({ cmd, args: args || {} });
          switch (cmd) {
            case 'mdv_initial_document': return doc;
            case 'mdv_read_document': {
              const wait = window.__shell.delay[args.path];
              if (wait) await new Promise((r) => setTimeout(r, wait));
              if (files[args.path]) return Object.assign({}, files[args.path], { reason: 'reload' });
              throw { code: 'not-found', message: 'no such file' };
            }
            case 'mdv_save_document':
              // As the shell: a window saves only into the file it opened
              if (!doc || args.path !== doc.path) return { ok: false, reason: 'not-allowed', message: 'A window saves only into the file it opened.' };
              saved++;
              files[doc.path] = Object.assign({}, files[doc.path], { text: args.text, mtimeMs: 5000 + saved, version: 'v-saved-' + saved });
              return { ok: true, mtimeMs: 5000 + saved, version: 'v-saved-' + saved };
            default: return null;
          }
        },
      },
      event: {
        async listen(event, handler) {
          (listeners[event] = listeners[event] || []).push(handler);
          return () => {};
        },
      },
    };
  }, { doc, disk });
  await page.goto('markdown-viewer.html');
  return errors;
}

export const callsTo = (page, cmd) => page.evaluate((c) => window.__shell.calls.filter((x) => x.cmd === c).map((x) => x.args), cmd);

export const windowFile = {
  path: '/notes/doc.md', name: 'doc.md', mtimeMs: 1000, version: 'v-1000', readOnly: null, reason: 'initial',
  text: longDocument('The window file', '', { 4: '[The other file](other.md) is next to it.\n\n' }),
};
export const otherFile = { path: '/notes/other.md', name: 'other.md', mtimeMs: 2000, version: 'v-2000', readOnly: null, text: '# The other file\n\nOpened from a link.\n' };
