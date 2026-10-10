// End-to-end checks of the viewer in a real browser, over the samples, in both themes.
// They are the safety net for every change: a page error, a console error, a diagram that did not render,
// or math that broke fails the run. Screenshots land in test-results/ for a human look.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const SAMPLES = ['kitchen-sink.md', 'commented.md', 'repro-dollar-signs.md'];
const THEMES = ['light', 'dark'];

// Console noise that is not the viewer's fault. Keep this list short and explained.
const KNOWN_NOISE = [
  /favicon\.ico/i, // the viewer ships no favicon; the browser asks anyway
  /fonts\.(googleapis|gstatic)\.com/i, // the web fonts are a network fetch, which an offline run cannot make
];

async function openSample(page, sample, theme) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    // A failed-resource message does not carry its URL in the text; it is in the message's location.
    const where = `${m.text()} ${(m.location() && m.location().url) || ''}`;
    if (!KNOWN_NOISE.some((r) => r.test(where))) errors.push(`console: ${where.trim()}`);
  });
  page.on('requestfailed', (r) => {
    if (!KNOWN_NOISE.some((x) => x.test(r.url()))) errors.push(`requestfailed: ${r.url()}`);
  });
  await page.addInitScript((t) => {
    try { localStorage.setItem('mdv-theme', t); } catch (_) { /* storage blocked: default theme */ }
  }, theme);
  await page.goto(`markdown-viewer.html?file=samples/${sample}`);
  await page.waitForSelector('#mdBody h1, #mdBody h2', { timeout: 30_000 });
  // Mermaid renders asynchronously after the main pass; wait until every placeholder has an SVG.
  await page.waitForFunction(() => {
    const all = document.querySelectorAll('#mdBody .mermaid');
    return [...all].every((el) => el.querySelector('svg') || el.classList.contains('mermaid-error'));
  }, null, { timeout: 30_000 });
  return errors;
}

function mermaidFences(sample) {
  const src = readFileSync(new URL(`../../samples/${sample}`, import.meta.url), 'utf8');
  return (src.match(/^```mermaid\s*$/gm) || []).length;
}

for (const sample of SAMPLES) {
  for (const theme of THEMES) {
    test(`${sample} renders cleanly in the ${theme} theme`, async ({ page }, info) => {
      const errors = await openSample(page, sample, theme);
      expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe(theme);
      const fences = mermaidFences(sample);
      await expect(page.locator('#mdBody .mermaid svg')).toHaveCount(fences);
      expect(await page.locator('#mdBody .katex-error').count()).toBe(0);
      await page.screenshot({ path: info.outputPath(`${sample}-${theme}.png`), fullPage: true });
      expect(errors, errors.join('\n')).toEqual([]);
    });
  }
}

test('the kitchen sink exercises every feature it claims', async ({ page }) => {
  await openSample(page, 'kitchen-sink.md', 'light');
  const counts = await page.evaluate(() => ({
    tables: document.querySelectorAll('#mdBody table').length,
    katex: document.querySelectorAll('#mdBody .katex').length,
    tasks: document.querySelectorAll('#mdBody input[type=checkbox]').length,
    callouts: document.querySelectorAll('#mdBody .callout, #mdBody [class*="callout-"]').length,
    footnotes: document.querySelectorAll('#mdBody .footnotes li, #mdBody section.footnotes li').length,
    code: document.querySelectorAll('#mdBody pre code').length,
  }));
  for (const [k, v] of Object.entries(counts)) expect(v, `${k} rendered`).toBeGreaterThan(0);
});

test('comment threads appear in the sidebar for the commented sample', async ({ page }) => {
  await openSample(page, 'commented.md', 'light');
  await page.waitForTimeout(300); // the comment sidebar renders 50 ms after the document
  // mdvComments is a script-level `let`, so it is a global binding, not a property of window.
  const threads = await page.evaluate(() => (typeof mdvComments !== 'undefined' ? mdvComments : []).filter((c) => !c.parent_id).length);
  expect(threads).toBeGreaterThanOrEqual(2);
});

test('an expanded diagram fills the overlay instead of shrinking', async ({ page }) => {
  await openSample(page, 'kitchen-sink.md', 'light');
  await page.locator('.mermaid-wrapper .diagram-expand-btn').first().click();
  const m = await page.evaluate(() => {
    const body = document.getElementById('diagramBody').getBoundingClientRect();
    const svg = document.querySelector('#diagramZoomContainer svg').getBoundingClientRect();
    return { bw: body.width, bh: body.height, sw: svg.width, sh: svg.height };
  });
  // The drawing scales to the overlay: one of its sides reaches (nearly) the overlay's.
  expect(Math.max(m.sw / m.bw, m.sh / m.bh)).toBeGreaterThan(0.85);
});

test('the viewer works opened straight from disk (file://), with no server', async ({ page }) => {
  // Classic <script src> files load from file:// (only ES modules do not), which is why the viewer is split
  // into plain scripts and not modules. A document opened with the Open button must render.
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const url = new URL('../../markdown-viewer.html', import.meta.url).href;
  await page.goto(url);
  expect(await page.evaluate(() => typeof renderMarkdown)).toBe('function');
  await page.locator('#fileInput').setInputFiles(new URL('../../samples/kitchen-sink.md', import.meta.url).pathname);
  await page.waitForSelector('#mdBody h1, #mdBody h2', { timeout: 30_000 });
  expect(await page.locator('#mdBody table').count()).toBeGreaterThan(0);
  expect(errors, errors.join('\n')).toEqual([]);
});
