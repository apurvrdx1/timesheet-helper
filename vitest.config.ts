import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    // Playwright's e2e/*.spec.ts files match Vitest's default `*.spec.ts`
    // include glob too — without this exclude, `npm test` would also try
    // (and fail) to run them under jsdom with the `@playwright/test` API.
    // `configDefaults.exclude` is spread in first so this stays additive
    // rather than silently dropping Vitest's own node_modules/dist/etc.
    // exclusions.
    // `*.integration.test.ts` runs against a real Supabase project and needs
    // network plus credentials. It has its own config
    // (`vitest.integration.config.ts`, `npm run test:integration`) and must
    // never join this suite: a developer with no credentials would otherwise
    // see failures that say nothing about their code.
    exclude: [...configDefaults.exclude, 'e2e/**', '**/*.integration.test.ts'],
    setupFiles: ['./src/test-setup.ts'],
    // Must stay comfortably ABOVE the 5000ms `asyncUtilTimeout` set in
    // src/test-setup.ts, which explains why that number is what it is. A test
    // that loses the live-region race can now spend ~2s inside a single
    // `findBy*`, and several such assertions plus `userEvent` typing in one
    // test would blow the 5000ms default long before anything was wrong.
    // Equal budgets would just move the failure from the assertion to the
    // test, reporting a timeout where the truth is "this ran slowly".
    //
    // This is a ceiling on pathology, not a target: the whole suite takes
    // ~11s wall clock on an idle 10-core machine and ~20s under heavy
    // contention, and the slowest single test is well under a second. Nothing
    // legitimate approaches 20s, so the only thing this can hide is a genuine
    // hang — which still fails, 15s later than it would have.
    testTimeout: 20_000,
    hookTimeout: 20_000,
    coverage: {
      provider: 'v8',
      thresholds: { lines: 80, functions: 80, branches: 75, statements: 80 },
      exclude: [
        '**/*.test.ts',
        '**/*.test.tsx',
        'src/test-setup.ts',
        '**/*.integration.test.ts',
      ],
    },
  },
});
