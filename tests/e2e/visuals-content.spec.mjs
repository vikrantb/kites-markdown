// Reading-surface details: figures, tables, task lists, highlights, diffs, callouts and the dashboard.
import { test, expect } from '@playwright/test';
import { THEMES, open, renderSource } from './visuals-helpers.mjs';

const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

test("a figure's caption is drawn, never added to the paragraph's text, so a comment on it is not misplaced", async ({ page }) => {
  await open(page, 'kitchen-sink.md');
  const doc = `# Doc\n\n## System overview\n\nIntro text.\n\n## Details\n\nMore text.\n\n![System overview](${PIXEL})\n`;
  await renderSource(page, doc);
  const figure = page.locator('#mdBody p.mdv-figure');
  await expect(figure.locator('.mdv-figcaption')).toHaveAttribute('data-caption', 'System overview');
  const shown = await figure.evaluate((p) => ({
    text: p.innerText.trim(),
    caption: getComputedStyle(p.querySelector('.mdv-figcaption'), '::before').content,
    captionHeight: p.querySelector('.mdv-figcaption').getBoundingClientRect().height,
  }));
  expect(shown.text).toBe(''); // what comments.js anchors by: the caption is not part of it
  expect(shown.caption).toContain('System overview');
  expect(shown.captionHeight).toBeGreaterThan(12); // and it is drawn under the image

  // The real comment path (comments.js): the anchor marker must not land before the heading with the same words.
  await page.evaluate(async () => {
    window.mdvScheduleSave = () => {}; // no file to save to in this test
    await mdvAddComment(document.querySelector('#mdBody p.mdv-figure'), null, 'A note on the image');
  });
  const source = await page.evaluate(() => rawMarkdown);
  expect(source.slice(0, source.indexOf('## System overview'))).not.toContain('MDV-ANCHOR');
});

const CALLOUTS = ['note', 'tip', 'important', 'warning', 'caution', 'tldr', 'decision', 'cost'];

for (const theme of THEMES) {
  test(`the eight callouts are told apart by colour, and each tint keeps its own hue, in the ${theme} theme`, async ({ page }) => {
    await open(page, 'kitchen-sink.md', theme);
    const r = await page.evaluate((types) => {
      const C = window.mdvTestColor;
      const els = types.map((t) => document.querySelector(`#mdBody .callout-${t}`));
      const bars = els.map((el) => getComputedStyle(el).borderLeftColor);
      const tints = els.map((el) => getComputedStyle(el).backgroundColor);
      let bar = [Infinity, ''], tint = [Infinity, ''];
      for (let i = 0; i < types.length; i++) {
        for (let j = i + 1; j < types.length; j++) {
          const pair = `${types[i]}/${types[j]}`;
          const b = C.dE(bars[i], bars[j]), t = C.dE(tints[i], tints[j]);
          if (b < bar[0]) bar = [b, pair];
          if (t < tint[0]) tint = [t, pair];
        }
      }
      // A tint mixed into a coloured page drifts towards the page's hue (cool callouts on sepia turned khaki).
      const drift = types.map((t, i) => [t, Math.abs(((C.hue(tints[i]) - C.hue(bars[i]) + 540) % 360) - 180)])
        .filter(([, d]) => d > 30).map(([t, d]) => `${t}: ${d.toFixed(0)} degrees`);
      const titles = types.map((t, i) => [t, C.contrast(getComputedStyle(els[i].querySelector('.callout-title')).color, tints[i])])
        .filter(([, c]) => c < 4.5).map(([t, c]) => `${t}: ${c.toFixed(2)}`);
      return { bar, tint, drift, titles };
    }, CALLOUTS);
    expect(r.bar[0], `closest accents: ${r.bar[1]}`).toBeGreaterThanOrEqual(20); // CIELAB dE76
    expect(r.tint[0], `closest tints: ${r.tint[1]}`).toBeGreaterThanOrEqual(2.5);
    expect(r.drift).toEqual([]);
    expect(r.titles).toEqual([]);
  });

  test(`pie slices stay apart for colour-blind readers, and each label is readable on its slice, in the ${theme} theme`, async ({ page }) => {
    for (const sample of ['kitchen-sink.md', 'diagram-gallery.md']) {
      await open(page, sample, theme);
      const r = await page.evaluate(() => {
        const C = window.mdvTestColor;
        const svg = document.querySelector('#mdBody .mermaid svg[aria-roledescription="pie"]');
        const slices = [...svg.querySelectorAll('path.pieCircle')].map((p) => C.rgb(getComputedStyle(p).fill));
        const labels = [...svg.querySelectorAll('text.slice')].map((t, i) => C.contrast(getComputedStyle(t).fill, slices[i]));
        let worst = [Infinity, ''];
        for (let i = 0; i < slices.length; i++) {
          for (let j = i + 1; j < slices.length; j++) {
            for (const kind of ['deutan', 'protan']) {
              const d = C.dE(C.cvd(slices[i], kind), C.cvd(slices[j], kind));
              if (d < worst[0]) worst = [d, `slices ${i + 1} and ${j + 1}, ${kind}`];
            }
          }
        }
        return { count: slices.length, worst, labels };
      });
      expect(r.count).toBeGreaterThanOrEqual(4);
      if (sample === 'kitchen-sink.md') expect(r.worst[0], r.worst[1]).toBeGreaterThanOrEqual(12); // every pair: a legend matches any two
      for (const c of r.labels) expect(c).toBeGreaterThanOrEqual(4.5);
    }
  });
}

test('tabular figures only in number columns: prose cells and the dashboard date keep proportional hyphens', async ({ page }) => {
  await open(page, 'kitchen-sink.md');
  const date = await page.evaluate(() => getComputedStyle(document.querySelector('#mdBody .fm-date')).fontVariantNumeric);
  const prose = await page.evaluate(() => {
    const cell = [...document.querySelectorAll('#mdBody td')].find((td) => td.textContent.trim() === 'character-level');
    return getComputedStyle(cell).fontVariantNumeric;
  });
  await renderSource(page, '# Numbers\n\n| Area | Words |\n|---|---|\n| Prose-heavy | 1,204 |\n| Code | 380 |\n');
  const cells = await page.evaluate(() => [...document.querySelectorAll('#mdBody tbody tr:first-child td')].map((td) => getComputedStyle(td).fontVariantNumeric));
  expect(date).toBe('normal');
  expect(prose).toBe('normal');
  expect(cells).toEqual(['normal', 'tabular-nums']);
});

test('a task-list checkbox is centred on the capital height of its text', async ({ page }) => {
  await open(page, 'kitchen-sink.md');
  const off = await page.evaluate(() => {
    const out = [];
    for (const box of document.querySelectorAll('#mdBody .task-list-item input[type="checkbox"]')) {
      const li = box.closest('li');
      // The baseline: a zero-size inline-block sits on it.
      const probe = document.createElement('span');
      probe.style.cssText = 'display:inline-block;width:0;height:0';
      box.after(probe);
      const baseline = probe.getBoundingClientRect().bottom;
      probe.remove();
      const ctx = document.createElement('canvas').getContext('2d');
      const cs = getComputedStyle(li);
      ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      const cap = ctx.measureText('H').actualBoundingBoxAscent;
      const r = box.getBoundingClientRect();
      out.push(+((r.top + r.height / 2) - (baseline - cap / 2)).toFixed(2));
    }
    return out;
  });
  expect(off.length).toBeGreaterThan(0);
  for (const o of off) expect(Math.abs(o)).toBeLessThanOrEqual(1.5);
});

test('a highlight does not push the punctuation after it away', async ({ page }) => {
  await open(page, 'kitchen-sink.md');
  const gap = await page.evaluate(() => {
    const mark = document.querySelector('#mdBody mark');
    const text = mark.firstChild;
    const end = document.createRange();
    end.setStart(text, text.length - 1);
    end.setEnd(text, text.length);
    const after = mark.nextSibling; // ", `inline code`..."
    const comma = document.createRange();
    comma.setStart(after, 0);
    comma.setEnd(after, 1);
    return { char: after.textContent[0], gap: comma.getBoundingClientRect().left - end.getBoundingClientRect().right };
  });
  expect(gap.char).toBe(',');
  expect(gap.gap).toBeLessThanOrEqual(1.5);
});

test('diff rows run the full width of the code block', async ({ page }) => {
  await open(page, 'kitchen-sink.md');
  const rows = await page.evaluate(() => {
    const code = document.querySelector('#mdBody pre code.hljs.language-diff, #mdBody pre code.language-diff code.hljs') ||
      [...document.querySelectorAll('#mdBody pre code.hljs')].find((c) => c.querySelector('.hljs-addition'));
    const box = code.getBoundingClientRect();
    return [...code.querySelectorAll('.hljs-addition, .hljs-deletion')].map((row) => {
      const r = row.getBoundingClientRect();
      return { left: r.left - box.left, right: box.right - r.right };
    });
  });
  expect(rows.length).toBeGreaterThan(0);
  for (const r of rows) {
    expect(Math.abs(r.left)).toBeLessThanOrEqual(1);
    expect(Math.abs(r.right)).toBeLessThanOrEqual(1);
  }
});

for (const width of [1366, 390]) {
  test(`the dashboard's metrics fill their rows, and the status reads as words, at ${width} px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await open(page, 'kitchen-sink.md');
    const d = await page.evaluate(() => {
      const box = document.querySelector('#mdBody .fm-metrics');
      const inner = box.getBoundingClientRect();
      const rows = new Map();
      for (const m of box.children) {
        const r = m.getBoundingClientRect();
        const key = Math.round(r.top);
        rows.set(key, [...(rows.get(key) || []), r]);
      }
      // Empty space at the end of each row (gaps between metrics are the layout's, not holes).
      const holes = [...rows.values()].map((rs) => inner.right - Math.max(...rs.map((r) => r.right)));
      return {
        rows: rows.size, holes,
        status: document.querySelector('#mdBody .fm-status-badge').innerText,
        repo: document.querySelector('#mdBody a.fm-repo-badge').innerText, // what is shown
      };
    });
    if (width === 1366) expect(d.rows).toBe(1);
    for (const h of d.holes) expect(h).toBeLessThanOrEqual(1);
    expect(d.status).not.toMatch(/[-_]/);
    expect(d.status.toLowerCase()).toContain('in progress');
    expect(d.repo).not.toContain('★');
  });
}

test('link-type marks are drawn icons, not stray characters', async ({ page }) => {
  await open(page, 'kitchen-sink.md');
  const marks = await page.evaluate(() => [...document.querySelectorAll('#mdBody a[data-link-type]:not([data-link-type="anchor"])')]
    .filter((a) => !a.closest('.fm-dashboard, .link-chip'))
    .map((a) => { const cs = getComputedStyle(a, '::after'); return { type: a.dataset.linkType, content: cs.content, mask: cs.maskImage || cs.webkitMaskImage }; }));
  expect(marks.length).toBeGreaterThan(0);
  for (const m of marks) {
    expect(m.content, m.type).toBe('""');
    expect(m.mask, m.type).toContain('url(');
  }
});
