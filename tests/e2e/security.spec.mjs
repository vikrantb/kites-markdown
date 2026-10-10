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

  // Touch what a reader might touch.
  for (const sel of ['#link-javascript', '#form-submit', '#doc-action', '#svg-onload']) {
    const target = page.locator(`#mdBody ${sel}`);
    if (await target.count()) await target.first().click({ force: true });
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
      documentLabel: (() => {
        const el = [...body.querySelectorAll('div')].find((d) => d.textContent.startsWith('A document element named'));
        return el ? { kept: true, id: el.id } : { kept: false };
      })(),
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
  expect(dom.documentLabel, 'the document element is kept, without the viewer\'s id').toEqual({ kept: true, id: '' });
  expect(dom.toolbarVisible, 'a document <style> hid the toolbar').toBe(true);
  expect(dom.h1).toContain('A hostile document');
  expect(dom.tables).toBe(1);
  expect(dom.dataImage).toBe(1);
  expect(dom.benignSvg).toBe(1);
  expect(dom.diagrams).toBe(1);
  expect({ links: dom.repoLinks, badges: dom.repoBadges }, 'a non-web repository URL is a plain badge').toEqual({ links: 0, badges: 1 });
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

test('a comment card that breaks out of its attribute still cannot run script', async ({ page }) => {
  await recordPayloads(page);
  await recordCspViolations(page);
  await openDocument(page, 'tests/fixtures/comment-sidebar-injection.md');
  await page.locator('#mdvToggleBtn').click();
  await expect(page.locator('#mdvSidebar')).toHaveClass(/open/);
  const card = page.locator('#mdvThreadList .mdv-comment').first();
  await card.hover();
  await page.waitForTimeout(300);
  expect(await payloadHits(page)).toEqual([]);
  // comments.js escapes the value without its quotes (see the PR); until it does, the attribute
  // lands in the sidebar and the CSP is what stops it.
  if (await page.locator('#mdvThreadList [onmouseover]').count()) {
    expect((await page.evaluate(() => window.__mdvCsp)).map((v) => v.directive)).toContain('script-src-attr');
  }
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
  const narration = await page.evaluate(() => ttsSections.flatMap((s) => s.items).find((t) => t.startsWith('Two boxes')));
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
