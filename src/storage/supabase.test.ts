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
import { APPROVED_RPC, createSupabaseAdapter, toStatePayload, WRITE_RPC } from './supabase';
import { INSUFFICIENT_PRIVILEGE, StorageError } from './modelAdapter';
import type { StoredState } from './modelAdapter';
import type { Model } from '../domain/types';

// ---------------------------------------------------------------------------
// A fake PostgREST
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;
type Tables = Readonly<Record<string, readonly Row[]>>;

interface OrderStep {
  readonly column: string;
  readonly nullsFirst?: boolean;
}

interface SelectCall {
  readonly table: string;
  readonly columns: string;
  /** The full option object of every `.order()`, not just the column name. */
  readonly order: readonly OrderStep[];
  /** What `.select()` was asked to count, e.g. `'exact'`. */
  readonly count: string | undefined;
  /** Every `[from, to]` this builder was asked for. One per page. */
  readonly ranges: readonly (readonly [number, number])[];
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
  /** SQLSTATE the failing rpc reports. Defaults to 42501. */
  readonly rpcCode?: string;
  /** `is_approved()` answers false — a revoked or never-approved account. */
  readonly notApproved?: boolean;
  /**
   * The server's `db-max-rows` ceiling. PostgREST truncates a select to this
   * many rows and reports 200, not an error — the whole reason `selectOrdered`
   * paginates. `Infinity` (the default) is "no ceiling".
   */
  readonly maxRows?: number;
  /**
   * Row count the server reports, when it should disagree with the rows it
   * actually hands over. Models a read that can never be completed.
   */
  readonly countSays?: number;
}

/**
 * An in-memory stand-in for the two client surfaces the adapter uses:
 * `from(table).select(columns, opts).order(...).range(...)` and `rpc(fn, args)`.
 *
 * ## It PROJECTS, and that is the point
 *
 * The first version of this fake recorded the requested column list and then
 * returned the whole fixture row regardless. Every column-list constant in
 * `supabase.ts` was therefore an untested string: dropping `person_id` from
 * `ALLOCATION_COLUMNS` — the one field this entire layer is organised around —
 * left the suite 448/448 green and `tsc` clean. So `select(columns)` here
 * returns rows containing EXACTLY the requested keys, the way PostgREST does.
 * A column list that forgets a field now produces rows without that field, and
 * the mapping tests go red.
 *
 * It also keeps `.order()`'s whole option object rather than the column name
 * alone, so `nullsFirst` is load-bearing; models `db-max-rows` truncation and
 * the exact count that detects it; and gives errors the shape PostgREST really
 * sends (`code`, `details`, `hint`, not `message` alone), so the code that
 * branches on `code` is exercised rather than merely written.
 *
 * Cast to `SupabaseClient` at the boundary: the real client's type is built
 * from generated database types this project does not have, so it cannot be
 * implemented structurally. The integration suite is what checks the real one
 * behaves like this one.
 */
function fakeClient(tables: Tables, failures: Failures = {}): Fake {
  const selects: SelectCall[] = [];
  const rpcs: RpcCall[] = [];
  const maxRows = failures.maxRows ?? Number.POSITIVE_INFINITY;

  const client = {
    from(table: string) {
      const order: OrderStep[] = [];
      const ranges: (readonly [number, number])[] = [];
      let projection: readonly string[] | null = null;
      let exactCount = false;

      const builder = {
        select(columns: string, options?: { readonly count?: string }) {
          exactCount = options?.count === 'exact';
          projection = columns.trim() === '*' ? null : columns.split(',').map((c) => c.trim());
          selects.push({ table, columns, order, count: options?.count, ranges });
          return builder;
        },
        order(column: string, options?: { readonly nullsFirst?: boolean }) {
          order.push(options === undefined ? { column } : { column, ...options });
          return builder;
        },
        range(from: number, to: number) {
          ranges.push([from, to]);
          return builder;
        },
        then<T>(
          onFulfilled: (value: {
            data: readonly Row[] | null;
            error: { message: string; code: string; details: string | null; hint: string | null } | null;
            count: number | null;
          }) => T,
        ) {
          if (failures.selectTable === table) {
            return Promise.resolve({
              data: null,
              // The shape PostgREST actually sends. `code` is what the adapter
              // has to carry through for a caller to tell 42501 from 42P01.
              error: {
                message: `relation "${table}" is on fire`,
                code: '42P01',
                details: 'it is really quite on fire',
                hint: null,
              },
              count: null,
            }).then(onFulfilled);
          }
          const all = tables[table] ?? [];
          const wanted = projection;
          const projected = wanted === null
            ? all
            : all.map((row) => Object.fromEntries(wanted.map((column) => [column, row[column]])));
          const [from, to] = ranges[ranges.length - 1] ?? [0, Number.POSITIVE_INFINITY];
          const page = projected.slice(from, to + 1).slice(0, maxRows);
          return Promise.resolve({
            data: page,
            error: null,
            count: exactCount ? (failures.countSays ?? all.length) : null,
          }).then(onFulfilled);
        },
      };
      return builder;
    },
    rpc(fn: string, args?: Record<string, unknown>) {
      rpcs.push({ fn, args: args ?? {} });
      if (fn === APPROVED_RPC) {
        return Promise.resolve({ data: failures.notApproved !== true, error: null });
      }
      return Promise.resolve(
        failures.rpc === undefined
          ? { data: null, error: null }
          : {
            data: null,
            error: {
              message: failures.rpc,
              code: failures.rpcCode ?? '42501',
              details: null,
              hint: null,
            },
          },
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
    //
    // Asserted as the whole option object, not the column name. `nullsFirst`
    // decides where the OTL's monthly TOTAL (the null-personId allocation)
    // sorts relative to the rows it totals, and ascending and descending
    // disagree on the default — so dropping it is a real behaviour change that
    // an assertion on column names alone cannot see.
    const ordering = Object.fromEntries(fake.selects.map((s) => [s.table, s.order]));
    expect(ordering['otls']).toEqual([{ column: 'project_code' }]);
    expect(ordering['allocations']).toEqual([
      { column: 'month' },
      { column: 'otl_project_code' },
      { column: 'person_id', nullsFirst: true },
    ]);
    expect(ordering['leave_ranges']).toEqual([
      { column: 'person_id' },
      { column: 'start_date' },
      { column: 'end_date' },
      { column: 'otl_project_code' },
    ]);
    expect(ordering['schedule']).toEqual([
      { column: 'person_id' },
      { column: 'date' },
      { column: 'otl_project_code' },
    ]);
  });

  it('throws naming the table when a read fails, and carries the Postgres code', async () => {
    const fake = fakeClient(FULL_TABLES, { selectTable: 'allocations' });
    const failure = await createSupabaseAdapter(fake.client).read().catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(StorageError);
    expect((failure as StorageError).message).toMatch(
      /could not read allocations from Supabase: relation "allocations" is on fire/,
    );
    // The code, not just the prose. Without it no caller can tell a broken
    // database from a refused one except by matching on English.
    expect((failure as StorageError).code).toBe('42P01');
    expect((failure as StorageError).details).toBe('it is really quite on fire');
  });

  // -------------------------------------------------------------------------
  // A denied read is not an empty one
  // -------------------------------------------------------------------------

  it('refuses to hand back a state for an account that is not approved', async () => {
    // The data-loss path this exists to close: RLS answers a revoked account's
    // select with zero rows and no error, so without this the adapter would
    // return EMPTY_STATE, the app would show a blank grid, and the next
    // debounced write would make the blank grid the account's real state.
    //
    // Note the fixture: the tables are FULL. The rows exist; it is the reader
    // who is not allowed to see them. Returning an empty state here would be
    // wrong even though every select "succeeded".
    const fake = fakeClient(FULL_TABLES, { notApproved: true });
    const failure = await createSupabaseAdapter(fake.client).read().catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(StorageError);
    expect((failure as StorageError).code).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('decides approval from profiles, not from the read coming back empty', async () => {
    // The rule, stated as a test: the same empty tables produce an empty state
    // when `is_approved()` says yes and an error when it says no. Nothing in
    // the ROWS distinguishes the two cases — only `profiles` does.
    const approvedEmpty = await createSupabaseAdapter(fakeClient({}).client).read();
    expect(approvedEmpty).toEqual(EMPTY_STATE);

    await expect(
      createSupabaseAdapter(fakeClient({}, { notApproved: true }).client).read(),
    ).rejects.toThrow(/not approved/);

    // And it asks the database, rather than inferring it.
    const fake = fakeClient({});
    await createSupabaseAdapter(fake.client).read();
    expect(fake.rpcs.map((r) => r.fn)).toContain(APPROVED_RPC);
  });

  // -------------------------------------------------------------------------
  // A truncated read is not a short state
  // -------------------------------------------------------------------------

  it('pages past the server row ceiling instead of returning a prefix', async () => {
    // PostgREST caps an unbounded select at `db-max-rows` and answers 200 with
    // a partial Content-Range — no error anywhere. Combined with a write that
    // replaces the whole account, a prefix read is a delete of everything
    // after it. The ceiling here is 3 against 7 rows, so a single-request read
    // would return 3 and lose 4.
    const many = Array.from({ length: 7 }, (_, i) => ({
      person_id: 'rep',
      date: `2026-01-0${i + 1}`,
      otl_project_code: 'CAP-1',
      blocks: 15,
      source: 'CALC',
      override_blocks: 0,
    }));
    const fake = fakeClient({ ...FULL_TABLES, schedule: many }, { maxRows: 3 });
    const state = await createSupabaseAdapter(fake.client).read();
    expect(state.entries).toHaveLength(7);
    expect(state.entries.map((e) => e.date)).toEqual(many.map((r) => r.date));

    // And it did it by asking for successive ranges, not by asking once.
    const scheduleRanges = fake.selects.filter((s) => s.table === 'schedule').flatMap((s) => s.ranges);
    expect(scheduleRanges.length).toBeGreaterThan(1);
    expect(scheduleRanges[0]?.[0]).toBe(0);
    expect(fake.selects.every((s) => s.count === 'exact')).toBe(true);
  });

  it('throws rather than return a short state when the server stops short', async () => {
    // The count says 99; the server will only ever hand over 2. That is a read
    // that cannot be completed, and the one thing it must not do is quietly
    // become the state the next write commits.
    const fake = fakeClient(FULL_TABLES, { countSays: 99 });
    await expect(createSupabaseAdapter(fake.client).read()).rejects.toThrow(
      /stopped returning rows at 2 of 99/,
    );
  });

  it('throws when the server returns no row count at all', async () => {
    // Without a count there is no way to know a page is the whole table.
    const noCount = {
      from() {
        const builder = {
          select: () => builder,
          order: () => builder,
          range: () => builder,
          then: <T,>(f: (v: { data: never[]; error: null; count: null }) => T) =>
            Promise.resolve({ data: [], error: null, count: null }).then(f),
        };
        return builder;
      },
      rpc: () => Promise.resolve({ data: true, error: null }),
    } as unknown as SupabaseClient;
    await expect(createSupabaseAdapter(noCount).read()).rejects.toThrow(/no row count/);
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

  it('throws when the write fails, carrying the Postgres code', async () => {
    const fake = fakeClient({}, { rpc: 'new row violates row-level security policy for table "otls"' });
    const failure = await createSupabaseAdapter(fake.client)
      .write(FULL_STATE)
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(StorageError);
    expect((failure as StorageError).message).toMatch(
      /could not write state to Supabase: new row violates row-level security policy/,
    );
    // A revoked admin hits exactly this. The app has to route it to the
    // pending/revoked screen, and it must not have to do that by reading the
    // sentence — which is why the code is carried and not flattened away.
    expect((failure as StorageError).code).toBe(INSUFFICIENT_PRIVILEGE);
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
