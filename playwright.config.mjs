// Browser tests for the viewer. Run: pnpm install && pnpm test
// Locally they use the installed Google Chrome; CI installs Playwright's Chromium.
import { defineConfig } from '@playwright/test';

const PORT = 4173;
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
