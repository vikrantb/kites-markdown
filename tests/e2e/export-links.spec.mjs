// Where the Export menu's links lead: a section's address (a heading's "#" and Copy link to this section), the address
// a page opens at, and the links inside an exported page or a rich-text paste. A link that opens another document, or
// none, is worse than no link, so each test checks the address against the document that is on screen.
import { test, expect } from '@playwright/test';
import { waitForLayoutSettled } from './support/viewer.mjs';
import { renderSource, waitForDiagrams } from './visuals-helpers.mjs';
import { FIXTURE, FIXTURE_DIR, SECTIONS, exportHtml, inspect, menu, openDoc, openInApp, readClipboard, repo, toast } from './export-helpers.mjs';

const HANDOFF = 'tests/fixtures/export/handoff.md';

// Every text the page writes to the clipboard through the async clipboard, recorded instead of written.
async function recordWrites(page) {
  await page.evaluate(() => {
    window.__writes = [];
    navigator.clipboard.writeText = async (t) => { window.__writes.push(t); };
  });
}
const writes = (page) => page.evaluate(() => window.__writes.slice());

async function clickPermalink(page, id) {
  await page.locator(`#${id}`).hover();
  await page.locator(`#${id} .header-anchor`).click();
}

// ---------------------------------------------------------------------------------------------------------------
// The address of a section
// ---------------------------------------------------------------------------------------------------------------

test('a heading\'s "#" copies the address of its section, and the address opens the document there', async ({ page, context, baseURL }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openDoc(page, SECTIONS);
  await page.evaluate(() => document.getElementById('timeline').scrollIntoView({ block: 'center', behavior: 'instant' }));
  await waitForLayoutSettled(page);
  const before = await page.evaluate(() => scrollY);
  await clickPermalink(page, 'timeline');
  const link = `${baseURL}markdown-viewer.html?file=${SECTIONS}#timeline`;
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(link);
  await expect(toast(page)).toHaveText('Link to “Timeline” copied.');
  expect(await page.evaluate(() => location.hash)).toBe('#timeline');
  expect(Math.abs((await page.evaluate(() => scrollY)) - before)).toBeLessThanOrEqual(1); // copied, not jumped

  // Opened: the section is at the top once the document and its diagrams (drawn after the first paint, above the
  // section) have settled.
  const other = await context.newPage();
  await other.goto(link);
  await other.waitForSelector('#mdBody h1');
  await waitForDiagrams(other);
  await waitForLayoutSettled(other);
  const place = await other.evaluate(() => ({
    top: document.getElementById('timeline').getBoundingClientRect().top,
    padding: parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop),
    scrolled: scrollY,
  }));
  expect(place.scrolled).toBeGreaterThan(0);
  expect(Math.abs(place.top - place.padding)).toBeLessThanOrEqual(4);

  // The layout above the section keeps changing after it opens (a late diagram, an image). Chrome's scroll anchoring
  // would hide a drift; WebKit (Safari, the desktop app on a Mac) has none, so turn it off: the section must stay put.
  await other.evaluate(() => {
    document.documentElement.style.overflowAnchor = 'none';
    const late = document.createElement('div');
    late.style.height = '600px';
    document.querySelector('#mdBody .section-content').prepend(late);
  });
  await other.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const after = await other.evaluate(() => document.getElementById('timeline').getBoundingClientRect().top);
  expect(Math.abs(after - place.padding)).toBeLessThanOrEqual(4);
});

test('a section link is copied only while the page\'s address opens the document on screen', async ({ page, baseURL }) => {
  // Positive control: the repository's README, opened by its address.
  await openDoc(page, 'README.md');
  await recordWrites(page);
  const first = await page.locator('#mdBody h2[id]').first().getAttribute('id');
  await clickPermalink(page, first);
  await expect.poll(() => writes(page)).toEqual([`${baseURL}markdown-viewer.html?file=README.md#${first}`]);

  // Another README.md, opened with the Open button. The address still says ?file=README.md, which opens the first one:
  // that link would name the wrong document, so none is copied, by the "#" or by the menu.
  await page.locator('#fileInput').setInputFiles({ name: 'README.md', mimeType: 'text/markdown', buffer: Buffer.from('# Agent workspace\n\n## Next steps\n\nText.\n') });
  await expect(page.locator('#mdBody h1')).toContainText('Agent workspace');
  expect(new URL(page.url()).searchParams.get('file')).toBe('README.md'); // the instrument: the address names a README
  await clickPermalink(page, 'next-steps');
  await expect(toast(page)).toContainText('No link copied');
  await menu(page, 'copy-section-link');
  await expect(toast(page)).toContainText('No link copied');
  expect(await writes(page)).toHaveLength(1);

  // Pasted text has no address either.
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.setData('text/plain', '# Pasted notes\n\n## Blockers\n\nNone today.\n');
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true }));
  });
  await expect(page.locator('#mdBody h1')).toContainText('Pasted notes');
  await clickPermalink(page, 'blockers');
  await expect(toast(page)).toContainText('No link copied');
  expect(await writes(page)).toHaveLength(1);
});

test('a document shown without its address changing (a file handle) copies no link of the address\'s document', async ({ page, baseURL }) => {
  await openDoc(page, SECTIONS);
  await recordWrites(page);
  await clickPermalink(page, 'risks');
  await expect.poll(() => writes(page)).toEqual([`${baseURL}markdown-viewer.html?file=${SECTIONS}#risks`]);
  // As the file-plus button and the startup restore show a file read through its handle: the address stays.
  await renderSource(page, '# Status of another agent\n\n## Risks\n\nOther risks.\n', 'STATUS.md');
  expect(new URL(page.url()).searchParams.get('file')).toBe(SECTIONS);
  await clickPermalink(page, 'risks');
  await expect(toast(page)).toContainText('No link copied');
  expect(await writes(page)).toHaveLength(1);
});

test('a page opened as a file (file://) copies no section link', async ({ page }) => {
  await page.goto(new URL('../../markdown-viewer.html', import.meta.url).href);
  await page.locator('#fileInput').setInputFiles(repo(SECTIONS));
  await page.waitForSelector('#mdBody #risks');
  await recordWrites(page);
  await clickPermalink(page, 'risks');
  await expect(toast(page)).toContainText('No link copied');
  expect(await writes(page)).toEqual([]);
});

test('a link to a section inside a closed <details> opens it there', async ({ page }) => {
  await page.goto(`markdown-viewer.html?file=${SECTIONS}#inside-the-details`);
  await page.waitForSelector('#mdBody h1');
  await waitForDiagrams(page);
  await waitForLayoutSettled(page);
  const r = await page.evaluate(() => {
    const h = document.getElementById('inside-the-details');
    return { open: h.closest('details').open, top: h.getBoundingClientRect().top, padding: parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop) };
  });
  expect(r.open).toBe(true);
  expect(Math.abs(r.top - r.padding)).toBeLessThanOrEqual(4);
});

test('a fragment in the page\'s address goes only to the document the address names', async ({ page }) => {
  // No document named: the welcome screen, then a document opened from disk that has a "timeline" section.
  await page.goto('markdown-viewer.html#timeline');
  await expect(page.locator('#welcomeScreen')).toBeVisible();
  await page.locator('#fileInput').setInputFiles(repo(SECTIONS));
  await page.waitForSelector('#mdBody #timeline');
  await waitForDiagrams(page);
  await waitForLayoutSettled(page);
  expect(await page.evaluate(() => scrollY)).toBe(0);
});

test('the Export menu names the section it will link to, and copies that one', async ({ page, baseURL }) => {
  await openDoc(page, SECTIONS);
  await recordWrites(page);
  await page.evaluate(() => document.getElementById('risks').scrollIntoView({ block: 'start', behavior: 'instant' }));
  await expect.poll(() => page.evaluate(() => mdvSpy.active && mdvSpy.active.id)).toBe('risks');
  await page.locator('#mdvExportBtn').click();
  const item = page.locator('#mdvExportDD [data-action="copy-section-link"]');
  await expect(item).toHaveText('Copy link to “Risks”');
  await item.click();
  await expect.poll(() => writes(page)).toEqual([`${baseURL}markdown-viewer.html?file=${SECTIONS}#risks`]);
  await expect(toast(page)).toHaveText('Link to “Risks” copied.');
  // Elsewhere in the document, the item names that section instead.
  await page.evaluate(() => document.getElementById('timeline').scrollIntoView({ block: 'start', behavior: 'instant' }));
  await expect.poll(() => page.evaluate(() => mdvSpy.active && mdvSpy.active.id)).toBe('timeline');
  await page.locator('#mdvExportBtn').click();
  await expect(item).toHaveText('Copy link to “Timeline”');
});

test('a "#" that a document writes itself copies nothing; the viewer\'s own does', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  // The forged one even guesses at the mark the viewer gives its own permalinks. (Served to the page's own address
  // loader, so the genuine one has an address to copy.)
  await page.route((url) => url.pathname.endsWith('/forged-permalink.md'), (route) => route.fulfill({ status: 200, contentType: 'text/markdown; charset=utf-8', body:
    '# Two kinds of permalink\n\n<h2 id="forged">Forged <a class="header-anchor" href="#forged" data-mdv-permalink="0123456789abcdef0123456789abcdef">#</a></h2>\n\nText.\n\n## Genuine\n\nText.\n' }));
  await openDoc(page, 'tests/fixtures/export/forged-permalink.md');
  await page.evaluate(() => navigator.clipboard.writeText('clipboard before'));
  await page.locator('#forged').hover();
  await page.locator('#forged .header-anchor').click({ force: true });
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('clipboard before');
  // Positive control: the permalink markdown-it made for a heading of the same document.
  await clickPermalink(page, 'genuine');
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toMatch(/#genuine$/);
});

// ---------------------------------------------------------------------------------------------------------------
// Links inside an export or a paste
// ---------------------------------------------------------------------------------------------------------------

test('Export HTML and Copy as rich text resolve a document\'s links to other files, so they open from the copy', async ({ page, context, baseURL }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openDoc(page, HANDOFF);
  const viewer = (path, fragment) => `${baseURL}markdown-viewer.html?file=${path}#${fragment}`;
  const { html } = await exportHtml(page);
  await expect(toast(page)).toHaveText('Downloading handoff.html: 2 links go to files on this computer.');
  const x = await inspect(page, html);
  const href = (text) => (x.links.find((l) => l.text === text) || {}).href;
  // Written relative to the document (../export/sections.md#risks, sections.md#timeline): each now opens in the viewer.
  expect(href('status report')).toBe(viewer('tests/fixtures/export/sections.md', 'risks'));
  expect(href('timeline')).toBe(viewer('tests/fixtures/export/sections.md', 'timeline'));
  // A footnote is a place in the page: its links stay in-page.
  expect(x.links.filter((l) => l.href.startsWith('#fn')).length).toBeGreaterThan(0);

  // The address opens that document at that section.
  const other = await context.newPage();
  await other.goto(href('status report'));
  await other.waitForSelector('#mdBody #risks');
  await waitForDiagrams(other);
  await waitForLayoutSettled(other);
  expect(await other.evaluate(() => document.querySelector('#mdBody h1').textContent)).toContain('Release handoff');
  expect(Math.abs(await other.evaluate(() => document.getElementById('risks').getBoundingClientRect().top - parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop)))).toBeLessThanOrEqual(4);
  await other.close();

  // The paste: the same addresses; a place in the document (the footnote mark, its way back) is only words there.
  await menu(page, 'copy-rich-text');
  await expect(toast(page)).toHaveText('Copied the document as rich text: 2 links go to files on this computer.');
  const clip = await readClipboard(page);
  const pasted = await page.evaluate((h) => {
    const d = new DOMParser().parseFromString(h, 'text/html');
    return { links: [...d.querySelectorAll('a[href]')].map((a) => ({ text: a.textContent.trim(), href: a.getAttribute('href') })), backrefs: d.querySelectorAll('.footnote-backref').length };
  }, clip.html);
  expect(pasted.links.find((l) => l.text === 'status report').href).toBe(viewer('tests/fixtures/export/sections.md', 'risks'));
  expect(pasted.links.filter((l) => l.href.startsWith('#'))).toEqual([]);
  expect(pasted.backrefs).toBe(0);
  // The plain text keeps the words, without a local address after them.
  expect(clip.text).toContain('tracked in the status report and the timeline.');
});

test('with no address to resolve them from, an export keeps links as written and a paste keeps their words, and both say so', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('markdown-viewer.html');
  await page.locator('#fileInput').setInputFiles(repo(HANDOFF));
  await page.waitForSelector('#mdBody h1');
  await waitForDiagrams(page);
  const { html } = await exportHtml(page);
  await expect(toast(page)).toHaveText('Downloading handoff.html: 2 links point at files next to the document.');
  const x = await inspect(page, html);
  expect(x.links.find((l) => l.text === 'status report').href).toBe('../export/sections.md#risks');
  await menu(page, 'copy-rich-text');
  await expect(toast(page)).toHaveText('Copied the document as rich text: 2 links to other files became plain text.');
  const clip = await readClipboard(page);
  const hrefs = await page.evaluate((h) => [...new DOMParser().parseFromString(h, 'text/html').querySelectorAll('a[href]')].map((a) => a.getAttribute('href')), clip.html);
  expect(hrefs.filter((h) => !/^(https?:|mailto:)/.test(h))).toEqual([]);
  expect(clip.html).toContain('status report');
});

// ---------------------------------------------------------------------------------------------------------------
// The desktop app (stand-in shell, the app's CSP)
// ---------------------------------------------------------------------------------------------------------------

test('in the desktop app a section link is the document\'s path, and following it there goes to the section', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  // The path form: a link in any document can take it (a file: link is dropped by markdown-it and the sanitizer).
  const own = `${FIXTURE_DIR}/doc.md#section-two`;
  await openInApp(page, `${FIXTURE}\n\n## Further down\n\n${'A paragraph of words to read. '.repeat(60)}\n\n${'Another paragraph of words. '.repeat(60)}\n\n[Back to section two](${own})\n`);
  const start = page.url();
  await clickPermalink(page, 'section-two');
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(own);
  expect(page.url()).toBe(start); // the app has no address bar to update

  // The app's own way of following a link (js/host.js) takes it to the section, in this window.
  await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' }));
  await page.locator('#mdBody a', { hasText: 'Back to section two' }).click();
  await expect.poll(() => page.evaluate(() => {
    const top = document.getElementById('section-two').getBoundingClientRect().top;
    return top >= 0 && top < innerHeight / 2;
  })).toBe(true);
  expect(await page.evaluate(() => window.__calls.filter((c) => c.cmd === 'mdv_open_path'))).toEqual([]);
});

test('in the desktop app a link to a section of the same document unfolds its section and opens its <details>', async ({ page }) => {
  const own = `${FIXTURE_DIR}/doc.md`;
  await openInApp(page, `# Linked sections\n\n[To the folded one](${own}#folded-target) and [into the details](${own}#hidden-target).\n\n` +
    `## Folded section\n\n### Folded target\n\nUnder a folded heading.\n\n## Open section\n\n<details>\n<summary>More</summary>\n\n### Hidden target\n\nInside a closed details block.\n\n</details>\n`);
  await page.evaluate(() => toggleSection(document.getElementById('folded-section')));
  const box = (id) => page.evaluate((i) => document.getElementById(i).getClientRects().length > 0, id);
  expect(await box('folded-target')).toBe(false); // the instrument: folded away, it has no box
  await page.locator('#mdBody a', { hasText: 'To the folded one' }).click();
  await expect.poll(() => box('folded-target')).toBe(true);
  await page.locator('#mdBody a', { hasText: 'into the details' }).click();
  await expect.poll(() => page.evaluate(() => document.getElementById('hidden-target').closest('details').open)).toBe(true);
  await expect.poll(() => box('hidden-target')).toBe(true);
  expect(await page.evaluate(() => window.__calls.filter((c) => c.cmd === 'mdv_open_path'))).toEqual([]);
});
