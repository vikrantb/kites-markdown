// Browser tests for the visual system and the diagram fixes (roadmap issues 9, 10, 11, 13, 14, 15, 16).
// Each test fails on the code before this change; the issue number is in the test name.
import { test, expect } from '@playwright/test';
import { THEMES, collectErrors, waitForDiagrams, open, renderSource, rgb, mermaidFences } from './visuals-helpers.mjs';

// ---------------------------------------------------------------------------------------------
// Issue 9: diagrams follow the theme
// ---------------------------------------------------------------------------------------------
// Diagrams are found by the role Mermaid itself writes on each SVG, so these tests also run against older code.
const FLOWCHART_NODE = '#mdBody .mermaid svg[aria-roledescription^="flowchart"] .node rect';
const SEQUENCE = '#mdBody .mermaid svg[aria-roledescription="sequence"]';

test('a theme change redraws every diagram in the dark palette, and back (issue 9)', async ({ page }) => {
  const errors = await open(page, 'kitchen-sink.md', 'light');
  const fills = () => page.evaluate(([nodeSel, seqSel]) => ({
    node: getComputedStyle(document.querySelector(nodeSel)).fill,
    message: getComputedStyle(document.querySelector(`${seqSel} .messageText`)).fill,
    svgs: document.querySelectorAll('#mdBody .mermaid svg').length,
  }), [FLOWCHART_NODE, SEQUENCE]);
  const token = (name) => page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n), name);

  // Contrast of the sequence diagram's message text against the card it is drawn on.
  const messageContrast = () => page.evaluate((seqSel) => {
    const nums = (c) => c.match(/[\d.]+/g).map(Number).slice(0, 3);
    const lum = (rgbv) => rgbv.map((c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; })
      .reduce((s, c, i) => s + c * [0.2126, 0.7152, 0.0722][i], 0);
    const svg = document.querySelector(seqSel);
    const fg = lum(nums(getComputedStyle(svg.querySelector('.messageText')).fill));
    const bg = lum(nums(getComputedStyle(svg.closest('.mermaid-wrapper')).backgroundColor));
    return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
  }, SEQUENCE);

  const light = await fills();
  await page.evaluate(() => setTheme('dark'));
  // Every diagram already on screen is redrawn (its node fill changes) ...
  await expect.poll(async () => (await fills()).node, { timeout: 10_000 }).not.toBe(light.node);
  // ... and sequence text is readable on the dark card, unlike Mermaid's default #333.
  await expect.poll(messageContrast, { timeout: 10_000 }).toBeGreaterThanOrEqual(4.5);
  const dark = await fills();
  expect(dark.svgs).toBe(light.svgs);
  expect(dark.node).toBe(rgb(await token('--diagram-node'))); // the colours are the dark theme's own tokens
  expect(dark.message).toBe(rgb(await token('--diagram-text')));

  await page.evaluate(() => setTheme('light'));
  await expect.poll(async () => (await fills()).node, { timeout: 10_000 }).toBe(light.node);
  expect(errors, errors.join('\n')).toEqual([]);
});

// A stand-in for Google Fonts: "Inter" is a vendored font file, served by the test server, that arrives only after
// `delay` ms (no network needed). The URL is absolute: relative to the stand-in stylesheet it would name Google's host.
async function holdInter(page, baseURL, delay) {
  const fontUrl = new URL('vendor/fonts/KaTeX_SansSerif-Regular.woff2', baseURL).href;
  await page.route('https://fonts.googleapis.com/**', (route) => route.fulfill({
    contentType: 'text/css',
    body: `@font-face { font-family: "Inter"; font-weight: 100 900; src: url(${fontUrl}) format("woff2"); }`,
  }));
  await page.route(fontUrl, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, delay));
    await route.continue();
  });
}

test("Mermaid's own load-time pass never draws the viewer's diagrams", async ({ page, baseURL }) => {
  // Mermaid draws every .mermaid element itself, in its own theme, on window "load" unless startOnLoad is off. The
  // viewer's first pass sets its own config only after waiting for the web font, so the race is "load" arriving
  // during that wait: hold the font, fire "load" inside the wait, and record every SVG ever put into a diagram.
  await holdInter(page, baseURL, 4000);
  await page.addInitScript(() => {
    window.mdvTestInserted = [];
    new MutationObserver((records) => {
      for (const r of records) {
        if (!r.target.classList || !r.target.classList.contains('mermaid')) continue;
        for (const n of r.addedNodes) if (n.nodeName.toLowerCase() === 'svg') window.mdvTestInserted.push(n.id);
      }
    }).observe(document, { childList: true, subtree: true });
  });
  const errors = collectErrors(page);
  // Not 'load': Chrome holds the load event until pending fonts arrive.
  await page.goto('markdown-viewer.html?file=samples/kitchen-sink.md', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#mdBody .mermaid', { state: 'attached' });
  expect(await page.locator('#mdBody .mermaid svg').count()).toBe(0); // the viewer's pass is still waiting for the font
  await page.evaluate(() => window.dispatchEvent(new Event('load')));
  await waitForDiagrams(page);
  await page.waitForTimeout(300);
  const inserted = await page.evaluate(() => window.mdvTestInserted);
  expect(inserted.length).toBeGreaterThanOrEqual(4);
  expect(inserted.filter((id) => !id.startsWith('mdv-mermaid-'))).toEqual([]);
  expect(await page.locator('#mdBody .mermaid-error').count()).toBe(0);
  expect(errors, errors.join('\n')).toEqual([]);
});

test('diagrams do not wait long for a slow web font, and are redrawn in it when it arrives', async ({ page, baseURL }) => {
  // "Inter" takes 5 s to arrive, well past the viewer's 1.5 s wait.
  await holdInter(page, baseURL, 5000);
  const errors = collectErrors(page);
  const start = Date.now();
  // Not 'load': Chrome holds the load event until pending fonts arrive.
  await page.goto('markdown-viewer.html?file=samples/kitchen-sink.md', { waitUntil: 'domcontentloaded' });
  await waitForDiagrams(page);
  const drawnAfter = Date.now() - start;
  const first = await page.$$eval('#mdBody .mermaid svg', (svgs) => svgs.map((s) => s.id));
  expect(await page.evaluate(() => document.fonts.check('400 14px Inter'))).toBe(false); // drawn before the font
  // Once the font is in, every diagram is drawn again, so its labels are measured in the font they are shown in.
  await page.waitForFunction(() => document.fonts.check('400 14px Inter'), null, { timeout: 15_000 });
  await page.waitForFunction((ids) => {
    const now = [...document.querySelectorAll('#mdBody .mermaid svg')].map((s) => s.id);
    return now.length === ids.length && now.every((id, i) => id !== ids[i]);
  }, first, { timeout: 15_000 });
  expect(drawnAfter).toBeLessThan(5000); // the diagrams did not wait for the font
  expect(errors, errors.join('\n')).toEqual([]);
});

test('while the web font is still loading, later passes do not wait for it again', async ({ page, baseURL }) => {
  await holdInter(page, baseURL, 9000);
  await page.goto('markdown-viewer.html?file=samples/kitchen-sink.md', { waitUntil: 'domcontentloaded' });
  await waitForDiagrams(page); // the first pass waited for the font, at most 1.5 s
  expect(await page.evaluate(() => document.fonts.check('400 14px Inter'))).toBe(false); // and it is still loading
  // A re-render (a comment added or deleted, a file dropped) draws every diagram again ...
  const rerender = await page.evaluate(async () => {
    const t0 = performance.now();
    renderMarkdown(rawMarkdown, 'kitchen-sink.md');
    while (![...document.querySelectorAll('#mdBody .mermaid')].every((el) => el.querySelector('svg'))) {
      await new Promise(requestAnimationFrame);
    }
    return performance.now() - t0;
  });
  // ... and so does a theme change (setTheme waits 100 ms before it starts).
  const themeChange = await page.evaluate(async () => {
    const t0 = performance.now();
    setTheme('dark');
    while (![...document.querySelectorAll('#mdBody .mermaid')].every((el) => (el.dataset.mdvPalette || '').startsWith('dark'))) {
      await new Promise(requestAnimationFrame);
    }
    return performance.now() - t0;
  });
  expect(rerender).toBeLessThan(900);
  expect(themeChange).toBeLessThan(1000);
});

test('an open expanded view follows a theme change', async ({ page }) => {
  await open(page, 'kitchen-sink.md', 'light');
  await page.evaluate(() => openDiagramOverlay(document.querySelector('#mdBody .mermaid-wrapper')));
  const fill = () => page.evaluate(() => getComputedStyle(document.querySelector('#diagramZoomContainer .node rect')).fill);
  const before = await fill();
  await page.evaluate(() => setTheme('dark'));
  const darkNode = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--diagram-node'));
  await expect.poll(fill, { timeout: 30_000 }).toBe(rgb(darkNode));
  expect(before).not.toBe(rgb(darkNode));
  await expect(page.locator('#diagramOverlay')).toHaveClass(/show/);
});

// ---------------------------------------------------------------------------------------------
// Issue 10: sequence notes wrap inside their box
// ---------------------------------------------------------------------------------------------
for (const theme of ['light', 'dark']) {
  test(`sequence-diagram notes stay inside their box in the ${theme} theme (issue 10)`, async ({ page }) => {
    await open(page, 'kitchen-sink.md', theme);
    const box = await page.evaluate((seqSel) => {
      const w = document.querySelector(seqSel);
      const note = w.querySelector('rect.note').getBBox();
      const lines = [...w.querySelectorAll('text.noteText')].map((t) => t.getBBox());
      const left = Math.min(...lines.map((b) => b.x));
      const right = Math.max(...lines.map((b) => b.x + b.width));
      return { noteLeft: note.x, noteRight: note.x + note.width, left, right, lines: lines.length };
    }, SEQUENCE);
    expect(box.lines).toBeGreaterThanOrEqual(1);
    expect(box.left).toBeGreaterThanOrEqual(box.noteLeft);
    expect(box.right).toBeLessThanOrEqual(box.noteRight);
  });
}

// ---------------------------------------------------------------------------------------------
// Issue 11: minimap labels
// ---------------------------------------------------------------------------------------------
// Labels whose drawn text is wider than their segment. A label that is DOM text (older code) is measured with a
// Range; one drawn by CSS (::before) by its box. The hover tooltip (::after) is left out of the measurement.
async function labelOverflow(page) {
  const style = await page.addStyleTag({ content: '.minimap-segment::after { display: none !important; }' });
  const out = await page.$$eval('#mdBody .minimap-segment', (els) => els.filter((el) => {
    const box = el.getBoundingClientRect().width;
    let drawn = parseFloat(getComputedStyle(el, '::before').width) || 0;
    if (el.textContent.trim()) {
      const range = document.createRange();
      range.selectNodeContents(el);
      drawn = Math.max(drawn, range.getBoundingClientRect().width);
    }
    return drawn > box + 0.5 || el.scrollWidth > el.clientWidth + 1;
  }).map((el) => el.dataset.label || el.textContent));
  await style.evaluate((el) => el.remove());
  return out;
}

test('minimap labels stay inside their segments and show the full title on hover (issue 11)', async ({ page }) => {
  await open(page, 'kitchen-sink.md');
  const sections = await page.$$eval('#mdBody h2', (hs) => hs.length);
  const segs = page.locator('#mdBody .section-minimap .minimap-segment');
  await expect(segs).toHaveCount(sections);
  expect(await labelOverflow(page)).toEqual([]);
  // Hover shows the full title.
  const third = segs.nth(2);
  const label = await third.getAttribute('data-label');
  // The labels are not document text: read-aloud and search never see them.
  expect(await page.locator('#mdBody .section-minimap').evaluate((el) => el.textContent)).toBe('');
  expect(await third.getAttribute('aria-label')).toBe(label);
  await third.hover();
  await expect.poll(() => third.evaluate((el) => getComputedStyle(el, '::after').opacity)).toBe('1');
  expect(await third.evaluate((el) => getComputedStyle(el, '::after').content)).toBe(JSON.stringify(label));
});

test('a minimap with room shows each label, truncated with an ellipsis when long (issue 11)', async ({ page }) => {
  await open(page, 'kitchen-sink.md');
  const long = 'A considerably longer section title than any segment can hold';
  await renderSource(page, `# Report\n\nIntro.\n\n## ${long}\n\nOne.\n\n## Short\n\nTwo.\n\n## Results\n\nThree.\n\n## Next steps\n\nFour.\n`);
  const segs = await page.$$eval('#mdBody .minimap-segment', (els) => els.map((el) => {
    const before = getComputedStyle(el, '::before');
    const ctx = document.createElement('canvas').getContext('2d');
    ctx.font = `${before.fontWeight} ${before.fontSize} ${before.fontFamily}`;
    return {
      label: el.dataset.label,
      shown: before.content,
      ellipsis: before.textOverflow,
      needsTruncation: ctx.measureText(el.dataset.label).width > el.clientWidth,
    };
  }));
  expect(segs.map((s) => s.label)).toEqual([long, 'Short', 'Results', 'Next steps']);
  for (const s of segs) {
    expect(s.shown).toBe(JSON.stringify(s.label)); // the label is drawn, not replaced by a bar
    expect(s.ellipsis).toBe('ellipsis');
  }
  expect(segs[0].needsTruncation).toBe(true); // the long label really is wider than its segment...
  expect(await labelOverflow(page)).toEqual([]); // ...and still stays inside it
});

test('the title keeps its fold toggle when the minimap sits under it', async ({ page }) => {
  await open(page, 'kitchen-sink.md');
  await renderSource(page, '# Title\n\nIntro.\n\n## One\n\nA.\n\n## Two\n\nB.\n\n## Three\n\nC.\n');
  const h1 = page.locator('#mdBody h1');
  await h1.hover();
  await h1.locator('.section-toggle').click();
  await expect(page.locator('#mdBody h1 + .section-content')).toHaveClass(/collapsed/);
});

// ---------------------------------------------------------------------------------------------
// Issue 13: copy copies only the code
// ---------------------------------------------------------------------------------------------
test('the copy button copies only the code (issue 13)', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await open(page, 'kitchen-sink.md');
  const block = page.locator('#mdBody pre').filter({ has: page.locator('code.language-python') }).first();
  await block.scrollIntoViewIfNeeded();
  await page.evaluate(() => navigator.clipboard.writeText('(clipboard before the click)'));
  await block.locator('.copy-btn').click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe([
    'def drain(queue, send):',
    '    """Send queued operations in order; stop at the first failure."""',
    '    for op in list(queue):',
    '        if not send(op):',
    '            break',
    '        queue.remove(op)',
  ].join('\n'));
  await expect(block.locator('.copy-btn')).toHaveText('Copied!');
  await expect(block.locator('.copy-btn')).toHaveText('Copy', { timeout: 5_000 });
});

// ---------------------------------------------------------------------------------------------
// Issue 14: diagram nodes link to sections
// ---------------------------------------------------------------------------------------------
test('a diagram node named like a heading jumps to that section (issue 14)', async ({ page }) => {
  await open(page, 'kitchen-sink.md');
  const links = page.locator('#mdBody .mermaid-wrapper .mdv-node-link');
  await expect(links).toHaveCount(3); // Capture, Merge and Delivery have headings; the other nodes do not
  expect(await links.evaluateAll((els) => els.map((e) => e.getAttribute('data-mdv-section')).sort()))
    .toEqual(['capture', 'delivery', 'merge']);

  const top = (id) => page.evaluate((i) => document.getElementById(i).getBoundingClientRect().top, id);
  await page.locator('#mdBody .mdv-node-link[data-mdv-section="merge"]').click();
  await expect(page.locator('#merge')).toHaveClass(/mdv-flash/); // the heading flashes so the eye finds it
  await expect(page.locator('#diagramOverlay')).not.toHaveClass(/show/); // a link, not "open the diagram"
  await expect.poll(() => top('merge')).toBeLessThan(140);

  // Keyboard: a linked node takes focus and Enter follows it.
  await page.locator('#mdBody .mdv-node-link[data-mdv-section="delivery"]').focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => top('delivery')).toBeLessThan(140);

  // A collapsed section is unfolded first.
  await page.evaluate(() => { window.scrollTo(0, 0); toggleAllSections(); });
  await page.evaluate(() => mdvJumpToSection('capture'));
  await expect(page.locator('#capture')).toBeVisible();
});

test('a linked node in the expanded view closes it and jumps (issue 14)', async ({ page }) => {
  await open(page, 'kitchen-sink.md');
  await page.evaluate(() => openDiagramOverlay(document.querySelector('#mdBody .mermaid-wrapper')));
  await page.locator('#diagramZoomContainer [data-mdv-section="capture"]').click();
  await expect(page.locator('#diagramOverlay')).not.toHaveClass(/show/);
  await expect.poll(() => page.evaluate(() => document.getElementById('capture').getBoundingClientRect().top)).toBeLessThan(140);
});

// ---------------------------------------------------------------------------------------------
// Issue 15: frontmatter abbreviations
// ---------------------------------------------------------------------------------------------
test('frontmatter abbreviations become tooltips, as a map or as a list (issue 15)', async ({ page }) => {
  await open(page, 'kitchen-sink.md');
  await renderSource(page, '---\ntitle: Plan\nabbreviations:\n  SLA: Service level agreement\n  RTO: Recovery time objective\n---\n# Plan\n\nThe SLA sets the RTO, and `SLA` in code stays plain.\n');
  expect(await page.$$eval('#mdBody abbr.abbr-tooltip', (els) => els.map((e) => [e.textContent, e.title])))
    .toEqual([['SLA', 'Service level agreement'], ['RTO', 'Recovery time objective']]);

  await renderSource(page, '---\nabbreviations:\n  - API: Application programming interface\n---\n# Docs\n\nCall the API.\n');
  expect(await page.$$eval('#mdBody abbr.abbr-tooltip', (els) => els.map((e) => [e.textContent, e.title])))
    .toEqual([['API', 'Application programming interface']]);
});

// ---------------------------------------------------------------------------------------------
// Issue 16: titles from the type Mermaid reports
// ---------------------------------------------------------------------------------------------
test('the expanded view is titled by the type Mermaid reports (issue 16)', async ({ page }) => {
  await open(page, 'kitchen-sink.md');
  const titles = [];
  const count = await page.locator('#mdBody .mermaid-wrapper').count();
  for (let i = 0; i < count; i++) {
    await page.evaluate((n) => openDiagramOverlay(document.querySelectorAll('#mdBody .mermaid-wrapper')[n]), i);
    titles.push(await page.locator('#diagramTitle').textContent());
    await page.keyboard.press('Escape');
  }
  expect(titles).toEqual(['Flowchart', 'Sequence diagram', 'State diagram', 'Pie chart · Estimated effort by area']);

  // The old title guess called anything containing the letters "pie" a pie chart.
  await renderSource(page, '# States\n\n```mermaid\nstateDiagram-v2\n  [*] --> Recipe\n  Recipe --> Copied\n```\n');
  await page.evaluate(() => openDiagramOverlay(document.querySelector('#mdBody .mermaid-wrapper')));
  await expect(page.locator('#diagramTitle')).toHaveText('State diagram');
});

// ---------------------------------------------------------------------------------------------
// The expanded view
// ---------------------------------------------------------------------------------------------
test('the expanded view zooms around the pointer, pans by drag, fits, and closes with Esc', async ({ page }) => {
  await open(page, 'kitchen-sink.md');
  const wrapper = page.locator('#mdBody .mermaid-wrapper').first();
  await wrapper.hover();
  await wrapper.locator('.diagram-expand-btn').click();
  const overlay = page.locator('#diagramOverlay');
  await expect(overlay).toHaveClass(/show/);

  const view = () => page.evaluate(() => {
    const r = document.querySelector('#diagramZoomContainer svg').getBoundingClientRect();
    const b = document.getElementById('diagramBody').getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height, bw: b.width, bh: b.height, label: document.getElementById('diagramZoomLabel').textContent };
  });
  // Wait until two reads 120 ms apart agree (the zoom animation lasts 180 ms).
  const settled = async () => {
    let last = null;
    await expect.poll(async () => {
      const now = await view();
      const same = !!last && now.w === last.w && now.x === last.x && now.y === last.y;
      last = now;
      return same;
    }, { intervals: [120] }).toBe(true);
    return last;
  };

  const fit = await settled();
  expect(Math.max(fit.w / fit.bw, fit.h / fit.bh)).toBeGreaterThan(0.85); // fit fills the view

  await page.keyboard.press('+');
  const zoomed = await settled();
  expect(zoomed.w / fit.w).toBeCloseTo(1.25, 2);

  // Wheel zoom keeps the diagram point under the pointer where it is.
  const body = await page.locator('#diagramBody').boundingBox();
  const px = body.x + body.width * 0.35, py = body.y + body.height * 0.4;
  await page.mouse.move(px, py);
  const before = await view();
  await page.mouse.wheel(0, -240);
  const after = await settled();
  expect(after.w).toBeGreaterThan(before.w * 1.2);
  expect((px - after.x) / after.w).toBeCloseTo((px - before.x) / before.w, 2);
  expect((py - after.y) / after.h).toBeCloseTo((py - before.y) / before.h, 2);

  // A trackpad pinch arrives as ctrl + wheel.
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, 40);
  await page.keyboard.up('Control');
  const pinched = await settled();
  expect(pinched.w).toBeLessThan(after.w);

  // Drag pans.
  await page.mouse.move(px, py);
  await page.mouse.down();
  await page.mouse.move(px + 120, py + 60, { steps: 6 });
  await page.mouse.up();
  const panned = await settled();
  expect(panned.x - pinched.x).toBeCloseTo(120, 0);
  expect(panned.y - pinched.y).toBeCloseTo(60, 0);

  // 1 = actual size (the drawing's own width), 0 = fit again.
  await page.keyboard.press('1');
  const actual = await settled();
  const natural = await page.evaluate(() => document.querySelector('#diagramZoomContainer svg').viewBox.baseVal.width);
  expect(actual.w).toBeCloseTo(natural, 0);
  expect(actual.label).toBe('100%');
  await page.keyboard.press('0');
  const refit = await settled();
  expect(refit.w).toBeCloseTo(fit.w, 0);

  // Esc closes and gives focus back to the button that opened it.
  await page.keyboard.press('Escape');
  await expect(overlay).not.toHaveClass(/show/);
  expect(await page.evaluate(() => document.activeElement.classList.contains('diagram-expand-btn'))).toBe(true);
});

// ---------------------------------------------------------------------------------------------
// Every diagram type, every theme
// ---------------------------------------------------------------------------------------------
const GALLERY_TYPES = ['flowchart-v2', 'sequence', 'class', 'stateDiagram', 'er', 'gantt', 'pie', 'mindmap', 'timeline',
  'journey', 'gitGraph', 'quadrantChart', 'xychart', 'flowchart-v2'];

for (const theme of THEMES) {
  test(`every diagram type in the gallery draws cleanly in the ${theme} theme`, async ({ page }, info) => {
    const errors = await open(page, 'diagram-gallery.md', theme);
    await expect(page.locator('#mdBody .mermaid svg')).toHaveCount(mermaidFences('diagram-gallery.md'));
    expect(await page.locator('#mdBody .mermaid-error').count()).toBe(0);
    expect(await page.$$eval('#mdBody .mermaid-wrapper', (ws) => ws.map((w) => w.dataset.diagramType))).toEqual(GALLERY_TYPES);
    // Every card is labelled with a readable type, never the "Diagram" fallback.
    expect(await page.$$eval('#mdBody .mermaid-wrapper', (ws) => ws.filter((w) => w.dataset.diagramLabel === 'Diagram').length)).toBe(0);
    // A Gantt chart is drawn at the column's width, so its text is not shrunk.
    const gantt = await page.evaluate(() => {
      const svg = document.querySelector('#mdBody .mermaid-wrapper[data-diagram-type="gantt"] svg.mdv-diagram');
      return svg.getBoundingClientRect().width / svg.viewBox.baseVal.width;
    });
    expect(gantt).toBeGreaterThan(0.9);
    await page.screenshot({ path: info.outputPath(`diagram-gallery-${theme}.png`), fullPage: true });
    expect(errors, errors.join('\n')).toEqual([]);
  });
}

test("a diagram's own style and classDef lines still win over the theme palette", async ({ page }) => {
  await open(page, 'kitchen-sink.md');
  await renderSource(page, '# Author styles\n\n```mermaid\nflowchart LR\n    A[Plain] --> B[Styled] --> C[Classed]\n    style B fill:#ffcc00\n    classDef hot fill:#ff6644\n    class C hot\n```\n');
  const fills = await page.evaluate(() => {
    const fill = (label) => {
      const node = [...document.querySelectorAll('#mdBody .node')]
        .find((n) => (n.querySelector('.nodeLabel') || n).textContent.trim() === label);
      return getComputedStyle(node.querySelector('rect, polygon, path')).fill;
    };
    return { plain: fill('Plain'), styled: fill('Styled'), classed: fill('Classed') };
  });
  expect(fills.styled).toBe('rgb(255, 204, 0)');
  expect(fills.classed).toBe('rgb(255, 102, 68)');
  expect(fills.plain).toBe(rgb(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--diagram-node'))));
});

test('a diagram with a syntax error shows the reason and its source, and leaves nothing behind', async ({ page }) => {
  const errors = await open(page, 'kitchen-sink.md');
  await renderSource(page, '# Broken\n\n```mermaid\nflowchart TD\n    A --> B -->\n```\n');
  const box = page.locator('#mdBody .mermaid.mermaid-error .mdv-diagram-error');
  await expect(box).toHaveCount(1);
  await expect(box.locator('.mdv-diagram-error-reason')).not.toBeEmpty();
  await expect(box.locator('.mdv-diagram-error-source')).toHaveText('flowchart TD\n    A --> B -->\n');
  // Mermaid would otherwise leave its own error graphic at the end of <body>.
  expect(await page.evaluate(() => document.querySelectorAll('body > div[id^="dmdv-mermaid"], body > svg[id^="mdv-mermaid"]').length)).toBe(0);
  expect(errors, errors.join('\n')).toEqual([]);
});

// ---------------------------------------------------------------------------------------------
// Figures, numeric columns, contrast
// ---------------------------------------------------------------------------------------------
test('an image alone in a paragraph becomes a captioned figure, and number columns align right', async ({ page }) => {
  await open(page, 'kitchen-sink.md');
  const figure = page.locator('#mdBody p.mdv-figure');
  await expect(figure).toHaveCount(1);
  const caption = figure.locator('.mdv-figcaption');
  await expect(caption).toHaveAttribute('data-caption', 'Blue gradient banner with a white stripe');
  expect(await caption.evaluate((el) => getComputedStyle(el, '::before').content)).toContain('Blue gradient banner with a white stripe');

  // A linked image with alt text stays an image (a figure), instead of becoming a text-only link card.
  const pixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  await renderSource(page, `# Linked\n\n[![Release chart](${pixel})](https://example.com/chart)\n`);
  await expect(page.locator('#mdBody a.link-chip')).toHaveCount(0);
  await expect(page.locator('#mdBody p.mdv-figure a img')).toHaveCount(1);

  await renderSource(page, '# Numbers\n\n| Area | Words | Share |\n|---|---|---|\n| Prose | 1,204 | 52% |\n| Code | 380 | 18% |\n| Notes | — | 3% |\n');
  const aligned = await page.$$eval('#mdBody table tr', (rows) => rows.map((r) => [...r.children].map((c) => getComputedStyle(c).textAlign)));
  for (const row of aligned) expect(row).toEqual(['left', 'right', 'right']);
});

test('at phone width nothing scrolls sideways and every toolbar button is on screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, 'kitchen-sink.md');
  const layout = await page.evaluate(() => ({
    pageWidth: document.documentElement.scrollWidth,
    offscreen: [...document.querySelectorAll('.toolbar button')]
      .filter((b) => b.offsetParent !== null)
      .filter((b) => { const r = b.getBoundingClientRect(); return r.right > window.innerWidth + 0.5 || r.left < 0; })
      .map((b) => b.title || b.textContent.trim()),
  }));
  expect(layout.pageWidth).toBeLessThanOrEqual(390);
  expect(layout.offscreen).toEqual([]);
});

const AA_PAIRS = [
  ['--text-primary', '--bg-primary'], ['--text-secondary', '--bg-primary'], ['--text-tertiary', '--bg-primary'],
  ['--text-secondary', '--bg-secondary'], ['--text-tertiary', '--bg-secondary'], ['--text-tertiary', '--bg-tertiary'],
  ['--text-primary', '--bg-card'], ['--text-tertiary', '--bg-card'], ['--text-link', '--bg-primary'],
  ['--accent-strong', '--accent-soft'], ['--text-on-accent', '--accent'], ['--text-code', '--bg-code'],
  ['--text-primary', '--bg-code-block'], ['--text-tertiary', '--bg-code-header'], ['--accent-warn', '--bg-primary'],
  ['--syntax-keyword', '--bg-code-block'], ['--syntax-string', '--bg-code-block'], ['--syntax-number', '--bg-code-block'],
  ['--syntax-title', '--bg-code-block'], ['--syntax-type', '--bg-code-block'], ['--syntax-attr', '--bg-code-block'],
  ['--syntax-comment', '--bg-code-block'], ['--syntax-meta', '--bg-code-block'],
  ['--syntax-addition', '--bg-code-block'], ['--syntax-deletion', '--bg-code-block'],
  ['--diagram-text', '--diagram-node'], ['--diagram-text', '--diagram-alt'], ['--diagram-text', '--diagram-third'],
  ['--diagram-note-text', '--diagram-note'], ['--diagram-series-text', '--diagram-series-1'],
];
const CALLOUTS = ['note', 'tip', 'important', 'warning', 'caution', 'tldr', 'decision', 'cost'];

for (const theme of THEMES) {
  test(`text colours meet WCAG AA (4.5:1) in the ${theme} theme`, async ({ page }) => {
    await open(page, 'kitchen-sink.md', theme);
    const failures = await page.evaluate(([pairs, callouts]) => {
      const cs = getComputedStyle(document.documentElement);
      const probe = document.createElement('span');
      document.body.appendChild(probe);
      const parse = (value) => {
        probe.style.color = value;
        const m = getComputedStyle(probe).color.match(/[\d.]+/g).map(Number);
        return m.slice(0, 3);
      };
      const lum = ([r, g, b]) => [r, g, b].map((c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; })
        .reduce((s, c, i) => s + c * [0.2126, 0.7152, 0.0722][i], 0);
      const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
      const out = [];
      for (const [fg, bg] of pairs) {
        const r = ratio(parse(cs.getPropertyValue(fg)), parse(cs.getPropertyValue(bg)));
        if (r < 4.5) out.push(`${fg} on ${bg}: ${r.toFixed(2)}`);
      }
      // Callout titles on their own tint, as drawn.
      for (const c of callouts) {
        const el = document.querySelector(`#mdBody .callout-${c}`);
        const r = window.mdvTestColor.contrast(getComputedStyle(el.querySelector('.callout-title')).color, getComputedStyle(el).backgroundColor);
        if (r < 4.5) out.push(`--callout-${c} on its tint: ${r.toFixed(2)}`);
      }
      probe.remove();
      return out;
    }, [AA_PAIRS, CALLOUTS]);
    expect(failures).toEqual([]);
  });
}
