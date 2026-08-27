/**
 * The Supabase storage adapter: the account's whole state, read and written
 * under the row-level security applied in `supabase/migrations/0003_rls.sql`.
 *
 * It replaces all three of v1's backends. Nothing in it names an owner: every
 * query is scoped by the policies, which compare `owner_id` to `auth.uid()`
 * from the caller's own JWT. There is no `.eq('owner_id', …)` anywhere below
 * and there must never be one — a filter the application remembered to write
 * is not isolation, it is a habit. The database refuses to return another
 * account's rows whether or not this file asks it to.
 *
 * ## Three things that are not obvious
 *
 * **1. `write` is one RPC, not eight deletes and eight inserts.** PostgREST
 * gives one transaction per REQUEST. A `.delete()` followed by an `.insert()`
 * is two of them, so a failed insert leaves the delete committed and the
 * account empty. The whole write is `replace_state(jsonb)`
 * (`supabase/migrations/0005_widen_keys.sql`), a single `security invoker`
 * PL/pgSQL function: one request, one transaction, all of it or none of it.
 *
 * **2. No `select('*')`, ever.** `allocations.person_key` is
 * `generated always as (coalesce(person_id, '')) stored`. A star select
 * returns it, and a round trip that read it would try to write it back —
 * which Postgres refuses outright with
 * `428C9 cannot insert a non-DEFAULT value into column "person_key"`.
 * Every read below names its columns, and `person_key` is in none of them.
 *
 * **3. `Allocation.personId === null` is meaningful.** A null marks the row as
 * the OTL's MONTHLY TOTAL, not an assignment. If it round-tripped as `''` or
 * as the string `"null"` a team budget would silently become an allocation for
 * a person named "null". Nothing here coalesces it, in either direction.
 *
 * ## What PostgREST actually returns
 *
 * Measured against the live project before this file was written, not
 * remembered:
 *
 * | column type | JS `typeof` | example |
 * |---|---|---|
 * | `numeric(8,2)` (`hours`) | `number` | `40`, `12.25` |
 * | `int` (`blocks`, `color_index`) | `number` | `15` |
 * | `date` | `string` | `"2026-01-05"` — no time part, already `IsoDate` |
 * | enum (`category`, `source`, …) | `string` | `"CAPEX"` |
 * | nullable anything | `null` | genuinely `null`, not `""` |
 *
 * So `numeric` comes back as a NUMBER. The plan asserted it came back as a
 * string; that was written from memory and is wrong for this project. `hours`
 * is still put through `Number(...)` on the way in: it is a no-op under the
 * measured behaviour, correct under the other, and costs nothing.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  Allocation,
  EntrySource,
  LeaveRange,
  LeaveSubtype,
  Model,
  Otl,
  OtlCategory,
  Override,
  Person,
  Role,
  ScheduleEntry,
  StatHoliday,
} from '../domain/types';
import { INSUFFICIENT_PRIVILEGE, StorageError } from './modelAdapter';
import type { StorageAdapter, StoredState } from './modelAdapter';

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------
//
// Only the columns this adapter reads are modelled, and they are listed again
// as literal strings below because PostgREST takes the column list as text.
// The two must agree; a column added to one and not the other is the mistake
// these types exist to make loud.
//
// The enum columns are typed as their domain unions rather than as `string`.
// The guarantee is the Postgres enum type itself (`otl_category`,
// `leave_subtype`, `person_role`, `entry_source` in `0001_schema.sql`), which
// cannot hold anything else — not an assumption about what the app wrote.

interface OtlRow {
  readonly project_code: string;
  readonly task_code: string;
  readonly expenditure_type_code: string;
  readonly time_reporting_code: string;
  readonly category: OtlCategory;
  readonly leave_subtype: LeaveSubtype | null;
  readonly is_default_opex: boolean;
  readonly color_index: number;
  readonly active: boolean;
}

interface PersonRow {
  readonly id: string;
  readonly name: string;
  readonly role: Role;
  readonly manager_id: string | null;
}

interface StatHolidayRow {
  readonly date: string;
  readonly name: string;
  readonly otl_project_code: string;
}

interface AllocationRow {
  readonly month: string;
  readonly otl_project_code: string;
  /** Null marks the OTL's monthly total. Never coalesced. */
  readonly person_id: string | null;
  /** `numeric(8,2)`. Measured as a JS number; typed to admit both. */
  readonly hours: number | string;
}

interface LeaveRangeRow {
  readonly person_id: string;
  readonly start_date: string;
  readonly end_date: string;
  readonly otl_project_code: string;
}

interface OverrideRow {
  readonly person_id: string;
  readonly date: string;
  readonly otl_project_code: string;
  readonly hours: number | string;
}

interface ScheduleRow {
  readonly person_id: string;
  readonly date: string;
  readonly otl_project_code: string;
  readonly blocks: number;
  readonly source: EntrySource;
  readonly override_blocks: number;
}

interface MetaRow {
  readonly model_hash: string | null;
}

// ---------------------------------------------------------------------------
// Column lists
// ---------------------------------------------------------------------------
//
// Written out rather than starred, for the `person_key` reason above. Naming
// them also means a column added to a table in a later migration cannot change
// what this adapter reads until someone deliberately adds it here.

const OTL_COLUMNS =
  'project_code, task_code, expenditure_type_code, time_reporting_code, category, leave_subtype, is_default_opex, color_index, active';
const PEOPLE_COLUMNS = 'id, name, role, manager_id';
const STAT_HOLIDAY_COLUMNS = 'date, name, otl_project_code';
const ALLOCATION_COLUMNS = 'month, otl_project_code, person_id, hours';
const LEAVE_RANGE_COLUMNS = 'person_id, start_date, end_date, otl_project_code';
const OVERRIDE_COLUMNS = 'person_id, date, otl_project_code, hours';
const SCHEDULE_COLUMNS = 'person_id, date, otl_project_code, blocks, source, override_blocks';
const META_COLUMNS = 'model_hash';

/** The RPC that performs the whole write. See `0005_widen_keys.sql`. */
export const WRITE_RPC = 'replace_state';

/**
 * The RPC that answers "is the caller approved?".
 *
 * `is_approved()` (`0003_rls.sql`) is the same `security definer` function
 * every row-level-security policy calls, so it cannot disagree with what the
 * policies will do — it reads `profiles.approved` for `auth.uid()` and
 * coalesces a missing profile to false. `read` below calls it because a
 * `using` refusal is SILENT: RLS hides rows, it does not raise, so a revoked
 * account's select is indistinguishable from a brand-new account's.
 */
export const APPROVED_RPC = 'is_approved';

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * How many rows one page of a read asks for.
 *
 * Not a limit: `selectOrdered` below keeps asking until it has the whole table
 * (see there for why a partial read is a data-loss bug and not a performance
 * one). The number only trades round trips against payload size.
 */
const PAGE_SIZE = 1000;

/**
 * One ordered `select`, read to completion.
 *
 * The order columns are each table's natural key, so a reload presents rows in
 * the same sequence every time — PostgREST makes no ordering promise
 * otherwise, and a UI whose rows shuffle between reloads looks like data loss
 * even when nothing changed.
 *
 * `nullsFirst` is stated explicitly wherever a sort column is nullable: the
 * default differs between ascending and descending, and "whichever Postgres
 * felt like" is not an order.
 *
 * ## Why this paginates, and why it counts
 *
 * An unbounded PostgREST select is NOT "every row". Every project carries a
 * `db-max-rows` ceiling (Settings → API → "Max rows"); over it PostgREST
 * returns **200 with a partial `Content-Range`**, and supabase-js reports no
 * error at all. `schedule` holds one row per person per day per OTL, so a real
 * account is thousands of rows and is over any plausible ceiling.
 *
 * That would be survivable if reads were all this layer did. They are not:
 * `write` is an unconditional whole-account replace, so a silently truncated
 * read followed by the next debounced write DELETES the remainder — atomically
 * and irreversibly. A short read is therefore a data-loss bug, not a
 * performance one.
 *
 * The loop below is deliberately independent of what the ceiling actually is,
 * because this project's value could not be measured from here (it needs an
 * approved account, and no service-role key was available) and could be changed
 * in the dashboard tomorrow. It asks the server for the exact row count and
 * keeps requesting ranges until it holds that many:
 *
 *   * a page shorter than asked for is fine — that is the ceiling doing its
 *     job — as long as the loop comes back for the rest;
 *   * a page of zero rows while rows are still outstanding is a hard stop, so
 *     a ceiling of 0 (or a server that stops paginating) fails loudly instead
 *     of silently returning a prefix;
 *   * a count that changes mid-read means someone else wrote to this account
 *     between pages, so the pages no longer describe one state — a torn read,
 *     which is refused rather than assembled.
 *
 * The cost is an exact count per table per read. That is the price of the
 * guarantee, and it is paid once per load.
 */
async function selectOrdered<Row>(
  client: SupabaseClient,
  table: string,
  columns: string,
  order: readonly { readonly column: string; readonly nullsFirst?: boolean }[],
): Promise<readonly Row[]> {
  const rows: Row[] = [];
  let expected: number | null = null;

  for (;;) {
    let query = client.from(table).select(columns, { count: 'exact' });
    for (const step of order) {
      query = step.nullsFirst === undefined
        ? query.order(step.column)
        : query.order(step.column, { nullsFirst: step.nullsFirst });
    }
    const { data, error, count } = await query.range(rows.length, rows.length + PAGE_SIZE - 1);
    if (error !== null) {
      throw new StorageError(`could not read ${table} from Supabase: ${error.message}`, error);
    }
    if (count === null || count === undefined) {
      // Asked for `count: 'exact'` and did not get one. Without it there is no
      // way to know whether this page is the whole table, and guessing is the
      // bug this function exists to remove.
      throw new StorageError(
        `could not read ${table} from Supabase: the server returned no row count, so a complete read cannot be confirmed`,
      );
    }
    if (expected === null) {
      expected = count;
    } else if (count !== expected) {
      throw new StorageError(
        `could not read ${table} from Supabase: the row count changed from ${expected} to ${count} while reading, so the pages do not describe one state`,
      );
    }

    // Without generated database types the client types a runtime column list
    // as `GenericStringError[]`, so the narrowing has to go through `unknown`.
    // The `Row` shapes above are the actual contract, and the integration suite
    // is what checks they match the live schema.
    const page = (data ?? []) as unknown as readonly Row[];
    rows.push(...page);

    if (rows.length >= expected) break;
    if (page.length === 0) {
      throw new StorageError(
        `could not read ${table} from Supabase: the server stopped returning rows at ${rows.length} of ${expected}`,
      );
    }
  }

  if (rows.length !== expected) {
    throw new StorageError(
      `could not read ${table} from Supabase: got ${rows.length} rows where the server counted ${expected}`,
    );
  }
  return rows;
}

function toOtl(row: OtlRow): Otl {
  return {
    projectCode: row.project_code,
    taskCode: row.task_code,
    expenditureTypeCode: row.expenditure_type_code,
    timeReportingCode: row.time_reporting_code,
    category: row.category,
    leaveSubtype: row.leave_subtype,
    isDefaultOpex: row.is_default_opex,
    colorIndex: row.color_index,
    active: row.active,
  };
}

function toPerson(row: PersonRow): Person {
  return { id: row.id, name: row.name, role: row.role, managerId: row.manager_id };
}

function toStatHoliday(row: StatHolidayRow): StatHoliday {
  return { date: row.date, name: row.name, otlProjectCode: row.otl_project_code };
}

function toAllocation(row: AllocationRow): Allocation {
  return {
    month: row.month,
    otlProjectCode: row.otl_project_code,
    // Strictly preserved. `?? ''` here would turn every monthly total into an
    // allocation for a person with an empty id.
    personId: row.person_id,
    hours: Number(row.hours),
  };
}

function toLeaveRange(row: LeaveRangeRow): LeaveRange {
  return {
    personId: row.person_id,
    startDate: row.start_date,
    endDate: row.end_date,
    otlProjectCode: row.otl_project_code,
  };
}

function toOverride(row: OverrideRow): Override {
  return {
    personId: row.person_id,
    date: row.date,
    otlProjectCode: row.otl_project_code,
    hours: Number(row.hours),
  };
}

function toScheduleEntry(row: ScheduleRow): ScheduleEntry {
  return {
    personId: row.person_id,
    date: row.date,
    otlProjectCode: row.otl_project_code,
    // `blocks` is the cell total; `overrideBlocks` is how much of it the user
    // pinned. They legitimately differ (see the doc comment on ScheduleEntry),
    // so neither is derived from the other here.
    blocks: row.blocks,
    source: row.source,
    overrideBlocks: row.override_blocks,
  };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------
//
// The payload is keyed in snake_case to match the columns `replace_state`
// inserts into, and mapped field by field. No automatic camelCase→snake_case
// conversion: a generic converter is silently wrong the day someone adds a
// field whose two spellings do not correspond, and wrong in a way no type
// checks.
//
// `owner_id` is absent on purpose — the RPC stamps every row with
// `auth.uid()` itself. `person_key` is absent on purpose: it is generated,
// and naming it is a 428C9.

interface StatePayload {
  readonly otls: readonly OtlRow[];
  readonly people: readonly PersonRow[];
  readonly stat_holidays: readonly StatHolidayRow[];
  readonly allocations: readonly AllocationRow[];
  readonly leave_ranges: readonly LeaveRangeRow[];
  readonly overrides: readonly OverrideRow[];
  readonly schedule: readonly ScheduleRow[];
  readonly hash: string | null;
}

export function toStatePayload(state: StoredState): StatePayload {
  const { model } = state;
  return {
    otls: model.otls.map((otl) => ({
      project_code: otl.projectCode,
      task_code: otl.taskCode,
      expenditure_type_code: otl.expenditureTypeCode,
      time_reporting_code: otl.timeReportingCode,
      category: otl.category,
      leave_subtype: otl.leaveSubtype,
      is_default_opex: otl.isDefaultOpex,
      color_index: otl.colorIndex,
      active: otl.active,
    })),
    people: model.people.map((person) => ({
      id: person.id,
      name: person.name,
      role: person.role,
      manager_id: person.managerId,
    })),
    stat_holidays: model.statHolidays.map((holiday) => ({
      date: holiday.date,
      name: holiday.name,
      otl_project_code: holiday.otlProjectCode,
    })),
    allocations: model.allocations.map((allocation) => ({
      month: allocation.month,
      otl_project_code: allocation.otlProjectCode,
      person_id: allocation.personId,
      hours: allocation.hours,
    })),
    leave_ranges: model.leave.map((range) => ({
      person_id: range.personId,
      start_date: range.startDate,
      end_date: range.endDate,
      otl_project_code: range.otlProjectCode,
    })),
    overrides: model.overrides.map((override) => ({
      person_id: override.personId,
      date: override.date,
      otl_project_code: override.otlProjectCode,
      hours: override.hours,
    })),
    schedule: state.entries.map((entry) => ({
      person_id: entry.personId,
      date: entry.date,
      otl_project_code: entry.otlProjectCode,
      blocks: entry.blocks,
      source: entry.source,
      override_blocks: entry.overrideBlocks,
    })),
    // Passed through untouched, `null` included: see `StoredState.hash`.
    hash: state.hash,
  };
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

/**
 * Whether the signed-in account is approved, as the database sees it.
 *
 * Deliberately the RPC and not a select on `profiles`: the owner's
 * `profiles_owner_reads_all` policy means a select returns EVERY profile row,
 * so the adapter would have to know its own `auth.uid()` to pick the right
 * one. `is_approved()` already does that server-side, and it is the identical
 * expression the policies themselves evaluate.
 */
async function isApproved(client: SupabaseClient): Promise<boolean> {
  const { data, error } = await client.rpc(APPROVED_RPC);
  if (error !== null && error !== undefined) {
    throw new StorageError(`could not check approval in Supabase: ${error.message}`, error);
  }
  return data === true;
}

/**
 * Binds the adapter to a signed-in Supabase client. The client is injected
 * rather than imported so this module never reaches for `import.meta.env`,
 * and so the unit tests can drive it without a network or a project.
 */
export function createSupabaseAdapter(client: SupabaseClient): StorageAdapter {
  return {
    async read(): Promise<StoredState> {
      // Eight independent reads; none of them depends on another's result, so
      // they go out together rather than as eight serial round trips to a
      // remote region.
      const [approved, otls, people, statHolidays, allocations, leave, overrides, schedule, meta] =
        await Promise.all([
          isApproved(client),
          selectOrdered<OtlRow>(client, 'otls', OTL_COLUMNS, [{ column: 'project_code' }]),
          selectOrdered<PersonRow>(client, 'people', PEOPLE_COLUMNS, [{ column: 'id' }]),
          selectOrdered<StatHolidayRow>(client, 'stat_holidays', STAT_HOLIDAY_COLUMNS, [
            { column: 'date' },
            { column: 'otl_project_code' },
          ]),
          selectOrdered<AllocationRow>(client, 'allocations', ALLOCATION_COLUMNS, [
            { column: 'month' },
            { column: 'otl_project_code' },
            // Nullable, and the null row (the OTL's monthly total) sorts first
            // so it reads as the heading of the rows it totals.
            { column: 'person_id', nullsFirst: true },
          ]),
          selectOrdered<LeaveRangeRow>(client, 'leave_ranges', LEAVE_RANGE_COLUMNS, [
            { column: 'person_id' },
            { column: 'start_date' },
            { column: 'end_date' },
            { column: 'otl_project_code' },
          ]),
          selectOrdered<OverrideRow>(client, 'overrides', OVERRIDE_COLUMNS, [
            { column: 'person_id' },
            { column: 'date' },
            { column: 'otl_project_code' },
          ]),
          selectOrdered<ScheduleRow>(client, 'schedule', SCHEDULE_COLUMNS, [
            { column: 'person_id' },
            { column: 'date' },
            { column: 'otl_project_code' },
          ]),
          selectOrdered<MetaRow>(client, 'meta', META_COLUMNS, [{ column: 'owner_id' }]),
        ]);

      // A denied read must NOT look like an empty account.
      //
      // RLS refuses a select by returning no rows, not by raising, so a revoked
      // admin's eight selects all succeed and all come back empty — exactly
      // what a brand-new approved account looks like. Handing that back as an
      // empty `StoredState` is the top of a data-loss path: the app shows a
      // blank grid, the user types one character, the debounced `write` fires,
      // and `replace_state` makes the blank state the account's real state.
      //
      // So approval is decided HERE, from `profiles` via `is_approved()`, and
      // never from "the read came back empty". The two facts are now
      // distinguishable by the caller: a `StorageError` with code 42501 means
      // "not approved", and an empty `StoredState` means "genuinely empty".
      if (!approved) {
        throw new StorageError(
          'this account is not approved to read its state',
          { code: INSUFFICIENT_PRIVILEGE },
        );
      }

      const model: Model = {
        otls: otls.map(toOtl),
        people: people.map(toPerson),
        statHolidays: statHolidays.map(toStatHoliday),
        allocations: allocations.map(toAllocation),
        leave: leave.map(toLeaveRange),
        overrides: overrides.map(toOverride),
      };

      // No rows anywhere is a valid, expected state, not an error: the account
      // an owner has just approved has never written anything, and that is
      // most accounts' first read. It must produce an empty StoredState so the
      // app opens on an empty grid the user can start filling in. An error
      // here would make "brand new account" indistinguishable from "the
      // database is unreachable", and the app would show a failure to someone
      // who has done nothing wrong.
      //
      // `meta` holds at most one row per owner. `hash` is null when there is
      // no row (never calculated) and otherwise whatever the row holds —
      // including `''`, which is a different fact from null and is preserved.
      return { model, entries: schedule.map(toScheduleEntry), hash: meta[0]?.model_hash ?? null };
    },

    async write(state: StoredState): Promise<void> {
      const { error } = await client.rpc(WRITE_RPC, { state: toStatePayload(state) });
      if (error !== null) {
        // `code` is carried, not flattened into the message. A revoked account
        // hits 42501 here, and the caller has to be able to route that to the
        // pending/revoked screen without matching on the English of
        // `new row violates row-level security policy for table "otls"`.
        throw new StorageError(`could not write state to Supabase: ${error.message}`, error);
      }
    },
  };
}
