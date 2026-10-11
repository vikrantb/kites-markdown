// Render correctness: dollar-sign math follows Pandoc's rules and never touches code; frontmatter
// of any shape renders; a render failure is reported as one; a missing library is named; the page
// has an icon; every icon-only button has a name.
import { test, expect } from '@playwright/test';
import { collectProblems, recordPayloads, payloadHits, openDocument, setTheme } from './support/viewer.mjs';

// What each case in tests/fixtures/math-dollars.md must become. `math` counts inline KaTeX in the
// case, `display` counts display formulas, `text` is the case's text with any math removed.
const MATH_CASES = {
  D01: { math: 1 },
  D02: { math: 0, text: 'costs $5 and $10 per month' },
  D03: { math: 0, text: '$ x$' },
  D04: { math: 0, text: '$x $' },
  D05: { math: 0, text: '$x$5' },
  D06: { math: 0, text: 'escaped dollars: $x$' },
  D07: { math: 1, tex: 'a\\$b' },
  D08: { math: 0, code: 'echo $HOME $PATH' },
  D09: { math: 0, code: 'y' },
  D10: { display: 1 },
  D11: { math: 1, emphasis: 0 },
  D12: { math: 0, code: '$PATH', text: 'costs $5, see' },
  D13: { math: 0, text: 'US$5 and US$10' },
  D14: { math: 0, text: '$5/$10' },
  D15: { math: 1 },
  D16: { comment: 'D16 a narration that mentions $5 and $10' },
  D17: { display: 1 },
  D18: { math: 0 },
  D19: { display: 1 },
  D20: { display: 1 },
  D21: { math: 0, code: 'echo "$HOME" and "$PATH"' },
  // Pandoc's rule, kept on purpose: "$ a + b $" was math before this change and is text now.
  D22: { math: 0, text: '$ a + b $' },
  // An inline comment is left alone, even after a lone dollar ("-->" must not leak onto the page).
  D23: { math: 0, text: '$x stays a comment' },
};

test('dollar signs follow Pandoc\'s rules and never become math inside code', async ({ page }) => {
  const problems = collectProblems(page);
  await openDocument(page, 'tests/fixtures/math-dollars.md');
  const seen = await page.evaluate(() => {
    const body = document.getElementById('mdBody');
    const plain = (el) => {
      const c = el.cloneNode(true);
      c.querySelectorAll('.katex').forEach((k) => k.remove());
      return c.textContent.replace(/\s+/g, ' ').trim();
    };
    const describe = (el) => ({
      math: el.querySelectorAll('.katex').length - el.querySelectorAll('.katex-display .katex').length,
      display: el.querySelectorAll('.katex-display').length,
      text: plain(el),
      code: [...el.querySelectorAll('code')].map((c) => c.textContent),
      tex: [...el.querySelectorAll('annotation')].map((a) => a.textContent),
      emphasis: el.querySelectorAll('em, strong').length,
    });
    const out = {};
    for (const li of body.querySelectorAll('li')) {
      const id = (li.textContent.trim().match(/^(D\d\d)\b/) || [])[1];
      if (id) out[id] = describe(li);
    }
    const row = [...body.querySelectorAll('tr')].find((tr) => tr.cells[0] && tr.cells[0].textContent.trim() === 'D15');
    if (row) out.D15 = describe(row.cells[1]);
    for (const id of ['D17', 'D19']) {
      const p = [...body.querySelectorAll('p')].find((el) => el.textContent.startsWith(id));
      if (p && p.nextElementSibling) out[id] = describe(p.nextElementSibling);
    }
    const d18 = [...body.querySelectorAll('p')].find((el) => el.textContent.startsWith('D18'));
    if (d18) {
      const a = d18.nextElementSibling; const b = a && a.nextElementSibling;
      out.D18 = { math: [a, b].reduce((n, el) => n + (el ? el.querySelectorAll('.katex').length : 0), 0) };
    }
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_COMMENT);
    while (walker.nextNode()) {
      if (walker.currentNode.nodeValue.includes('D16')) out.D16 = { comment: walker.currentNode.nodeValue.replace(/^\s*narrate:\s*/, '').trim() };
    }
    const pre = [...body.querySelectorAll('pre')].find((el) => el.textContent.includes('D21'));
    if (pre) out.D21 = describe(pre);
    return out;
  });

  const wrong = [];
  for (const [id, want] of Object.entries(MATH_CASES)) {
    const got = seen[id];
    if (!got) { wrong.push(`${id}: not found`); continue; }
    for (const [key, value] of Object.entries(want)) {
      const ok = key === 'text' ? got.text.includes(value)
        : key === 'code' ? got.code.some((c) => c === value || c.startsWith(value))
        : key === 'tex' ? got.tex.includes(value)
        : got[key] === value;
      if (!ok) wrong.push(`${id}.${key}: wanted ${JSON.stringify(value)}, got ${JSON.stringify(got[key])}`);
    }
  }
  console.log(`dollar cases right: ${Object.keys(MATH_CASES).length - new Set(wrong.map((w) => w.slice(0, 3))).size} of ${Object.keys(MATH_CASES).length}`);
  expect(wrong, wrong.join('\n')).toEqual([]);
  expect(await page.locator('#mdBody .katex-error').count()).toBe(0);
  expect(problems, problems.join('\n')).toEqual([]);
});

for (const theme of ['light', 'dark']) {
  test(`the dollar-sign repro renders as GitHub does, in the ${theme} theme`, async ({ page }, info) => {
    const problems = collectProblems(page);
    await setTheme(page, theme);
    await openDocument(page, 'samples/repro-dollar-signs.md');
    const r = await page.evaluate(() => {
      const body = document.getElementById('mdBody');
      return {
        katex: body.querySelectorAll('.katex').length,
        katexInCode: body.querySelectorAll('code .katex, pre .katex').length,
        prices: body.textContent.includes('The basic plan costs $5 and the pro plan costs $10 per month.'),
        inlineCode: [...body.querySelectorAll('p code')].map((c) => c.textContent),
        block: body.querySelector('pre code.hljs')?.textContent || '',
        formula: body.querySelector('.katex annotation')?.textContent,
      };
    });
    expect(r.katex).toBe(1);
    expect(r.katexInCode).toBe(0);
    expect(r.prices).toBe(true);
    expect(r.inlineCode).toContain('echo $HOME $PATH');
    expect(r.block).toContain('echo "$HOME" and "$PATH"');
    expect(r.formula).toBe('a^2 + b^2 = c^2');
    await page.screenshot({ path: info.outputPath(`repro-dollar-signs-${theme}.png`), fullPage: true, animations: 'disabled' });
    expect(problems, problems.join('\n')).toEqual([]);
  });
}

test('the kitchen sink and the built-in demo still typeset all their math', async ({ page }) => {
  const problems = collectProblems(page);
  await openDocument(page, 'samples/kitchen-sink.md');
  const count = () => page.evaluate(() => ({
    inline: document.querySelectorAll('#mdBody .katex').length - document.querySelectorAll('#mdBody .katex-display .katex').length,
    display: document.querySelectorAll('#mdBody .katex-display').length,
    errors: document.querySelectorAll('#mdBody .katex-error').length,
  }));
  expect(await count()).toEqual({ inline: 4, display: 1, errors: 0 });
  await page.goto('markdown-viewer.html#demo');
  await page.waitForSelector('#mdBody h1');
  expect(await count()).toEqual({ inline: 1, display: 1, errors: 0 });
  expect(problems, problems.join('\n')).toEqual([]);
});

test('an empty frontmatter field does not stop the document, or its dashboard, from rendering', async ({ page }) => {
  const problems = collectProblems(page);
  // The dashboard is built inside its own try/catch, so a failure there is only a warning: count those too.
  const warnings = [];
  page.on('console', (m) => { if (m.type() === 'warning') warnings.push(m.text()); });
  await openDocument(page, 'tests/fixtures/frontmatter-empty-fields.md');
  await expect(page.locator('#mdBody h1')).toHaveText(/Empty frontmatter fields/);
  await expect(page.locator('#welcomeScreen')).toBeHidden();
  expect(await page.locator('body').textContent()).not.toContain('File not found');
  const d = await page.evaluate(() => {
    const dash = document.querySelector('#mdBody .fm-dashboard');
    return {
      dashboard: Boolean(dash),
      status: dash ? dash.querySelectorAll('.fm-status-badge').length : null,
      date: dash ? dash.querySelectorAll('.fm-date').length : null,
      metrics: [...(dash ? dash.querySelectorAll('.fm-metric') : [])].map((m) => m.textContent.trim()),
      repos: [...(dash ? dash.querySelectorAll('.fm-repo-badge') : [])].map((r) => `${r.tagName}:${r.textContent.trim()}`),
    };
  });
  expect(d).toEqual({ dashboard: true, status: 0, date: 0, metrics: ['4Open questions'], repos: ['A:\u2605 linked'] });
  expect(warnings.filter((w) => /frontmatter/i.test(w)), 'frontmatter warnings').toEqual([]);
  expect(problems, problems.join('\n')).toEqual([]);
});

test('frontmatter in odd shapes still gives a dashboard', async ({ page }) => {
  const problems = collectProblems(page);
  await openDocument(page, 'tests/fixtures/frontmatter-odd-shapes.md');
  const d = await page.evaluate(() => {
    const dash = document.querySelector('#mdBody .fm-dashboard');
    return {
      status: dash?.querySelector('.fm-status-badge')?.className,
      date: dash?.querySelectorAll('.fm-date').length,
      metrics: [...(dash?.querySelectorAll('.fm-metric') || [])].map((m) => m.textContent.trim()),
      repos: [...(dash?.querySelectorAll('.fm-repo-badge') || [])].map((r) => `${r.tagName}:${r.textContent.trim()}`),
    };
  });
  expect(d.status).toContain('in-progress');
  expect(d.date).toBe(0);
  expect(d.metrics).toEqual(['plain text metric', '4Open questions']);
  expect(d.repos).toEqual(['SPAN:plain-name', 'A:\u2605 linked']);
  expect(problems, problems.join('\n')).toEqual([]);
});

for (const theme of ['light', 'dark']) {
  test(`a document that cannot be rendered is shown as an error with its text, not as "not found" (${theme})`, async ({ page }, info) => {
    // A markdown-it plugin that throws on every render stands in for any render failure.
    await page.route('**/vendor/markdown-it-deflist.min.js', (route) => route.fulfill({
      contentType: 'text/javascript',
      body: "window.markdownitDeflist = function (md) { md.core.ruler.push('test_failure', function () { throw new Error('test: the renderer failed'); }); };",
    }));
    const problems = collectProblems(page, [/Render error/]);
    await setTheme(page, theme);
    await page.goto('markdown-viewer.html?file=samples/kitchen-sink.md');
    await expect(page.locator('#mdBody')).toContainText('This document could not be rendered');
    await expect(page.locator('#mdBody')).toContainText('test: the renderer failed');
    await expect(page.locator('#mdBody pre code')).toContainText('# Offline Sync Design Review');
    await expect(page.locator('#welcomeScreen')).toBeHidden();
    expect(await page.locator('body').textContent()).not.toContain('File not found');
    await page.screenshot({ path: info.outputPath(`render-error-${theme}.png`), animations: 'disabled' });
    expect(problems, problems.join('\n')).toEqual([]);
  });
}

test('the page has its own icon, so the browser never asks for favicon.ico', async ({ page }, info) => {
  const asked = [];
  page.on('request', (r) => { if (/favicon/i.test(r.url())) asked.push(r.url()); });
  await page.goto('markdown-viewer.html');
  await page.waitForLoadState('load');
  await page.waitForTimeout(500);
  expect(asked).toEqual([]);
  const href = await page.locator('link[rel="icon"]').getAttribute('href');
  expect(href).toMatch(/^data:image\/svg\+xml,/);
  // The icon decodes and draws; show it at tab size and large for a human look.
  const drawn = await page.evaluate((src) => new Promise((resolve) => {
    const img = new Image();
    img.addEventListener('load', () => resolve(img.naturalWidth));
    img.addEventListener('error', () => resolve(0));
    img.src = src;
  }), href);
  expect(drawn).toBeGreaterThan(0);
  await page.setContent(`<body style="margin:0;padding:12px;background:#fff;display:flex;gap:16px;align-items:end">
    <img src="${href}" width="16" height="16"><img src="${href}" width="32" height="32"><img src="${href}" width="96" height="96"></body>`);
  await page.screenshot({ path: info.outputPath('favicon.png'), clip: { x: 0, y: 0, width: 200, height: 120 } });
});

test('a library that does not load is named once in the console and in a dismissible notice', async ({ page }, info) => {
  const blocked = ['katex.min.js', 'mermaid.min.js', 'highlight.min.js', 'markdown-it-footnote.min.js'];
  for (const lib of blocked) await page.route(`**/vendor/${lib}`, (route) => route.abort());
  const warnings = [];
  page.on('console', (m) => { if (m.type() === 'warning' && / is off: /.test(m.text())) warnings.push(m.text()); });
  const problems = collectProblems(page, [/vendor\/(katex|mermaid|highlight|markdown-it-footnote)/]);
  await page.goto('markdown-viewer.html?file=samples/kitchen-sink.md');
  await page.waitForSelector('#mdBody h1');

  expect(warnings).toHaveLength(4);
  for (const feature of ['Math', 'Mermaid diagrams', 'Code highlighting', 'Footnotes']) {
    expect(warnings.filter((w) => w.startsWith(`${feature} is off`)), feature).toHaveLength(1);
  }
  const notice = page.locator('.mdv-notice');
  await expect(notice).toHaveCount(1);
  await expect(notice).toBeVisible();
  for (const feature of ['Math', 'Mermaid diagrams', 'Code highlighting', 'Footnotes']) await expect(notice).toContainText(feature);
  // Without KaTeX the formulas stay readable as TeX.
  await expect(page.locator('#mdBody code.mdv-math-source').first()).toContainText('$\\Delta t');
  // The notice sits above the document, not over it: the dashboard at the top stays readable.
  const covers = await page.evaluate(() => {
    const a = document.querySelector('.mdv-notice').getBoundingClientRect();
    const b = document.querySelector('#mdBody .fm-dashboard').getBoundingClientRect();
    return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  });
  expect(covers, 'the notice covers the dashboard').toBe(false);
  await page.screenshot({ path: info.outputPath('library-notice-light.png'), animations: 'disabled' });
  await page.evaluate(() => setTheme('dark'));
  await page.screenshot({ path: info.outputPath('library-notice-dark.png'), animations: 'disabled' });
  await notice.getByRole('button', { name: 'Dismiss' }).click();
  await expect(notice).toHaveCount(0);
  expect(problems, problems.join('\n')).toEqual([]);
});

test('without the sanitizer, raw HTML is shown as text and still nothing runs', async ({ page }) => {
  await page.route('**/vendor/purify.min.js', (route) => route.abort());
  await recordPayloads(page);
  const problems = collectProblems(page, [/vendor\/purify/, /does-not-exist\.png/]);
  await page.route(/example\.(invalid|com)/, (route) => route.abort());
  await openDocument(page, 'tests/fixtures/hostile.md');
  await expect(page.locator('.mdv-notice')).toContainText('Raw HTML (shown as text');
  await page.locator('#mdBody .fm-repo-badge').last().hover();
  await page.waitForTimeout(300);
  expect(await payloadHits(page)).toEqual([]);
  expect(await page.locator('#mdBody img#img-onerror, #mdBody script, #mdBody iframe').count()).toBe(0);
  await expect(page.locator('#mdBody')).toContainText('<script>window.__mdvPwned');
  // Neither repository URL is a web address, so neither is a link; "java<TAB>script:" included, which
  // the browser's URL parser reads as javascript: (it drops tabs).
  const repos = await page.evaluate(() => [...document.querySelectorAll('#mdBody .fm-repo-badge')].map((b) => b.tagName));
  expect(repos).toEqual(['SPAN', 'SPAN']);
  expect(problems, problems.join('\n')).toEqual([]);
});

test('every button has an accessible name, and icon-only ones an aria-label', async ({ page }) => {
  await page.goto('markdown-viewer.html');
  const unnamed = await page.evaluate(() => [...document.querySelectorAll('button')]
    .filter((b) => !/[\p{L}\p{N}]{2,}/u.test(b.textContent) && !(b.getAttribute('aria-label') || '').trim())
    .map((b) => b.id || b.title || b.className));
  expect(unnamed, 'icon-only buttons without an aria-label').toEqual([]);
  await expect(page.locator('#widthBtn')).toHaveAccessibleName('Toggle page width');
  await page.locator('.toolbar button[title^="Search"]').click();
  await expect(page.locator('#searchInput')).toHaveAccessibleName('Search headings and content');
  await page.keyboard.press('Escape');
  await page.locator('.toolbar button[title="Settings"]').click();
  await expect(page.locator('#basePathInput')).toHaveAccessibleName('Workspace Root Path');
});
