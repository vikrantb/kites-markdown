// Shared helpers for the visuals specs. Not a spec itself: Playwright only collects *.spec.mjs.
import { expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

export const THEMES = ['light', 'sepia', 'dark'];
const KNOWN_NOISE = [
  /favicon\.ico/i, // the viewer ships no favicon; the browser asks anyway
  /fonts\.(googleapis|gstatic)\.com/i, // the web fonts are a network fetch, which an offline run cannot make
];

export function collectErrors(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const where = `${m.text()} ${(m.location() && m.location().url) || ''}`;
    if (!KNOWN_NOISE.some((r) => r.test(where))) errors.push(`console: ${where.trim()}`);
  });
  return errors;
}

export async function waitForDiagrams(page) {
  await page.waitForFunction(() => [...document.querySelectorAll('#mdBody .mermaid')]
    .every((el) => el.querySelector('svg') || el.classList.contains('mermaid-error')), null, { timeout: 30_000 });
}

// Colour tools for page.evaluate: any CSS colour (hex, rgb(), oklch(), color-mix() results) to sRGB through a
// canvas, WCAG contrast, and CIELAB dE76. Test-only; installed before the page's own scripts run.
function installColorTools() {
  const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  const rgb = (css, under = '#ffffff') => {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = under;
    ctx.fillRect(0, 0, 1, 1);
    ctx.fillStyle = '#000';
    ctx.fillStyle = css;
    ctx.fillRect(0, 0, 1, 1);
    return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3);
  };
  const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const lum = (c) => { const [r, g, b] = c.map(lin); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const contrast = (a, b) => {
    const [x, y] = [lum(Array.isArray(a) ? a : rgb(a)), lum(Array.isArray(b) ? b : rgb(b))].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };
  const lab = (c) => {
    const [r, g, b] = (Array.isArray(c) ? c : rgb(c)).map(lin);
    const X = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
    const Y = 0.2126729 * r + 0.7151522 * g + 0.0721750 * b;
    const Z = (0.0193339 * r + 0.1191920 * g + 0.9503041 * b) / 1.08883;
    const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
    return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
  };
  const dE = (a, b) => { const p = lab(a), q = lab(b); return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]); };
  const chroma = (c) => { const l = lab(c); return Math.hypot(l[1], l[2]); };
  const hue = (c) => { const l = lab(c); return (Math.atan2(l[2], l[1]) * 180 / Math.PI + 360) % 360; };
  // Colour as seen with deuteranopia or protanopia (Machado, Oliveira and Fernandes 2009, severity 1), as sRGB.
  const MACHADO = {
    deutan: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.011820, 0.042940, 0.968881]],
    protan: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  };
  const cvd = (c, kind) => {
    const v = (Array.isArray(c) ? c : rgb(c)).map(lin);
    return MACHADO[kind].map((row) => {
      const x = Math.min(1, Math.max(0, row[0] * v[0] + row[1] * v[1] + row[2] * v[2]));
      return 255 * (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055);
    });
  };
  window.mdvTestColor = { rgb, contrast, dE, chroma, hue, lab, cvd };
}

export async function open(page, sample, theme = 'light', { waitUntil = 'load' } = {}) {
  const errors = collectErrors(page);
  await page.addInitScript(installColorTools);
  await page.addInitScript((t) => { try { localStorage.setItem('mdv-theme', t); } catch (_) { /* default theme */ } }, theme);
  await page.goto(`markdown-viewer.html?file=samples/${sample}`, { waitUntil });
  await page.waitForSelector('#mdBody h1, #mdBody h2', { timeout: 30_000 });
  await waitForDiagrams(page);
  return errors;
}

// Render a markdown string through the viewer's own entry point, as a loader does.
export async function renderSource(page, src, title = 'test.md') {
  await page.evaluate(([s, t]) => { rawMarkdown = s; renderMarkdown(s, t); }, [src, title]);
  await waitForDiagrams(page);
}

export const rgb = (hex) => {
  const h = hex.trim().replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  return `rgb(${r}, ${g}, ${b})`;
};

export function mermaidFences(sample) {
  const src = readFileSync(new URL(`../../samples/${sample}`, import.meta.url), 'utf8');
  return (src.match(/^```mermaid\s*$/gm) || []).length;
}

// Wait until two reads of `read` 120 ms apart agree (zoom animations last 180 ms).
export async function settled(read) {
  let last = null;
  await expect.poll(async () => {
    const now = await read();
    const same = !!last && JSON.stringify(now) === JSON.stringify(last);
    last = now;
    return same;
  }, { intervals: [120] }).toBe(true);
  return last;
}
