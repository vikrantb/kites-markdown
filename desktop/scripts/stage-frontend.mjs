// Stages the viewer as the desktop app's frontend: desktop/dist/index.html is markdown-viewer.html, next to
// copies of css/, js/ and vendor/. The viewer stays the single source; nothing here is edited by hand.
//
// Two checks make a broken app fail the build instead of failing on someone's screen:
// - every local script and stylesheet the page loads must exist, and js/host.js must be among them;
// - inline event handlers (onclick="…") are counted: the app's Content Security Policy blocks them, so
//   any that remain are buttons that do nothing in the app. They are reported; `--strict` fails on them.
//
// Usage, from desktop/: node scripts/stage-frontend.mjs [--strict]   (tauri dev/build run it for you)
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';

const root = new URL('../../', import.meta.url);
const dist = new URL('../dist/', import.meta.url);
const strict = process.argv.includes('--strict');

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

let html = readFileSync(new URL('markdown-viewer.html', root), 'utf8');
// The app makes no third-party requests. Web-font links would only be blocked by its CSP (font-src
// 'self'), so they are left out and the page uses its font fallbacks until the fonts are vendored.
const before = html.length;
html = html.replace(/^[ \t]*<link\b[^>]*\bhref="https:\/\/fonts\.(?:googleapis|gstatic)\.com[^"]*"[^>]*>[ \t]*\r?\n/gm, '');
const droppedFontLinks = before !== html.length;
writeFileSync(new URL('index.html', dist), html);
for (const dir of ['css', 'js', 'vendor']) {
  cpSync(new URL(`${dir}/`, root), new URL(`${dir}/`, dist), { recursive: true });
}

const local = (u) => !/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(u);
const refs = [...html.matchAll(/<(?:script|link)\b[^>]*?\b(?:src|href)="([^"]+)"/g)].map((m) => m[1]).filter(local);
const missing = refs.filter((r) => !existsSync(new URL(r, dist)));
const problems = [];
if (missing.length) problems.push(`the page loads files that do not exist: ${missing.join(', ')}`);
if (!refs.includes('js/host.js')) problems.push('markdown-viewer.html does not load js/host.js, so the app could not reach its files');

const handlerRe = /\son(?:click|change|input|keydown|keyup|submit|load|error|mouse\w+)\s*=\s*["'\\]/gi;
const inMarkup = (html.match(handlerRe) || []).length;
let inScripts = 0;
for (const f of readdirSync(new URL('js/', root)).filter((n) => n.endsWith('.js'))) {
  inScripts += (readFileSync(new URL(`js/${f}`, root), 'utf8').match(handlerRe) || []).length;
}
const inline = inMarkup + inScripts;

console.log(`staged dist/index.html + css/ js/ vendor/ (${refs.length} local files referenced${droppedFontLinks ? ', web-font links left out' : ''})`);
if (inline) {
  const msg = `${inline} inline event handlers (${inMarkup} in the markup, ${inScripts} in js/) are blocked by the app's CSP`;
  if (strict) problems.push(msg);
  else console.warn(`warning: ${msg}; the buttons that use them do nothing in the app`);
}
if (problems.length) {
  for (const p of problems) console.error(`error: ${p}`);
  process.exit(1);
}
