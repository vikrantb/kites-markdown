// The diagram expanded view: keyboard access to linked nodes, its own ids, zoom steps that compound, and what
// happens when the document under it changes.
import { test, expect } from '@playwright/test';
import { open, renderSource, settled } from './visuals-helpers.mjs';

async function openFirstDiagram(page) {
  await open(page, 'kitchen-sink.md');
  await page.evaluate(() => openDiagramOverlay(document.querySelector('#mdBody .mermaid-wrapper')));
  await expect(page.locator('#diagramOverlay')).toHaveClass(/show/);
}

const svgBox = (page) => page.evaluate(() => {
  const r = document.querySelector('#diagramZoomContainer svg').getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
});

test('in the expanded view, Tab reaches the nodes that link to a section, and Enter follows one', async ({ page }) => {
  await openFirstDiagram(page);
  const focused = [];
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press('Tab');
    focused.push(await page.evaluate(() => {
      const el = document.activeElement;
      return el.getAttribute('data-mdv-section') || el.id || el.textContent.trim();
    }));
  }
  const nodes = focused.filter((f) => ['capture', 'merge', 'delivery'].includes(f));
  expect(nodes.length).toBeGreaterThanOrEqual(3); // every linked node is reachable
  expect(await page.evaluate(() => document.getElementById('diagramOverlay').contains(document.activeElement))).toBe(true);

  // Enter on a focused node closes the view and goes to its section.
  while (!['capture', 'merge', 'delivery'].includes(await page.evaluate(() => document.activeElement.getAttribute('data-mdv-section')))) {
    await page.keyboard.press('Tab');
  }
  const id = await page.evaluate(() => document.activeElement.getAttribute('data-mdv-section'));
  await page.keyboard.press('Enter');
  await expect(page.locator('#diagramOverlay')).not.toHaveClass(/show/);
  await expect.poll(() => page.evaluate((h) => document.getElementById(h).getBoundingClientRect().top, id)).toBeLessThan(200);
});

test("the expanded view's copy has its own ids, so its arrowheads never resolve to the page", async ({ page }) => {
  await openFirstDiagram(page);
  const ids = await page.evaluate(() => {
    const all = [...document.querySelectorAll('[id]')].map((e) => e.id);
    const duplicates = [...new Set(all.filter((id, i) => all.indexOf(id) !== i))];
    const view = document.getElementById('diagramZoomContainer');
    const refs = [];
    for (const el of view.querySelectorAll('*')) {
      for (const attr of el.attributes) {
        for (const m of attr.value.matchAll(/url\(#([^)]+)\)/g)) refs.push(m[1]);
      }
    }
    const outside = refs.filter((id) => !view.contains(document.getElementById(id)));
    return { duplicates, refs: refs.length, outside };
  });
  expect(ids.refs).toBeGreaterThan(0); // the flowchart's edges do reference markers
  expect(ids.duplicates).toEqual([]);
  expect(ids.outside).toEqual([]);
});

test('two quick presses of + zoom by two full steps', async ({ page }) => {
  await openFirstDiagram(page);
  const fit = await settled(() => svgBox(page));
  await page.keyboard.press('+');
  await page.waitForTimeout(40); // mid-animation (each step animates for 180 ms)
  await page.keyboard.press('+');
  const zoomed = await settled(() => svgBox(page));
  expect(zoomed.w / fit.w).toBeCloseTo(1.25 * 1.25, 2);
});

test('an expanded view closes when another document replaces its diagram', async ({ page }) => {
  await openFirstDiagram(page);
  await renderSource(page, '# Another document\n\n```mermaid\nflowchart LR\n  A --> B\n```\n');
  await expect(page.locator('#diagramOverlay')).not.toHaveClass(/show/);
  expect(await page.locator('#diagramZoomContainer svg').count()).toBe(0);
});

test('a translucent diagram colour is resolved over the card it is drawn on, not over white', async ({ page }) => {
  await open(page, 'kitchen-sink.md', 'dark');
  const node = await page.evaluate(() => {
    document.documentElement.style.setProperty('--diagram-node', 'rgba(255, 255, 255, 0.08)');
    const p = mdvDiagramPalette();
    document.documentElement.style.removeProperty('--diagram-node');
    return { node: p.node, card: p.bg };
  });
  const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const expected = hex(node.card).map((c) => 0.08 * 255 + 0.92 * c);
  hex(node.node).forEach((c, i) => expect(Math.abs(c - expected[i])).toBeLessThanOrEqual(1.5));
});
