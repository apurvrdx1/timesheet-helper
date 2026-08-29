import { defineConfig, devices } from '@playwright/test';
import { requireEnv } from './e2e/env';

/**
 * Vite's dev server always serves this app under its configured `base`
 * (vite.config.ts: `/timesheet-helper/`) rather than the origin root, so
 * every relative `page.goto()` in the suite needs a `baseURL` that already
 * carries that path — `page.goto('/')` alone would 404 at the origin root.
 */
const PORT = 5173;
const BASE_URL = `http://localhost:${PORT}/timesheet-helper/`;

/**
 * The app has exactly one backend and `src/auth/client.ts` throws at module
 * load without these two, so a dev server started without them serves a blank
 * page and every test fails on a missing sign-in form instead of on the
 * missing configuration. Locally Vite reads them from `.env.local` itself; in
 * CI they arrive as job environment variables, so they are passed through to
 * the server process explicitly rather than left to inheritance. `requireEnv`
 * names them out loud when they are absent — there is no silent skip.
 */
const WEB_SERVER_ENV = {
  VITE_SUPABASE_URL: requireEnv('VITE_SUPABASE_URL', 'SUPABASE_URL'),
  VITE_SUPABASE_ANON_KEY: requireEnv('VITE_SUPABASE_ANON_KEY', 'SUPABASE_ANON_KEY'),
};

export default defineConfig({
  testDir: './e2e',
  // The journey signs in, waits for the account read, and then drives a few
  // dozen interactions against a REMOTE project rather than the localStorage
  // backend it was originally written for. 30s was a budget for the latter.
  timeout: 120_000,
  expect: { timeout: 5_000 },
  // Tests in a file share the run's fixture accounts, built once in
  // `beforeAll`. Under `fullyParallel` Playwright would split them across
  // workers, and each worker would run that hook — creating a second set of
  // accounts, and tearing down only its own.
  fullyParallel: false,
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
    env: WEB_SERVER_ENV,
    // Local runs reuse whatever `npm run dev` is already up on 5173; CI
    // always starts a fresh server so a stale process can't mask a real
    // failure.
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
