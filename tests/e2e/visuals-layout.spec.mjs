// The section rail and the phone layout.
import { test, expect } from '@playwright/test';
import { open } from './visuals-helpers.mjs';

test('the section rail comes first and stays under the toolbar, showing where the reader is', async ({ page }) => {
  await open(page, 'kitchen-sink.md');
  const rail = page.locator('#mdBody > .section-minimap');
  await expect(rail).toHaveCount(1);
  const top = await page.evaluate(() => {
    const body = document.getElementById('mdBody');
    const nav = body.querySelector('.section-minimap');
    const next = nav.nextElementSibling.getBoundingClientRect();
    return {
      first: body.firstElementChild === nav,
      inSection: !!nav.closest('.section-content'),
      gapBelow: next.top - nav.getBoundingClientRect().bottom,
      track: nav.classList.contains('is-track'),
      current: nav.dataset.current, position: nav.dataset.position,
      shown: getComputedStyle(nav, '::before').content,
    };
  });
  expect(top.first).toBe(true); // ahead of the dashboard and the title, as chrome; never between them
  expect(top.inSection).toBe(false); // outside every section: their blocks keep their sibling positions
  expect(top.gapBelow).toBeGreaterThanOrEqual(6);
  expect(top.track).toBe(true); // 17 sections are too many for labels
  expect(top.current).toBe('Offline Sync Design Review');
  expect(top.position).toBe('17 sections');
  expect(top.shown).toBe(JSON.stringify(top.current)); // the rail names where the reader is

  const at = (id) => page.evaluate(async (h) => {
    document.getElementById(h).scrollIntoView({ block: 'start', behavior: 'instant' });
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const nav = document.querySelector('#mdBody .section-minimap');
    const r = nav.getBoundingClientRect();
    const toolbar = document.querySelector('.toolbar').getBoundingClientRect().bottom;
    return {
      onScreen: r.top >= toolbar - 0.5 && r.top <= toolbar + 12 && r.bottom <= window.innerHeight,
      active: [...nav.querySelectorAll('.minimap-segment.active')].map((s) => s.dataset.targetId),
      passed: nav.querySelectorAll('.minimap-segment.passed').length,
      current: nav.dataset.current, position: nav.dataset.position,
    };
  }, id);
  const architecture = await at('architecture');
  expect(architecture.onScreen).toBe(true); // sticky: in view while reading, not only at the top
  expect(architecture.active).toEqual(['architecture']);
  expect(architecture.passed).toBe(2);
  expect(architecture.current).toBe('Architecture');
  expect(architecture.position).toBe('3 / 17');
  const back = await at('callouts'); // right scrolling up as well
  expect(back.active).toEqual(['callouts']);
  expect(back.position).toBe('2 / 17');
});

test('the title keeps its fold toggle with the section rail in place', async ({ page }) => {
  await open(page, 'kitchen-sink.md');
  const h1 = page.locator('#mdBody h1');
  await h1.hover();
  await h1.locator('.section-toggle').click();
  await expect(page.locator('#mdBody h1 + .section-content')).toHaveClass(/collapsed/);
});

test.describe('at phone width', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('the text-size control stays, and the toolbar holds no clipped file name', async ({ page }) => {
    await open(page, 'kitchen-sink.md');
    const ctrl = await page.evaluate(() => {
      const visible = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
      const buttons = [...document.querySelectorAll('.font-ctrl button')].filter(visible);
      // The file name is cut when its text runs past what shows of it (its own box or the toolbar title's) without
      // an ellipsis.
      const title = document.getElementById('titleText');
      const words = document.createRange();
      words.selectNodeContents(title);
      const shown = Math.min(title.getBoundingClientRect().right, document.getElementById('toolbarTitle').getBoundingClientRect().right);
      return {
        buttons: buttons.map((b) => { const r = b.getBoundingClientRect(); return r.left >= 0 && r.right <= window.innerWidth; }),
        titleClipped: visible(title) && words.getBoundingClientRect().right > shown + 1 && getComputedStyle(title).textOverflow !== 'ellipsis',
      };
    });
    expect(ctrl.buttons).toEqual([true, true]); // A- and A+ are on screen
    expect(ctrl.titleClipped).toBe(false);
    const size = () => page.evaluate(() => getComputedStyle(document.querySelector('#mdBody p')).fontSize);
    const before = await size();
    await page.locator('.font-ctrl button').last().click();
    expect(await size()).not.toBe(before);
  });

  test('headings keep the text edge, wide tables show they scroll, and nothing floats over the text', async ({ page }) => {
    await open(page, 'kitchen-sink.md');
    const layout = await page.evaluate(() => {
      const h1 = document.querySelector('#mdBody h1');
      const words = [...h1.childNodes].find((n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim());
      const range = document.createRange();
      range.selectNodeContents(words);
      const lines = [...range.getClientRects()].map((r) => r.left);
      const p = document.querySelector('#mdBody p').getBoundingClientRect().left;
      const table = document.querySelector('#mdBody table');
      const fabs = document.getElementById('fabContainer');
      return { lines, p, cue: table.classList.contains('mdv-more-right'), mask: getComputedStyle(table).maskImage || getComputedStyle(table).webkitMaskImage, fabs: fabs.getClientRects().length };
    });
    expect(layout.lines.length).toBeGreaterThanOrEqual(2); // the title wraps at this width
    for (const left of layout.lines) expect(Math.abs(left - layout.p)).toBeLessThanOrEqual(1.5);
    expect(layout.cue).toBe(true);
    expect(layout.mask).not.toBe('none');
    expect(layout.fabs).toBe(0);
    // Scrolled to its end, the table fades on the other side.
    const end = await page.evaluate(async () => {
      const t = document.querySelector('#mdBody table');
      t.scrollLeft = t.scrollWidth;
      await new Promise((r) => setTimeout(r, 50));
      return { left: t.classList.contains('mdv-more-left'), right: t.classList.contains('mdv-more-right') };
    });
    expect(end).toEqual({ left: true, right: false });
  });
});
