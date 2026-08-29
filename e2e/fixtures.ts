/**
 * The accounts the end-to-end journey runs as, and their teardown.
 *
 * ## Why this file exists at all (amendment A6)
 *
 * The journey used to start at an unauthenticated app and write its rows into
 * whatever account was in front of it. That made it a suite that passes
 * EXACTLY ONCE: CI runs it on every push, and on the second run the previous
 * run's rows are still there — `OPEX-ADMIN` collides on the primary key, a
 * second "Alex" makes `getByLabel('Alex P-1001')` match two cells, and the
 * stale banner's presence depends on leftover state rather than on what the
 * test did.
 *
 * So every run gets its OWN accounts, stamped with a unique run id, and
 * deletes them afterwards. Deleting the `auth.users` row cascades through
 * `profiles` and all eight domain tables (`supabase/README.md` §
 * "`on delete cascade`"), so a completed run leaves the project exactly as it
 * found it, and two runs at once — a developer and CI, or two CI jobs — cannot
 * collide, because they share no identifier. This is the same shape as
 * `src/storage/rls.integration.test.ts`, on purpose.
 *
 * ## The service-role key, and the two things it is used for
 *
 * Nothing that ships to a browser ever sees this key (`supabase/README.md` §
 * "Credentials"). Here it does exactly what it does in the isolation suite and
 * nothing else: it CREATES a user and FLIPS `profiles.approved`, both of which
 * are by design impossible through the publishable key, and it DELETES the
 * user at the end. It never reads or writes a single row that the journey then
 * asserts on — every assertion in `journey.spec.ts` goes through the real
 * browser, the real publishable key and the real RLS policies.
 *
 * Approving is the one step that cannot be done through the UI in a throwaway
 * run: approval is the account owner's action, and `profiles`' partial unique
 * index `one_owner_only` permits exactly one owner across the whole project —
 * so a suite that minted its own owner could not run twice at the same time.
 *
 * ## THE UNAPPROVED FIXTURE — read this before "fixing" a failing run
 *
 * `createAccount('pending', { approved: false })` below is the account the
 * pending-screen test needs, and NOTHING approves it: not this file, not the
 * spec, not a migration. It is created unapproved and deleted unapproved, and
 * `createAccount` reads the profile row back to prove it started that way.
 *
 * It is a fresh account per run precisely so that nobody is ever tempted to
 * keep a standing "pending" login around and approve it while debugging. If
 * that test fails, do not approve this account to see what happens — the
 * account is gone by the time you read the report, and approving a rebuilt one
 * would turn the only end-to-end proof that the gate holds into a test that
 * asserts nothing.
 */
import { randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { requireEnv } from './env';

/**
 * Unique per run. Everything this suite creates carries it, so nothing it
 * touches can be confused with real data or with another run's fixtures.
 */
export const RUN_ID = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;

/** Random per run: nothing here could become a standing password anywhere. */
const PASSWORD = `e2e-journey-${randomUUID()}`;

/** Every table `0003_rls.sql` gates on `owner_id = auth.uid() and is_approved()`. */
const DOMAIN_TABLES = [
  'otls',
  'people',
  'stat_holidays',
  'allocations',
  'leave_ranges',
  'overrides',
  'schedule',
  'meta',
] as const;

export interface TestAccount {
  /** Which fixture this is, for error messages. */
  readonly label: string;
  readonly email: string;
  readonly password: string;
  readonly userId: string;
}

/** Only the columns this file reads; the Supabase client is untyped here. */
type ProfileRow = { readonly id: string; readonly approved: boolean };

let adminClient: SupabaseClient | null = null;

/**
 * Built on first use rather than at import time, so a missing key is reported
 * from inside the `beforeAll` hook that needed it — attributed to the suite,
 * with the message from `requireEnv`, instead of as a bare module-load error.
 */
function admin(): SupabaseClient {
  if (adminClient === null) {
    const url = requireEnv('SUPABASE_URL', 'VITE_SUPABASE_URL');
    const serviceRoleKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
    adminClient = createClient(url, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }
  return adminClient;
}

/** Ids of the users this run created, so teardown can remove every one. */
const createdUserIds: string[] = [];

/**
 * Creates a throwaway account.
 *
 * `email_confirm: true` skips the confirmation mail — the suite must not
 * depend on a mailbox, or on how this project's auth settings happen to be
 * configured. The insert into `auth.users` still fires `handle_new_user()`
 * from `0002_profiles.sql`, so the profile row (approved = false, is_owner =
 * false) is created by the real trigger, not by this harness.
 */
export async function createAccount(
  label: string,
  { approved }: { approved: boolean },
): Promise<TestAccount> {
  const email = `e2e-${RUN_ID}-${label}@example.test`;

  const created = await admin().auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
  });
  if (created.error !== null) {
    throw new Error(`could not create ${label} (${email}): ${created.error.message}`);
  }
  const userId = created.data.user?.id;
  if (userId === undefined) {
    throw new Error(`could not create ${label} (${email}): no user returned`);
  }
  createdUserIds.push(userId);

  if (approved) {
    const update = await admin()
      .from('profiles')
      .update({ approved: true })
      .eq('id', userId)
      .select('id, approved');
    if (update.error !== null) {
      throw new Error(`could not approve ${label}: ${update.error.message}`);
    }
    const rows: readonly ProfileRow[] = update.data ?? [];
    if (rows.length !== 1) {
      throw new Error(
        `could not approve ${label}: expected exactly 1 profile row, got ${rows.length}. ` +
          `The handle_new_user() trigger may not have run.`,
      );
    }
  }

  // Read the row back and check it says what this fixture claims. For the
  // approved account that catches a failed trigger; for the unapproved one it
  // proves the account really did start life unapproved, so the pending-screen
  // test is asserting against the state it thinks it is.
  const check = await admin().from('profiles').select('id, approved').eq('id', userId).maybeSingle();
  if (check.error !== null) {
    throw new Error(`could not read back the profile for ${label}: ${check.error.message}`);
  }
  const profile: ProfileRow | null = check.data;
  if (profile === null) {
    throw new Error(
      `no profiles row for ${label} (${email}) — the handle_new_user() trigger did not run.`,
    );
  }
  if (profile.approved !== approved) {
    throw new Error(
      `${label} was created with approved=${approved} but the profiles row says ` +
        `approved=${profile.approved}. Something else is writing to this project.`,
    );
  }

  return { label, email, password: PASSWORD, userId };
}

/**
 * Deletes every account this run created, then VERIFIES the cascade rather
 * than assuming it. A run that leaves rows behind pollutes the project for the
 * next one, and a silent leftover would eventually be mistaken for real data.
 */
export async function tearDownAccounts(): Promise<void> {
  const failures: string[] = [];

  for (const userId of createdUserIds) {
    const { error } = await admin().auth.admin.deleteUser(userId);
    if (error !== null) failures.push(`delete user ${userId}: ${error.message}`);
  }

  if (createdUserIds.length > 0) {
    const leftoverProfiles = await admin().from('profiles').select('id').in('id', createdUserIds);
    const profiles: readonly { readonly id: string }[] = leftoverProfiles.data ?? [];
    if (profiles.length > 0) failures.push(`${profiles.length} profile row(s) survived cleanup`);

    for (const table of DOMAIN_TABLES) {
      const { count, error } = await admin()
        .from(table)
        .select('owner_id', { count: 'exact', head: true })
        .in('owner_id', createdUserIds);
      if (error !== null) failures.push(`could not check ${table} for leftovers: ${error.message}`);
      else if (count !== null && count > 0) failures.push(`${count} row(s) survived cleanup in ${table}`);
    }
  }

  createdUserIds.length = 0;

  if (failures.length > 0) {
    throw new Error(`the end-to-end journey did not clean up after itself:\n  ${failures.join('\n  ')}`);
  }
}

