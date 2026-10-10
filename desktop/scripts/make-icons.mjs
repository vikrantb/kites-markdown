// Makes every app icon from app-icon.svg: renders it to a 1024×1024 PNG with a transparent background
// (Chrome, through the Playwright the repository's browser tests install), runs `tauri icon` on it, and
// keeps only the icons the desktop bundles use (no Android, iOS or Windows Store tiles).
// Usage, from desktop/: pnpm icon   (needs `pnpm install` at the repository root as well)
import { readFileSync, rmSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const png = here('../app-icon.png');
const icons = here('../src-tauri/icons/');
const KEEP = new Set(['32x32.png', '128x128.png', '128x128@2x.png', 'icon.icns', 'icon.ico', 'icon.png']);

const browser = await chromium.launch({ channel: process.env.CI ? undefined : 'chrome' });
try {
  const page = await browser.newPage({ viewport: { width: 1024, height: 1024 }, deviceScaleFactor: 1 });
  const svg = readFileSync(here('../app-icon.svg'), 'utf8');
  await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent">${svg}</body></html>`);
  await page.locator('svg').first().screenshot({ path: png, omitBackground: true });
  console.log(`rendered ${png}`);
} finally {
  await browser.close();
}

const tauri = here(`../node_modules/.bin/tauri${process.platform === 'win32' ? '.cmd' : ''}`);
execFileSync(tauri, ['icon', png, '--output', icons], { stdio: 'inherit', shell: process.platform === 'win32' });
for (const name of readdirSync(icons)) {
  if (!KEEP.has(name)) rmSync(`${icons}${name}`, { recursive: true, force: true });
}
console.log(`kept: ${[...KEEP].join(', ')}`);
