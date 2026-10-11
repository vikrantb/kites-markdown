// Security: a document is untrusted input. Nothing in it may run script, leave the page or take
// over the viewer's own controls, and the viewer's own markup (comment anchors, narration, KaTeX,
// diagrams, code-block buttons) must come through the sanitizer intact.
import { test, expect } from '@playwright/test';
import { readFileSync, readdirSync } from 'node:fs';
import {
  collectProblems, recordPayloads, payloadHits, recordCspViolations, stubFilePickers, openDocument,
} from './support/viewer.mjs';

const ROOT = new URL('../../', import.meta.url);
// An inline handler written into HTML: on<event>= as an attribute.
const HTML_HANDLER = /\son[a-z]+\s*=/gi;
// An inline handler inside a JS string that becomes HTML: on<event>= followed by a quote, a
// backtick, an escaped quote or ${. A property assignment such as `btn.onclick = (e) =>` is fine.
const JS_HANDLER = /\bon[a-z]+\s*=\s*["'`\\$]/gi;

test('no inline event handler anywhere: the markup, the scripts, the rendered page', async ({ page }) => {
  // The probes find what they look for, and nothing else.
  expect('<button class="b" onclick="go()">'.match(HTML_HANDLER)).toHaveLength(1);
  expect('return `<div data-idx="${i}" onclick="goSearch(${i})">`;'.match(JS_HANDLER)).toHaveLength(1);
  expect("x.innerHTML = '<b onmouseover=\\'f()\\'>';".match(JS_HANDLER)).toHaveLength(1);
  expect('btn.onclick = (e) => go(e); reader.onload = async (ev) => {};'.match(JS_HANDLER)).toBeNull();

  const html = readFileSync(new URL('markdown-viewer.html', ROOT), 'utf8');
  expect(html.match(HTML_HANDLER), 'inline handlers in markdown-viewer.html').toBeNull();
  const scripts = readdirSync(new URL('js/', ROOT)).filter((f) => f.endsWith('.js'));
  expect(scripts).toContain('actions.js');
  for (const f of scripts) {
    expect(readFileSync(new URL(`js/${f}`, ROOT), 'utf8').match(JS_HANDLER), `inline handlers in js/${f}`).toBeNull();
  }

  await openDocument(page, 'samples/kitchen-sink.md');
  await page.locator('.toolbar button[title^="Search"]').click();
  await page.locator('#searchInput').pressSequentially('sync');
  await expect(page.locator('.search-result-item').first()).toBeVisible();
  const handlerAttributes = () => page.evaluate(() => [...document.querySelectorAll('*')]
    .flatMap((el) => [...el.attributes].filter((a) => /^on/i.test(a.name)).map((a) => `${el.tagName}[${a.name}]`)));
  await page.evaluate(() => document.body.append(Object.assign(document.createElement('i'), { id: 'mdvProbe' })));
  await page.evaluate(() => document.getElementById('mdvProbe').setAttribute('onclick', 'void 0'));
  expect(await handlerAttributes(), 'the DOM probe sees a handler attribute').toEqual(['I[onclick]']);
  await page.evaluate(() => document.getElementById('mdvProbe').remove());
  expect(await handlerAttributes()).toEqual([]);
});

test('every converted control is wired through a registered action', async ({ page }) => {
  await openDocument(page, 'samples/kitchen-sink.md');
  await page.locator('.toolbar button[title^="Search"]').click();
  await page.locator('#searchInput').pressSequentially('sync');
  await expect(page.locator('.search-result-item').first()).toBeVisible();
  const wiring = await page.evaluate(() => {
    const names = [...document.querySelectorAll('[data-action]')].map((el) => el.dataset.action);
    return { used: [...new Set(names)].sort(), missing: [...new Set(names)].filter((n) => !mdvActions[n]) };
  });
  expect(wiring.missing, 'data-action names with no registry entry').toEqual([]);
  // The 46 inline handlers this replaced: 42 in the markup, copy-code (core.js), go-search
  // (navigation.js, twice) and browse-file in the not-found prompt (files.js).
  for (const name of ['font-size', 'toggle-width', 'toggle-toc', 'toggle-all-sections', 'toggle-focus', 'open-search',
    'toggle-links-panel', 'tts-toggle', 'toggle-comments', 'open-writable', 'pick-workspace', 'toggle-dropdown',
    'set-theme', 'toggle-settings', 'open-file', 'file-chosen', 'save-base-path', 'close-search', 'search',
    'close-shortcuts', 'close-lightbox', 'diagram-zoom', 'diagram-fit', 'close-diagram', 'copy-link', 'browse-file',
    'scroll-top', 'scroll-bottom', 'tts-prev', 'tts-play-pause', 'tts-next', 'tts-seek', 'tts-speed', 'tts-stop',
    'copy-code', 'go-search']) {
    expect(wiring.used, `a control uses ${name}`).toContain(name);
  }
});

test('a hostile document runs nothing, goes nowhere and keeps its harmless content', async ({ page }) => {
  await recordPayloads(page);
  await recordCspViolations(page);
  await stubFilePickers(page);
  const problems = collectProblems(page, [/does-not-exist\.(png|bin)/]);
  const navigations = [];
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) navigations.push(f.url()); });
  await page.route(/example\.invalid/, (route) => route.abort());

  await openDocument(page, 'tests/fixtures/hostile.md');
  const loadedUrl = page.url();

  // Touch what a reader might touch. Each target is still on the page (minus its payload), so a
  // missing one would make this check pass without clicking anything.
  for (const sel of ['#link-javascript', '#form-submit', '#doc-action', '#svg-onload']) {
    const target = page.locator(`#mdBody ${sel}`);
    await expect(target, `${sel} is on the page`).toHaveCount(1);
    await target.click({ force: true });
  }
  const nodes = page.locator('#mdBody .mermaid svg .node');
  for (let i = 0; i < await nodes.count(); i++) await nodes.nth(i).click({ force: true });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  expect(await payloadHits(page), 'items that ran').toEqual([]);
  expect(navigations, 'navigations after the first load').toEqual([loadedUrl]);
  expect(page.url()).toBe(loadedUrl);
  expect(await page.evaluate(() => window.__mdvPickerCalls), 'viewer actions a document triggered').toEqual([]);

  const dom = await page.evaluate(() => {
    const body = document.getElementById('mdBody');
    const all = [...body.querySelectorAll('*')];
    return {
      // Mermaid's own SVG carries a <style> for the diagram; everything else came from the document.
      forbidden: all.filter((el) => !el.closest('.mermaid'))
        .filter((el) => /^(script|iframe|frame|object|embed|form|style)$/i.test(el.tagName)).map((el) => el.tagName),
      handlers: all.flatMap((el) => [...el.attributes].filter((a) => /^on/i.test(a.name)).map((a) => `${el.tagName}[${a.name}]`)),
      scriptUrls: all.flatMap((el) => ['href', 'src', 'xlink:href', 'action'].map((n) => el.getAttribute(n)).filter(Boolean))
        .filter((v) => /^javascript:/i.test(v.trim())),
      chromeLabelOwner: document.getElementById('ttsSectionLabel').closest('#ttsPlayer') !== null,
      chromeThreadList: document.getElementById('mdvThreadList').closest('#mdvSidebar') !== null,
      // The document's elements named like the player's label and like the three containers that
      // hold document content (#mdBody, the diagram overlay's, the comment sidebar's thread list).
      // Leaf divs only: the section wrapper around them starts with the same text.
      documentLabels: [...body.querySelectorAll('div')]
        .filter((d) => !d.children.length && d.textContent.startsWith('A document element named')).map((d) => d.id),
      toolbarVisible: getComputedStyle(document.querySelector('.toolbar')).display !== 'none',
      h1: body.querySelector('h1')?.textContent,
      tables: [...body.querySelectorAll('table th')].filter((th) => th.textContent === 'Kind').length,
      dataImage: body.querySelectorAll('img[src^="data:image/png"]').length,
      benignSvg: body.querySelectorAll('#benign-svg rect').length,
      diagrams: body.querySelectorAll('.mermaid svg').length,
      repoLinks: body.querySelectorAll('a.fm-repo-badge').length,
      repoBadges: body.querySelectorAll('.fm-repo-badge').length,
    };
  });
  expect(dom.forbidden).toEqual([]);
  expect(dom.handlers).toEqual([]);
  expect(dom.scriptUrls).toEqual([]);
  expect(dom.chromeLabelOwner, 'the read-aloud label is still the player\'s').toBe(true);
  expect(dom.chromeThreadList, 'the thread list is still the sidebar\'s').toBe(true);
  expect(dom.documentLabels, 'the document elements are kept, without the viewer\'s ids').toEqual(['', '', '', '']);
  expect(dom.toolbarVisible, 'a document <style> hid the toolbar').toBe(true);
  expect(dom.h1).toContain('A hostile document');
  expect(dom.tables).toBe(1);
  expect(dom.dataImage).toBe(1);
  expect(dom.benignSvg).toBe(1);
  expect(dom.diagrams).toBe(1);
  expect({ links: dom.repoLinks, badges: dom.repoBadges }, 'a non-web repository URL is a plain badge').toEqual({ links: 0, badges: 2 });
  expect(await page.evaluate(() => window.__mdvCsp), 'nothing reached the CSP').toEqual([]);
  expect(problems, problems.join('\n')).toEqual([]);
});

test('the Content Security Policy refuses inline script that reaches the page another way', async ({ page }) => {
  await recordPayloads(page);
  await recordCspViolations(page);
  await openDocument(page, 'samples/kitchen-sink.md');
  // Markup inserted without the sanitizer, as a bug in any innerHTML sink would.
  await page.evaluate(() => {
    const div = document.createElement('div');
    div.innerHTML = '<img src="does-not-exist.png" onerror="window.__mdvPwned=\'unsanitized-sink\'">';
    document.body.append(div);
  });
  await expect.poll(() => page.evaluate(() => window.__mdvCsp.length)).toBeGreaterThan(0);
  expect(await payloadHits(page)).toEqual([]);
  expect((await page.evaluate(() => window.__mdvCsp)).map((v) => v.directive)).toContain('script-src-attr');
});

test('a comment card that breaks out of its attribute runs nothing', async ({ page }) => {
  await recordPayloads(page);
  await recordCspViolations(page);
  await stubFilePickers(page);
  await openDocument(page, 'tests/fixtures/comment-sidebar-injection.md');
  await page.locator('#mdvToggleBtn').click();
  await expect(page.locator('#mdvSidebar')).toHaveClass(/open/);
  const card = page.locator('#mdvThreadList .mdv-comment');
  await expect(card).toHaveCount(1);
  await card.hover();
  await card.click();
  await page.waitForTimeout(300);
  expect(await payloadHits(page), 'a handler from comment data ran').toEqual([]);
  expect(await page.evaluate(() => window.__mdvPickerCalls)).toEqual([]);
  // comments.js escapes the value without its quotes (stream C's), so at this commit the attribute
  // does land; the CSP is what refuses it. Once C escapes quotes, nothing lands and nothing is refused.
  const landed = await page.locator('#mdvThreadList [onmouseover]').count();
  const refused = (await page.evaluate(() => window.__mdvCsp)).some((v) => v.directive === 'script-src-attr');
  expect({ landed, refused }).toEqual(landed ? { landed: 1, refused: true } : { landed: 0, refused: false });
});

test('no surface lets a document press the viewer\'s buttons', async ({ page, context }) => {
  // The document names viewer actions in attributes through every route document data takes: its
  // own HTML, a fake code block, a guessed code-block key, a Mermaid label (shown again in the
  // diagram overlay), and comment fields that break out of an attribute in the sidebar.
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await stubFilePickers(page);
  await recordPayloads(page);
  const problems = collectProblems(page);
  await page.route(/example\.invalid/, (route) => route.abort());
  await openDocument(page, 'tests/fixtures/press-the-buttons.md');
  await page.evaluate(() => navigator.clipboard.writeText('clipboard before'));
  const state = () => page.evaluate(async () => ({
    pickers: window.__mdvPickerCalls.slice(),
    theme: document.documentElement.getAttribute('data-theme'),
    focus: document.body.classList.contains('focus-mode'),
    clipboard: await navigator.clipboard.readText(),
  }));
  const before = await state();
  expect(before).toEqual({ pickers: [], theme: 'light', focus: false, clipboard: 'clipboard before' });

  const overlay = page.locator('#diagramOverlay');
  const clickEach = async (selector, label) => {
    const names = [];
    for (const el of await page.locator(selector).all()) {
      names.push(label || await el.getAttribute('data-mdv-probe'));
      await el.click({ force: true });
      // A click inside a diagram opens the overlay; close it so the next click reaches the page.
      if (selector.startsWith('#mdBody') && await overlay.evaluate((o) => o.classList.contains('show'))) {
        await page.keyboard.press('Escape');
        await expect(overlay).not.toHaveClass(/show/);
      }
    }
    return names.sort();
  };
  const clicked = {};
  clicked.body = await clickEach('#mdBody [data-mdv-probe]');
  await page.locator('#mdBody .diagram-expand-btn').click();
  await expect(overlay).toHaveClass(/show/);
  clicked.overlay = await clickEach('#diagramZoomContainer [data-mdv-probe]');
  await page.keyboard.press('Escape');
  await page.locator('#mdvToggleBtn').click();
  await expect(page.locator('#mdvSidebar')).toHaveClass(/open/);
  clicked.cards = await clickEach('#mdvThreadList .mdv-comment', 'card');
  await page.waitForTimeout(300);

  // The routes were all exercised: each probe is on the page and was clicked.
  expect(clicked).toEqual({
    body: ['forged-key', 'mermaid', 'mermaid-copy', 'raw-copy', 'raw-html'],
    overlay: ['mermaid', 'mermaid-copy'],
    cards: ['card', 'card'],
  });
  expect(await state(), 'the viewer\'s state after every click').toEqual(before);
  expect(await payloadHits(page)).toEqual([]);

  const dom = await page.evaluate(() => ({
    // An element that names an action, outside every container of document content.
    outside: [...document.querySelectorAll('[data-mdv-probe][data-action]')]
      .filter((el) => !el.closest('[data-mdv-document]')).map((el) => el.dataset.mdvProbe),
    // The sanitizer drops a document's data-action and data-arg; only Mermaid's labels keep theirs.
    sanitizedActions: [...document.querySelectorAll('#mdBody [data-mdv-probe]')]
      .filter((el) => el.hasAttribute('data-action') && !el.closest('.mermaid')).map((el) => el.dataset.mdvProbe),
    keyAttributes: document.querySelectorAll('#mdBody [data-mdv-code]').length,
  }));
  expect(dom).toEqual({ outside: [], sanitizedActions: [], keyAttributes: 0 });

  // Positive controls: the viewer's own Copy button and toolbar button still work, and the
  // instruments (clipboard, picker stub) see them.
  await page.keyboard.press('Escape');
  await page.locator('#mdvSidebar .mdv-sidebar-close').click();
  const genuine = page.locator('#mdBody pre', { hasText: 'const genuine = true;' }).locator('.copy-btn');
  await expect(genuine).toHaveCount(1);
  await genuine.click();
  await expect(genuine).toHaveText('Copied!');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('const genuine = true;');
  await page.locator('#mdvWorkspaceBtn').click();
  await expect.poll(() => page.evaluate(() => window.__mdvPickerCalls.slice())).toEqual(['showDirectoryPicker']);
  expect(problems, problems.join('\n')).toEqual([]);
});

test('a document cannot draw over the viewer\'s controls', async ({ page }) => {
  // Style attributes are kept (KaTeX needs them), so a document can position an element anywhere,
  // above everything it contains. #mdBody isolates its stacking, so the viewer's own fixed controls
  // stay on top and stay clickable.
  const problems = collectProblems(page);
  await openDocument(page, 'tests/fixtures/cover.md');
  await page.evaluate(() => mdvToggleSidebar(true));
  await expect(page.locator('#mdvSidebar')).toHaveClass(/open/);
  await page.waitForTimeout(600);   // the sidebar slides in
  const hits = await page.evaluate(() => {
    const hit = (el) => {
      const b = el.getBoundingClientRect();
      const top = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
      return top === el || el.contains(top) ? 'control' : (top && (top.id || top.className || top.tagName));
    };
    const content = document.getElementById('content').getBoundingClientRect();
    const middle = document.elementFromPoint(content.x + 40, content.y + content.height / 2);
    return {
      // Positive control: the cover is rendered and is what a click in the document area reaches.
      documentArea: middle && middle.id,
      openFile: hit(document.querySelector('.toolbar button[title="Open file"]')),
      theme: hit(document.querySelector('.dropdown-wrap > button')),
      outline: hit(document.querySelector('#tocList .toc-link')),
      scrollTop: hit(document.getElementById('fabUp')),
      closeComments: hit(document.querySelector('#mdvSidebar .mdv-sidebar-close')),
    };
  });
  expect(hits).toEqual({ documentArea: 'cover', openFile: 'control', theme: 'control', outline: 'control', scrollTop: 'control', closeComments: 'control' });
  expect(problems, problems.join('\n')).toEqual([]);
});

test('Mermaid directives in a document cannot restyle the viewer or loosen its security', async ({ page }) => {
  const problems = collectProblems(page);
  const requests = [];
  page.on('request', (r) => { if (/example\.invalid/.test(r.url())) requests.push(r.url()); });
  await page.route(/example\.invalid/, (route) => route.abort());
  await openDocument(page, 'tests/fixtures/mermaid-directives.md');
  await page.waitForTimeout(300);
  const r = await page.evaluate(() => {
    const svgs = [...document.querySelectorAll('#mdBody .mermaid svg')];
    return {
      diagrams: svgs.length,
      // Positive control: each directive's CSS did reach its diagram, scoped under the diagram's id.
      scoped: svgs.map((svg) => svg.querySelector('style').textContent.includes(`#${svg.id} .toolbar`)),
      toolbar: getComputedStyle(document.querySelector('.toolbar')).display,
      background: getComputedStyle(document.body).backgroundColor,
      level: mermaid.mermaidAPI.getConfig().securityLevel,
    };
  });
  expect(r.diagrams).toBe(3);
  expect(r.scoped).toEqual([true, true, false]);
  expect(r.toolbar).toBe('flex');
  expect(r.background).not.toBe('rgb(255, 0, 0)');
  expect(r.level).toBe('strict');
  expect(requests, 'a directive\'s @import was fetched').toEqual([]);
  expect(problems, problems.join('\n')).toEqual([]);
});

test('comments next to markup characters survive the sanitizer, and so does the text around them', async ({ page }) => {
  // DOMPurify (SAFE_FOR_XML) removes a comment holding "<" plus a letter, digit or "/", and an element
  // whose only children are text and comments when that text holds one: "if a<b <!-- note -->".
  const problems = collectProblems(page);
  await openDocument(page, 'tests/fixtures/comments-with-markup.md');
  const r = await page.evaluate(() => {
    const body = document.getElementById('mdBody');
    const texts = (sel) => [...body.querySelectorAll(sel)].map((el) => el.textContent.replace(/\s+/g, ' ').trim());
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_COMMENT);
    const comments = [];
    while (walker.nextNode()) comments.push(walker.currentNode.nodeValue.trim());
    return {
      comments,
      // The read-aloud sections are built on demand since stream R (ttsEnsureSections), not by the render
      spoken: (ttsEnsureSections(), ttsSections).flatMap((s) => s.items).find((t) => t.startsWith('Two boxes')) || null,
      paragraphs: texts('p'),
      items: texts('li'),
      rows: [...body.querySelectorAll('tbody tr')].map((tr) => [...tr.cells].map((c) => c.textContent.trim())),
    };
  });
  // The narration is kept and read aloud; a space follows each "<" that could start a tag.
  expect(r.comments).toEqual(['narrate: Two boxes joined by an arrow; requests with latency< 200ms return a List< String>.']);
  expect(r.spoken).toBe('Two boxes joined by an arrow; requests with latency< 200ms return a List< String>.');
  // The comments inside a paragraph, a list item and a table cell go; their text stays.
  expect(r.paragraphs).toContain('If a<b then swap them.');
  expect(r.items).toEqual(['L1 if a<b then swap them', 'L2 a plain item']);
  expect(r.rows).toEqual([['T1', 'x<y']]);
  expect(r.paragraphs).toContain('Control: if a<b then swap them, with no comment.');
  expect(problems, problems.join('\n')).toEqual([]);
});

test('Mermaid runs at securityLevel strict, whatever a caller asks for', async ({ page }) => {
  await openDocument(page, 'samples/kitchen-sink.md');
  const level = await page.evaluate(() => {
    mermaid.initialize({ startOnLoad: false, securityLevel: 'loose' });
    return mermaid.mermaidAPI.getConfig().securityLevel;
  });
  expect(level).toBe('strict');
});

test('comment anchors, narration, KaTeX MathML and heading ids survive the sanitizer', async ({ page }) => {
  const problems = collectProblems(page);
  await openDocument(page, 'samples/commented.md');
  await expect(page.locator('#mdBody .mdv-chip')).toHaveCount(2);
  const comments = await page.evaluate(() => {
    const walker = document.createTreeWalker(document.getElementById('mdBody'), NodeFilter.SHOW_COMMENT);
    const texts = [];
    while (walker.nextNode()) texts.push(walker.currentNode.nodeValue.trim().slice(0, 20));
    return { anchors: texts.filter((t) => t.startsWith('MDV-ANCHOR')).length, threads: mdvComments.filter((c) => !c.parent_id).length };
  });
  expect(comments).toEqual({ anchors: 2, threads: 2 });

  await openDocument(page, 'tests/fixtures/narration-top-level.md');
  const narration = await page.evaluate(() => (ttsEnsureSections(), ttsSections).flatMap((s) => s.items).find((t) => t.startsWith('Two boxes')));
  expect(narration).toBe('Two boxes joined by an arrow, read aloud instead of the diagram.');

  await openDocument(page, 'samples/kitchen-sink.md');
  const kitchen = await page.evaluate(() => ({
    annotations: [...document.querySelectorAll('#mdBody .katex annotation[encoding="application/x-tex"]')].map((a) => a.textContent),
    imagesHeading: document.getElementById('images')?.tagName,
    linksHeading: document.getElementById('links')?.tagName,
    narrationComments: (() => {
      const w = document.createTreeWalker(document.getElementById('mdBody'), NodeFilter.SHOW_COMMENT);
      let n = 0; while (w.nextNode()) if (/^\s*narrate:/.test(w.currentNode.nodeValue)) n++; return n;
    })(),
  }));
  expect(kitchen.annotations).toContain('\\Delta t = t_{remote} - t_{local}');
  expect(kitchen.annotations).toContain('P(\\text{conflict}) = 1 - e^{-\\lambda t}');
  expect(kitchen.imagesHeading).toBe('H2');
  expect(kitchen.linksHeading).toBe('H2');
  expect(kitchen.narrationComments).toBe(1);
  expect(problems, problems.join('\n')).toEqual([]);
});
