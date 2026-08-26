import { defineConfig, devices } from '@playwright/test';

/**
 * Vite's dev server always serves this app under its configured `base`
 * (vite.config.ts: `/timesheet-helper/`) rather than the origin root, so
 * every relative `page.goto()` in the suite needs a `baseURL` that already
 * carries that path — `page.goto('/')` alone would 404 at the origin root.
 */
const PORT = 5173;
const BASE_URL = `http://localhost:${PORT}/timesheet-helper/`;

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
  },
  // Chromium only (task 21 brief): this is a laptop-first internal tool
  // (DESIGN.md §2.3), not a cross-browser product surface.
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    command: 'npm run dev',
    url: BASE_URL,
    // Local runs reuse whatever `npm run dev` is already up on 5173; CI
    // always starts a fresh server so a stale process can't mask a real
    // failure.
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
