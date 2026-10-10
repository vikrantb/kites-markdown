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
process.exit(failed || orphans.length || !srcs.length ? 1 : 0);
