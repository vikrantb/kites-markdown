// The reading surface: the section rail as a progress strip that follows the outline, a quiet cue on diagram nodes
// that link to a section, diagrams that keep a legible size at any width, and two guards over every sample: body
// text and links meet WCAG AA in every theme, and nothing on a phone runs off the side of the page.
import { test, expect } from '@playwright/test';
import { readdirSync } from 'node:fs';
import { THEMES, open, renderSource, settled } from './visuals-helpers.mjs';
import { waitForLayoutSettled } from './support/viewer.mjs';

const SAMPLES = readdirSync(new URL('../../samples/', import.meta.url)).filter((f) => f.endsWith('.md')).sort();

// A long agent handoff, as a reader opens one most days: a title and its introduction, 27 sections of prose, and among
// them a 12-step deploy pipeline (a flowchart about 2,900 px wide), a sequence diagram with 7 participants and a
// Gantt chart.
const HANDOFF_SECTIONS = ['Summary', 'Context', 'Goals', 'Non-goals', 'Current state', 'Architecture', 'Deploy path',
  'Request flow', 'State model', 'Data model', 'Schedule', 'Cost split', 'Throughput', 'Risks', 'Mitigations',
  'Open questions', 'Decisions taken', 'Rollout plan', 'Monitoring', 'Alerts', 'Runbook', 'Testing', 'Known issues',
  'Dependencies', 'Staffing', 'Appendix', 'Next steps'];
function handoff() {
  const prose = 'The worker reads each job document and writes a status update before it moves on to the next stage. '.repeat(12);
  const diagrams = {
    'Deploy path': ['flowchart LR', ...Array.from({ length: 11 }, (_, i) => `  S${i}[Step ${i + 1}: build stage ${i + 1}] --> S${i + 1}[Step ${i + 2}: build stage ${i + 2}]`)],
    'Request flow': ['sequenceDiagram', ...['Client', 'Gateway', 'Auth', 'Queue', 'Worker', 'Store', 'Notifier'].map((p) => `  participant ${p}`),
      '  Client->>Gateway: submit request', '  Gateway->>Queue: create job document', '  Queue->>Worker: lease job',
      '  Worker->>Store: write result', '  Worker->>Notifier: notify', '  Notifier-->>Client: done'],
    Schedule: ['gantt', '  dateFormat YYYY-MM-DD', '  section Build', '  Design :a1, 2026-10-01, 4d', '  Implement :a2, after a1, 6d',
      '  section Verify', '  Test :b1, after a2, 3d', '  Review :b2, after b1, 2d', '  section Rollout', '  Canary :c1, after b2, 2d',
      '  Full rollout :c2, after c1, 3d'],
  };
  return `# Status report: queue sharding\n\n${prose}\n\n` + HANDOFF_SECTIONS.map((s) =>
    `## ${s}\n\n${prose}\n\n${diagrams[s] ? '```mermaid\n' + diagrams[s].join('\n') + '\n```\n\n' : ''}${prose}\n`).join('\n');
}

// ---------------------------------------------------------------------------------------------
// The section rail
// ---------------------------------------------------------------------------------------------

// Scrolls so the reader is `frac` of the way through the section that heading `id` starts, as the rail counts it, and
// lets the scroll spy run. A section starts where a jump to its heading lands (0: the heading at the page's
// scroll-padding-top, under the toolbar and the rail) and ends where the next section becomes current (1: the next
// h1 or h2 at the reading line).
async function readAt(page, id, frac = 0) {
  await page.evaluate(async ([hid, f]) => {
    const line = Math.max(80, innerHeight * 0.3);
    const land = Math.min(parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop) || 0, line);
    const docTop = (el) => el.getBoundingClientRect().top + scrollY;
    const heading = document.getElementById(hid);
    const all = [...document.querySelectorAll('#mdBody h1, #mdBody h2')];
    const next = all[all.indexOf(heading) + 1];
    const start = docTop(heading) - land;
    const end = (next ? docTop(next) : document.documentElement.scrollHeight) - line;
    window.scrollTo({ top: start + 1 + f * (end - start - 2), behavior: 'instant' });
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  }, [id, frac]);
}

// What the rail shows, and the section the outline is in (the h2 at or above its current entry, within its h1).
const railState = (page) => page.evaluate(() => {
  const nav = document.querySelector('#mdBody .section-minimap');
  const segs = [...nav.querySelectorAll('.minimap-segment')];
  const p = (s) => Number(getComputedStyle(s).getPropertyValue('--p'));
  const active = segs.filter((s) => s.classList.contains('active'));
  const link = document.querySelector('#tocList .toc-link.active');
  let outlineSection = null;
  if (link) {
    const headings = [...document.querySelectorAll('#mdBody h1, #mdBody h2, #mdBody h3, #mdBody h4, #mdBody h5, #mdBody h6')];
    for (let i = headings.findIndex((h) => h.id === link.dataset.target); i >= 0; i--) {
      if (headings[i].tagName === 'H2') { outlineSection = headings[i].id; break; }
      if (headings[i].tagName === 'H1') break;
    }
  }
  return {
    active: active.map((s) => s.dataset.targetId),
    passed: segs.filter((s) => s.classList.contains('passed')).length,
    fills: segs.map(p),
    progress: active.length ? p(active[0]) : null,
    intro: nav.classList.contains('at-intro'),
    outline: link ? link.dataset.target : null,
    outlineSection,
  };
});

test('the rail follows the reader: its current segment moves on scroll as the outline does, read sections are filled, and the current one fills as the reader goes', async ({ page }) => {
  const errors = await open(page, 'kitchen-sink.md');
  const at = async (id, frac) => {
    if (id) await readAt(page, id, frac);
    const s = await railState(page);
    // The rail and the outline agree at every stop: the rail's current section is the outline's.
    expect(s.active).toEqual(s.outlineSection ? [s.outlineSection] : []);
    return s;
  };

  let s = await at(null);
  expect(s.outline).toBe(null); // the top of the page: nothing is read yet
  expect(s.intro).toBe(false);
  expect(s.fills.every((f) => f === 0)).toBe(true);

  // In the title's introduction the outline marks the title, and the rail marks it too.
  s = await at('offline-sync-design-review', 0.5);
  expect(s.outline).toBe('offline-sync-design-review');
  expect(s.intro).toBe(true);

  s = await at('architecture', 0);
  expect(s.active).toEqual(['architecture']);
  expect(s.intro).toBe(false);
  expect(s.passed).toBe(2);
  expect(s.fills.slice(0, 2)).toEqual([1, 1]); // read: filled
  expect(s.fills.slice(3).every((f) => f === 0)).toBe(true); // ahead: empty
  expect(s.progress).toBeLessThan(0.05);

  s = await at('architecture', 0.5); // half way through the section, its segment is half filled
  expect(s.active).toEqual(['architecture']);
  expect(s.progress).toBeGreaterThan(0.45);
  expect(s.progress).toBeLessThan(0.55);

  s = await at('code', 0.3); // further down, the current segment moves on
  expect(s.active).toEqual(['code']);
  expect(s.passed).toBe(7);
  expect(s.progress).toBeGreaterThan(0.25);
  expect(s.progress).toBeLessThan(0.35);

  s = await at('callouts', 0.2); // and back up, it moves back
  expect(s.active).toEqual(['callouts']);
  expect(s.passed).toBe(1);
  expect(s.fills.slice(2).every((f) => f === 0)).toBe(true);

  // At the very bottom of the page the last section is current and read to its end.
  await page.evaluate(async () => {
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' });
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
  s = await at(null);
  expect(s.active).toEqual(['heading-levels']);
  expect(s.progress).toBe(1);
  expect(s.fills.every((f) => f === 1)).toBe(true);
  expect(errors, errors.join('\n')).toEqual([]);
});

test("the rail draws what it marks: the current segment's bar is filled as far as the reader has got, and in the title's introduction the title is accented", async ({ page }) => {
  await open(page, 'kitchen-sink.md'); // 17 sections: the track form
  await readAt(page, 'architecture', 0.5);
  const bar = await page.evaluate(() => {
    const seg = document.querySelector('#mdBody .minimap-segment.active');
    const cs = getComputedStyle(seg, '::before');
    const stop = cs.backgroundImage.match(/\)\s+([\d.]+)%/); // the first colour stop: "rgb(…) 49.7%"
    return { p: Number(getComputedStyle(seg).getPropertyValue('--p')), stop: stop ? Number(stop[1]) : null, height: parseFloat(cs.height) };
  });
  expect(bar.stop).not.toBe(null);
  expect(Math.abs(bar.stop - bar.p * 100)).toBeLessThan(0.6);
  const ahead = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('#mdBody .minimap-segment:not(.active):not(.passed)'), '::before').height));
  expect(bar.height).toBeGreaterThan(ahead); // the current segment stands out

  await readAt(page, 'offline-sync-design-review', 0.5);
  const title = () => page.evaluate(() => {
    const nav = document.querySelector('#mdBody .section-minimap');
    const cs = getComputedStyle(nav, '::before');
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent-strong');
    return { content: cs.content, dot: cs.backgroundImage, dE: window.mdvTestColor.dE(cs.color, accent.trim()), current: nav.dataset.current };
  });
  await expect.poll(async () => (await title()).dE).toBeLessThan(2); // the title is in the accent (it eases in)
  const t = await title();
  expect(t.content).toBe(JSON.stringify(t.current));
  expect(t.current).toBe('Offline Sync Design Review');
  expect(t.dot).toContain('radial-gradient'); // after a "you are here" dot
});

test('a rail with room for labels fills the same way: read, current and ahead under their labels', async ({ page }) => {
  await open(page, 'commented.md'); // four sections: the label form
  await expect(page.locator('#mdBody .section-minimap')).not.toHaveClass(/is-track/);
  await readAt(page, 'plan', 0.5);
  const s = await railState(page);
  expect(s.active).toEqual(['plan']);
  expect(s.fills[0]).toBe(1);
  expect(s.progress).toBeGreaterThan(0.4);
  expect(s.progress).toBeLessThan(0.6);
  expect(s.fills.slice(2)).toEqual([0, 0]);
  const look = () => page.evaluate(() => {
    const seg = document.querySelector('#mdBody .minimap-segment.active');
    const root = getComputedStyle(document.documentElement);
    return {
      bar: getComputedStyle(seg).backgroundImage, // the bar under the label
      label: getComputedStyle(seg, '::before').content,
      dE: window.mdvTestColor.dE(getComputedStyle(seg, '::before').color, root.getPropertyValue('--accent-strong').trim()),
    };
  });
  await expect.poll(async () => (await look()).dE).toBeLessThan(2); // the current label is in the accent
  const l = await look();
  expect(l.bar).toContain('linear-gradient');
  expect(l.label).toBe('"Plan"');
});

// The colours the rail draws, read from its bars as CSS paints them: in the label form from a segment's own
// background, in the track form from its ::before. A bar is one gradient, the fill up to --p and the rest after it,
// so a read segment shows only its first colour, one ahead only its second, and the current one both.
const railDrawn = (page) => page.evaluate(() => {
  const C = window.mdvTestColor;
  const nav = document.querySelector('#mdBody .section-minimap');
  const under = getComputedStyle(nav).backgroundColor;
  const track = nav.classList.contains('is-track');
  const bar = (seg) => {
    const image = getComputedStyle(seg, track ? '::before' : null).backgroundImage;
    const gradient = (image.match(/linear-gradient\(.*\)/) || [''])[0]; // the bar, after the label form's dot if any
    const stops = [...gradient.matchAll(/((?:rgba?|color|oklch|oklab|lab|lch|hsla?)\([^()]*\))\s*(-?[\d.]+(?:%|px))?/g)]
      .map((m) => ({ colour: C.rgb(m[1], under), at: parseFloat(m[2] || '0') }));
    const shows = stops.length !== 2 ? 'no bar' : stops[0].at >= 99.5 ? 'fill' : stops[0].at <= 0.5 ? 'rest' : 'both';
    return { fill: stops[0] && stops[0].colour, rest: stops[1] && stops[1].colour, shows };
  };
  const read = bar(nav.querySelector('.minimap-segment.passed'));
  const now = bar(nav.querySelector('.minimap-segment.active'));
  const ahead = bar(nav.querySelector('.minimap-segment.active ~ .minimap-segment:not(.passed)'));
  return {
    form: track ? 'track' : 'label', shows: [read.shows, now.shows, ahead.shows],
    readVsAhead: C.contrast(read.fill, ahead.rest), nowVsAhead: C.contrast(now.fill, ahead.rest), nowVsItsRest: C.contrast(now.fill, now.rest),
  };
});

for (const theme of THEMES) {
  test(`the rail draws its read, current and ahead states at 3:1 or more from each other, in both forms, in the ${theme} theme`, async ({ page }) => {
    for (const [sample, section, form] of [['kitchen-sink.md', 'architecture', 'track'], ['commented.md', 'plan', 'label']]) {
      await open(page, sample, theme);
      await readAt(page, section, 0.5);
      const r = await railDrawn(page);
      expect(r.form).toBe(form);
      // What each segment draws: a read one its fill alone, the current one both colours, one ahead its rest alone.
      expect(r.shows, `${form} form`).toEqual(['fill', 'both', 'rest']);
      for (const pair of ['readVsAhead', 'nowVsAhead', 'nowVsItsRest']) expect(r[pair], `${form} form: ${pair}`).toBeGreaterThanOrEqual(3);
    }
  });
}

test('a rail segment shows its full name on keyboard focus as well as on hover', async ({ page }) => {
  await open(page, 'kitchen-sink.md');
  const segs = page.locator('#mdBody .minimap-segment');
  const tip = (i) => segs.nth(i).evaluate((el) => {
    const cs = getComputedStyle(el, '::after');
    return cs.display === 'none' ? null : cs.content;
  });
  expect(await tip(4)).toBe(null);
  await segs.nth(3).focus();
  await page.keyboard.press('Tab'); // the keyboard brings the focus to the fifth segment
  await expect(segs.nth(4)).toBeFocused();
  expect(await tip(4)).toBe(JSON.stringify(await segs.nth(4).getAttribute('data-label')));
  await page.locator('#mdBody h1').click(); // away from the rail
  await segs.nth(6).hover();
  await expect.poll(() => tip(6)).toBe(JSON.stringify(await segs.nth(6).getAttribute('data-label')));
});

// Every scroll listener on the window and the document, named by the script and the source line of its handler, so a
// listener the page adds once for its whole lifetime is caught as surely as one added per render.
async function scrollListeners(page) {
  const client = await page.context().newCDPSession(page);
  const scripts = new Map();
  client.on('Debugger.scriptParsed', (e) => scripts.set(e.scriptId, e.url));
  await client.send('Debugger.enable'); // reports every script already parsed
  const out = [];
  for (const target of ['window', 'document']) {
    const { result } = await client.send('Runtime.evaluate', { expression: target });
    const { listeners } = await client.send('DOMDebugger.getEventListeners', { objectId: result.objectId });
    for (const l of listeners.filter((x) => x.type === 'scroll')) {
      const { scriptSource } = await client.send('Debugger.getScriptSource', { scriptId: l.scriptId });
      out.push(`${target} ${(scripts.get(l.scriptId) || '?').split('/').pop()}: ${scriptSource.split('\n')[l.lineNumber].trim()}`);
    }
  }
  await client.detach();
  return out.sort();
}

test('the rail adds no scroll listener of its own: the page keeps the scroll spy\'s and the progress bar\'s, and no other', async ({ page }) => {
  await open(page, 'kitchen-sink.md');
  // The two the page has always had. A new one fails here by its file and line; a reading aid that needs scrolling
  // belongs in the scroll spy's frame (navigation.js), as the rail's fill does.
  const known = [
    "window app.js: window.addEventListener('scroll', () => {",
    'window navigation.js: function mdvScrollSpySchedule() {',
  ];
  expect(await scrollListeners(page)).toEqual(known);
  const filler = 'Line of text that fills the section. '.repeat(30);
  for (let i = 0; i < 3; i++) {
    await renderSource(page, `# Report ${i}\n\nIntro.\n\n` + Array.from({ length: 12 }, (_, k) => `## Part ${k}\n\n${filler}\n`).join('\n'));
    await expect(page.locator('#mdBody .section-minimap')).toHaveCount(1);
    await readAt(page, 'part-5', 0.5);
    expect((await railState(page)).progress).toBeGreaterThan(0.4); // the fill still follows the reader
  }
  expect(await scrollListeners(page)).toEqual(known);
});

test('the fill restyles only the current segment as the reader scrolls, however many sections the rail has', async ({ page }) => {
  await open(page, 'kitchen-sink.md');
  const filler = 'Line of text that fills the section. '.repeat(40);
  await renderSource(page, '# Run log\n\nIntro.\n\n' + Array.from({ length: 120 }, (_, k) => `## Step ${k}\n\n${filler}\n\n${filler}\n`).join('\n'));
  await readAt(page, 'step-60', 0.2);
  // The jump made 60 segments read at once; let their transitions (a bar thickening) finish before measuring.
  await page.waitForFunction(() => document.querySelector('#mdBody .section-minimap').getAnimations({ subtree: true }).length === 0);
  const browser = page.context().browser();
  await browser.startTracing(page, { categories: ['devtools.timeline'] });
  const steps = [];
  for (let i = 0; i < 6; i++) {
    steps.push(await page.evaluate(async () => {
      window.scrollBy({ top: 12, behavior: 'instant' }); // the page scrolls smoothly otherwise
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const seg = document.querySelector('#mdBody .minimap-segment.active');
      return `${seg.dataset.targetId} ${getComputedStyle(seg).getPropertyValue('--p')}`;
    }));
  }
  const recalcs = JSON.parse((await browser.stopTracing()).toString()).traceEvents
    .filter((e) => e.name === 'UpdateLayoutTree' && e.args && typeof e.args.elementCount === 'number')
    .map((e) => e.args.elementCount);
  // Positive controls: the reader stayed in one section, its fill moved at every step, and the trace saw restyles.
  expect(new Set(steps.map((s) => s.split(' ')[0]))).toEqual(new Set(['step-60']));
  expect(new Set(steps).size).toBe(6);
  expect(recalcs.length).toBeGreaterThan(5);
  // The current segment and its two pseudo-elements, plus the page's progress bar: written on the rail, the fill
  // restyled every segment, 484 elements a frame with these 120.
  expect(Math.max(...recalcs), recalcs.join(' ')).toBeLessThan(20);
});

test('a jump to a section starts its fill at 0: the fill counts from where the jump lands the heading', async ({ page }) => {
  await open(page, 'kitchen-sink.md');
  await renderSource(page, handoff());
  await page.locator('#tocList .toc-link[data-target="decisions-taken"]').click();
  // The jump scrolls smoothly. Positive control: it puts the heading at the top of the reading area (the page's
  // scroll-padding-top, 112 px), above the reading line (270 px at this height), where the fill used to start counting.
  const top = () => page.$eval('#decisions-taken', (h) => Math.abs(h.getBoundingClientRect().top - 112) < 3);
  await expect.poll(top, { timeout: 10_000 }).toBe(true);
  await settled(() => page.evaluate(() => Math.round(window.scrollY)));
  const s = await railState(page);
  expect(s.active).toEqual(['decisions-taken']);
  expect(s.progress).toBeLessThan(0.02); // the reader has read nothing of it yet
  expect(s.passed).toBe(16); // the sections above it are filled: the rail shows where the reader is
});

test("in the label form too, the title's introduction is marked: a 'you are here' dot at the start of the next section's bar", async ({ page }) => {
  await open(page, 'kitchen-sink.md');
  const prose = 'The status of each part of the work, written by the agent that did it. '.repeat(20);
  await renderSource(page, `# Status report\n\n${prose}\n\n${prose}\n\n` + ['Done', 'Doing', 'Blocked', 'Next'].map((h) => `## ${h}\n\n${prose}\n\n${prose}\n`).join('\n'));
  await expect(page.locator('#mdBody .section-minimap')).not.toHaveClass(/is-track/); // four sections: the label form
  // Per segment: whether its background draws a dot (a radial gradient) whose colour is the accent.
  const dots = () => page.$$eval('#mdBody .minimap-segment', (segs) => segs.map((s) => {
    const image = getComputedStyle(s).backgroundImage;
    const at = image.indexOf('radial-gradient(');
    if (at < 0) return false;
    const colour = image.slice(at).match(/(?:rgba?|color|oklch|oklab|lab|lch|hsla?)\([^()]*\)/)[0];
    return window.mdvTestColor.dE(colour, getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()) < 2;
  }));
  await readAt(page, 'status-report', 0.5);
  const s = await railState(page);
  expect(s.outline).toBe('status-report'); // the outline marks the title
  expect(s.intro).toBe(true);
  expect(await dots()).toEqual([true, false, false, false]); // a dot in the accent, on the first section's bar
  await readAt(page, 'doing', 0.3);
  expect(await dots()).toEqual([false, false, false, false]); // in a section, the current segment says where
});

// ---------------------------------------------------------------------------------------------
// Diagram nodes that link to a section
// ---------------------------------------------------------------------------------------------
for (const theme of THEMES) {
  test(`a diagram node that links to a section: a quiet dotted underline at rest, the accent and a lift under the pointer, in the ${theme} theme`, async ({ page }) => {
    await open(page, 'kitchen-sink.md', theme);
    const node = page.locator('#mdBody .mdv-node-link[data-mdv-section="merge"]');
    await node.scrollIntoViewIfNeeded();
    const look = () => node.evaluate((n) => {
      const C = window.mdvTestColor;
      const label = n.querySelector('.nodeLabel');
      const shape = n.querySelector(':scope > rect, :scope > polygon, :scope > path');
      const cs = getComputedStyle(label);
      const fill = getComputedStyle(shape).fill;
      const root = getComputedStyle(document.documentElement);
      return {
        line: cs.textDecorationLine, style: cs.textDecorationStyle, cursor: getComputedStyle(n).cursor,
        labelContrast: C.contrast(cs.color, fill),
        strokeIsAccent: C.dE(getComputedStyle(shape).stroke, root.getPropertyValue('--accent').trim()) < 2,
        lifted: getComputedStyle(shape).filter.includes('drop-shadow(rgba') && getComputedStyle(shape).filter.split('drop-shadow').length > 2,
      };
    });
    await page.mouse.move(2, 2);
    const rest = await look();
    expect(rest.line).toBe('underline');
    expect(rest.style).toBe('dotted'); // was a solid underline, heavy inside a node
    expect(rest.cursor).toBe('pointer');
    expect(rest.strokeIsAccent).toBe(false);
    expect(rest.labelContrast).toBeGreaterThanOrEqual(4.5);
    await node.hover();
    await expect.poll(async () => (await look()).strokeIsAccent).toBe(true);
    const hover = await look();
    expect(hover.style).toBe('solid');
    expect(hover.lifted).toBe(true);
    expect(hover.labelContrast).toBeGreaterThanOrEqual(4.5);
    // The keyboard gets the same cue as the pointer: Tab from the node before it.
    await page.mouse.move(2, 2);
    await page.locator('#mdBody .mdv-node-link[data-mdv-section="capture"]').focus();
    await page.keyboard.press('Tab');
    await expect(node).toBeFocused();
    await expect.poll(async () => (await look()).strokeIsAccent).toBe(true);
  });
}

test("a linked class name keeps its underline, and a mind map's SVG label takes the link colour instead", async ({ page }) => {
  await open(page, 'kitchen-sink.md');
  await renderSource(page, [
    '# Linked', '', '```mermaid', 'classDiagram', '    class Draft', '    class Queued', '    Draft --> Queued', '```', '',
    '```mermaid', 'mindmap', '  root((Notes))', '    Draft', '```', '', '## Draft', '', 'Text.', '', '## Queued', '', 'Text.', '',
  ].join('\n'));
  await expect(page.locator('#mdBody .mdv-node-link')).toHaveCount(3);
  const r = await page.evaluate(() => {
    const C = window.mdvTestColor;
    const cls = document.querySelector('#mdBody .mermaid-wrapper[data-diagram-type="class"] .mdv-node-link');
    const label = cls.querySelector('.nodeLabel');
    const fo = cls.querySelector('foreignObject');
    // The underline sits below the label's 21 px box: it is drawn only because that box no longer clips it.
    const mind = document.querySelector('#mdBody .mermaid-wrapper[data-diagram-type="mindmap"] .mdv-node-link text');
    const root = getComputedStyle(document.documentElement);
    return {
      classStyle: getComputedStyle(label).textDecorationStyle, overflow: getComputedStyle(fo).overflow,
      mindFill: C.dE(getComputedStyle(mind).fill, root.getPropertyValue('--accent-strong').trim()),
    };
  });
  expect(r.classStyle).toBe('dotted');
  expect(r.overflow).toBe('visible');
  expect(r.mindFill).toBeLessThan(2);
});

// The inline link marks became drawn icons in an earlier change. The link card, the link tooltip and the links panel
// kept their glyphs (a star for GitHub, colour emoji for docs and files).
test("a link's mark is drawn, not a glyph: on a link card, in the link tooltip and in the links panel", async ({ page }) => {
  await open(page, 'kitchen-sink.md');
  // A mark is drawn when making its colour transparent changes the pixels of its tile (it is painted in currentColor).
  const drawnMark = async (icon) => {
    await page.mouse.move(2, 2);
    const shown = await icon.screenshot();
    await icon.evaluate((el) => { el.style.color = 'transparent'; });
    const hidden = await icon.screenshot();
    await icon.evaluate((el) => { el.style.color = ''; });
    return icon.evaluate((el, changed) => {
      const before = getComputedStyle(el, '::before');
      return { changed, glyph: el.textContent.trim(), glyphSize: getComputedStyle(el).fontSize,
               mask: before.maskImage || before.webkitMaskImage, inColour: window.mdvTestColor.dE(before.backgroundColor, getComputedStyle(el).color) < 1 };
    }, !shown.equals(hidden));
  };
  const cardIcon = page.locator('#mdBody a.link-chip .link-chip-icon').first();
  await cardIcon.scrollIntoViewIfNeeded();
  const card = await drawnMark(cardIcon);
  expect(card.glyph).toBe('\u2605'); // positive control: the star is still there for anything that reads the text
  expect(card.glyphSize).toBe('0px');
  expect(card.mask).toContain('url(');
  expect(card.inColour).toBe(true);
  expect(card.changed).toBe(true);

  const link = page.locator('#mdBody li a[data-link-type="file"]').first();
  await link.scrollIntoViewIfNeeded();
  await link.hover();
  await expect(page.locator('#linkTooltip')).toHaveClass(/visible/);
  const tipIcon = page.locator('#linkTooltipIcon');
  const tip = await tipIcon.evaluate((el) => {
    const before = getComputedStyle(el, '::before');
    return { glyph: el.textContent.trim(), glyphSize: getComputedStyle(el).fontSize, mask: before.maskImage || before.webkitMaskImage };
  });
  expect(tip.glyph).toBe('\u{1F4C4}'); // positive control: the tooltip shows a file link's (a page emoji)
  expect(tip.glyphSize).toBe('0px');
  expect(tip.mask).toBe(card.mask); // one drawn mark
  const shown = await tipIcon.screenshot();
  await tipIcon.evaluate((el) => { el.style.color = 'transparent'; });
  expect(shown.equals(await tipIcon.screenshot())).toBe(false);
  await tipIcon.evaluate((el) => { el.style.color = ''; });
  // The repository badge in the dashboard draws the same mark.
  expect(await page.$eval('#mdBody a.fm-repo-badge', (a) => { const b = getComputedStyle(a, '::before'); return b.maskImage || b.webkitMaskImage; })).toBe(card.mask);

  await page.mouse.move(2, 2);
  await page.locator('#linksPanelBtn').click();
  const titles = await page.$$eval('#linksPanelContent .links-panel-group-title', (ts) => ts.map((t) => t.firstChild.textContent.trim()));
  expect(titles.length).toBeGreaterThan(4); // positive control: the panel lists the sample's kinds of link
  for (const t of titles) expect(t).toMatch(/^[A-Za-z]+$/); // "GitHub", not "\u2605 GitHub"
  // The dashboard's repository badge is listed by its name: its star is not drawn on the page, so not in the panel.
  const items = await page.$$eval('#linksPanelContent .links-panel-item > span:first-child', (s) => s.map((x) => x.textContent));
  expect(items).toContain('sync-engine'); // positive control: the badge's link is listed (it was "\u2605 sync-engine")
  expect(items.filter((t) => t.includes('\u2605'))).toEqual([]);
});

// ---------------------------------------------------------------------------------------------
// Diagrams keep a legible size
// ---------------------------------------------------------------------------------------------
const diagramSizes = (page) => page.$$eval('#mdBody .mermaid-wrapper', (ws) => ws.map((w) => {
  const box = w.querySelector('pre.mermaid'); // the drawing's box, which scrolls sideways inside the card
  const svg = box.querySelector('svg');
  const natural = svg.viewBox.baseVal.width;
  const card = w.getBoundingClientRect();
  return {
    type: w.dataset.diagramType, natural, scale: svg.getBoundingClientRect().width / natural,
    scrolls: box.scrollWidth > box.clientWidth + 1, cardScrolls: w.scrollWidth > w.clientWidth + 1,
    left: card.left, right: card.right, width: card.width,
  };
}));

const columnBox = (page) => page.evaluate(() => {
  const body = document.getElementById('mdBody').getBoundingClientRect();
  const area = document.getElementById('contentWrapper').getBoundingClientRect();
  return { left: body.left, right: body.right, width: body.width, areaLeft: area.left, areaRight: area.right };
});

test('on a wide window a diagram much wider than the column uses the margins instead of shrinking, and the others keep the column', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, 'commented.md');
  const [wide] = await diagramSizes(page);
  const col = await columnBox(page);
  expect(wide.natural).toBeGreaterThan(1000);
  expect(wide.scale).toBeGreaterThan(0.85); // was 0.59: 8 px labels
  expect(wide.width).toBeGreaterThan(col.width * 1.2);
  expect(Math.abs((wide.left + wide.right) / 2 - (col.left + col.right) / 2)).toBeLessThan(1); // centred on the column
  expect(wide.left).toBeGreaterThanOrEqual(col.areaLeft);
  expect(wide.right).toBeLessThanOrEqual(col.areaRight);
  expect(wide.right).toBeLessThanOrEqual(1440 - 58); // clear of the floating scroll buttons (right: 20 px, 38 px wide)
  expect(wide.scrolls).toBe(false);
  // A drawing that fits is not faded.
  expect(await page.$eval('#mdBody pre.mermaid', (b) => getComputedStyle(b).maskImage || getComputedStyle(b).webkitMaskImage)).toBe('none');

  await open(page, 'diagram-gallery.md');
  let grown = 0;
  for (const d of await diagramSizes(page)) {
    // A card either lines up with the text or is at least a fifth wider than it (the journey grows).
    if (Math.abs(d.width - col.width) < 1) continue;
    expect(d.width, d.type).toBeGreaterThanOrEqual(col.width * 1.2 - 1);
    grown++;
  }
  expect(grown).toBeGreaterThan(0);
});

test("in the desktop app's window (1180 px), where the margins would make a card only a tenth wider, a wide diagram keeps the column", async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 860 });
  await open(page, 'commented.md');
  const [wide] = await diagramSizes(page);
  const col = await columnBox(page);
  expect(col.areaRight - col.areaLeft - 80).toBeLessThan(col.width * 1.2); // positive control: the room is under a fifth
  expect(wide.natural).toBeGreaterThan(col.width * 1.2); // and the drawing would use more
  expect(Math.abs(wide.width - col.width)).toBeLessThan(1); // it overhung the text by 36 px a side
  expect(wide.scrolls).toBe(false);
});

// On a laptop or a desktop nothing tells a reader that a drawing continues past its card, so a drawing there is always
// whole: it shrinks to fit, and the expand button shows it at full size. That holds when its column narrows after it
// was drawn: a sidebar opens, or the window shrinks.
test('on a laptop or a desktop a diagram is never cut off, at any width and after its column narrows', async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 860 }); // the desktop app's window
  await open(page, 'kitchen-sink.md');
  await renderSource(page, handoff());
  const cut = async (label) => {
    await waitForLayoutSettled(page);
    return page.$$eval('#mdBody .mermaid-wrapper', (ws, where) => ws.map((w) => {
      const box = w.querySelector('pre.mermaid');
      const hidden = box.scrollWidth - box.clientWidth;
      return hidden > 1 ? `${where}: ${w.dataset.diagramType} hides ${hidden} px` : null;
    }).filter(Boolean), label);
  };
  const deploy = await page.$eval('#mdBody .mermaid-wrapper[data-diagram-type="flowchart-v2"] pre.mermaid', (b) => b.querySelector('svg').viewBox.baseVal.width / b.clientWidth);
  expect(deploy).toBeGreaterThan(3); // positive control: the pipeline is over three times as wide as its card
  expect(await cut('1180')).toEqual([]);
  await page.evaluate(() => mdvToggleSidebar(true)); // the comments sidebar narrows the column to about 500 px
  expect(await page.$eval('#mdBody', (b) => b.getBoundingClientRect().width)).toBeLessThan(560);
  expect(await cut('1180, comments open')).toEqual([]);
  await page.evaluate(() => mdvToggleSidebar(false));
  for (const width of [1366, 1000, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await cut(String(width))).toEqual([]);
  }
});

// A section change while scrolling lays the page out again, so nothing may make that layout dearer. A size container
// around the document (container-type), with the diagram cards sized against it, made each layout about four times as
// dear in Chrome (0.53 against 0.13 ms on a 27-section handoff with nine diagrams). The cards get their room from
// mermaid.js instead, and still use the margins.
test('the room a wide diagram card uses is measured, not queried: nothing around the document is a size container', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, 'commented.md');
  const [wide] = await diagramSizes(page);
  const col = await columnBox(page);
  expect(wide.width).toBeGreaterThan(col.width * 1.2); // positive control: a card uses the margins here
  expect(await page.$$eval('body *', (els) => els.filter((el) => (el.contains(document.getElementById('mdBody')) || el.closest('#mdBody'))
    && getComputedStyle(el).containerType !== 'normal').map((el) => el.id || el.className))).toEqual([]);
});

test('on a laptop, a Gantt chart drawn before the comments sidebar opens shrinks with its column', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page, 'diagram-gallery.md');
  const gantt = () => page.$eval('#mdBody .mermaid-wrapper[data-diagram-type="gantt"] pre.mermaid', (b) => ({
    hidden: b.scrollWidth - b.clientWidth, drawn: b.querySelector('svg').getBoundingClientRect().width, box: b.clientWidth,
  }));
  const before = await gantt();
  await page.evaluate(() => mdvToggleSidebar(true));
  await waitForLayoutSettled(page);
  const after = await gantt();
  expect(after.box).toBeLessThan(before.drawn); // positive control: the column became narrower than the drawing
  expect(after.hidden).toBeLessThanOrEqual(1); // it hid 96 px, its last section among them
  expect(after.drawn).toBeLessThanOrEqual(after.box + 1);
});

test('printed, a wide diagram shrinks to fit the page, since paper cannot scroll', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, 'commented.md');
  const state = () => page.$eval('#mdBody .mermaid-wrapper', (w) => {
    const box = w.querySelector('pre.mermaid');
    return { scrolls: box.scrollWidth > box.clientWidth + 1, card: w.getBoundingClientRect().width,
             column: document.getElementById('mdBody').getBoundingClientRect().width };
  });
  expect((await state()).scrolls).toBe(true); // positive control: on a phone's screen it stops at its floor
  await page.emulateMedia({ media: 'print' });
  const r = await state();
  expect(r.scrolls).toBe(false);
  expect(Math.abs(r.card - r.column)).toBeLessThan(1);
});

test.describe('at phone width', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('a diagram never shrinks below 70 % of its size: it scrolls sideways in its card instead, fading out at the side it continues to', async ({ page }) => {
    await open(page, 'diagram-gallery.md');
    const sizes = await diagramSizes(page);
    expect(sizes.length).toBe(14);
    let scrolling = 0;
    for (const d of sizes) {
      expect(d.scale, d.type).toBeGreaterThanOrEqual(0.69); // was 0.32 to 0.56 for nine of them
      expect(d.left, d.type).toBeGreaterThanOrEqual(0);
      expect(d.right, d.type).toBeLessThanOrEqual(390);
      expect(d.cardScrolls, d.type).toBe(false); // the drawing scrolls; the card, its label and its button stay put
      if (d.scrolls) scrolling++;
    }
    expect(scrolling).toBeGreaterThan(5);
    // The cue follows the scroll position: a fade at the end still to come, then at the start once scrolled there.
    const cue = await page.evaluate(async () => {
      const box = document.querySelector('#mdBody .mermaid-wrapper[data-diagram-type="journey"] pre.mermaid');
      const mask = () => getComputedStyle(box).maskImage || getComputedStyle(box).webkitMaskImage;
      const frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const start = mask();
      box.scrollLeft = box.scrollWidth;
      await frames();
      const end = mask();
      box.scrollLeft = box.scrollWidth / 3;
      await frames();
      return { start, end, middle: mask() };
    });
    expect(cue.start).toContain('linear-gradient(to right');
    expect(cue.end).toContain('linear-gradient(to left');
    expect(cue.middle.match(/transparent|rgba\(0, 0, 0, 0\)/g).length).toBe(2); // both sides
  });

  test("a Gantt chart's date labels and task names do not run into each other", async ({ page }) => {
    await open(page, 'diagram-gallery.md');
    const r = await page.$eval('#mdBody .mermaid-wrapper[data-diagram-type="gantt"] .mermaid svg', (svg) => {
      const texts = [...svg.querySelectorAll('text')].filter((t) => t.textContent.trim())
        .map((t) => ({ t: t.textContent.trim(), b: t.getBoundingClientRect() })).filter((x) => x.b.width);
      const out = [];
      for (let i = 0; i < texts.length; i++) {
        for (let j = i + 1; j < texts.length; j++) {
          const a = texts[i].b, b = texts[j].b;
          const w = Math.min(a.right, b.right) - Math.max(a.left, b.left), h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
          if (w > 1 && h > 1) out.push(`${texts[i].t} / ${texts[j].t}`);
        }
      }
      return { ticks: svg.querySelectorAll('.tick text').length, out };
    });
    expect(r.ticks).toBeGreaterThan(4); // positive control: the probe found the axis labels
    expect(r.out).toEqual([]);
  });

  test("an XY chart's axis title clears its tick labels, as it does on a wide screen", async ({ page }) => {
    await open(page, 'diagram-gallery.md');
    const r = await page.$eval('#mdBody .mermaid-wrapper[data-diagram-type="xychart"] .mermaid svg', (svg) => {
      const texts = [...svg.querySelectorAll('text')];
      const title = texts.find((t) => t.textContent.trim() === 'Words').getBoundingClientRect();
      const ticks = texts.filter((t) => /^\d+$/.test(t.textContent.trim())).map((t) => t.getBoundingClientRect());
      return { ticks: ticks.length, gap: Math.min(...ticks.map((b) => b.left)) - title.right };
    });
    expect(r.ticks).toBeGreaterThan(4); // positive control: the probe found the tick labels
    expect(r.gap).toBeGreaterThan(2); // it ran over the tick labels: Mermaid measured them on a drawing shrunk to the window
  });

  test('the page does not widen while a diagram is drawn: Mermaid\'s 1,600 px scratch area is out of its flow', async ({ page }) => {
    await open(page, 'kitchen-sink.md');
    await page.evaluate(() => {
      window.__mdvDrawWidths = [];
      new MutationObserver(() => {
        if (document.querySelector('body > div[id^="dmdv-mermaid-"]')) window.__mdvDrawWidths.push(document.documentElement.scrollWidth);
      }).observe(document.body, { childList: true });
    });
    await page.evaluate(() => setTheme('dark')); // every diagram is drawn again, in the new palette
    await page.waitForFunction(() => [...document.querySelectorAll('#mdBody .mermaid')].every((el) => (el.dataset.mdvPalette || '').startsWith('dark|')));
    const widths = await page.evaluate(() => window.__mdvDrawWidths);
    expect(widths.length).toBeGreaterThanOrEqual(3); // positive control: the probe saw the scratch area during the draws
    expect(Math.max(...widths)).toBeLessThanOrEqual(390); // it was 1,600 at every draw
  });

  test('a diagram that scrolls sideways is a keyboard stop in every engine, and its focus ring is drawn around its card', async ({ page }) => {
    await open(page, 'diagram-gallery.md');
    const boxes = await page.$$eval('#mdBody .mermaid-wrapper pre.mermaid', (ps) => ps.map((p) => ({
      type: p.closest('.mermaid-wrapper').dataset.diagramType, scrolls: p.scrollWidth > p.clientWidth + 1,
      tab: p.getAttribute('tabindex'), role: p.getAttribute('role'), label: p.getAttribute('aria-label'),
    })));
    expect(boxes.filter((b) => b.scrolls).length).toBeGreaterThan(5); // positive controls: some scroll, some do not
    expect(boxes.filter((b) => !b.scrolls).length).toBeGreaterThan(0);
    for (const b of boxes) {
      // WebKit (the Mac app) only stops on a scroller with a tabindex; Chrome stops on one by itself.
      expect(b.tab, b.type).toBe(b.scrolls ? '0' : null);
      expect(b.role, b.type).toBe(b.scrolls ? 'group' : null);
      if (b.scrolls) expect(b.label, b.type).toMatch(/, scrolls sideways$/);
    }

    // Tab from the journey's expand button onto its drawing: the ring shows in the strip just left of the card. The
    // drawing's fade masks its own ring, so before there was nothing to see.
    const card = page.locator('#mdBody .mermaid-wrapper[data-diagram-type="journey"]');
    await card.scrollIntoViewIfNeeded();
    const box = await card.boundingBox();
    const strip = () => page.screenshot({ clip: { x: box.x - 5, y: box.y + 50, width: 4, height: 40 } });
    await card.locator('.diagram-expand-btn').focus();
    const unfocused = await strip();
    await page.keyboard.press('Tab');
    await expect(card.locator('pre.mermaid')).toBeFocused();
    expect((await card.boundingBox()).y).toBe(box.y); // positive control: the page did not move
    expect((await strip()).equals(unfocused)).toBe(false);
    // The arrow keys then scroll the drawing.
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => card.locator('pre.mermaid').evaluate((b) => b.scrollLeft)).toBeGreaterThan(0);

    // On a wide screen nothing scrolls, so no drawing is a stop: the observer takes the marks off as the page widens.
    await page.setViewportSize({ width: 1366, height: 900 });
    await expect.poll(() => page.$$eval('#mdBody pre.mermaid[tabindex]', (ps) => ps.length)).toBe(0);
  });

  // A guard over every sample: nothing in the document or the toolbar reaches past the side of the screen. Something
  // inside a box that scrolls or clips sideways (a table, a code block, a diagram's card) is that box's business, so
  // the box is checked instead.
  for (const sample of SAMPLES) {
    test(`nothing in ${sample} runs off the side of a phone screen`, async ({ page }) => {
      await open(page, sample);
      const r = await page.evaluate(() => {
        const width = window.innerWidth;
        const inClip = (el) => {
          for (let e = el.parentElement; e && e !== document.body; e = e.parentElement) {
            if (getComputedStyle(e).overflowX !== 'visible') return true;
          }
          return false;
        };
        const out = [];
        let checked = 0;
        for (const el of document.querySelectorAll('#mdBody *, .toolbar *')) {
          if (!el.getClientRects().length || inClip(el)) continue;
          checked++;
          const b = el.getBoundingClientRect();
          if (b.right > width + 0.5 || b.left < -0.5) out.push(`${el.localName}.${[...el.classList].join('.')} [${Math.round(b.left)}, ${Math.round(b.right)}]`);
        }
        return { page: document.documentElement.scrollWidth, width, out, checked };
      });
      expect(r.checked).toBeGreaterThan(20); // positive control: the probe saw the page
      expect(r.page).toBeLessThanOrEqual(r.width);
      expect(r.out).toEqual([]);
    });
  }
});

// ---------------------------------------------------------------------------------------------
// A guard over every sample and theme: body text and links meet WCAG AA on what they are drawn on
// ---------------------------------------------------------------------------------------------
// Every element of the document that holds text of its own, measured as drawn: its computed colour against the
// colour under it (its own background and its ancestors', translucent layers composited from the page up). Large
// text (24 px, or 18.66 px bold) needs 3:1, everything else 4.5:1. Diagram labels have their own tests; code blocks
// are measured by the syntax-colour test in visuals.spec.mjs.
for (const theme of THEMES) {
  test(`body text and links meet WCAG AA on what they are drawn on, in every sample, in the ${theme} theme`, async ({ page }) => {
    const failures = [];
    let checked = 0, links = 0;
    for (const sample of SAMPLES) {
      await open(page, sample, theme);
      const r = await page.evaluate(() => {
        const C = window.mdvTestColor;
        const shown = (el) => {
          if (!el.getClientRects().length) return false;
          for (let e = el; e; e = e.parentElement) {
            const cs = getComputedStyle(e);
            if (cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
          }
          return true;
        };
        const under = (el) => {
          const layers = [];
          for (let e = el; e; e = e.parentElement) layers.push(getComputedStyle(e).backgroundColor);
          let acc = C.rgb(getComputedStyle(document.body).backgroundColor);
          for (const layer of layers.reverse()) acc = C.rgb(layer, `rgb(${acc.join(',')})`);
          return acc;
        };
        const out = [];
        let n = 0, a = 0;
        for (const el of document.querySelectorAll('#mdBody *')) {
          if (el.closest('.mermaid-wrapper, pre, .katex, svg')) continue;
          if (![...el.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim())) continue;
          if (!shown(el)) continue;
          const cs = getComputedStyle(el);
          const bg = under(el);
          const fg = C.rgb(cs.color, `rgb(${bg.join(',')})`);
          const size = parseFloat(cs.fontSize), weight = Number(cs.fontWeight) || 400;
          const need = size >= 24 || (size >= 18.66 && weight >= 700) ? 3 : 4.5;
          const ratio = C.contrast(fg, bg);
          n++;
          if (el.localName === 'a') a++;
          if (ratio < need) out.push(`${el.localName}.${[...el.classList].join('.')} "${el.textContent.trim().slice(0, 30)}": ${ratio.toFixed(2)} < ${need}`);
        }
        return { out, n, a };
      });
      failures.push(...r.out.map((f) => `${sample}: ${f}`));
      checked += r.n;
      links += r.a;
    }
    // Positive controls: the probe measured the samples' text, links included. Measured on 2026-10-11 over the four
    // samples: 210 text elements and 14 links in each theme (the floors leave room for edits to the samples).
    expect(checked, `${checked} elements`).toBeGreaterThan(150);
    expect(links, `${links} links`).toBeGreaterThan(10);
    expect(failures).toEqual([]);
  });
}
