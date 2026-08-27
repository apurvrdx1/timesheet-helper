import { fileURLToPath } from 'node:url';
import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

// The isolation suite talks to a real Supabase project over the network. It is
// deliberately NOT part of `npm test`: that suite must stay runnable by a
// developer who has never seen a credential, and a missing key there would show
// up as a wall of red rather than as "you did not configure this optional
// suite". `vitest.config.ts` excludes `*.integration.test.ts` for the same
// reason; this config is the only thing that runs them.
//
// `node` rather than `jsdom`: there is no DOM here, and jsdom's fetch/XHR
// shims are exactly the sort of thing that could make a network test pass or
// fail for reasons unrelated to row-level security.

const rootDir = fileURLToPath(new URL('.', import.meta.url));

// `.env.local` is where a developer already keeps VITE_SUPABASE_URL and
// VITE_SUPABASE_ANON_KEY for `npm run dev`, so the suite reads them from there
// rather than making anyone re-declare the same two values under new names.
// The empty prefix loads every key, not just VITE_-prefixed ones.
const fileEnv = loadEnv('test', rootDir, '');

/**
 * First non-empty value among `names`, preferring the real environment over
 * `.env.local` so CI (which injects secrets as environment variables, never as
 * files) wins over anything checked out on disk.
 *
 * Returns '' rather than throwing: the suite itself reports what is missing,
 * with a message that says how to supply it. A throw here would fail during
 * config loading, before Vitest can attribute it to anything.
 */
function fromEnv(...names: readonly string[]): string {
  for (const name of names) {
    const value = process.env[name] ?? fileEnv[name];
    if (value !== undefined && value !== '') return value;
  }
  return '';
}

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.integration.test.ts'],
    // Sign-up, sign-in and teardown are several network round trips each
    // against a remote region; the 5s default is not a meaningful budget.
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // The suite creates real rows in a shared project. Running files or tests
    // concurrently would let one run's fixtures overlap another's assertions.
    fileParallelism: false,
    // A retry would re-run an isolation assertion that already failed once.
    // If accounts can see each other, that is a fact, not a flake.
    retry: 0,
    env: {
      SUPABASE_URL: fromEnv('SUPABASE_URL', 'VITE_SUPABASE_URL'),
      SUPABASE_ANON_KEY: fromEnv('SUPABASE_ANON_KEY', 'VITE_SUPABASE_ANON_KEY'),
      SUPABASE_SERVICE_ROLE_KEY: fromEnv('SUPABASE_SERVICE_ROLE_KEY'),
    },
  },
});
