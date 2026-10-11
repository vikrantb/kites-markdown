// Shared helpers for the Export menu's specs (export*.spec.mjs). Not a spec itself: Playwright only collects *.spec.mjs.
import { expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDocument, waitForLayoutSettled } from './support/viewer.mjs';

export const repo = (p) => fileURLToPath(new URL(`../../${p}`, import.meta.url));
export const SECTIONS = 'tests/fixtures/export/sections.md';
export const IMAGES = 'tests/fixtures/export/images.md';

export async function openDoc(page, file, theme = 'light') {
  await page.addInitScript((t) => { try { localStorage.setItem('mdv-theme', t); } catch (_) { /* default theme */ } }, theme);
  await page.route(/example\.invalid/, (route) => route.abort());
  await openDocument(page, file);
}

export async function menu(page, action) {
  await page.locator('#mdvExportBtn').click();
  await expect(page.locator('#mdvExportDD')).toBeVisible();
  await page.locator(`#mdvExportDD [data-action="${action}"]`).click();
}

export async function exportHtml(page) {
  const [download] = await Promise.all([page.waitForEvent('download'), menu(page, 'export-html')]);
  return { download, name: download.suggestedFilename(), html: readFileSync(await download.path(), 'utf8') };
}

// What an exported file holds, parsed as a browser parses it.
export const inspect = (page, html) => page.evaluate((h) => {
  const d = new DOMParser().parseFromString(h, 'text/html');
  const attrs = [...d.querySelectorAll('*')].flatMap((el) => [...el.attributes].map((a) => `${a.name}=${a.value}`));
  return {
    scripts: d.querySelectorAll('script').length,
    handlers: attrs.filter((a) => /^on/i.test(a)),
    jsUrls: attrs.filter((a) => /^\s*[^=]+=\s*javascript:/i.test(a)),
    actions: d.querySelectorAll('[data-action]').length,
    diagrams: d.querySelectorAll('.mermaid > svg').length,
    controls: d.querySelectorAll('button, .section-toggle, .copy-btn, .diagram-expand-btn, .section-minimap, .mdv-chip').length,
    stylesheetLinks: d.querySelectorAll('link').length,
    style: [...d.querySelectorAll('head style')].map((s) => s.textContent).join('\n'),
    csp: (d.querySelector('meta[http-equiv="Content-Security-Policy"]') || {}).content || '',
    theme: d.documentElement.getAttribute('data-theme'),
    title: d.title,
    images: [...d.querySelectorAll('img')].map((i) => i.getAttribute('src')),
    notes: [...d.querySelectorAll('.mdv-export-missing')].map((n) => n.textContent),
    headings: [...d.querySelectorAll('h1, h2')].map((h) => h.id),
    links: [...d.querySelectorAll('article a[href]')].map((a) => ({ text: a.textContent.trim(), href: a.getAttribute('href') })),
  };
}, html);

// The clipboard as a paste reads it: its types, its HTML and its plain text.
export const readClipboard = (page) => page.evaluate(async () => {
  const [item] = await navigator.clipboard.read();
  const read = async (type) => (item.types.includes(type) ? (await item.getType(type)).text() : null);
  return { types: item.types.slice().sort(), html: await read('text/html'), text: await read('text/plain') };
});

export const toast = (page) => page.locator('.mdv-toast').last();

// ---------------------------------------------------------------------------------------------------------------
// The desktop app (stand-in shell, the app's CSP)
// ---------------------------------------------------------------------------------------------------------------
export const FIXTURE_DIR = '/desktop/tests/fixtures/linked';
export const FIXTURE = readFileSync(repo('desktop/tests/fixtures/linked/doc.md'), 'utf8');
const APP_CSP = Object.entries(JSON.parse(readFileSync(repo('desktop/src-tauri/tauri.conf.json'), 'utf8')).app.security.csp)
  .map(([directive, value]) => `${directive} ${value}`).join('; ');

// Just enough of the shell for these tests: the window's document, the commands the page sends (recorded), and the
// asset protocol (convertFileSrc), served with the app's Content Security Policy.
export async function openInApp(page, text) {
  await page.route('**/markdown-viewer.html', async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, headers: Object.assign({}, response.headers(), { 'content-security-policy': APP_CSP }) });
  });
  const doc = { path: `${FIXTURE_DIR}/doc.md`, name: 'doc.md', text, mtimeMs: 1000, version: 'v-1000', readOnly: null, reason: 'initial' };
  await page.addInitScript((doc) => {
    try { localStorage.setItem('mdv-theme', 'light'); } catch (_) { /* default theme */ }
    window.__calls = [];
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.effectiveDirective} ${e.blockedURI}`));
    window.__TAURI_INTERNALS__ = { metadata: { currentWindow: { label: 'doc-1' }, currentWebview: { label: 'doc-1' } } };
    window.__TAURI__ = {
      core: {
        convertFileSrc: (path) => location.origin + path.split('/').map(encodeURIComponent).join('/'),
        async invoke(cmd, args) {
          window.__calls.push({ cmd, args: args || {} });
          if (cmd === 'mdv_initial_document') return doc;
          return null;
        },
      },
      event: { async listen() { return () => {}; } },
    };
  }, doc);
  await page.goto('markdown-viewer.html');
  await page.waitForSelector('#mdBody h1');
  await page.waitForFunction(() => [...document.querySelectorAll('#mdBody img')].every((i) => i.complete));
  await waitForLayoutSettled(page);
}
