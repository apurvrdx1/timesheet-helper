/**
 * Unit tests for the Supabase storage adapter.
 *
 * The fake client below returns the shapes MEASURED against the live project
 * (see the table in `supabase.ts`), not the shapes the plan remembered:
 * `numeric` arrives as a JS `number`, `date` as a `'YYYY-MM-DD'` string, enums
 * as strings, nullable columns as genuine `null`. A mock that disagreed with
 * the server would make every test here prove nothing about the real thing.
 *
 * The one deliberate exception is `coerces a numeric that arrives as a string`,
 * which feeds the shape PostgREST does NOT produce, to show the adapter is
 * still correct if it ever starts to.
 *
 * What these tests cannot check is that the column lists match the live
 * schema, or that `replace_state` accepts the payload. Only
 * `supabase.integration.test.ts` can, and it does.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { createSupabaseAdapter, toStatePayload, WRITE_RPC } from './supabase';
import type { StoredState } from './modelAdapter';
import type { Model } from '../domain/types';

// ---------------------------------------------------------------------------
// A fake PostgREST
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;
type Tables = Readonly<Record<string, readonly Row[]>>;

interface SelectCall {
  readonly table: string;
  readonly columns: string;
  readonly order: readonly string[];
}
interface RpcCall {
  readonly fn: string;
  readonly args: Record<string, unknown>;
}

interface Fake {
  readonly client: SupabaseClient;
  readonly selects: SelectCall[];
  readonly rpcs: RpcCall[];
}

interface Failures {
  /** Table whose select should come back as an error. */
  readonly selectTable?: string;
  /** Message the rpc should come back as an error with. */
  readonly rpc?: string;
}

/**
 * An in-memory stand-in for the two client surfaces the adapter uses:
 * `from(table).select(columns).order(...)` and `rpc(fn, args)`. It records
 * every call, which is how the tests assert on things that have no visible
 * result — that `'*'` is never selected, that `person_key` is never written,
 * and that the write is exactly one request.
 *
 * Cast to `SupabaseClient` at the boundary: the real client's type is built
 * from generated database types this project does not have, so it cannot be
 * implemented structurally. The integration suite is what checks the real one
 * behaves like this one.
 */
function fakeClient(tables: Tables, failures: Failures = {}): Fake {
  const selects: SelectCall[] = [];
  const rpcs: RpcCall[] = [];

  const client = {
    from(table: string) {
      const order: string[] = [];
      const call: SelectCall = { table, columns: '', order };
      const builder = {
        select(columns: string) {
          selects.push({ ...call, columns, order });
          return builder;
        },
        order(column: string) {
          order.push(column);
          return builder;
        },
        then<T>(onFulfilled: (value: { data: readonly Row[] | null; error: { message: string } | null }) => T) {
          const result = failures.selectTable === table
            ? { data: null, error: { message: `relation "${table}" is on fire` } }
            : { data: tables[table] ?? [], error: null };
          return Promise.resolve(result).then(onFulfilled);
        },
      };
      return builder;
    },
    rpc(fn: string, args: Record<string, unknown>) {
      rpcs.push({ fn, args });
      return Promise.resolve(
        failures.rpc === undefined ? { data: null, error: null } : { data: null, error: { message: failures.rpc } },
      );
    },
  };

  return { client: client as unknown as SupabaseClient, selects, rpcs };
}

// ---------------------------------------------------------------------------
// Fixtures — every shape the round trip has to survive
// ---------------------------------------------------------------------------

/** Exactly what PostgREST returns for the state in `FULL_STATE` below. */
const FULL_TABLES: Tables = {
  otls: [
    {
      project_code: 'CAP-1',
      task_code: 'T1',
      expenditure_type_code: 'E1',
      time_reporting_code: 'R1',
      category: 'CAPEX',
      leave_subtype: null,
      is_default_opex: false,
      color_index: 3,
      active: true,
    },
    {
      project_code: 'LV-1',
      task_code: '',
      expenditure_type_code: '',
      time_reporting_code: '',
      category: 'LEAVE',
      leave_subtype: 'STAT',
      is_default_opex: false,
      color_index: 1,
      active: false,
    },
  ],
  people: [
    { id: 'mgr', name: 'Mira Manager', role: 'MANAGER', manager_id: null },
    { id: 'rep', name: 'Ray Report', role: 'REPORT', manager_id: 'mgr' },
  ],
  // The same date twice, pointing at two different OTLs. Legal in the domain,
  // and a 23505 against the primary key 0001 shipped — 0005 widened it.
  stat_holidays: [
    { date: '2026-07-01', name: 'Canada Day', otl_project_code: 'CAP-1' },
    { date: '2026-07-01', name: 'Canada Day (stat)', otl_project_code: 'LV-1' },
  ],
  allocations: [
    // The critical case: a null person_id is the OTL's MONTHLY TOTAL.
    { month: '2026-01', otl_project_code: 'CAP-1', person_id: null, hours: 40 },
    { month: '2026-01', otl_project_code: 'CAP-1', person_id: 'rep', hours: 12.25 },
  ],
  // Same start date, different end dates. Also a 23505 before 0005.
  leave_ranges: [
    { person_id: 'rep', start_date: '2026-03-02', end_date: '2026-03-04', otl_project_code: 'LV-1' },
    { person_id: 'rep', start_date: '2026-03-02', end_date: '2026-03-06', otl_project_code: 'LV-1' },
  ],
  overrides: [{ person_id: 'rep', date: '2026-01-05', otl_project_code: 'CAP-1', hours: 3.5 }],
  schedule: [
    // overrideBlocks < blocks: the user pinned part of the cell.
    { person_id: 'rep', date: '2026-01-05', otl_project_code: 'CAP-1', blocks: 15, source: 'OVERRIDE', override_blocks: 7 },
    // overrideBlocks 0: nothing pinned.
    { person_id: 'rep', date: '2026-01-06', otl_project_code: 'CAP-1', blocks: 15, source: 'CALC', override_blocks: 0 },
  ],
  meta: [{ model_hash: 'deadbeef' }],
};

const FULL_MODEL: Model = {
  otls: [
    {
      projectCode: 'CAP-1',
      taskCode: 'T1',
      expenditureTypeCode: 'E1',
      timeReportingCode: 'R1',
      category: 'CAPEX',
      leaveSubtype: null,
      isDefaultOpex: false,
      colorIndex: 3,
      active: true,
    },
    {
      projectCode: 'LV-1',
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
    { id: 'mgr', name: 'Mira Manager', role: 'MANAGER', managerId: null },
    { id: 'rep', name: 'Ray Report', role: 'REPORT', managerId: 'mgr' },
  ],
  statHolidays: [
    { date: '2026-07-01', name: 'Canada Day', otlProjectCode: 'CAP-1' },
    { date: '2026-07-01', name: 'Canada Day (stat)', otlProjectCode: 'LV-1' },
  ],
  allocations: [
    { month: '2026-01', otlProjectCode: 'CAP-1', personId: null, hours: 40 },
    { month: '2026-01', otlProjectCode: 'CAP-1', personId: 'rep', hours: 12.25 },
  ],
  leave: [
    { personId: 'rep', startDate: '2026-03-02', endDate: '2026-03-04', otlProjectCode: 'LV-1' },
    { personId: 'rep', startDate: '2026-03-02', endDate: '2026-03-06', otlProjectCode: 'LV-1' },
  ],
  overrides: [{ personId: 'rep', date: '2026-01-05', otlProjectCode: 'CAP-1', hours: 3.5 }],
};

const FULL_STATE: StoredState = {
  model: FULL_MODEL,
  entries: [
    { personId: 'rep', date: '2026-01-05', otlProjectCode: 'CAP-1', blocks: 15, source: 'OVERRIDE', overrideBlocks: 7 },
    { personId: 'rep', date: '2026-01-06', otlProjectCode: 'CAP-1', blocks: 15, source: 'CALC', overrideBlocks: 0 },
  ],
  hash: 'deadbeef',
};

const EMPTY_STATE: StoredState = {
  model: { otls: [], people: [], statHolidays: [], allocations: [], leave: [], overrides: [] },
  entries: [],
  hash: null,
};

/** Every string anywhere in a value, however deeply nested. */
function everyKey(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) everyKey(item, into);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      into.add(key);
      everyKey(nested, into);
    }
  }
  return into;
}

// ---------------------------------------------------------------------------
// read
// ---------------------------------------------------------------------------

describe('createSupabaseAdapter().read', () => {
  it('assembles every table into a StoredState', async () => {
    const fake = fakeClient(FULL_TABLES);
    await expect(createSupabaseAdapter(fake.client).read()).resolves.toEqual(FULL_STATE);
  });

  it('keeps a null allocation personId strictly null', async () => {
    // The single most important case in the suite. A null person_id marks the
    // OTL's monthly TOTAL; if it came back as '' or as the string "null", a
    // team budget would silently become an allocation for a person named
    // "null". `toBeNull` rather than `toBeFalsy`: '' and 0 are falsy too.
    const state = await createSupabaseAdapter(fakeClient(FULL_TABLES).client).read();
    const total = state.model.allocations[0];
    expect(total?.personId).toBeNull();
    expect(total?.hours).toBe(40);

    const assigned = state.model.allocations[1];
    expect(assigned?.personId).toBe('rep');
  });

  it('returns hours as a number, not a string', async () => {
    // Matches the live measurement: PostgREST renders numeric unquoted.
    const state = await createSupabaseAdapter(fakeClient(FULL_TABLES).client).read();
    expect(typeof state.model.allocations[1]?.hours).toBe('number');
    expect(state.model.allocations[1]?.hours).toBe(12.25);
    expect(typeof state.model.overrides[0]?.hours).toBe('number');
    expect(state.model.overrides[0]?.hours).toBe(3.5);
  });

  it('coerces a numeric that arrives as a string', async () => {
    // The shape PostgREST does not currently produce. Asserted anyway so that
    // if a future PostgREST or a numeric wider than a double ever starts
    // quoting, the adapter is already correct rather than silently producing
    // NaN-adjacent arithmetic on a string.
    const fake = fakeClient({
      ...FULL_TABLES,
      allocations: [{ month: '2026-01', otl_project_code: 'CAP-1', person_id: 'rep', hours: '12.25' }],
      overrides: [{ person_id: 'rep', date: '2026-01-05', otl_project_code: 'CAP-1', hours: '3.50' }],
    });
    const state = await createSupabaseAdapter(fake.client).read();
    expect(state.model.allocations[0]?.hours).toBe(12.25);
    expect(state.model.overrides[0]?.hours).toBe(3.5);
  });

  it('keeps overrideBlocks distinct from blocks', async () => {
    // `blocks` is the cell total; `overrideBlocks` is how much the user
    // pinned. They legitimately differ, and neither may be derived from the
    // other. A mapping that dropped overrideBlocks would still deep-equal on
    // a fixture where the two always matched, so the fixture makes them differ.
    const state = await createSupabaseAdapter(fakeClient(FULL_TABLES).client).read();
    expect(state.entries[0]).toEqual({
      personId: 'rep',
      date: '2026-01-05',
      otlProjectCode: 'CAP-1',
      blocks: 15,
      source: 'OVERRIDE',
      overrideBlocks: 7,
    });
    expect(state.entries[1]?.overrideBlocks).toBe(0);
    expect(state.entries[1]?.blocks).toBe(15);
  });

  it('reads two stat holidays on the same date, and two leave ranges from the same day', async () => {
    // Both were 23505 against the keys 0001 shipped; 0005 widened them. The
    // adapter must not quietly deduplicate what the database now accepts.
    const state = await createSupabaseAdapter(fakeClient(FULL_TABLES).client).read();
    expect(state.model.statHolidays.map((h) => h.otlProjectCode)).toEqual(['CAP-1', 'LV-1']);
    expect(state.model.statHolidays.every((h) => h.date === '2026-07-01')).toBe(true);
    expect(state.model.leave.map((l) => l.endDate)).toEqual(['2026-03-04', '2026-03-06']);
    expect(state.model.leave.every((l) => l.startDate === '2026-03-02')).toBe(true);
  });

  it('reads an account that has never written anything as an empty state, not an error', async () => {
    const fake = fakeClient({});
    await expect(createSupabaseAdapter(fake.client).read()).resolves.toEqual(EMPTY_STATE);
  });

  it('reports a hash of null when there is no meta row', async () => {
    const fake = fakeClient({ ...FULL_TABLES, meta: [] });
    const state = await createSupabaseAdapter(fake.client).read();
    expect(state.hash).toBeNull();
  });

  it('reports a null model_hash as null, and an empty one as empty', async () => {
    // '' is not a certificate, but it is also not null, and the storage layer
    // is not the place to collapse the two. See StoredState.hash.
    const nullHash = await createSupabaseAdapter(
      fakeClient({ ...FULL_TABLES, meta: [{ model_hash: null }] }).client,
    ).read();
    expect(nullHash.hash).toBeNull();

    const emptyHash = await createSupabaseAdapter(
      fakeClient({ ...FULL_TABLES, meta: [{ model_hash: '' }] }).client,
    ).read();
    expect(emptyHash.hash).toBe('');
  });

  it('never selects * and never names person_key', async () => {
    // `allocations.person_key` is `generated always as (coalesce(person_id,
    // '')) stored`. A star select returns it, and a round trip that read it
    // would try to write it back — `428C9 cannot insert a non-DEFAULT value
    // into column "person_key"`.
    const fake = fakeClient(FULL_TABLES);
    await createSupabaseAdapter(fake.client).read();

    expect(fake.selects.map((s) => s.table).sort()).toEqual([
      'allocations',
      'leave_ranges',
      'meta',
      'otls',
      'overrides',
      'people',
      'schedule',
      'stat_holidays',
    ]);
    for (const select of fake.selects) {
      expect(select.columns, `${select.table} column list`).not.toContain('*');
      expect(select.columns, `${select.table} column list`).not.toContain('person_key');
      expect(select.columns.length).toBeGreaterThan(0);
    }
  });

  it('orders every read by its natural key', async () => {
    // PostgREST promises no order without one, and rows that shuffle between
    // reloads read as data loss even when nothing changed.
    const fake = fakeClient(FULL_TABLES);
    await createSupabaseAdapter(fake.client).read();
    const ordering = Object.fromEntries(fake.selects.map((s) => [s.table, s.order]));
    expect(ordering['otls']).toEqual(['project_code']);
    expect(ordering['allocations']).toEqual(['month', 'otl_project_code', 'person_id']);
    expect(ordering['leave_ranges']).toEqual(['person_id', 'start_date', 'end_date', 'otl_project_code']);
    expect(ordering['schedule']).toEqual(['person_id', 'date', 'otl_project_code']);
  });

  it('throws naming the table when a read fails', async () => {
    const fake = fakeClient(FULL_TABLES, { selectTable: 'allocations' });
    await expect(createSupabaseAdapter(fake.client).read()).rejects.toThrow(
      /could not read allocations from Supabase: relation "allocations" is on fire/,
    );
  });
});

// ---------------------------------------------------------------------------
// write
// ---------------------------------------------------------------------------

describe('createSupabaseAdapter().write', () => {
  it('is exactly one request', async () => {
    // Not decoration. Eight deletes and eight inserts would be sixteen
    // transactions, and a failure part-way through would leave the account
    // half-erased. One `.rpc()` is one transaction.
    const fake = fakeClient({});
    await createSupabaseAdapter(fake.client).write(FULL_STATE);
    expect(fake.rpcs).toHaveLength(1);
    expect(fake.rpcs[0]?.fn).toBe(WRITE_RPC);
    expect(fake.selects).toHaveLength(0);
  });

  it('sends the whole state, snake_cased field by field', async () => {
    const fake = fakeClient({});
    await createSupabaseAdapter(fake.client).write(FULL_STATE);
    expect(fake.rpcs[0]?.args).toEqual({
      state: {
        otls: FULL_TABLES['otls'],
        people: FULL_TABLES['people'],
        stat_holidays: FULL_TABLES['stat_holidays'],
        allocations: FULL_TABLES['allocations'],
        leave_ranges: FULL_TABLES['leave_ranges'],
        overrides: FULL_TABLES['overrides'],
        schedule: FULL_TABLES['schedule'],
        hash: 'deadbeef',
      },
    });
  });

  it('never sends person_key or owner_id', async () => {
    // person_key is generated (428C9 to write). owner_id is the RPC's to
    // stamp, from auth.uid(); a client-supplied one is exactly what the
    // insert policies' `with check` exists to refuse.
    const keys = everyKey(toStatePayload(FULL_STATE));
    expect(keys.has('person_key')).toBe(false);
    expect(keys.has('owner_id')).toBe(false);
    expect(keys.has('person_id')).toBe(true);
  });

  it('sends a null allocation personId as null', async () => {
    const payload = toStatePayload(FULL_STATE);
    expect(payload.allocations[0]?.person_id).toBeNull();
    // And explicitly not as either of the two ways this goes wrong.
    expect(JSON.stringify(payload.allocations[0])).toContain('"person_id":null');
    expect(JSON.stringify(payload.allocations[0])).not.toContain('"person_id":""');
    expect(JSON.stringify(payload.allocations[0])).not.toContain('"person_id":"null"');
  });

  it('sends a null hash as null, and an empty hash as empty', async () => {
    expect(toStatePayload({ ...FULL_STATE, hash: null }).hash).toBeNull();
    expect(toStatePayload({ ...FULL_STATE, hash: '' }).hash).toBe('');
  });

  it('carries blocks and overrideBlocks separately', async () => {
    const payload = toStatePayload(FULL_STATE);
    expect(payload.schedule[0]).toEqual({
      person_id: 'rep',
      date: '2026-01-05',
      otl_project_code: 'CAP-1',
      blocks: 15,
      source: 'OVERRIDE',
      override_blocks: 7,
    });
    expect(payload.schedule[1]?.override_blocks).toBe(0);
  });

  it('sends empty arrays for an empty state rather than omitting them', async () => {
    // A missing key would mean "leave that table alone", which is not what an
    // empty model means — it means clear it. The RPC coalesces a missing key
    // to `[]` anyway; sending it makes the intent explicit on both sides.
    const fake = fakeClient({});
    await createSupabaseAdapter(fake.client).write(EMPTY_STATE);
    expect(fake.rpcs[0]?.args).toEqual({
      state: {
        otls: [],
        people: [],
        stat_holidays: [],
        allocations: [],
        leave_ranges: [],
        overrides: [],
        schedule: [],
        hash: null,
      },
    });
  });

  it('throws when the write fails', async () => {
    const fake = fakeClient({}, { rpc: 'new row violates row-level security policy for table "otls"' });
    await expect(createSupabaseAdapter(fake.client).write(FULL_STATE)).rejects.toThrow(
      /could not write state to Supabase: new row violates row-level security policy/,
    );
  });
});

// ---------------------------------------------------------------------------
// Round trip
// ---------------------------------------------------------------------------

describe('createSupabaseAdapter round trip', () => {
  it('reads back exactly what it wrote', async () => {
    // Feeds the write's own payload back as the read's rows. That is only a
    // check on the two mappings agreeing with each other — the check that
    // either agrees with the live schema is the integration suite.
    const writer = fakeClient({});
    await createSupabaseAdapter(writer.client).write(FULL_STATE);
    const sent = writer.rpcs[0]?.args['state'] as Record<string, readonly Row[] | string | null>;

    const reader = fakeClient({
      otls: sent['otls'] as readonly Row[],
      people: sent['people'] as readonly Row[],
      stat_holidays: sent['stat_holidays'] as readonly Row[],
      allocations: sent['allocations'] as readonly Row[],
      leave_ranges: sent['leave_ranges'] as readonly Row[],
      overrides: sent['overrides'] as readonly Row[],
      schedule: sent['schedule'] as readonly Row[],
      meta: [{ model_hash: sent['hash'] as string | null }],
    });
    await expect(createSupabaseAdapter(reader.client).read()).resolves.toEqual(FULL_STATE);
  });

  it('round trips an empty state', async () => {
    const writer = fakeClient({});
    await createSupabaseAdapter(writer.client).write(EMPTY_STATE);
    const reader = fakeClient({ meta: [{ model_hash: null }] });
    await expect(createSupabaseAdapter(reader.client).read()).resolves.toEqual(EMPTY_STATE);
  });
});
