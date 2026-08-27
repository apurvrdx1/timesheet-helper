/**
 * The Supabase storage adapter, against the REAL project.
 *
 * Nothing here is mocked, deliberately. `supabase.test.ts` proves the two
 * mappings agree with each other; only this file can prove either agrees with
 * the schema that is actually applied. Every claim the adapter makes that
 * matters — that a null `personId` survives, that `numeric` is a number, that
 * a failed write changes nothing, that one account cannot reach another's rows
 * — is a claim about Postgres, and a mock of Postgres would answer whatever it
 * was told to.
 *
 * It follows `rls.integration.test.ts` exactly: run-stamped accounts created
 * and approved with the service-role key, every assertion made through the
 * publishable key on a real user session (the path the shipped app takes), and
 * the users deleted in `afterAll` so a completed run leaves the project as it
 * found it.
 *
 * **No assertion here reads through the admin client.** It bypasses RLS, so
 * anything it returned would be a fact about the database rather than about
 * the shipped app. The admin client only creates accounts, approves them, and
 * deletes them.
 *
 * Credentials: see `supabase/README.md` § "Running the isolation suite".
 */

import { randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSupabaseAdapter } from './supabase';
import type { StorageAdapter, StoredState } from './modelAdapter';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(
      `${name} is not set. The storage-adapter suite talks to a real Supabase ` +
        `project and cannot be run without credentials. See supabase/README.md ` +
        `§ "Running the isolation suite".`,
    );
  }
  return value;
}

const SUPABASE_URL = requireEnv('SUPABASE_URL');
const SUPABASE_ANON_KEY = requireEnv('SUPABASE_ANON_KEY');
const SUPABASE_SERVICE_ROLE_KEY = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

/** Unique per run, so concurrent suites never touch each other's fixtures. */
const RUN_ID = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
const PASSWORD = `storage-suite-${randomUUID()}`;

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

type Account = {
  readonly label: string;
  readonly userId: string;
  readonly client: SupabaseClient;
  readonly storage: StorageAdapter;
};

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const createdUserIds: string[] = [];

let alice: Account;
let bob: Account;
let pending: Account;

async function setApproval(userId: string, approved: boolean): Promise<void> {
  const { data, error } = await admin.from('profiles').update({ approved }).eq('id', userId).select('id');
  if (error !== null) throw new Error(`could not approve ${userId}: ${error.message}`);
  if ((data ?? []).length !== 1) {
    throw new Error(`could not approve ${userId}: expected 1 profile row, got ${(data ?? []).length}`);
  }
}

async function createAccount(label: string, approved: boolean): Promise<Account> {
  const email = `storage-${RUN_ID}-${label}@example.test`;
  const created = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (created.error !== null) throw new Error(`could not create ${label}: ${created.error.message}`);
  const userId = created.data.user?.id;
  if (userId === undefined) throw new Error(`could not create ${label}: no user returned`);
  createdUserIds.push(userId);

  if (approved) await setApproval(userId, true);

  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const signedIn = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (signedIn.error !== null) throw new Error(`could not sign in as ${label}: ${signedIn.error.message}`);

  return { label, userId, client, storage: createSupabaseAdapter(client) };
}

beforeAll(async () => {
  alice = await createAccount('alice', true);
  bob = await createAccount('bob', true);
  pending = await createAccount('pending', false);
});

afterAll(async () => {
  const failures: string[] = [];

  for (const userId of createdUserIds) {
    const { error } = await admin.auth.admin.deleteUser(userId);
    if (error !== null) failures.push(`delete user ${userId}: ${error.message}`);
  }

  // Deleting the auth.users row cascades through profiles and all eight
  // domain tables. Verified rather than assumed: a leftover row pollutes the
  // project for the next run and would eventually be mistaken for real data.
  if (createdUserIds.length > 0) {
    const leftoverProfiles = await admin.from('profiles').select('id').in('id', createdUserIds);
    const profiles = leftoverProfiles.data ?? [];
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
    throw new Error(`the storage-adapter suite did not clean up after itself:\n  ${failures.join('\n  ')}`);
  }
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CAP = `A-cap-${RUN_ID}`;
const LEAVE = `B-leave-${RUN_ID}`;
const MANAGER = `a-mgr-${RUN_ID}`;
const REPORT = `b-rep-${RUN_ID}`;

/**
 * Every shape that has ever gone wrong, in one state.
 *
 * The rows are listed in the order `read` returns them (each table's natural
 * key), so the round-trip assertion can be a plain deep equality rather than a
 * sort-then-compare that would hide an ordering regression.
 */
function fullState(hash: string | null): StoredState {
  return {
    model: {
      otls: [
        {
          projectCode: CAP,
          taskCode: 'T-100',
          expenditureTypeCode: 'LABOR',
          timeReportingCode: 'REG',
          category: 'CAPEX',
          leaveSubtype: null,
          isDefaultOpex: false,
          colorIndex: 3,
          active: true,
        },
        {
          projectCode: LEAVE,
          taskCode: '',
          expenditureTypeCode: '',
          timeReportingCode: '',
          category: 'LEAVE',
          leaveSubtype: 'STAT',
          isDefaultOpex: false,
          colorIndex: 1,
          active: false,
        },
      ],
      people: [
        { id: MANAGER, name: 'Mira Manager', role: 'MANAGER', managerId: null },
        { id: REPORT, name: 'Ray Report', role: 'REPORT', managerId: MANAGER },
      ],
      // Same date, two OTLs. A 23505 against the key 0001 shipped.
      statHolidays: [
        { date: '2026-07-01', name: 'Canada Day', otlProjectCode: CAP },
        { date: '2026-07-01', name: 'Canada Day (stat book)', otlProjectCode: LEAVE },
      ],
      allocations: [
        // personId null: the OTL's MONTHLY TOTAL, not an assignment. Sorts
        // first (nullsFirst), which is also how `read` orders it.
        { month: '2026-01', otlProjectCode: CAP, personId: null, hours: 40 },
        { month: '2026-01', otlProjectCode: CAP, personId: REPORT, hours: 12.25 },
      ],
      // Same start date, different ends. Also a 23505 against 0001's key.
      leave: [
        { personId: REPORT, startDate: '2026-03-02', endDate: '2026-03-04', otlProjectCode: LEAVE },
        { personId: REPORT, startDate: '2026-03-02', endDate: '2026-03-06', otlProjectCode: LEAVE },
      ],
      overrides: [{ personId: REPORT, date: '2026-01-05', otlProjectCode: CAP, hours: 3.5 }],
    },
    entries: [
      // overrideBlocks < blocks, and > 0: the user pinned part of the cell.
      { personId: REPORT, date: '2026-01-05', otlProjectCode: CAP, blocks: 15, source: 'OVERRIDE', overrideBlocks: 7 },
      // overrideBlocks 0: nothing pinned.
      { personId: REPORT, date: '2026-01-06', otlProjectCode: CAP, blocks: 15, source: 'CALC', overrideBlocks: 0 },
    ],
    hash,
  };
}

const EMPTY_STATE: StoredState = {
  model: { otls: [], people: [], statHolidays: [], allocations: [], leave: [], overrides: [] },
  entries: [],
  hash: null,
};

// ---------------------------------------------------------------------------
// The guarantees
// ---------------------------------------------------------------------------

describe('the Supabase storage adapter', () => {
  it('reads a brand-new approved account as an empty state, not an error', async () => {
    // The first read every approved account makes. It must not look like a
    // failure, or a user who has done nothing wrong sees one.
    await expect(bob.storage.read()).resolves.toEqual(EMPTY_STATE);
  });

  it('round trips a full state through the real schema', async () => {
    const state = fullState('deadbeef');
    await alice.storage.write(state);
    await expect(alice.storage.read()).resolves.toEqual(state);
  });

  it('keeps a null allocation personId strictly null across the database', async () => {
    // The single most important case. Postgres stores the null in a column
    // whose generated `person_key` coalesces it to '' for the primary key —
    // so the value that comes back has to be the column, never the key.
    const state = await alice.storage.read();
    const total = state.model.allocations.find((a) => a.otlProjectCode === CAP && a.hours === 40);
    expect(total).toBeDefined();
    expect(total?.personId).toBeNull();
    expect(total?.personId).not.toBe('');
    expect(total?.personId).not.toBe('null');

    const assigned = state.model.allocations.find((a) => a.hours === 12.25);
    expect(assigned?.personId).toBe(REPORT);
  });

  it('A15: PostgREST returns numeric as a JS number, not a string', async () => {
    // The plan asserted the opposite, from memory. Measured here, through the
    // account's own session, on the two numeric columns the domain uses.
    const raw = await alice.client
      .from('allocations')
      .select('person_id, hours')
      .eq('otl_project_code', CAP)
      .order('person_id', { nullsFirst: true });
    expect(raw.error).toBeNull();
    const rows = (raw.data ?? []) as readonly { person_id: string | null; hours: unknown }[];
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(typeof row.hours, `typeof hours for person_id=${JSON.stringify(row.person_id)}`).toBe('number');
    }
    expect(rows.map((r) => r.hours)).toEqual([40, 12.25]);

    // And the adapter's own output, which is what the app sees.
    const state = await alice.storage.read();
    for (const allocation of state.model.allocations) expect(typeof allocation.hours).toBe('number');
    for (const override of state.model.overrides) expect(typeof override.hours).toBe('number');
  });

  it('A15: date columns arrive as bare YYYY-MM-DD strings', async () => {
    // The mapping copies them straight into `IsoDate`. If Postgres rendered a
    // timestamp here instead, every date in the app would silently gain a time
    // and a timezone.
    const raw = await alice.client.from('schedule').select('date').limit(1);
    expect(raw.error).toBeNull();
    const rows = (raw.data ?? []) as readonly { date: unknown }[];
    expect(typeof rows[0]?.date).toBe('string');
    expect(rows[0]?.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('keeps overrideBlocks separate from blocks through the round trip', async () => {
    const state = await alice.storage.read();
    const pinned = state.entries.find((e) => e.date === '2026-01-05');
    expect(pinned?.blocks).toBe(15);
    expect(pinned?.overrideBlocks).toBe(7);
    expect(pinned?.source).toBe('OVERRIDE');

    const calculated = state.entries.find((e) => e.date === '2026-01-06');
    expect(calculated?.blocks).toBe(15);
    expect(calculated?.overrideBlocks).toBe(0);
  });

  it('stores two stat holidays on one date and two leave ranges from one day', async () => {
    // Both are legal in the domain and both were `23505 duplicate key value
    // violates unique constraint` against the keys 0001 shipped. 0005 widened
    // them; this is the proof that it did.
    const state = await alice.storage.read();
    const holidays = state.model.statHolidays.filter((h) => h.date === '2026-07-01');
    expect(holidays.map((h) => h.otlProjectCode)).toEqual([CAP, LEAVE]);

    const ranges = state.model.leave.filter((l) => l.startDate === '2026-03-02');
    expect(ranges.map((l) => l.endDate)).toEqual(['2026-03-04', '2026-03-06']);
  });

  it('never writes person_key, and never has to read it', async () => {
    // The hazard is real, not hypothetical: a star select DOES return the
    // generated column, and writing it back is a hard error. Both halves are
    // asserted here so that the adapter's explicit column lists are visibly
    // load-bearing rather than a style preference.
    const starred = await alice.client.from('allocations').select('*').limit(1);
    expect(starred.error).toBeNull();
    const starredRows = (starred.data ?? []) as readonly Record<string, unknown>[];
    expect(Object.keys(starredRows[0] ?? {})).toContain('person_key');

    const rejected = await alice.client
      .from('allocations')
      .insert({ month: '2026-09', otl_project_code: CAP, person_id: 'x', hours: 1, person_key: 'x' });
    expect(rejected.error?.code).toBe('428C9');
    expect(rejected.error?.message).toMatch(/cannot insert a non-DEFAULT value into column "person_key"/);

    // The adapter, meanwhile, writes and reads the same state without ever
    // meeting that error.
    const state = fullState('deadbeef');
    await expect(alice.storage.write(state)).resolves.toBeUndefined();
    await expect(alice.storage.read()).resolves.toEqual(state);
  });

  it('replaces rather than appends', async () => {
    const stateB: StoredState = {
      model: {
        otls: [
          {
            projectCode: `Z-only-${RUN_ID}`,
            taskCode: '',
            expenditureTypeCode: '',
            timeReportingCode: '',
            category: 'OPEX',
            leaveSubtype: null,
            isDefaultOpex: true,
            colorIndex: 0,
            active: true,
          },
        ],
        people: [],
        statHolidays: [],
        allocations: [],
        leave: [],
        overrides: [],
      },
      entries: [],
      hash: null,
    };

    await alice.storage.write(fullState('deadbeef'));
    await alice.storage.write(stateB);

    // Exactly B. Not B plus what A left behind — which is what a naive
    // upsert-only write would produce, and which would grow the account
    // without bound as rows were deleted in the UI.
    await expect(alice.storage.read()).resolves.toEqual(stateB);
  });

  it('preserves a null hash as null and an empty hash as empty', async () => {
    // `''` is not a certificate but it is also not `null`, and collapsing the
    // two is what made staleness unclearable in v1.
    await alice.storage.write(fullState(null));
    expect((await alice.storage.read()).hash).toBeNull();

    await alice.storage.write(fullState(''));
    expect((await alice.storage.read()).hash).toBe('');

    await alice.storage.write(fullState('deadbeef'));
    expect((await alice.storage.read()).hash).toBe('deadbeef');
  });

  it('is atomic: a write that fails on a later table changes nothing', async () => {
    // The property the whole RPC exists for, forced rather than asserted.
    //
    // `replace_state` deletes all seven domain tables and then re-inserts
    // them. The state below is valid right up to `schedule`, whose `blocks: 0`
    // violates `schedule_blocks_check` — so the function gets as far as
    // deleting everything and inserting a different set of OTLs before it
    // fails. If the deletes were a separate request, as `.delete()` then
    // `.insert()` would be, the account would now be empty. In one
    // transaction it is untouched.
    const good = fullState('deadbeef');
    await alice.storage.write(good);
    expect(await alice.storage.read()).toEqual(good);

    const doomed: StoredState = {
      model: {
        ...good.model,
        otls: [
          {
            projectCode: `WIPED-${RUN_ID}`,
            taskCode: '',
            expenditureTypeCode: '',
            timeReportingCode: '',
            category: 'OPEX',
            leaveSubtype: null,
            isDefaultOpex: true,
            colorIndex: 0,
            active: true,
          },
        ],
      },
      entries: [
        { personId: REPORT, date: '2026-01-05', otlProjectCode: CAP, blocks: 0, source: 'CALC', overrideBlocks: 0 },
      ],
      hash: 'wiped',
    };

    await expect(alice.storage.write(doomed)).rejects.toThrow(
      /violates check constraint "schedule_blocks_check"/,
    );

    // Every table, including the ones the doomed write had already replaced
    // in its own transaction before it failed.
    expect(await alice.storage.read()).toEqual(good);
  });

  it('is atomic against the pin invariant too', async () => {
    // A second, different constraint, so the proof above is not
    // `blocks > 0`-shaped. `override_blocks <= blocks` is `pin_within_cell`.
    const good = fullState('deadbeef');
    await alice.storage.write(good);

    const doomed: StoredState = {
      ...good,
      entries: [
        { personId: REPORT, date: '2026-01-05', otlProjectCode: CAP, blocks: 4, source: 'OVERRIDE', overrideBlocks: 9 },
      ],
    };
    await expect(alice.storage.write(doomed)).rejects.toThrow(/violates check constraint "pin_within_cell"/);
    expect(await alice.storage.read()).toEqual(good);
  });

  it('cannot reach another account rows, in either direction', async () => {
    // The RPC is new attack surface: it is `execute`-granted to
    // `authenticated`, so every signed-in account in the project can call it.
    // `security invoker` is the only thing between that and a cross-account
    // write, because it is what keeps 0003_rls.sql's policies applied inside
    // the function body. `security definer` here would have run as the
    // function's owner and bypassed them entirely.
    const aliceState = fullState('alice-hash');
    await alice.storage.write(aliceState);

    // Bob writes a state naming ALICE's project codes and people. Every
    // insert inside `replace_state` stamps `auth.uid()`, so these become
    // Bob's rows; the deletes could not see Alice's.
    const bobState = fullState('bob-hash');
    await bob.storage.write(bobState);

    expect(await alice.storage.read()).toEqual(aliceState);
    expect(await bob.storage.read()).toEqual(bobState);

    // And the rows really are two disjoint sets, not one shared set read
    // twice: Bob's own unfiltered select returns only his.
    const bobRows = await bob.client.from('otls').select('project_code, owner_id');
    const rows = (bobRows.data ?? []) as readonly { project_code: string; owner_id: string }[];
    expect(rows.every((r) => r.owner_id === bob.userId)).toBe(true);
    expect(rows).toHaveLength(2);

    // Bob now clears his account. Alice's identical-looking rows survive.
    await bob.storage.write(EMPTY_STATE);
    expect(await bob.storage.read()).toEqual(EMPTY_STATE);
    expect(await alice.storage.read()).toEqual(aliceState);
  });

  it('gives an unapproved account nothing, through the RPC as well as through selects', async () => {
    // Registration is open, so the approval gate is the whole security model
    // for a stranger who signs up. A new RPC that ignored it would be a way
    // around every policy in 0003_rls.sql.
    await expect(pending.storage.read()).resolves.toEqual(EMPTY_STATE);

    await expect(pending.storage.write(fullState('nope'))).rejects.toThrow(
      /new row violates row-level security policy/,
    );

    // And the write it attempted left nothing behind anywhere.
    for (const table of DOMAIN_TABLES) {
      const { count, error } = await pending.client
        .from(table)
        .select('owner_id', { count: 'exact', head: true });
      expect(error, `select on ${table}`).toBeNull();
      expect(count ?? 0, `rows an unapproved account owns in ${table}`).toBe(0);
    }
  });

  it('stops a revoked account writing, and does not destroy what it owns', async () => {
    // Revocation (§4.4) hides data; it must not delete it. Worth checking
    // specifically for the RPC, whose first act is seven DELETEs — if those
    // were somehow exempt from the policies while the INSERTs were not, a
    // revoked account's own write would empty its account.
    const state = fullState('revocable');
    await alice.storage.write(state);

    await setApproval(alice.userId, false);
    await expect(alice.storage.read()).resolves.toEqual(EMPTY_STATE);
    await expect(alice.storage.write(fullState('after-revocation'))).rejects.toThrow(
      /new row violates row-level security policy/,
    );

    await setApproval(alice.userId, true);
    await expect(alice.storage.read()).resolves.toEqual(state);
  });
});
