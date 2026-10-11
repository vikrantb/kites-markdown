// Browser tests for the viewer. Run: pnpm install && pnpm test
// Locally they use the installed Google Chrome; CI installs Playwright's Chromium.
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

// One port per checkout. With a fixed port and reuseExistingServer, a second worktree testing at the same time
// reused the first one's server and silently tested the other tree's code. MDV_TEST_PORT overrides.
const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.MDV_TEST_PORT)
  || 4173 + (parseInt(createHash('sha1').update(ROOT).digest('hex').slice(0, 6), 16) % 2000);
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 90_000,
  fullyParallel: true,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}/`,
    viewport: { width: 1366, height: 900 },
    channel: process.env.CI ? undefined : 'chrome',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: `node tests/serve.mjs ${PORT}`,
    url: `http://127.0.0.1:${PORT}/markdown-viewer.html`,
    reuseExistingServer: !process.env.CI,
    stdout: 'ignore',
  },
});
