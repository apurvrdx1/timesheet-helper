/**
 * Row-level security: the isolation suite.
 *
 * This portal is used by several managers, each for their own team, and none of
 * them may see another's data. That guarantee lives entirely in
 * `supabase/migrations/0003_rls.sql` — it is a property of Postgres, not of
 * application code. These tests are what stop a future migration weakening it
 * silently.
 *
 * They run against the REAL project. Nothing here is mocked, on purpose: a mock
 * of the database would be a mock of the thing that enforces isolation, and a
 * suite built on one would pass just as happily with every policy dropped.
 *
 * Two shapes of refusal show up below, and telling them apart is most of the
 * point of this file:
 *
 *   - a `using` failure is SILENT. The rows are invisible, so an UPDATE or
 *     DELETE matches nothing and PostgREST returns success with zero rows. A
 *     test that asserted "throws" for a cross-account UPDATE would fail against
 *     correct policies.
 *   - a `with check` failure is LOUD: `42501 new row violates row-level
 *     security policy for table "..."`. That is the only signal that
 *     distinguishes "you may not create this row" from "there was nothing to
 *     change", so the cross-owner tests assert on the code and the message
 *     rather than on "something went wrong".
 *
 * Fixtures: every run creates its own three accounts, stamped with a unique
 * run id, and deletes them in `afterAll`. Deleting the `auth.users` row
 * cascades through `profiles` and all eight domain tables, so a completed run
 * leaves the project exactly as it found it. Two runs at once cannot collide,
 * because no identifier is shared between them.
 *
 * Credentials: see `supabase/README.md` § "Running the isolation suite". The
 * assertions all run through the publishable key with a real user session —
 * the path the shipped app takes. The service-role key only ever builds and
 * tears down fixtures: it does the two things no client-side key can do,
 * approve an account and delete a user, and nothing else.
 */

import { randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(
      `${name} is not set. The row-level-security suite talks to a real Supabase ` +
        `project and cannot be run without credentials. See supabase/README.md ` +
        `§ "Running the isolation suite".`,
    );
  }
  return value;
}

const SUPABASE_URL = requireEnv('SUPABASE_URL');
const SUPABASE_ANON_KEY = requireEnv('SUPABASE_ANON_KEY');
const SUPABASE_SERVICE_ROLE_KEY = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

/**
 * Unique per run, so two suites running at the same time — a developer and CI,
 * or two CI jobs — never touch each other's rows, users or project codes.
 */
const RUN_ID = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;

/** Random per run: nothing that could become a standing password anywhere. */
const PASSWORD = `rls-suite-${randomUUID()}`;

const ALICE_OTL = `A-${RUN_ID}`;
const BOB_OTL = `B-${RUN_ID}`;
const PENDING_OTL = `P-${RUN_ID}`;
const REVOKED_OTL = `R-${RUN_ID}`;
const STOLEN_OTL = `STOLEN-${RUN_ID}`;
const ALICE_PERSON = `PA-${RUN_ID}`;
const BOB_PERSON = `PB-${RUN_ID}`;

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

// Only the columns this suite reads are modelled. The Supabase client is
// untyped without generated database types, so results are narrowed to these
// at the point of use rather than being carried around loosely.
type ProjectCodeRow = { readonly project_code: string };
type TaskCodeRow = { readonly task_code: string };
type OwnerIdRow = { readonly owner_id: string };
type ApprovalRow = { readonly id: string; readonly approved: boolean };
type PersonIdRow = { readonly id: string };
type PersonOwnerRow = { readonly id: string; readonly owner_id: string };
type ProfileRow = {
  readonly id: string;
  readonly email: string;
  readonly approved: boolean;
  readonly is_owner: boolean;
};

type Account = {
  readonly label: string;
  readonly email: string;
  readonly userId: string;
  /** Publishable key + this account's session. The path the app takes. */
  readonly client: SupabaseClient;
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Service-role client. It does exactly two things, both of which are by design
 * impossible through the publishable key: flipping `profiles.approved`, which
 * `0003_rls.sql` reserves to the owner, and deleting an `auth.users` row,
 * which nothing in the app may do. Both are fixture management — standing in
 * for the owner, and for the dashboard.
 *
 * It bypasses RLS entirely, so nothing it returns could prove anything about
 * isolation. No `expect` in this file reads from it: every assertion below
 * goes through an account's own publishable-key session.
 */
const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

/** Ids of the users this run created, so teardown can remove them all. */
const createdUserIds: string[] = [];

let alice: Account;
let bob: Account;
let pending: Account;
let revoked: Account;

/**
 * Flips `profiles.approved`. The owner does this in the app; there is no
 * owner in a throwaway run — `profiles.is_owner` is guarded by a partial
 * unique index that permits exactly one across the whole project, so a suite
 * that minted an owner could not run twice at the same time. The service-role
 * key stands in for that one action, and for nothing else.
 */
async function setApproval(userId: string, approved: boolean): Promise<void> {
  const { data, error } = await admin
    .from('profiles')
    .update({ approved })
    .eq('id', userId)
    .select('id, approved');
  if (error !== null) {
    throw new Error(`could not set approved=${approved} on ${userId}: ${error.message}`);
  }
  const rows: readonly ApprovalRow[] = data ?? [];
  if (rows.length !== 1) {
    throw new Error(
      `could not set approved=${approved} on ${userId}: expected exactly 1 profile row, got ${rows.length}. ` +
        `The handle_new_user() trigger may not have run.`,
    );
  }
}

async function createAccount(label: string, approved: boolean): Promise<Account> {
  const email = `rls-${RUN_ID}-${label}@example.test`;

  // `email_confirm: true` skips the confirmation mail — the suite must not
  // depend on a mailbox, or on how this project's auth settings are configured.
  // The insert into `auth.users` still fires `handle_new_user()` from
  // `0002_profiles.sql`, so the profile row (approved = false, is_owner =
  // false) is created by the real trigger, not by the harness.
  const created = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (created.error !== null) {
    throw new Error(`could not create ${label} (${email}): ${created.error.message}`);
  }
  const userId = created.data.user?.id;
  if (userId === undefined) {
    throw new Error(`could not create ${label} (${email}): no user returned`);
  }
  createdUserIds.push(userId);

  if (approved) await setApproval(userId, true);

  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const signedIn = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (signedIn.error !== null) {
    throw new Error(`could not sign in as ${label}: ${signedIn.error.message}`);
  }
  if (signedIn.data.session === null) {
    throw new Error(`could not sign in as ${label}: no session returned`);
  }

  return { label, email, userId, client };
}

beforeAll(async () => {
  alice = await createAccount('alice', true);
  bob = await createAccount('bob', true);
  pending = await createAccount('pending', false);
  revoked = await createAccount('revoked', true);
});

afterAll(async () => {
  const failures: string[] = [];

  for (const userId of createdUserIds) {
    const { error } = await admin.auth.admin.deleteUser(userId);
    if (error !== null) failures.push(`delete user ${userId}: ${error.message}`);
  }

  // Deleting the auth.users row cascades to profiles and to every domain
  // table via `owner_id ... on delete cascade`. Verify that rather than assume
  // it: a run that leaves rows behind pollutes the project for the next one,
  // and a silent leftover would eventually be mistaken for real data.
  if (createdUserIds.length > 0) {
    const leftoverProfiles = await admin.from('profiles').select('id').in('id', createdUserIds);
    const profiles: readonly PersonIdRow[] = leftoverProfiles.data ?? [];
    if (profiles.length > 0) failures.push(`${profiles.length} profile row(s) survived cleanup`);

    for (const table of DOMAIN_TABLES) {
      const { count, error } = await admin
        .from(table)
        .select('owner_id', { count: 'exact', head: true })
        .in('owner_id', createdUserIds);
      if (error !== null) failures.push(`could not check ${table} for leftovers: ${error.message}`);
      else if (count !== null && count > 0) failures.push(`${count} row(s) survived cleanup in ${table}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(`the isolation suite did not clean up after itself:\n  ${failures.join('\n  ')}`);
  }
});

// ---------------------------------------------------------------------------
// The guarantees
// ---------------------------------------------------------------------------

describe('row-level security', () => {
  it('lets an approved account write and read back its own row', async () => {
    const { error } = await alice.client.from('otls').insert({ project_code: ALICE_OTL, category: 'CAPEX' });
    expect(error).toBeNull();

    const read = await alice.client.from('otls').select('project_code');
    expect(read.error).toBeNull();
    const rows: readonly ProjectCodeRow[] = read.data ?? [];
    expect(rows.map((row) => row.project_code)).toContain(ALICE_OTL);
  });

  it('does not return another account rows', async () => {
    const written = await bob.client.from('otls').insert({ project_code: BOB_OTL, category: 'OPEX' });
    expect(written.error).toBeNull();

    // Deliberately unfiltered: the same query that returns Alice's row for
    // Alice. Bob's result is not "Alice's row filtered out by a where clause
    // the app remembered to write" — it is a set Alice's row was never in.
    const read = await bob.client.from('otls').select('project_code');
    expect(read.error).toBeNull();
    const rows: readonly ProjectCodeRow[] = read.data ?? [];
    expect(rows.map((row) => row.project_code)).toEqual([BOB_OTL]);
  });

  it('refuses to update another account row', async () => {
    const attempt = await bob.client
      .from('otls')
      .update({ task_code: 'HACKED' })
      .eq('project_code', ALICE_OTL)
      .select();

    // A `using` refusal, and it must stay one: the row is invisible, so the
    // statement matches nothing and succeeds vacuously. Bob learns nothing
    // about whether Alice's project code exists.
    expect(attempt.error).toBeNull();
    expect(attempt.data ?? []).toHaveLength(0);

    const check = await alice.client.from('otls').select('task_code').eq('project_code', ALICE_OTL).single();
    const row: TaskCodeRow | null = check.data;
    expect(row?.task_code).toBe('');
  });

  it('refuses to delete another account row', async () => {
    const attempt = await bob.client.from('otls').delete().eq('project_code', ALICE_OTL).select();
    expect(attempt.error).toBeNull();
    expect(attempt.data ?? []).toHaveLength(0);

    const check = await alice.client.from('otls').select('project_code').eq('project_code', ALICE_OTL);
    expect(check.data ?? []).toHaveLength(1);
  });

  it('refuses to insert a row owned by someone else', async () => {
    // `owner_id` defaults to auth.uid(), but a caller is free to override the
    // default — the insert policy's `with check` is what stops them.
    const attempt = await bob.client
      .from('otls')
      .insert({ owner_id: alice.userId, project_code: STOLEN_OTL, category: 'CAPEX' });

    expect(attempt.error).not.toBeNull();
    expect(attempt.error?.code).toBe('42501');
    expect(attempt.error?.message).toMatch(/new row violates row-level security policy/i);

    const check = await alice.client.from('otls').select('project_code').eq('project_code', STOLEN_OTL);
    expect(check.data ?? []).toHaveLength(0);
  });

  it('refuses to move a row to another owner via update', async () => {
    // Handing your own row to another account. Alice targets her OWN row, so
    // `using` matches: this is not the silent no-op the two tests above check,
    // and a test that only expected "some failure" would pass against either.
    // The refusal here is LOUD, and the assertion says so.
    //
    // What refuses it is worth being exact about, because it is not what it
    // looks like. `otls_update`'s `with check` refuses it at the SQL level —
    // but so does `otls_select`, which Postgres also applies to the row an
    // UPDATE produces whenever the statement has a RETURNING clause, and
    // PostgREST always emits one (it needs the affected-row count, even for
    // `return=minimal`). The two expressions are identical in 0003_rls.sql, so
    // through this API the `with check` cannot be told apart from its absence:
    // verified by relaxing it to `with check (true)` and watching every test
    // here stay green, then relaxing `otls_select` to `using (true)` as well
    // and watching the row move.
    //
    // So this test pins the BEHAVIOUR — the handover is refused, loudly, and
    // the row does not move — rather than crediting one clause. Do not read
    // its greenness as licence to drop the `with check`: it is the only guard
    // on the plain-SQL path, which has no RETURNING, and the only one that
    // survives `otls_select` ever being broadened (a shared or team-wide read
    // policy would make a weak `with check` immediately exploitable).
    const attempt = await alice.client
      .from('otls')
      .update({ owner_id: bob.userId })
      .eq('project_code', ALICE_OTL);

    expect(attempt.error).not.toBeNull();
    expect(attempt.error?.code).toBe('42501');
    expect(attempt.error?.message).toMatch(/new row violates row-level security policy/i);

    // Belt and braces: whatever the error said, the row must not have moved.
    const stillAlices = await alice.client
      .from('otls')
      .select('owner_id')
      .eq('project_code', ALICE_OTL)
      .single();
    const row: OwnerIdRow | null = stillAlices.data;
    expect(row?.owner_id).toBe(alice.userId);

    const bobSees = await bob.client.from('otls').select('project_code').eq('project_code', ALICE_OTL);
    expect(bobSees.data ?? []).toHaveLength(0);
  });

  it('gives an unapproved account nothing, on every operation', async () => {
    // Registration is open, so this gate is the whole security model for a
    // stranger who signs up: a valid session that Postgres answers with
    // nothing. Select is the least of it — insert, update and delete matter
    // just as much, and only insert reports a refusal out loud.
    const read = await pending.client.from('otls').select('project_code');
    expect(read.error).toBeNull();
    expect(read.data ?? []).toHaveLength(0);

    // With `pending`'s OWN owner_id, so ownership is satisfied and the only
    // thing left to refuse this is `is_approved()`.
    const inserted = await pending.client
      .from('otls')
      .insert({ owner_id: pending.userId, project_code: PENDING_OTL, category: 'CAPEX' });
    expect(inserted.error).not.toBeNull();
    expect(inserted.error?.code).toBe('42501');
    expect(inserted.error?.message).toMatch(/new row violates row-level security policy/i);

    const updated = await pending.client
      .from('otls')
      .update({ task_code: 'HACKED' })
      .eq('project_code', ALICE_OTL)
      .select();
    expect(updated.error).toBeNull();
    expect(updated.data ?? []).toHaveLength(0);

    const deleted = await pending.client.from('otls').delete().eq('project_code', ALICE_OTL).select();
    expect(deleted.error).toBeNull();
    expect(deleted.data ?? []).toHaveLength(0);

    const survived = await alice.client.from('otls').select('task_code').eq('project_code', ALICE_OTL).single();
    const row: TaskCodeRow | null = survived.data;
    expect(row?.task_code).toBe('');
  });

  it('gives an unapproved account nothing on every table, not just otls', async () => {
    for (const table of DOMAIN_TABLES) {
      const { count, error } = await pending.client.from(table).select('owner_id', {
        count: 'exact',
        head: true,
      });
      expect(error, `select on ${table}`).toBeNull();
      expect(count ?? 0, `rows visible to an unapproved account in ${table}`).toBe(0);
    }
  });

  it('does not let a non-owner read the profiles of others', async () => {
    // Exactly one row: their own. Not zero — the app needs this row to know
    // whether it is approved. Not two — admins cannot see each other at all.
    const read = await bob.client.from('profiles').select('id, email, approved, is_owner');
    expect(read.error).toBeNull();
    const rows: readonly ProfileRow[] = read.data ?? [];
    expect(rows).toHaveLength(1);
    expect(rows.map((row) => row.id)).toEqual([bob.userId]);
    expect(rows.map((row) => row.email)).toEqual([bob.email]);
    expect(rows.map((row) => row.is_owner)).toEqual([false]);
  });

  it('lets an unapproved account read its own profile, and only its own', async () => {
    // `profiles_self_read` carries no `is_approved()` term on purpose: an
    // account that cannot read `approved = false` about itself cannot be told
    // apart from a signed-out one, and the app cannot show the awaiting-
    // approval screen. Adding the gate here would break the login flow, so it
    // is asserted rather than left to a code comment.
    const read = await pending.client.from('profiles').select('id, email, approved, is_owner');
    expect(read.error).toBeNull();
    const rows: readonly ProfileRow[] = read.data ?? [];
    expect(rows).toHaveLength(1);
    expect(rows.map((row) => row.id)).toEqual([pending.userId]);
    expect(rows.map((row) => row.approved)).toEqual([false]);
  });

  it('does not let an account approve itself, or promote itself to owner', async () => {
    // The escalation that would undo every test above in one statement.
    // `profiles_owner_updates` is the only update policy on the table, so a
    // non-owner's UPDATE matches no rows at all.
    const attempt = await pending.client
      .from('profiles')
      .update({ approved: true, is_owner: true })
      .eq('id', pending.userId)
      .select();
    expect(attempt.error).toBeNull();
    expect(attempt.data ?? []).toHaveLength(0);

    const check = await pending.client.from('profiles').select('id, email, approved, is_owner');
    const rows: readonly ProfileRow[] = check.data ?? [];
    expect(rows.map((row) => row.approved)).toEqual([false]);
    expect(rows.map((row) => row.is_owner)).toEqual([false]);

    // Still refused everywhere, which is the point of checking at all.
    const stillBlind = await pending.client.from('otls').select('project_code');
    expect(stillBlind.data ?? []).toHaveLength(0);
  });

  it('isolates a second table the same way, so the guarantee is not otls-shaped', async () => {
    const aliceWrote = await alice.client
      .from('people')
      .insert({ id: ALICE_PERSON, name: 'Alice Report', role: 'REPORT' });
    expect(aliceWrote.error).toBeNull();

    const bobWrote = await bob.client
      .from('people')
      .insert({ id: BOB_PERSON, name: 'Bob Report', role: 'REPORT' });
    expect(bobWrote.error).toBeNull();

    const bobReads = await bob.client.from('people').select('id');
    const rows: readonly PersonIdRow[] = bobReads.data ?? [];
    expect(rows.map((row) => row.id)).toEqual([BOB_PERSON]);

    const crossUpdate = await bob.client
      .from('people')
      .update({ name: 'HACKED' })
      .eq('id', ALICE_PERSON)
      .select();
    expect(crossUpdate.error).toBeNull();
    expect(crossUpdate.data ?? []).toHaveLength(0);

    // No `.select()`, for the reason given on the otls handover test above.
    const handover = await bob.client.from('people').update({ owner_id: alice.userId }).eq('id', BOB_PERSON);
    expect(handover.error?.code).toBe('42501');
    expect(handover.error?.message).toMatch(/new row violates row-level security policy/i);

    const stillBobs = await bob.client.from('people').select('id, owner_id').eq('id', BOB_PERSON).single();
    const person: PersonOwnerRow | null = stillBobs.data;
    expect(person?.owner_id).toBe(bob.userId);
  });

  it('stops a revoked account reading rows it already owns, and keeps them', async () => {
    // The case the other approval tests cannot reach. `pending` owns nothing,
    // so `owner_id = auth.uid()` alone would already return it zero rows —
    // which means removing `is_approved()` from the SELECT policy would not
    // change a single assertion above. Only an account that owns rows and is
    // then revoked can tell the two halves of that predicate apart. It is also
    // the design's revocation path (§4.4) exercised end to end.
    const written = await revoked.client.from('otls').insert({ project_code: REVOKED_OTL, category: 'CAPEX' });
    expect(written.error).toBeNull();

    const before = await revoked.client.from('otls').select('project_code');
    const visible: readonly ProjectCodeRow[] = before.data ?? [];
    expect(visible.map((row) => row.project_code)).toEqual([REVOKED_OTL]);

    // Fixture change, not an assertion: what the owner does in the app.
    await setApproval(revoked.userId, false);

    // Same client, same JWT, no sign-out and no session invalidation. The next
    // query simply returns nothing.
    const after = await revoked.client.from('otls').select('project_code');
    expect(after.error).toBeNull();
    expect(after.data ?? []).toHaveLength(0);

    const update = await revoked.client
      .from('otls')
      .update({ task_code: 'HACKED' })
      .eq('project_code', REVOKED_OTL)
      .select();
    expect(update.error).toBeNull();
    expect(update.data ?? []).toHaveLength(0);

    const remove = await revoked.client.from('otls').delete().eq('project_code', REVOKED_OTL).select();
    expect(remove.error).toBeNull();
    expect(remove.data ?? []).toHaveLength(0);

    // Revocation hides data; it does not destroy it. Re-approving restores
    // access to exactly the rows that were there before, which is what makes
    // revoking an admin a reversible act.
    await setApproval(revoked.userId, true);

    const restored = await revoked.client.from('otls').select('project_code');
    const again: readonly ProjectCodeRow[] = restored.data ?? [];
    expect(again.map((row) => row.project_code)).toEqual([REVOKED_OTL]);
  });
});
