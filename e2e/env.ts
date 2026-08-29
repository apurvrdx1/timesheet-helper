/**
 * Where the end-to-end suite gets its credentials.
 *
 * Two consumers, and they need different things:
 *
 * - `playwright.config.ts` needs `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`
 *   so the dev server it starts is pointed at a real project. Vite would pick
 *   these up from `.env.local` on its own locally, but in CI they arrive as
 *   environment variables on the job, so `webServer.env` passes them through
 *   explicitly rather than relying on inheritance.
 * - `e2e/fixtures.ts` needs `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` to
 *   build and tear down the run's throwaway accounts.
 *
 * The precedence and the `.env.local` fallback are deliberately identical to
 * `vitest.integration.config.ts`: the real environment wins over anything on
 * disk, because CI injects secrets as environment variables and never as
 * files, and a developer should not have to re-declare under a second name the
 * two values `npm run dev` already reads.
 */
import { fileURLToPath } from 'node:url';
import { loadEnv } from 'vite';

const rootDir = fileURLToPath(new URL('..', import.meta.url));

/** The empty prefix loads every key from `.env.local`, not just `VITE_`-prefixed ones. */
const fileEnv = loadEnv('test', rootDir, '');

/** First non-empty value among `names`, or `''` when none is set. */
export function fromEnv(...names: readonly string[]): string {
  for (const name of names) {
    const value = process.env[name] ?? fileEnv[name];
    if (value !== undefined && value !== '') return value;
  }
  return '';
}

/**
 * Like `fromEnv`, but a missing value is a LOUD failure naming exactly what to
 * supply. There is no skip path: a journey that quietly did not run is
 * indistinguishable from one that ran and passed, and this suite is the only
 * thing that exercises the auth gate through a real browser.
 */
export function requireEnv(...names: readonly string[]): string {
  const value = fromEnv(...names);
  if (value === '') {
    const [primary] = names;
    const alternatives = names.length > 1 ? ` (or ${names.slice(1).join(', ')})` : '';
    throw new Error(
      `${primary}${alternatives} is not set. The end-to-end journey signs in to a REAL ` +
        `Supabase project and creates its own throwaway accounts, so it cannot run without ` +
        `credentials. Set it in .env.local for a local run, or as a job secret in CI. ` +
        `See supabase/README.md § "Running the end-to-end journey".`,
    );
  }
  return value;
}
