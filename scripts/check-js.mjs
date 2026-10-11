// Syntax check of every script the viewer loads, as a CLASSIC script (the grammar the browser uses for a
// plain <script src>), with no execution. $0 and instant; it does not check behaviour (the browser tests do).
// Usage: node scripts/check-js.mjs   (exits 1 on the first file that does not parse)
import { readFileSync, readdirSync } from 'node:fs';
import { Script } from 'node:vm';

const html = readFileSync(new URL('../markdown-viewer.html', import.meta.url), 'utf8');
const srcs = [...html.matchAll(/<script\s+src="(js\/[^"]+)"/g)].map((m) => m[1]);
const onDisk = readdirSync(new URL('../js/', import.meta.url)).filter((f) => f.endsWith('.js')).map((f) => `js/${f}`);
const orphans = onDisk.filter((f) => !srcs.includes(f));
let failed = 0;
for (const src of srcs) {
  try {
    new Script(readFileSync(new URL(`../${src}`, import.meta.url), 'utf8'), { filename: src });
    console.log(`ok    ${src}`);
  } catch (e) {
    failed++;
    console.error(`FAIL  ${src}: ${e.message}`);
  }
}
console.log(`${srcs.length - failed} of ${srcs.length} scripts parse`);
if (orphans.length) console.error(`FAIL  js/ files that no <script> tag loads: ${orphans.join(', ')}`);
if (!srcs.length) console.error('FAIL  markdown-viewer.html loads no js/ scripts');

// The scripts share one global scope, so a name declared at the top level of two of them is one name: a second
// function declaration silently replaces the first for every script (copy.js once replaced the comment code's
// mdvBlockText, which hashes comment anchors), and a second let or const stops the later script from loading. A
// declaration that starts a line is taken as top level: the scripts indent everything inside a function or block.
const declaredIn = new Map();
for (const src of srcs) {
  const text = readFileSync(new URL(`../${src}`, import.meta.url), 'utf8');
  for (const m of text.matchAll(/^(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)|^(?:let|const|var|class)\s+([A-Za-z_$][\w$]*)/gm)) {
    const name = m[1] || m[2];
    if (!declaredIn.has(name)) declaredIn.set(name, new Set());
    declaredIn.get(name).add(src);
  }
}
const twice = [...declaredIn].filter(([, files]) => files.size > 1);
for (const [name, files] of twice) console.error(`FAIL  ${name} is declared at the top level of ${[...files].join(' and ')}: one replaces the other`);
console.log(`${declaredIn.size} top-level names, ${twice.length} declared by more than one script`);
process.exit(failed || orphans.length || !srcs.length || twice.length ? 1 : 0);
