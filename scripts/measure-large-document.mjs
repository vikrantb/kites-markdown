// Measures the viewer on a generated large document: render time, IntersectionObservers left alive,
// DOM nodes and event listeners retained after garbage collection, and the main-thread cost of scrolling.
// It opens the viewer from file:// in Chrome (Playwright), so it needs no server.
//
// Usage: node scripts/measure-large-document.mjs [viewer-dir] [--sections 3000] [--renders 5] [--scroll-steps 60]
//   viewer-dir defaults to this checkout. Point it at another checkout (for example an extracted copy of
//   main) to measure the other arm of a comparison with the same command on the same machine.
// Prints one JSON object. Timings vary between runs and machines; compare arms measured back to back.
import { chromium } from '@playwright/test';
import { resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { largeDocument } from './large-document.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? Number(args[i + 1]) : dflt; };
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
const viewerDir = resolve(positional[0] || fileURLToPath(new URL('..', import.meta.url)));
const SECTIONS = opt('--sections', 3000);
const RENDERS = opt('--renders', 5);
const SCROLL_STEPS = opt('--scroll-steps', 60);

// Counts IntersectionObservers by wrapping the constructor before any viewer script runs. "live" is
// created minus disconnected: an observer nobody disconnected keeps its callback and target list.
function countObservers() {
  const Native = window.IntersectionObserver;
  const stats = { created: 0, disconnected: 0, observeCalls: 0 };
  window.__mdvObserverStats = stats;
  window.IntersectionObserver = class extends Native {
    constructor(cb, o) { super(cb, o); stats.created++; this.__live = true; }
    observe(t) { stats.observeCalls++; return super.observe(t); }
    disconnect() { if (this.__live) { stats.disconnected++; this.__live = false; } return super.disconnect(); }
  };
}

const browser = await chromium.launch({ channel: process.env.CI ? undefined : 'chrome' });
try {
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(countObservers);
  await page.goto(pathToFileURL(resolve(viewerDir, 'markdown-viewer.html')).href);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');

  const source = largeDocument(SECTIONS);
  const retained = async () => {
    await cdp.send('HeapProfiler.collectGarbage');
    const dom = await cdp.send('Memory.getDOMCounters');
    const heap = await cdp.send('Runtime.getHeapUsage');
    const io = await page.evaluate(() => ({ ...window.__mdvObserverStats }));
    return { domNodes: dom.nodes, jsEventListeners: dom.jsEventListeners, heapUsedMB: +(heap.usedSize / 1048576).toFixed(1),
             observersLive: io.created - io.disconnected, observersCreated: io.created };
  };

  const renders = [];
  for (let r = 1; r <= RENDERS; r++) {
    // renderMarkdown is synchronous up to the Mermaid pass; time it inside the page, then let the comment
    // sidebar's deferred pass (50 ms) run before counting what stayed alive.
    const ms = await page.evaluate((src) => { const t = performance.now(); renderMarkdown(src, 'large.md'); return performance.now() - t; }, source);
    await page.waitForTimeout(150);
    renders.push({ render: r, ms: Math.round(ms), ...(await retained()) });
  }

  // Scroll cost: step through the whole document, one animation frame per step, and read Chrome's own
  // main-thread counters before and after.
  const metric = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
  const m0 = await metric();
  const wall = await page.evaluate(async (steps) => {
    const t = performance.now();
    const max = document.documentElement.scrollHeight - innerHeight;
    for (let i = 1; i <= steps; i++) {
      window.scrollTo(0, (max * i) / steps);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    }
    for (let i = steps - 1; i >= 0; i--) {
      window.scrollTo(0, (max * i) / steps);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    }
    return performance.now() - t;
  }, SCROLL_STEPS);
  const m1 = await metric();
  const d = (k) => +((m1[k] - m0[k]) * 1000).toFixed(1);
  const scroll = { steps: SCROLL_STEPS * 2, wallMs: Math.round(wall), scriptMs: d('ScriptDuration'), layoutMs: d('LayoutDuration'),
                   styleMs: d('RecalcStyleDuration'), taskMs: d('TaskDuration') };

  const counts = await page.evaluate(() => ({
    headings: document.querySelectorAll('#mdBody h1,#mdBody h2,#mdBody h3,#mdBody h4,#mdBody h5,#mdBody h6').length,
    tocLinks: document.querySelectorAll('#tocList a').length,
  }));
  console.log(JSON.stringify({ viewerDir: viewerDir.split('/').slice(-2).join('/'), sections: SECTIONS, ...counts, renders, scroll, errors }, null, 1));
} finally {
  await browser.close();
}
