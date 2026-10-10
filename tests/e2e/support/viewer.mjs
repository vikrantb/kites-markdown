// Helpers for the security, controls and render-correctness specs.

// Console noise that is not the viewer's fault (the same list as viewer.spec.mjs keeps).
const KNOWN_NOISE = [/fonts\.(googleapis|gstatic)\.com/i];

// Page errors and console errors, minus known noise and whatever a test expects (`allow`).
export function collectProblems(page, allow = []) {
  const problems = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const where = `${m.text()} ${(m.location() && m.location().url) || ''}`;
    if ([...KNOWN_NOISE, ...allow].some((r) => r.test(where))) return;
    problems.push(`console: ${where.trim()}`);
  });
  return problems;
}

// Every payload in a hostile document assigns window.__mdvPwned. Record each assignment, so a
// payload that runs is caught even if a later one overwrites the value.
export async function recordPayloads(page) {
  await page.addInitScript(() => {
    window.__mdvHits = [];
    Object.defineProperty(window, '__mdvPwned', {
      configurable: true,
      get() { return window.__mdvHits[window.__mdvHits.length - 1]; },
      set(v) { window.__mdvHits.push(String(v)); },
    });
  });
}

export const payloadHits = (page) => page.evaluate(() => window.__mdvHits.slice());

// CSP violations seen by the page.
export async function recordCspViolations(page) {
  await page.addInitScript(() => {
    window.__mdvCsp = [];
    document.addEventListener('securitypolicyviolation', (e) => {
      window.__mdvCsp.push({ directive: e.effectiveDirective || e.violatedDirective, sample: e.sample || '' });
    });
  });
}

// The File System Access pickers open native dialogs; record calls instead.
export async function stubFilePickers(page) {
  await page.addInitScript(() => {
    window.__mdvPickerCalls = [];
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker', 'showDirectoryPicker']) {
      window[name] = async () => {
        window.__mdvPickerCalls.push(name);
        throw new DOMException('stubbed in tests', 'AbortError');
      };
    }
  });
}

export async function setTheme(page, theme) {
  await page.addInitScript((t) => {
    try { localStorage.setItem('mdv-theme', t); } catch (_) { /* storage blocked: default theme */ }
  }, theme);
}

// Open a document by ?file= and wait until it, and every Mermaid diagram in it, has rendered.
export async function openDocument(page, path) {
  await page.goto(`markdown-viewer.html?file=${path}`);
  await page.waitForSelector('#mdBody > *', { timeout: 30_000 });
  await page.waitForFunction(() => [...document.querySelectorAll('#mdBody .mermaid')]
    .every((el) => el.querySelector('svg') || /Mermaid error/.test(el.textContent)), null, { timeout: 30_000 });
}
