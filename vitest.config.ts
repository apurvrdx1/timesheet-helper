import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    coverage: {
      provider: 'v8',
      thresholds: { lines: 80, functions: 80, branches: 75, statements: 80 },
      exclude: ['**/*.test.ts', '**/*.test.tsx', 'src/test-setup.ts', 'apps-script/**'],
    },
  },
});
