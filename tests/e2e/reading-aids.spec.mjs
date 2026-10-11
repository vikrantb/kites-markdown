// Reading aids: section folding, narration, the outline and scroll spy, search, the keyboard shortcuts,
// the dialogs (search, shortcuts sheet, image lightbox) and the read-aloud player.
// Read-aloud runs against a fake speechSynthesis that behaves like Chrome's where it matters: cancel()
// reports 'interrupted' for the utterance being spoken a moment later, and it does not clear the
// paused flag. No audio is produced. Setting window.__speechRefuse to an error name ('not-allowed') makes
// it refuse every utterance with that error, as a browser does before the first user gesture.
import { test, expect } from '@playwright/test';
import { largeDocument } from '../../scripts/large-document.mjs';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function installSpeechStub() {
  const log = { started: [], ended: [], interrupted: [], refused: [] };
  window.__speech = log;
  let queue = [], current = null, paused = false, timer = null;
  const duration = () => window.__speechDuration || 60; // ms per utterance
  const finish = (u) => {
    if (current !== u) return;
    current = null;
    log.ended.push(u.text);
    if (u.onend) u.onend({ utterance: u });
    pump();
  };
  const pump = () => {
    if (current || paused || !queue.length) return;
    const u = current = queue.shift();
    log.started.push(u.text);
    timer = setTimeout(() => finish(u), duration());
  };
  const synth = {
    get speaking() { return !!current; },
    get paused() { return paused; },
    get pending() { return queue.length > 0; },
    speak(u) {
      if (window.__speechRefuse) {
        log.refused.push(u.text);
        setTimeout(() => u.onerror && u.onerror({ error: window.__speechRefuse }), 0);
        return;
      }
      queue.push(u); pump();
    },
    cancel() {
      const dropped = queue; queue = [];
      dropped.forEach(u => setTimeout(() => u.onerror && u.onerror({ error: 'canceled' }), 0));
      if (current) {
        const u = current; current = null; clearTimeout(timer);
        log.interrupted.push(u.text);
        setTimeout(() => u.onerror && u.onerror({ error: 'interrupted' }), 0);
      }
    },
    pause() { paused = true; clearTimeout(timer); },
    resume() {
      paused = false;
      if (current) { const u = current; timer = setTimeout(() => finish(u), duration()); } else pump();
    },
    getVoices() { return []; },
  };
  Object.defineProperty(window, 'speechSynthesis', { configurable: true, get: () => synth });
  window.SpeechSynthesisUtterance = function (text) { this.text = text; this.rate = 1; };
}

function countObservers() {
  const Native = window.IntersectionObserver;
  const stats = { created: 0, disconnected: 0 };
  window.__observers = stats;
  window.IntersectionObserver = class extends Native {
    constructor(cb, o) { super(cb, o); stats.created++; this.__live = true; }
    disconnect() { if (this.__live) { stats.disconnected++; this.__live = false; } return super.disconnect(); }
  };
}

async function openViewer(page, { theme = 'light', speech = true, observers = false } = {}) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript((t) => { try { localStorage.setItem('mdv-theme', t); } catch (_) {} }, theme);
  if (speech) await page.addInitScript(installSpeechStub);
  if (observers) await page.addInitScript(countObservers);
  await page.goto('markdown-viewer.html');
  await page.waitForFunction(() => typeof renderMarkdown === 'function');
  return errors;
}

async function render(page, source, title = 'test.md') {
  await page.evaluate(([s, t]) => renderMarkdown(s, t), [source, title]);
  // The comment layer and the scroll spy finish on a timer and the next frame.
  await page.waitForTimeout(120);
}

const key = (page, init) => page.evaluate((i) => {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...i });
  (document.activeElement || document.body).dispatchEvent(e);
  return e.defaultPrevented;
}, init);

const frames = (page) => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));

// ---------------------------------------------------------------------------------------------------
// Section folding: comments stay with their blocks (roadmap issue 12)
// ---------------------------------------------------------------------------------------------------

const NARRATED = `# Guide

Intro paragraph.

## Diagrams

<!-- narrate: The flow goes from A to B. -->

\`\`\`mermaid
graph LR
  A --> B
\`\`\`

### Nested table

<!-- narrate: The table lists two owners. -->

| Owner | Area |
|---|---|
| Ana | Storage |

## Plain

Some text.
`;

test('narration before a diagram or a table under a heading is read aloud (issue 12)', async ({ page }) => {
  const errors = await openViewer(page);
  await render(page, NARRATED);
  const sections = await page.evaluate(() => { ttsToggle(); return ttsSections.map(s => s.items.join(' | ')); });
  const all = sections.join('\n');
  expect(all).toContain('The flow goes from A to B.');
  expect(all).toContain('The table lists two owners.');
  // The table's own cells are not read when it has a narration.
  expect(all).not.toContain('Ana, Storage');
  expect(errors).toEqual([]);
});

// A narration, and a diagram, table or code block, inside every kind of container. The diagram labels are
// star names, so a label read aloud is easy to spot.
const CONTAINERS = [
  '# Narrations', '',
  '<!-- narrate: N1 top-level diagram. -->', '', '```mermaid', 'graph LR', '  A1[Kaus] --> B1[Lesath]', '```', '',
  '<!-- narrate: N2 top-level table. -->', '', '| A | B |', '|---|---|', '| 1 | 2 |', '',
  '## Containers', '',
  '<details><summary>Architecture</summary>', '', '<!-- narrate: N3 diagram in details. -->', '',
  '```mermaid', 'graph LR', '  K3[Pyxis] --> L3[Rigel]', '```', '', '</details>', '',
  '<details><summary>Owners</summary>', '', '<!-- narrate: N4 table in details. -->', '',
  '| Owner | Area |', '|---|---|', '| Ana | Storage |', '', '</details>', '',
  '- A list item with a diagram:', '', '  <!-- narrate: N5 diagram in a list item. -->', '',
  '  ```mermaid', '  graph LR', '    P5[Sirius] --> R5[Tarazed]', '  ```', '',
  '- A list item with a table:', '', '  <!-- narrate: N6 table in a list item. -->', '',
  '  | X | Y |', '  |---|---|', '  | 7 | 8 |', '',
  '> [!NOTE]', '> A callout with a table:', '>', '> <!-- narrate: N7 table in a callout. -->', '>',
  '> | Key | Value |', '> |---|---|', '> | kk | vv |', '',
  '> A quote with a diagram:', '>', '> <!-- narrate: N8 diagram in a quote. -->', '>',
  '> ```mermaid', '> graph LR', '>   S8[Vega] --> T8[Wezen]', '> ```', '',
  '1. Outer item', '   - Inner item with a diagram:', '', '     <!-- narrate: N9 diagram in a nested list. -->', '',
  '     ```mermaid', '     graph LR', '       U9[Alnair] --> V9[Yildun]', '     ```', '',
  '## Unnarrated', '',
  '<details><summary>Plain diagram</summary>', '', '```mermaid', 'graph LR', '  X10[Zaniah] --> Y10[Mirach]', '```', '', '</details>', '',
  '- Code in a list:', '', '  ```json', '  { "nested": true }', '  ```', '',
  'An inline icon <svg width="12" height="12"><style>.dot { fill: tomato; }</style><circle class="dot" cx="6" cy="6" r="5"/></svg> inside a sentence.', '',
].join('\n');

test('a narration is read wherever it is, and a nested diagram is never read as its stylesheet or labels', async ({ page }) => {
  const errors = await openViewer(page);
  await render(page, CONTAINERS);
  // The player is opened after Mermaid has drawn every diagram: the SVGs hold a <style> and the labels.
  await page.waitForFunction(() => [...document.querySelectorAll('#mdBody .mermaid')].every(m => m.querySelector('svg')), null, { timeout: 30_000 });
  const all = await page.evaluate(() => { ttsToggle(); return ttsSections.map(s => s.items.join('\n')).join('\n'); });
  for (let i = 1; i <= 9; i++) expect(all, `narration N${i}`).toContain(`N${i} `);
  for (const label of ['Kaus', 'Pyxis', 'Rigel', 'Sirius', 'Vega', 'Alnair', 'Zaniah', 'Mirach']) expect(all).not.toContain(label);
  expect(all).not.toMatch(/font-family|#mermaid|fill:/);
  // A narrated table is not also read cell by cell; a nested code block is announced, not spelled out.
  for (const cells of ['Ana, Storage', '7, 8', 'kk, vv']) expect(all).not.toContain(cells);
  expect(all).toContain('Code block in json.');
  expect(all).not.toContain('"nested"');
  // An SVG's <style> is not prose either, in read-aloud or in search.
  expect(all).toContain('An inline icon inside a sentence.');
  expect(all).not.toContain('tomato');
  expect(await page.evaluate(() => mdvSearchIndex().some(e => e.lower.includes('tomato')))).toBe(false);
  expect(errors).toEqual([]);
});

test('the kitchen sink narration under "Sync flow" is found', async ({ page }) => {
  await openViewer(page);
  await page.goto('markdown-viewer.html?file=samples/kitchen-sink.md');
  await page.waitForSelector('#mdBody h2');
  const sync = await page.evaluate(() => { ttsToggle(); return ttsSections.find(s => s.heading === 'Sync flow')?.items.join(' '); });
  expect(sync).toContain('This sequence diagram shows a client reconnecting');
});

test('a comment thread inside a section is attached to its own paragraph, not the next heading', async ({ page }) => {
  await openViewer(page);
  const payload = { version: 1, generator: 'mdv-viewer', comments: [{ id: 'cm_t1', parent_id: null,
    anchor: { id: 'c_inside', blockKind: 'p', blockHash: '0', sibIdx: 1, quote: null },
    author: { name: 'Reviewer', kind: 'human' }, body_md: 'Is this right?', created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-01T00:00:00Z', status: 'open' }] };
  await render(page, `# Plan\n\nFirst paragraph.\n\n## Steps\n\nStep one.\n\n<!-- MDV-ANCHOR id="c_inside" -->\nStep two is the anchored one.\n\n## Next\n\nAfter.\n\n<!-- MDV-COMMENTS:v1\n${JSON.stringify(payload)}\nMDV-COMMENTS:end -->\n`);
  await page.waitForSelector('#mdBody .mdv-chip', { timeout: 10_000 });
  const host = await page.evaluate(() => {
    const chip = document.querySelector('#mdBody .mdv-chip');
    return { tag: chip.parentElement.tagName, text: chip.parentElement.textContent };
  });
  expect(host.tag).toBe('P');
  expect(host.text).toContain('Step two is the anchored one.');
});

test('folding leaves no long runs of stranded text and comment nodes', async ({ page }) => {
  await openViewer(page);
  await render(page, largeDocument(300));
  const longest = await page.evaluate(() => {
    const body = document.getElementById('mdBody');
    let longest = 0;
    for (const parent of [body, ...body.querySelectorAll('.section-content')]) {
      let run = 0;
      for (const n of parent.childNodes) { run = n.nodeType === 1 ? 0 : run + 1; longest = Math.max(longest, run); }
    }
    return longest;
  });
  // Between two blocks there is at most a newline, a comment and a newline.
  expect(longest).toBeLessThanOrEqual(3);
});

test('re-rendering a 3,000-section document costs about what the first render costs', async ({ page }) => {
  await openViewer(page);
  const ms = await page.evaluate((src) => {
    const t0 = performance.now(); renderMarkdown(src, 'large.md');
    const t1 = performance.now(); renderMarkdown(src, 'large.md');
    return [t1 - t0, performance.now() - t1];
  }, largeDocument(3000));
  // Before the folding fix the second render took about five times as long as the first.
  expect(ms[1], `first ${Math.round(ms[0])} ms, second ${Math.round(ms[1])} ms`).toBeLessThan(ms[0] * 2);
});

test('the H1 folds even when the section minimap sits between it and its section', async ({ page }) => {
  await openViewer(page);
  await render(page, '# Title\n\nLead.\n\n## One\n\nA.\n\n## Two\n\nB.\n\n## Three\n\nC.\n');
  expect(await page.locator('#mdBody .section-minimap').count()).toBe(1);
  const toggle = page.locator('#mdBody h1 .section-toggle');
  await toggle.click();
  await expect(page.locator('#mdBody h2', { hasText: 'One' })).toBeHidden();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await expect(page.locator('#mdBody h2', { hasText: 'One' })).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
});

// ---------------------------------------------------------------------------------------------------
// Observers, outline and scroll spy
// ---------------------------------------------------------------------------------------------------

test('re-rendering leaves no IntersectionObserver alive in the reading aids', async ({ page }) => {
  await openViewer(page, { observers: true });
  // Two h2 sections: no minimap (it needs three), so every observer would be the reading aids' own.
  for (let i = 0; i < 5; i++) await render(page, '# T\n\n## A\n\nx\n\n## B\n\ny\n');
  const s = await page.evaluate(() => window.__observers);
  expect(s.created - s.disconnected).toBe(0);
});

const LONG = Array.from({ length: 12 }, (_, i) => `## Part ${i + 1}\n\n${'Line of text that fills the section. '.repeat(60)}\n`).join('\n');

test('the outline follows the reader down, back up, and to the end', async ({ page }) => {
  await openViewer(page);
  await render(page, '# Long\n\n' + LONG);
  const active = () => page.evaluate(() => document.querySelector('#tocList .toc-link.active')?.textContent);
  // The viewer scrolls smoothly; the test jumps.
  const jump = (y) => page.evaluate((top) => window.scrollTo({ top, behavior: 'instant' }), y);
  await jump(await page.evaluate(() => document.getElementById('part-6').getBoundingClientRect().top + scrollY - 100));
  await frames(page);
  expect(await active()).toBe('Part 6');
  expect(await page.textContent('#breadcrumb')).toBe('Part 6');
  // Back up into the middle of Part 5: Part 6's heading is now below the reading line.
  await jump(await page.evaluate(() => scrollY - innerHeight * 0.6));
  await frames(page);
  expect(await active()).toBe('Part 5');
  await jump(await page.evaluate(() => document.documentElement.scrollHeight));
  await frames(page);
  expect(await active()).toBe('Part 12');
  await expect(page.locator('#tocList .toc-link.active')).toHaveAttribute('aria-current', 'location');
});

const activeEntry = (page) => page.evaluate(() => document.querySelector('#tocList .toc-link.active')?.textContent);

test('the outline reaches short final sections at the bottom; a page too short to scroll starts at its top', async ({ page }) => {
  await openViewer(page);
  const parts = Array.from({ length: 10 }, (_, i) => `## Part ${i + 1}\n\n${'Line of text that fills the section. '.repeat(60)}\n`).join('\n');
  await render(page, `# Long\n\n${parts}\n## Tail A\n\nShort.\n\n## Tail B\n\nShort.\n\n## Tail C\n\nShort.\n`);
  await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }));
  await frames(page);
  // None of the three short tails can reach the reading line; the last one on screen is current.
  expect(await activeEntry(page)).toBe('Tail C');
  // A note that fits in the window: the reading line decides, as at the top of any page.
  await render(page, `# Alpha\n\n${'A short paragraph.\n\n'.repeat(6)}## Beta\n\nEnd.\n`);
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(true);
  expect(await page.evaluate(() => document.getElementById('beta').getBoundingClientRect().top > Math.max(80, innerHeight * 0.3))).toBe(true);
  await frames(page);
  expect(await activeEntry(page)).toBe('Alpha');
  expect(await page.textContent('#breadcrumb')).toBe('Alpha');
});

test('a heading inside a closed <details> never becomes the current heading', async ({ page }) => {
  await openViewer(page);
  const lines = Array.from({ length: 30 }, (_, i) => `Line ${i + 1} of the section.`).join('\n\n');
  await render(page, `# Doc\n\n## Before\n\n${lines}\n\n<details><summary>More options</summary>\n\n### Hidden option\n\nHidden text.\n\n</details>\n\n${'Text after the details.\n\n'.repeat(4)}## After\n\n${lines}\n`);
  // The summary sits just above the reading line (270 px), and so does the box Chrome reports for the
  // hidden heading inside the closed element.
  await page.evaluate(() => {
    const s = document.querySelector('#mdBody summary');
    window.scrollTo({ top: s.getBoundingClientRect().top + scrollY - 150, behavior: 'instant' });
  });
  await frames(page);
  expect(await page.evaluate(() => document.querySelector('#mdBody details').open)).toBe(false);
  expect(await activeEntry(page)).toBe('Before');
  expect(await page.textContent('#breadcrumb')).toBe('Before');
});

test('a hidden outline is out of the Tab order, wide and narrow', async ({ page }) => {
  await openViewer(page);
  await render(page, '# Guide\n\n## One\n\nText.\n\n## Two\n\nText.\n');
  const toc = page.locator('#tocSidebar');
  const inert = () => toc.evaluate(t => t.inert);
  // An inert link cannot take the focus.
  const linkFocusable = () => page.evaluate(() => { const a = document.querySelector('#tocList a'); a.focus(); const ok = document.activeElement === a; a.blur(); return ok; });
  expect(await inert()).toBe(false);
  expect(await linkFocusable()).toBe(true);
  await page.keyboard.press('Control+KeyB');
  expect(await inert()).toBe(true);
  expect(await linkFocusable()).toBe(false);
  await page.keyboard.press('Control+KeyB');
  expect(await inert()).toBe(false);
  // At 800 px the outline is off-canvas until it slides in; Esc slides it out.
  await page.setViewportSize({ width: 800, height: 900 });
  await expect.poll(inert).toBe(true);
  await page.keyboard.press('Control+KeyB');
  expect(await inert()).toBe(false);
  await page.keyboard.press('Escape');
  expect(await inert()).toBe(true);
});

test('headings are named by their own words, and each fold button after its section', async ({ page }) => {
  await openViewer(page);
  await render(page, '# Notes\n\n## C# tips\n\nUse records.\n');
  await expect(page.getByRole('heading', { level: 2, name: 'C# tips', exact: true })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Toggle section: C# tips', exact: true })).toHaveCount(1);
  // Chrome's own accessibility tree agrees.
  const cdp = await page.context().newCDPSession(page);
  const { result } = await cdp.send('Runtime.evaluate', { expression: 'document.querySelector("#mdBody h2")' });
  const { node } = await cdp.send('DOM.describeNode', { objectId: result.objectId });
  const { nodes } = await cdp.send('Accessibility.getPartialAXTree', { backendNodeId: node.backendNodeId, fetchRelatives: false });
  expect(nodes[0].name.value).toBe('C# tips');
});

test('Tab from a heading never lands on its invisible "#" permalink', async ({ page }) => {
  await openViewer(page);
  await render(page, '# Long\n\n' + LONG);
  await page.locator('#tocList .toc-link', { hasText: 'Part 3' }).click();
  expect(await page.evaluate(() => document.activeElement.id)).toBe('part-3');
  await page.keyboard.press('Tab'); // the heading's fold button
  expect(await page.evaluate(() => document.activeElement.getAttribute('aria-label'))).toBe('Toggle section: Part 3');
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => document.activeElement.className)).not.toContain('header-anchor');
  const anchors = page.locator('#mdBody .header-anchor');
  expect(await anchors.count()).toBeGreaterThan(10);
  await expect(page.locator('#mdBody .header-anchor:not([tabindex="-1"])')).toHaveCount(0);
});

test('a "#" the author wrote stays in the outline, the breadcrumb, search and read-aloud', async ({ page }) => {
  await openViewer(page);
  await render(page, '# Notes\n\n## C# tips\n\nUse records.\n');
  expect(await page.locator('#tocList .toc-link').nth(1).textContent()).toBe('C# tips');
  expect(await page.evaluate(() => { ttsToggle(); return ttsSections.map(s => s.heading); })).toContain('C# tips');
  await page.keyboard.press('Control+KeyK');
  await page.keyboard.type('C#');
  await expect(page.locator('#searchResults .search-result-item').first()).toHaveText('## C# tips');
});

test('after a document without headings, the next document shows its outline again', async ({ page }) => {
  await openViewer(page);
  await render(page, 'Just a paragraph, no headings.\n');
  await expect(page.locator('#tocSidebar')).toHaveClass(/hidden/);
  await render(page, '# Title\n\n## Part\n\nText.\n');
  await expect(page.locator('#tocSidebar')).not.toHaveClass(/hidden/);
});

test('an outline link moves the keyboard focus to its heading and unfolds it', async ({ page }) => {
  await openViewer(page);
  await render(page, '# Long\n\n' + LONG);
  await page.evaluate(() => toggleAllSections());
  await page.locator('#tocList .toc-link', { hasText: 'Part 9' }).click();
  await expect(page.locator('#part-9')).toBeVisible();
  expect(await page.evaluate(() => document.activeElement.id)).toBe('part-9');
});

// ---------------------------------------------------------------------------------------------------
// Keyboard shortcuts
// ---------------------------------------------------------------------------------------------------

test('shortcuts work with Caps Lock, Shift, Cmd and non-Latin layouts, and leave browser shortcuts alone', async ({ page }) => {
  await openViewer(page);
  await render(page, '# T\n\n## A\n\nx\n\n## B\n\ny\n');
  const searchOpen = () => page.evaluate(() => document.getElementById('searchOverlay').classList.contains('show'));
  // Caps Lock on: Ctrl+K arrives as "K".
  expect(await key(page, { key: 'K', code: 'KeyK', ctrlKey: true })).toBe(true);
  expect(await searchOpen()).toBe(true);
  await key(page, { key: 'Escape', code: 'Escape' });
  expect(await searchOpen()).toBe(false);
  // Cmd on a Mac, Caps Lock on.
  await key(page, { key: 'K', code: 'KeyK', metaKey: true });
  expect(await searchOpen()).toBe(true);
  await key(page, { key: 'Escape', code: 'Escape' });
  // A Russian layout: the K key types "л".
  await key(page, { key: 'л', code: 'KeyK', ctrlKey: true });
  expect(await searchOpen()).toBe(true);
  await key(page, { key: 'Escape', code: 'Escape' });
  // Ctrl+Shift+F, with Caps Lock off ("F") and on ("f" on Windows): fold all, then unfold all.
  await key(page, { key: 'F', code: 'KeyF', ctrlKey: true, shiftKey: true });
  expect(await page.evaluate(() => allCollapsed)).toBe(true);
  await key(page, { key: 'f', code: 'KeyF', ctrlKey: true, shiftKey: true });
  expect(await page.evaluate(() => allCollapsed)).toBe(false);
  // Ctrl+B with Caps Lock.
  await key(page, { key: 'B', code: 'KeyB', ctrlKey: true });
  expect(await page.evaluate(() => tocVisible)).toBe(false);
  await key(page, { key: 'b', code: 'KeyB', ctrlKey: true });
  // Ctrl+\ on a German layout, where that key types "#".
  await key(page, { key: '#', code: 'Backslash', ctrlKey: true });
  expect(await page.evaluate(() => isExpanded)).toBe(true);
  // Not ours: Ctrl+Shift+B (bookmarks bar), Ctrl+Shift+O, and AltGr (Ctrl+Alt) typing a backslash.
  expect(await key(page, { key: 'B', code: 'KeyB', ctrlKey: true, shiftKey: true })).toBe(false);
  expect(await key(page, { key: 'O', code: 'KeyO', ctrlKey: true, shiftKey: true })).toBe(false);
  expect(await key(page, { key: '\\', code: 'IntlBackslash', ctrlKey: true, altKey: true })).toBe(false);
  // A ticked task-list checkbox has the focus: shortcuts still work.
  await render(page, '# T\n\n- [ ] task\n');
  await page.focus('#mdBody input[type=checkbox]');
  expect(await key(page, { key: '?', code: 'Slash', shiftKey: true })).toBe(true);
  await expect(page.locator('#shortcutsOverlay')).toHaveClass(/show/);
});

test('the shortcuts sheet lists every shortcut, with one backslash and this platform\'s key names', async ({ page }) => {
  await openViewer(page);
  await page.keyboard.press('Shift+Slash');
  await expect(page.locator('#shortcutsOverlay')).toHaveClass(/show/);
  const mac = await page.evaluate(() => /mac/i.test(navigator.userAgentData?.platform || navigator.platform));
  expect(await page.locator('#shortcutsOverlay kbd', { hasText: mac ? '⌘' : 'Ctrl' }).count()).toBeGreaterThan(5);
  const rows = await page.locator('#shortcutsOverlay .shortcut-row').allTextContents();
  const n = await page.evaluate(() => MDV_SHORTCUTS.length);
  expect(rows.length).toBe(n + 1); // every shortcut, and the row with the Close button
  expect(rows.join('\n')).toContain('Comments');
  expect(rows.join('\n')).not.toContain('\\\\');
  expect(await page.locator('#shortcutsOverlay kbd', { hasText: '\\' }).count()).toBe(1);
});

// ---------------------------------------------------------------------------------------------------
// Dialogs: search, shortcuts sheet, image lightbox
// ---------------------------------------------------------------------------------------------------

test('search is a modal dialog: focus moves in, Tab stays in, Esc closes and gives the focus back', async ({ page }) => {
  await openViewer(page);
  await render(page, '# Guide\n\n## Backups\n\nNightly backups go to object storage.\n\n## Restore\n\nRestore the backup from storage.\n');
  const button = page.locator('.toolbar button[title^="Search"]');
  await button.focus();
  await page.keyboard.press('Enter');
  const overlay = page.locator('#searchOverlay');
  await expect(overlay).toHaveAttribute('role', 'dialog');
  await expect(overlay).toHaveAttribute('aria-modal', 'true');
  expect(await page.evaluate(() => document.activeElement.id)).toBe('searchInput');
  expect(await page.evaluate(() => document.querySelector('.toolbar').inert)).toBe(true);
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => document.activeElement.id)).toBe('searchInput');
  await page.keyboard.press('Shift+Tab');
  expect(await page.evaluate(() => document.activeElement.id)).toBe('searchInput');
  await page.keyboard.type('backup');
  await expect(page.locator('#searchResults [role=option]')).toHaveCount(3);
  await expect(page.locator('#searchResults')).toHaveAttribute('role', 'listbox');
  await expect(page.locator('#mdvSearchStatus')).toHaveText('3 matches');
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('#searchInput')).toHaveAttribute('aria-activedescendant', 'mdv-search-result-0');
  await expect(page.locator('#mdv-search-result-0')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Escape');
  await expect(overlay).not.toHaveClass(/show/);
  expect(await page.evaluate(() => document.querySelector('.toolbar').inert)).toBe(false);
  expect(await button.evaluate(b => b === document.activeElement)).toBe(true);
});

test('search finds words deep in a long paragraph, Enter takes the first result, and it unfolds the section', async ({ page }) => {
  await openViewer(page);
  const filler = 'Words that are not the target. '.repeat(20);
  await render(page, `# Doc\n\n## First\n\nIntro.\n\n## Second\n\n${filler}The zanzibar clause is here.\n`);
  await page.evaluate(() => toggleAllSections());
  await page.keyboard.press('Control+KeyK');
  await page.keyboard.type('zanzibar');
  await expect(page.locator('#searchResults .search-match')).toHaveText('zanzibar');
  await expect(page.locator('#mdvSearchStatus')).toHaveText('1 match');
  // An Enter that confirms an input method's text (Japanese, Chinese) is not a jump.
  await key(page, { key: 'Enter', code: 'Enter', isComposing: true });
  await expect(page.locator('#searchOverlay')).toHaveClass(/show/);
  await page.keyboard.press('Enter');
  await expect(page.locator('#searchOverlay')).not.toHaveClass(/show/);
  const p = page.locator('#mdBody p', { hasText: 'zanzibar' });
  await expect(p).toBeVisible();
  expect(await p.evaluate(el => el === document.activeElement)).toBe(true);
  await page.keyboard.press('Control+KeyK');
  await page.keyboard.type('nothing like this');
  await expect(page.locator('#mdvSearchStatus')).toHaveText('No matches');
});

test('search shows a heading whose letters change length when lower-cased, without garbling it', async ({ page }) => {
  await openViewer(page);
  await render(page, '# Trip\n\n## İstanbul notes\n\nFerries.\n');
  await page.keyboard.press('Control+KeyK');
  await page.keyboard.type('notes');
  const item = page.locator('#searchResults .search-result-item').first();
  await expect(item).toHaveText('## İstanbul notes');
  // Either no highlight, or the right one: never part of a word ("otes").
  const marks = await item.locator('.search-match').allTextContents();
  expect(marks.every(m => m.toLowerCase() === 'notes'), JSON.stringify(marks)).toBe(true);
});

test('a search jump opens the closed <details> around its match', async ({ page }) => {
  await openViewer(page);
  await render(page, '# Doc\n\n## Options\n\n<details><summary>Advanced</summary>\n\nThe quetzal setting lives here.\n\n</details>\n');
  await page.keyboard.press('Control+KeyK');
  await page.keyboard.type('quetzal');
  await page.keyboard.press('Enter');
  await expect(page.locator('#mdBody details p', { hasText: 'quetzal' })).toBeVisible();
  expect(await page.evaluate(() => document.querySelector('#mdBody details').open)).toBe(true);
});

test('a search jump flashes the block, then gives back the background colour its author set', async ({ page }) => {
  await openViewer(page);
  await render(page, '# Colours\n\n## Table\n\n<table><tr><td style="background: rgb(255, 0, 0)">Cardinal red cell</td></tr></table>\n');
  await page.keyboard.press('Control+KeyK');
  await page.keyboard.type('cardinal');
  await page.keyboard.press('Enter');
  const td = page.locator('#mdBody td', { hasText: 'Cardinal' });
  expect(await td.evaluate(el => el.style.backgroundColor)).toBe('var(--bg-tts-highlight)');
  await expect.poll(() => td.evaluate(el => el.style.background), { timeout: 5000 }).toBe('rgb(255, 0, 0)');
});

test('after a search, a re-render keeps nothing of the previous document', async ({ page }) => {
  await openViewer(page);
  await render(page, '# Guide\n\n## Backups\n\nNightly backups.\n');
  await page.keyboard.press('Control+KeyK');
  await page.keyboard.type('backup');
  await expect(page.locator('#searchResults [role=option]')).toHaveCount(2);
  await page.keyboard.press('Escape');
  await render(page, '# Other\n\nSomething else.\n', 'other.md');
  expect(await page.evaluate(() => (document.getElementById('searchResults')._matches || []).filter(m => !m.element.isConnected).length)).toBe(0);
  // With search open, a re-render runs the query again on the new document.
  await page.keyboard.press('Control+KeyK');
  await page.keyboard.type('backup');
  await expect(page.locator('#mdvSearchStatus')).toHaveText('No matches');
  await page.evaluate(() => renderMarkdown('# Guide\n\n## Backups\n\nNightly backups.\n', 'guide.md'));
  await expect(page.locator('#mdvSearchStatus')).toHaveText('2 matches');
});

test('a comment chip on a heading stays out of its words: read-aloud, the breadcrumb and search', async ({ page }) => {
  await openViewer(page);
  const payload = { version: 1, generator: 'mdv-viewer', comments: [{ id: 'cm_h1', parent_id: null,
    anchor: { id: 'c_head', blockKind: 'h2', blockHash: '0', sibIdx: 0, quote: null },
    author: { name: 'Reviewer', kind: 'human' }, body_md: 'Rename this?', created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-01T00:00:00Z', status: 'open' }] };
  await render(page, `# Plan\n\nFirst paragraph.\n\n<!-- MDV-ANCHOR id="c_head" -->\n## Steps\n\n${'Step text. '.repeat(300)}\n\n## Next\n\nAfter.\n\n<!-- MDV-COMMENTS:v1\n${JSON.stringify(payload)}\nMDV-COMMENTS:end -->\n`);
  await page.waitForSelector('#mdBody h2 .mdv-chip', { timeout: 10_000 });
  expect(await page.evaluate(() => { ttsToggle(); return ttsSections.map(s => s.heading); })).toContain('Steps');
  await page.evaluate(() => window.scrollTo({ top: document.getElementById('steps').getBoundingClientRect().top + scrollY - 100, behavior: 'instant' }));
  await frames(page);
  expect(await page.textContent('#breadcrumb')).toBe('Steps');
  await page.keyboard.press('Control+KeyK');
  await page.keyboard.type('steps');
  await expect(page.locator('#searchResults .search-result-item').first()).toHaveText('## Steps');
});

test('a dialog hides the page behind it from screen readers without restyling it, and keeps the focus', async ({ page }) => {
  await openViewer(page);
  await render(page, '# Guide\n\n## Links\n\nSee [the reference](#links) for more.\n');
  await page.keyboard.press('Control+KeyK');
  const layout = page.locator('.layout');
  await expect(layout).toHaveAttribute('aria-hidden', 'true');
  // Not inert: on a 3,000-section document, making it inert took over 100 ms each way.
  expect(await layout.evaluate(l => l.inert)).toBe(false);
  const cdp = await page.context().newCDPSession(page);
  const { result } = await cdp.send('Runtime.evaluate', { expression: 'document.querySelector("#mdBody h2")' });
  const { node } = await cdp.send('DOM.describeNode', { objectId: result.objectId });
  const { nodes } = await cdp.send('Accessibility.getPartialAXTree', { backendNodeId: node.backendNodeId, fetchRelatives: false });
  expect(nodes[0].ignored).toBe(true);
  // Focus that reaches the page behind the dialog goes back into it.
  await page.evaluate(() => document.querySelector('#mdBody p a').focus());
  expect(await page.evaluate(() => document.activeElement.id)).toBe('searchInput');
  await page.keyboard.press('Escape');
  await expect(layout).not.toHaveAttribute('aria-hidden', 'true');
});

test('after a dialog opened while nothing had the focus, Tab continues where the reader was', async ({ page }) => {
  await openViewer(page);
  await render(page, '# Guide\n\nA paragraph to click in, with no link in it.\n\n## Next part\n\nText.\n');
  // Nothing clicked yet: Tab after the dialog starts at the top of the page, as it does on a fresh page.
  await page.keyboard.press('Control+KeyK');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => !!document.activeElement.closest('.toolbar'))).toBe(true);
  // After a click in the document, Tab continues from the click, with or without a dialog in between.
  const p = page.locator('#mdBody p').first();
  await p.click();
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => document.activeElement.getAttribute('aria-label'))).toBe('Toggle section: Next part');
  await p.click();
  await page.keyboard.press('Control+KeyK');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => document.activeElement.getAttribute('aria-label'))).toBe('Toggle section: Next part');
});

test('with a dialog open, the other shortcuts do nothing and are kept from the browser', async ({ page }) => {
  await openViewer(page);
  await render(page, `# Pictures\n\n![A small square](${PNG})\n\n## Notes\n\nText.\n`);
  const opened = { sheet: 'shortcutsOverlay', lightbox: 'lightbox', search: 'searchOverlay' };
  for (const [name, id] of Object.entries(opened)) {
    if (name === 'sheet') await page.keyboard.press('Shift+Slash');
    if (name === 'lightbox') { await page.locator('#mdBody img[role=button]').focus(); await page.keyboard.press('Enter'); }
    if (name === 'search') await page.keyboard.press('Control+KeyK');
    await expect(page.locator(`#${id}`)).toHaveClass(/show/);
    // Ctrl+Shift+R is the browser's hard reload, Ctrl+O its Open dialog.
    expect(await key(page, { key: 'R', code: 'KeyR', ctrlKey: true, shiftKey: true }), `${name}: Ctrl+Shift+R`).toBe(true);
    expect(await key(page, { key: 'o', code: 'KeyO', ctrlKey: true }), `${name}: Ctrl+O`).toBe(true);
    expect(await page.evaluate(() => document.getElementById('ttsPlayer').classList.contains('show'))).toBe(false);
    // The comments sidebar does not open underneath.
    await key(page, { key: 'C', code: 'KeyC', ctrlKey: true, shiftKey: true });
    expect(await page.evaluate(() => document.getElementById('mdvSidebar').classList.contains('open')), `${name}: Ctrl+Shift+C`).toBe(false);
    await page.keyboard.press('Escape');
    await expect(page.locator(`#${id}`)).not.toHaveClass(/show/);
  }
  // A "?" typed into search is text, not the help sheet.
  await page.keyboard.press('Control+KeyK');
  await page.keyboard.type('a?');
  await expect(page.locator('#searchInput')).toHaveValue('a?');
  await expect(page.locator('#shortcutsOverlay')).not.toHaveClass(/show/);
});

test('over the expanded diagram, shortcuts do nothing and its buttons keep working', async ({ page }) => {
  await openViewer(page);
  await page.goto('markdown-viewer.html?file=samples/kitchen-sink.md');
  await page.waitForFunction(() => document.querySelector('#mdBody .mermaid-wrapper .mermaid svg'), null, { timeout: 30_000 });
  await page.locator('#mdBody .mermaid-wrapper').first().click();
  const overlay = page.locator('#diagramOverlay');
  await expect(overlay).toHaveClass(/show/);
  await page.keyboard.press('Control+KeyK');
  await page.keyboard.type('sync');
  await page.keyboard.press('Shift+Slash');
  await expect(page.locator('#searchOverlay')).not.toHaveClass(/show/);
  await expect(page.locator('#shortcutsOverlay')).not.toHaveClass(/show/);
  expect(await overlay.evaluate(o => o.inert)).toBe(false);
  await expect(page.locator('#diagramZoomLabel')).toHaveText('Fit');
  await page.locator('#diagramFitBtn').click();
  await expect(page.locator('#diagramZoomLabel')).toHaveText('100%');
  await page.keyboard.press('Escape');
  await expect(overlay).not.toHaveClass(/show/);
});

test('the shortcuts sheet traps the focus and gives it back on Esc', async ({ page }) => {
  await openViewer(page);
  await render(page, '# T\n\nText.\n');
  const opener = page.locator('#tocBtn');
  await opener.focus();
  await page.keyboard.press('Shift+Slash');
  const overlay = page.locator('#shortcutsOverlay');
  await expect(overlay).toHaveAttribute('role', 'dialog');
  await expect(overlay).toHaveAttribute('aria-labelledby', 'mdvShortcutsTitle');
  const close = overlay.locator('button', { hasText: 'Close' });
  expect(await close.evaluate(b => b === document.activeElement)).toBe(true);
  await page.keyboard.press('Tab');
  expect(await close.evaluate(b => b === document.activeElement)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(overlay).not.toHaveClass(/show/);
  expect(await opener.evaluate(b => b === document.activeElement)).toBe(true);
  // ? toggles it closed as well.
  await page.keyboard.press('Shift+Slash');
  await expect(overlay).toHaveClass(/show/);
  await page.keyboard.press('Shift+Slash');
  await expect(overlay).not.toHaveClass(/show/);
});

test('an image opens the lightbox from the keyboard; an image inside a link does not', async ({ page }) => {
  await openViewer(page);
  await render(page, `# Pictures\n\n![A small square](${PNG})\n\nA badge [![Badge](${PNG})](https://example.com) inside a sentence.\n`);
  const img = page.locator('#mdBody img[alt="A small square"]');
  await expect(img).toHaveAttribute('role', 'button');
  await expect(img).toHaveAttribute('aria-label', 'Enlarge image: A small square');
  await expect(page.locator('#mdBody a img')).not.toHaveAttribute('role', 'button');
  await img.focus();
  await page.keyboard.press('Enter');
  const box = page.locator('#lightbox');
  await expect(box).toHaveClass(/show/);
  await expect(box).toHaveAttribute('role', 'dialog');
  await expect(box).toHaveAttribute('aria-label', 'Image: A small square');
  await expect(page.locator('#lightboxImg')).toHaveAttribute('alt', 'A small square');
  expect(await page.evaluate(() => document.activeElement.id)).toBe('lightboxImg');
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => document.activeElement.id)).toBe('lightboxImg');
  await page.keyboard.press('Escape');
  await expect(box).not.toHaveClass(/show/);
  expect(await img.evaluate(i => i === document.activeElement)).toBe(true);
});

// ---------------------------------------------------------------------------------------------------
// Read aloud
// ---------------------------------------------------------------------------------------------------

const SPOKEN = `# Reader

Opening words.

## Second

${'This sentence is long enough to need a chunk of its own when it is read. '.repeat(4)}

## Third

Third words.

## Fourth

Fourth words.
`;

test('the read-aloud player is operable from the keyboard alone', async ({ page }) => {
  await openViewer(page);
  await render(page, SPOKEN);
  await page.evaluate(() => { window.__speechDuration = 5000; }); // reading must not finish mid-test
  await page.locator('#ttsToggleBtn').focus();
  await page.keyboard.press('Control+Shift+KeyR');
  await expect(page.locator('#ttsPlayer')).toHaveClass(/show/);
  await expect(page.locator('#ttsPlayer')).toHaveAttribute('role', 'region');
  await expect(page.locator('#ttsToggleBtn')).toHaveAttribute('aria-expanded', 'true');
  const play = page.locator('#ttsPlayBtn');
  expect(await play.evaluate(b => b === document.activeElement)).toBe(true);
  await expect(play).toHaveAttribute('aria-label', 'Play');
  await page.keyboard.press('Space');
  await expect(play).toHaveAttribute('aria-label', 'Pause');
  await page.keyboard.press('Space');
  await expect(play).toHaveAttribute('aria-label', 'Play');
  await page.keyboard.press('Tab'); // Next
  await expect(page.locator('#ttsNextBtn')).toHaveAttribute('aria-label', 'Next section');
  await page.keyboard.press('Enter');
  const bar = page.locator('#ttsProgressBar');
  await expect(bar).toHaveAttribute('aria-valuenow', '2');
  await page.keyboard.press('Tab'); // the progress slider
  expect(await bar.evaluate(b => b === document.activeElement)).toBe(true);
  await expect(bar).toHaveAttribute('role', 'slider');
  await page.keyboard.press('ArrowRight');
  await expect(bar).toHaveAttribute('aria-valuenow', '3');
  await expect(bar).toHaveAttribute('aria-valuetext', 'Section 3 of 4: Third');
  await page.keyboard.press('End');
  await expect(bar).toHaveAttribute('aria-valuenow', '4');
  await expect(page.locator('#ttsNextBtn')).toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('Home');
  await expect(bar).toHaveAttribute('aria-valuenow', '1');
  await page.keyboard.press('Tab'); // speed
  await expect(page.locator('#ttsSpeedBtn')).toHaveAttribute('aria-label', 'Speed 1x');
  await page.keyboard.press('Enter');
  await expect(page.locator('#ttsSpeedBtn')).toHaveAttribute('aria-label', 'Speed 1.25x');
  await page.keyboard.press('Tab'); // close
  await page.keyboard.press('Enter');
  await expect(page.locator('#ttsPlayer')).not.toHaveClass(/show/);
  expect(await page.locator('#ttsToggleBtn').evaluate(b => b === document.activeElement)).toBe(true);
  // The speed is remembered for the next visit.
  expect(await page.evaluate(() => localStorage.getItem('mdv-tts-rate'))).toBe('1.25');
});

test('Next while speaking reads the next section from its first chunk', async ({ page }) => {
  await openViewer(page);
  await render(page, SPOKEN);
  // The first utterance lasts 5 s, so it is still being spoken when Next is pressed.
  await page.evaluate(() => { window.__speechDuration = 5000; ttsToggle(); ttsPlay(); });
  await page.waitForFunction(() => window.__speech.started.length >= 1);
  const second = await page.evaluate(() => { window.__speechDuration = 60; ttsNext(); return ttsChunks.slice(); });
  expect(second.length).toBeGreaterThan(1);
  await page.waitForFunction((n) => window.__speech.ended.includes(n), second[1], { timeout: 5000 });
  const log = await page.evaluate(() => window.__speech);
  expect(log.ended).toContain(second[0]);
  expect(log.interrupted).not.toContain(second[0]);
});

test('Pause, then Next, then Play speaks the next section', async ({ page }) => {
  await openViewer(page);
  await render(page, SPOKEN);
  await page.evaluate(() => { window.__speechDuration = 5000; ttsToggle(); ttsPlay(); });
  await page.waitForFunction(() => window.__speech.started.length >= 1);
  const first = await page.evaluate(async () => {
    window.__speechDuration = 60;
    ttsPause();
    ttsNext();
    const next = ttsChunks[0];
    await new Promise(r => setTimeout(r, 30));
    window.__speech.started.length = 0;
    ttsPlay();
    return next;
  });
  await page.waitForFunction((t) => window.__speech.started.includes(t), first, { timeout: 5000 });
});

test('Pause, then a click on the progress bar, reads the chosen section at once', async ({ page }) => {
  await openViewer(page);
  await render(page, SPOKEN);
  await page.evaluate(() => { window.__speechDuration = 5000; ttsToggle(); ttsPlay(); });
  await page.waitForFunction(() => window.__speech.started.length >= 1);
  const play = page.locator('#ttsPlayBtn');
  await play.click();
  await expect(play).toHaveAttribute('aria-label', 'Play');
  expect(await page.evaluate(() => speechSynthesis.paused)).toBe(true);
  await page.evaluate(() => { window.__speechDuration = 60; });
  // 85% along the bar: the fourth of four sections.
  const bar = page.locator('#ttsProgressBar');
  const box = await bar.boundingBox();
  await bar.click({ position: { x: box.width * 0.85, y: box.height / 2 } });
  await expect(page.locator('#ttsSectionLabel')).toHaveText('4/4: Fourth');
  // Speech starts, so the button's "Pause" is true: before, the browser's paused flag held the new utterance.
  await page.waitForFunction(() => window.__speech.started.includes('Fourth.\nFourth words.'), null, { timeout: 5000 });
  expect(await page.evaluate(() => speechSynthesis.paused)).toBe(false);
});

test('opening another document stops reading, even when it shares the section\'s name', async ({ page }) => {
  await openViewer(page);
  const startedSince = (n) => page.evaluate((i) => window.__speech.started.slice(i), n);
  // A shared "Installation".
  const alpha = `# Alpha guide\n\n## Installation\n\n${'Alpha installs with the alpha tool. '.repeat(12)}\n\n## Usage\n\nAlpha usage.\n`;
  await render(page, alpha, 'alpha.md');
  await page.evaluate(() => { window.__speechDuration = 150; ttsToggle(); ttsGoTo(1); ttsPlay(); });
  await page.waitForFunction(() => window.__speech.started.some(t => t.startsWith('Installation.')));
  let mark = await page.evaluate(() => window.__speech.started.length);
  await render(page, '# Beta guide\n\n## Installation\n\nBeta installs differently.\n\n## Usage\n\nBeta usage.\n', 'beta.md');
  await page.waitForTimeout(600); // four utterances' worth
  expect(await page.evaluate(() => ttsIsPlaying)).toBe(false);
  expect((await startedSince(mark)).filter(t => /alpha/i.test(t))).toEqual([]);
  // A shared "Introduction": any two documents with text before their first heading have one.
  await render(page, `${'Alpha sentence. '.repeat(40)}\n\n# Alpha\n\nBody.\n`, 'a.md');
  await page.evaluate(() => { ttsGoTo(0); ttsPlay(); });
  await page.waitForFunction(() => window.__speech.started.some(t => t.startsWith('Alpha sentence.')));
  mark = await page.evaluate(() => window.__speech.started.length);
  await render(page, 'Beta words.\n\n# Beta\n\nBeta body.\n', 'b.md');
  await page.waitForTimeout(600);
  expect(await page.evaluate(() => ttsIsPlaying)).toBe(false);
  expect((await startedSince(mark)).filter(t => /alpha/i.test(t))).toEqual([]);
});

test('re-rendering the same document keeps reading, after a change elsewhere and next to a link card', async ({ page }) => {
  await openViewer(page);
  // A standalone link becomes a link card after the render's later passes; the section must still match.
  const doc = (usage) => `# Guide\n\n## Installation\n\n${'Install it with the tool. '.repeat(12)}\n\nhttps://github.com/example/tool\n\n## Usage\n\n${usage}\n`;
  await render(page, doc('Usage words.'), 'guide.md');
  await page.evaluate(() => { window.__speechDuration = 5000; ttsToggle(); ttsGoTo(1); ttsPlay(); });
  await page.waitForFunction(() => window.__speech.started.some(t => t.startsWith('Installation.')));
  await render(page, doc('Usage words, edited.'), 'guide.md');
  expect(await page.evaluate(() => [ttsIsPlaying, ttsSections[ttsCurrentIdx].heading])).toEqual([true, 'Installation']);
  // The highlight is on the page's own elements, the link card included.
  expect(await page.evaluate(() => [...document.querySelectorAll('.tts-active')].every(el => el.isConnected && document.getElementById('mdBody').contains(el)))).toBe(true);
  expect(await page.locator('#mdBody .link-chip.tts-active').count()).toBe(1);
});

test('the block being read is unfolded, not only its heading', async ({ page }) => {
  await openViewer(page);
  await render(page, SPOKEN);
  await page.evaluate(() => { window.__speechDuration = 5000; toggleAllSections(); ttsToggle(); ttsPlay(); ttsGoTo(1); });
  const read = page.locator('#mdBody p.tts-active');
  await expect(read).toHaveCount(1);
  await expect(read).toBeVisible();
});

test('speech the browser refuses stops at once and says so, instead of racing through the document', async ({ page }) => {
  await openViewer(page);
  await render(page, SPOKEN);
  await page.evaluate(() => { window.__speechRefuse = 'not-allowed'; ttsToggle(); ttsPlay(); });
  await expect(page.locator('#ttsSectionLabel')).toHaveText('The browser blocked speech. Press Play to try again.');
  expect(await page.evaluate(() => [window.__speech.refused.length, ttsIsPlaying])).toEqual([1, false]);
  // Any other error stops after three in a row.
  await page.evaluate(() => { window.__speechRefuse = 'synthesis-failed'; ttsPlay(); });
  await expect(page.locator('#ttsSectionLabel')).toHaveText('Speech failed. Press Play to try again.');
  expect(await page.evaluate(() => [window.__speech.refused.length, ttsIsPlaying])).toEqual([4, false]);
});

test('re-rendering the same document keeps the reading position; opening another one stops reading', async ({ page }) => {
  await openViewer(page);
  await render(page, SPOKEN);
  // Utterances last 5 s here, so reading is still on "Third" when the document is rendered again.
  await page.evaluate(() => { window.__speechDuration = 5000; ttsToggle(); ttsPlay(); ttsNext(); ttsNext(); });
  await page.evaluate((s) => renderMarkdown(s, 'test.md'), SPOKEN);
  expect(await page.evaluate(() => [ttsCurrentIdx, ttsIsPlaying, ttsSections[ttsCurrentIdx].heading])).toEqual([2, true, 'Third']);
  expect(await page.evaluate(() => document.querySelector('.tts-active')?.textContent)).toContain('Third');
  await render(page, '# Other\n\nSomething else.\n', 'other.md');
  expect(await page.evaluate(() => [ttsCurrentIdx, ttsIsPlaying])).toEqual([0, false]);
});

test('what is read: no minimap, chevrons or chips; tables by row; images by their alt text', async ({ page }) => {
  await openViewer(page);
  await render(page, `# Report\n\nSummary first.\n\n![Chart of sales](${PNG})\n\n## One\n\n| Step | Owner |\n|---|---|\n| Build | Ana |\n| Ship | Bo |\n\n## Two\n\nB.\n\n## Three\n\nC.\n`);
  const intro = await page.evaluate(() => { ttsToggle(); return ttsSections[0].items.join('\n'); });
  expect(intro).toContain('Image: Chart of sales.');
  expect(intro).not.toMatch(/OneTwoThree/i);
  const one = await page.evaluate(() => ttsSections.find(s => s.heading === 'One').items.join('\n'));
  expect(one).toContain('Step, Owner.');
  expect(one).toContain('Build, Ana.');
});

test('what is read: the frontmatter dashboard as phrases, and each formula once', async ({ page }) => {
  await openViewer(page);
  await render(page, `---\nstatus: In progress\ndate: 2026-10-04\nmetrics:\n  - value: 4\n    label: Open questions\n---\n\nEnergy is $E=mc^2$ here.\n`);
  const intro = await page.evaluate(() => { ttsToggle(); return ttsSections[0].items.join('\n'); });
  expect(intro).toContain('In progress.\n2026-10-04.\n4 Open questions.');
  expect(intro).toContain('Energy is E=mc2 here.');
  expect(intro.split('E=mc').length - 1).toBe(1);
});

test('a link card is read and found by its title, without its icon, address line or badge', async ({ page }) => {
  await openViewer(page);
  await render(page, '# Links\n\n## Tools\n\n[The marked parser](https://github.com/markedjs/marked)\n\nAfter.\n');
  await expect(page.locator('#mdBody .link-chip')).toHaveCount(1);
  const tools = await page.evaluate(() => { ttsToggle(); return ttsSections.find(s => s.heading === 'Tools').items; });
  expect(tools).toEqual(['Tools.', 'The marked parser', 'After.']);
  await page.keyboard.press('Control+KeyK');
  await page.keyboard.type('marked parser');
  await expect(page.locator('#mdvSearchStatus')).toHaveText('1 match');
  await expect(page.locator('#searchResults .search-result-ctx')).toHaveText('The marked parser');
});

test('without speech support the player says so instead of throwing', async ({ page }) => {
  const errors = await openViewer(page, { speech: false });
  await page.addInitScript(() => { delete window.SpeechSynthesisUtterance; Object.defineProperty(window, 'speechSynthesis', { value: undefined, configurable: true }); });
  await page.reload();
  await page.waitForFunction(() => typeof renderMarkdown === 'function');
  await render(page, SPOKEN);
  await page.evaluate(() => { ttsToggle(); ttsPlayPause(); });
  await expect(page.locator('#ttsSectionLabel')).toContainText('does not have');
  await expect(page.locator('#ttsPlayBtn')).toBeDisabled();
  expect(errors).toEqual([]);
});

// ---------------------------------------------------------------------------------------------------
// Screenshots, both themes: search, the shortcuts sheet, the player
// ---------------------------------------------------------------------------------------------------

for (const theme of ['light', 'dark']) {
  test(`dialogs and the player in the ${theme} theme (screenshots)`, async ({ page }, info) => {
    const errors = await openViewer(page, { theme });
    await page.goto('markdown-viewer.html?file=samples/kitchen-sink.md');
    await page.waitForSelector('#mdBody h2');
    await page.keyboard.press('Control+KeyK');
    await page.keyboard.type('sync');
    await page.keyboard.press('ArrowDown');
    await page.screenshot({ path: info.outputPath(`search-${theme}.png`) });
    await page.keyboard.press('Escape');
    await page.keyboard.press('Shift+Slash');
    await page.screenshot({ path: info.outputPath(`shortcuts-${theme}.png`) });
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+Shift+KeyR');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.keyboard.press('ArrowRight');
    await page.screenshot({ path: info.outputPath(`player-${theme}.png`) });
    await page.locator('#ttsPlayer .tts-close').click();
    await page.locator('#mdBody img[role=button]').first().focus({ timeout: 10_000 });
    await page.keyboard.press('Enter');
    await expect(page.locator('#lightbox')).toHaveClass(/show/);
    await page.screenshot({ path: info.outputPath(`lightbox-${theme}.png`) });
    await page.keyboard.press('Escape');
    expect(errors).toEqual([]);
  });
}
