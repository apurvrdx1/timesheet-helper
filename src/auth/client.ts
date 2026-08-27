import { createClient } from '@supabase/supabase-js';

type RequiredEnvVar = 'VITE_SUPABASE_URL' | 'VITE_SUPABASE_ANON_KEY';

// `ImportMetaEnv` (declared in `vite/client`'s ambient types) extends
// `Record<string, any>` because this project does not opt into Vite's
// `strictImportMetaEnv` type option — so `import.meta.env.VITE_X` types as
// `any` and reading it directly would violate the no-`any` rule. Assigning
// straight into an `unknown`-typed binding stops that `any` from
// propagating anywhere else, and the `typeof` check below narrows it back
// to `string` before it is used.
function requireEnv(name: RequiredEnvVar): string {
  const value: unknown = import.meta.env[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(
      `${name} is not set. Add it to .env.local before running the app — ` +
        'see supabase/README.md for where to find the value and how to set it up.',
    );
  }
  return value;
}

const url = requireEnv('VITE_SUPABASE_URL');
const anonKey = requireEnv('VITE_SUPABASE_ANON_KEY');

// The publishable ("anon") key is public by design — it ships in the built
// bundle and grants nothing on its own. Every table it can reach is gated
// by the row-level-security policies in `supabase/migrations/0003_rls.sql`;
// see `supabase/README.md` for the full model.
export const supabase = createClient(url, anonKey, {
  auth: { persistSession: true, autoRefreshToken: true },
});
