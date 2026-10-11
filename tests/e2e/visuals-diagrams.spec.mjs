// Diagram finish: one shape language across Mermaid's types. Arrowheads in their line's colour and resolved
// inside their own diagram, journey actors from the palette, outlines at 3:1, labels that do not collide.
import { test, expect } from '@playwright/test';
import { open } from './visuals-helpers.mjs';

const svgOf = (type) => `#mdBody .mermaid-wrapper[data-diagram-type="${type}"] .mermaid svg`;

test("a journey's actors and faces are drawn in the palette, not in Mermaid's defaults", async ({ page }) => {
  for (const theme of ['light', 'dark']) {
    await open(page, 'diagram-gallery.md', theme);
    const drawn = await page.evaluate((sel) => {
      const C = window.mdvTestColor;
      const svg = document.querySelector(sel);
      const cs = getComputedStyle(document.documentElement);
      const series = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => C.rgb(cs.getPropertyValue('--diagram-series-' + i)).join());
      return {
        actors: [...svg.querySelectorAll('circle[class^="actor-"]')].map((c) => C.rgb(getComputedStyle(c).fill).join()),
        faces: [...svg.querySelectorAll('circle.face')].map((c) => C.rgb(getComputedStyle(c).fill).join()),
        series,
      };
    }, svgOf('journey'));
    expect(drawn.actors.length).toBeGreaterThan(0);
    for (const a of drawn.actors) expect(drawn.series).toContain(a);
    expect(drawn.actors).not.toContain('143,188,143'); // Mermaid's #8FBC8F
    expect(drawn.actors).not.toContain('124,252,0'); // and #7CFC00
    expect(drawn.faces.length).toBeGreaterThan(0);
    expect(drawn.faces).not.toContain('255,248,220'); // Mermaid's face colour
  }
});

for (const theme of ['light', 'dark']) {
  test(`arrowheads are drawn in their line's colour and resolve inside their own diagram in the ${theme} theme`, async ({ page }) => {
    await open(page, 'diagram-gallery.md', theme);
    const result = await page.evaluate(() => {
      const C = window.mdvTestColor;
      const all = [...document.querySelectorAll('[id]')].map((e) => e.id);
      const duplicates = [...new Set(all.filter((id, i) => all.indexOf(id) !== i))];
      const foreign = [], mismatched = [];
      let checked = 0;
      for (const svg of document.querySelectorAll('#mdBody .mermaid svg')) {
        const type = svg.getAttribute('aria-roledescription');
        for (const el of svg.querySelectorAll('[marker-end], [marker-start]')) {
          const ref = (el.getAttribute('marker-end') || el.getAttribute('marker-start')).match(/url\(#([^)]+)\)/);
          if (!ref) continue;
          const marker = document.getElementById(ref[1]);
          if (!marker || !svg.contains(marker)) { foreign.push(`${type}: ${ref[1]}`); continue; }
          if (!['stateDiagram', 'timeline', 'journey'].includes(type)) continue;
          const head = marker.querySelector('path');
          const line = getComputedStyle(el).stroke;
          checked++;
          if (C.dE(getComputedStyle(head).fill, line) > 2) mismatched.push(`${type}: head ${getComputedStyle(head).fill} on line ${line}`);
        }
      }
      return { duplicates, foreign, mismatched: [...new Set(mismatched)], checked };
    });
    expect(result.checked).toBeGreaterThan(5);
    expect(result.duplicates).toEqual([]);
    expect(result.foreign).toEqual([]);
    expect(result.mismatched).toEqual([]);
  });
}

test("a stick-figure actor's name sits below its legs", async ({ page }) => {
  await open(page, 'diagram-gallery.md');
  const man = await page.evaluate((sel) => {
    const g = document.querySelector(`${sel} g.actor-man`);
    const legs = Math.max(...[...g.querySelectorAll('line')].map((l) => l.getBoundingClientRect().bottom));
    const label = g.querySelector('text').getBoundingClientRect();
    return { legs, labelTop: label.top };
  }, svgOf('sequence'));
  expect(man.labelTop).toBeGreaterThanOrEqual(man.legs - 0.5);
});

test('edge labels inside a subgraph or a composite state sit on that container, without a canvas-coloured patch', async ({ page }) => {
  await open(page, 'diagram-gallery.md');
  const chips = await page.evaluate(() => {
    const C = window.mdvTestColor;
    const out = [];
    const label = (svg, words) => [...svg.querySelectorAll('g.edgeLabel')].find((g) => g.textContent.trim() === words);
    const check = (type, words, containerSel) => {
      const svg = document.querySelector(`#mdBody .mermaid-wrapper[data-diagram-type="${type}"] .mermaid svg`);
      const g = label(svg, words);
      const chip = getComputedStyle(g.querySelector('.labelBkg')).backgroundColor;
      const box = getComputedStyle(svg.querySelector(containerSel)).fill;
      out.push({ type, words, dE: C.dE(chip, box) });
    };
    check('flowchart-v2', 'changes', 'g.cluster > rect');
    check('stateDiagram', 'wheel or pinch', 'g.statediagram-cluster rect.inner');
    check('stateDiagram', 'press 0', 'g.statediagram-cluster rect.inner');
    // The composite state draws one bottom border, not two: its inner box keeps only its top edge.
    const inner = document.querySelector('#mdBody .mermaid-wrapper[data-diagram-type="stateDiagram"] g.statediagram-cluster rect.inner');
    const dash = (inner.getAttribute('stroke-dasharray') || '').split(/[ ,]+/).map(Number);
    return { out, topEdgeOnly: dash.length === 2 && Math.abs(dash[0] - inner.width.baseVal.value) < 0.5 };
  });
  for (const c of chips.out) expect(c.dE, `${c.type} "${c.words}"`).toBeLessThan(1);
  expect(chips.topEdgeOnly).toBe(true);
});

test('sequence notes, frames, class boxes, titles and the Gantt today line are finished like the rest', async ({ page }) => {
  await open(page, 'diagram-gallery.md');
  const r = await page.evaluate(() => {
    const C = window.mdvTestColor;
    const q = (t) => document.querySelector(`#mdBody .mermaid-wrapper[data-diagram-type="${t}"] .mermaid svg`);
    const seq = q('sequence');
    const lines = [...seq.querySelectorAll('.messageLine0, .messageLine1')].map((l) => l.getBoundingClientRect().top);
    const note = seq.querySelector('rect.note').getBoundingClientRect();
    const scale = note.width / seq.querySelector('rect.note').getBBox().width; // drawn size per SVG unit
    const noteGap = (note.top - Math.max(...lines.filter((y) => y < note.top))) / scale;
    const card = getComputedStyle(seq.closest('.mermaid-wrapper')).backgroundColor;
    const frame = C.contrast(getComputedStyle(seq.querySelector('.loopLine')).stroke, card);
    const classBoxes = [...q('class').querySelectorAll('g.node > g.basic.label-container > path')].map((p) => /Q/.test(p.getAttribute('d')));
    const centred = ['timeline', 'journey'].map((t) => {
      const svg = q(t);
      const title = svg.querySelector('text[font-size="4ex"]').getBoundingClientRect();
      const box = svg.getBoundingClientRect();
      return Math.abs((title.left + title.width / 2) - (box.left + box.width / 2));
    });
    const periods = [...q('timeline').querySelectorAll('g.timeline-node')].map((n) => {
      const b = n.querySelector('path.node-bkg').getBoundingClientRect();
      const t = n.querySelector('text').getBoundingClientRect();
      return Math.abs((b.top + b.height / 2) - (t.top + t.height / 2));
    });
    const gantt = q('gantt');
    const today = gantt.querySelector('g.today');
    const firstTask = gantt.querySelector('.task');
    return {
      noteGap, frame, classBoxes, centred, worstPeriod: Math.max(...periods),
      todayBehind: !!(today && firstTask && (today.compareDocumentPosition(firstTask) & Node.DOCUMENT_POSITION_FOLLOWING)),
    };
  });
  expect(r.noteGap).toBeGreaterThanOrEqual(17); // a note is not pressed against the message above it
  expect(r.frame).toBeGreaterThanOrEqual(3); // alt and loop frames are visible
  expect(r.classBoxes.length).toBeGreaterThan(0);
  expect(r.classBoxes.every(Boolean)).toBe(true); // rounded like every other node
  for (const off of r.centred) expect(off).toBeLessThan(3);
  expect(r.worstPeriod).toBeLessThan(3);
  expect(r.todayBehind).toBe(true);
});
