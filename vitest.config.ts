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
    exclude: [...configDefaults.exclude, 'e2e/**'],
    setupFiles: ['./src/test-setup.ts'],
    coverage: {
      provider: 'v8',
      thresholds: { lines: 80, functions: 80, branches: 75, statements: 80 },
      exclude: ['**/*.test.ts', '**/*.test.tsx', 'src/test-setup.ts', 'apps-script/**'],
    },
  },
});
