-- Multi-admin Timesheet Helper: widen two primary keys, and make `write`
-- a single atomic statement.
--
-- Two separate problems, one migration, because the second cannot be made
-- correct without the first.
--
-- ---------------------------------------------------------------------------
-- 1. Two primary keys from 0001_schema.sql are NARROWER than the domain
-- ---------------------------------------------------------------------------
--
-- `stat_holidays` was keyed `(owner_id, date)`, which says "one holiday per
-- day". The domain disagrees: a StatHoliday carries an `otl_project_code`, and
-- two holidays falling on the same date but booking to different STAT OTLs is
-- an ordinary thing for an admin to enter. Verified against the live project
-- before writing this file -- inserting two such rows returns
-- `23505 duplicate key value violates unique constraint "stat_holidays_pkey"`.
--
-- `leave_ranges` was keyed `(owner_id, person_id, start_date,
-- otl_project_code)` -- it omits `end_date`, so one person cannot have two
-- leave ranges starting on the same day. Splitting a range (a week of
-- vacation where one day is booked differently) produces exactly that, and it
-- too returns `23505` against the applied schema.
--
-- Both are widened below to include the columns that actually distinguish the
-- rows. Widening a key can only ever ACCEPT rows a narrower key rejected; no
-- row that was legal before becomes illegal, so this cannot fail on existing
-- data.
--
-- ---------------------------------------------------------------------------
-- 2. `replace_state()` -- why the whole write is one function
-- ---------------------------------------------------------------------------
--
-- PostgREST gives one transaction per REQUEST, not per session. So a client
-- that writes the account by `.delete()` and then `.insert()` has made two
-- requests and two transactions: if the insert fails -- for a constraint
-- violation, a dropped connection, a closed laptop lid -- the delete has
-- already committed and the account's data is gone. That is a data-loss path,
-- and removing one is the entire point of this rewrite; reintroducing it in
-- the storage layer would be self-defeating.
--
-- It is not a theoretical failure either. Before the widenings above, the
-- inserts really did fail with 23505 on input the UI legitimately produces.
--
-- So the whole write is this one function, called once through `.rpc()`. One
-- request, one transaction, atomic: either the account's entire state is
-- replaced or nothing changes at all.
--
-- SECURITY INVOKER -- stated explicitly, though it is also the default,
-- because getting this wrong would be catastrophic and silent. A SECURITY
-- DEFINER function runs as its owner (here, a superuser), and a superuser
-- BYPASSES row-level security: every isolation guarantee 0003_rls.sql
-- establishes would simply not apply inside the function body, and this one
-- function would become a hole straight through the model the whole design
-- rests on. As SECURITY INVOKER it runs as the caller -- role `authenticated`,
-- with their JWT -- so the policies apply exactly as they do to any other
-- statement:
--
--   * the DELETEs cannot reach another account's rows, because
--     `<table>_delete`'s `using` makes those rows invisible;
--   * the INSERTs cannot create a row for another owner, because
--     `<table>_insert`'s `with check` refuses it;
--   * an unapproved or revoked account gets nothing done at all, because
--     `is_approved()` is a term in every one of those policies.
--
-- `owner_id` is set explicitly to `auth.uid()` in each insert rather than
-- leaning on the column default. The default would produce the same value, but
-- the guarantee should be readable in the statement that makes it.
--
-- `auth.uid()` is written schema-qualified so it resolves regardless of the
-- `search_path` set below.
--
-- `person_key` (allocations) appears NOWHERE in this function. It is
-- `generated always as (coalesce(person_id, '')) stored`, and naming it in an
-- INSERT is a hard error: `428C9 cannot insert a non-DEFAULT value into column
-- "person_key"`. Postgres computes it from `person_id`, which is the column
-- the app reads and writes.
--
-- The parameter is `jsonb`, keyed in snake_case to match the columns. The
-- adapter maps camelCase to snake_case field by field on the way in
-- (`src/storage/supabase.ts`); nothing here guesses at a name.
--
-- `coalesce(state->'x', '[]'::jsonb)` on every collection: a state that omits
-- a key means "no rows of that kind", which must clear the table, not skip it.
-- Without the coalesce a missing key yields SQL NULL, `jsonb_to_recordset`
-- returns no rows for it, and the DELETE above would silently be the whole
-- operation -- the same answer, by accident rather than by decision.

-- ---------------------------------------------------------------------------
-- Widen the two keys
-- ---------------------------------------------------------------------------

alter table stat_holidays drop constraint stat_holidays_pkey;
alter table stat_holidays add primary key (owner_id, date, otl_project_code);

alter table leave_ranges drop constraint leave_ranges_pkey;
alter table leave_ranges add primary key (owner_id, person_id, start_date, end_date, otl_project_code);

-- ---------------------------------------------------------------------------
-- The atomic whole-account write
-- ---------------------------------------------------------------------------

create function replace_state(state jsonb) returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  -- Clear first, in one transaction with the inserts below. Scoped by
  -- owner_id for legibility; the delete policies scope it regardless.
  delete from schedule      where owner_id = auth.uid();
  delete from overrides     where owner_id = auth.uid();
  delete from leave_ranges  where owner_id = auth.uid();
  delete from allocations   where owner_id = auth.uid();
  delete from stat_holidays where owner_id = auth.uid();
  delete from people        where owner_id = auth.uid();
  delete from otls          where owner_id = auth.uid();

  insert into otls (
    owner_id, project_code, task_code, expenditure_type_code,
    time_reporting_code, category, leave_subtype, is_default_opex,
    color_index, active
  )
  select
    auth.uid(), r.project_code, r.task_code, r.expenditure_type_code,
    r.time_reporting_code, r.category, r.leave_subtype, r.is_default_opex,
    r.color_index, r.active
  from jsonb_to_recordset(coalesce(state->'otls', '[]'::jsonb)) as r(
    project_code          text,
    task_code             text,
    expenditure_type_code text,
    time_reporting_code   text,
    category              otl_category,
    leave_subtype         leave_subtype,
    is_default_opex       boolean,
    color_index           int,
    active                boolean
  );

  insert into people (owner_id, id, name, role, manager_id)
  select auth.uid(), r.id, r.name, r.role, r.manager_id
  from jsonb_to_recordset(coalesce(state->'people', '[]'::jsonb)) as r(
    id         text,
    name       text,
    role       person_role,
    manager_id text
  );

  insert into stat_holidays (owner_id, date, name, otl_project_code)
  select auth.uid(), r.date, r.name, r.otl_project_code
  from jsonb_to_recordset(coalesce(state->'stat_holidays', '[]'::jsonb)) as r(
    date             date,
    name             text,
    otl_project_code text
  );

  -- person_id is nullable BY DESIGN: null marks the OTL's monthly TOTAL, not
  -- an assignment to a person. It is inserted verbatim; nothing here
  -- coalesces it, and `person_key` is left entirely to the database.
  insert into allocations (owner_id, month, otl_project_code, person_id, hours)
  select auth.uid(), r.month, r.otl_project_code, r.person_id, r.hours
  from jsonb_to_recordset(coalesce(state->'allocations', '[]'::jsonb)) as r(
    month            text,
    otl_project_code text,
    person_id        text,
    hours            numeric(8,2)
  );

  insert into leave_ranges (owner_id, person_id, start_date, end_date, otl_project_code)
  select auth.uid(), r.person_id, r.start_date, r.end_date, r.otl_project_code
  from jsonb_to_recordset(coalesce(state->'leave_ranges', '[]'::jsonb)) as r(
    person_id        text,
    start_date       date,
    end_date         date,
    otl_project_code text
  );

  insert into overrides (owner_id, person_id, date, otl_project_code, hours)
  select auth.uid(), r.person_id, r.date, r.otl_project_code, r.hours
  from jsonb_to_recordset(coalesce(state->'overrides', '[]'::jsonb)) as r(
    person_id        text,
    date             date,
    otl_project_code text,
    hours            numeric(8,2)
  );

  -- blocks is the cell total; override_blocks is how much of it the user
  -- pinned. They legitimately differ, and `pin_within_cell` enforces
  -- override_blocks <= blocks. Both are carried; neither is derived.
  insert into schedule (owner_id, person_id, date, otl_project_code, blocks, source, override_blocks)
  select auth.uid(), r.person_id, r.date, r.otl_project_code, r.blocks, r.source, r.override_blocks
  from jsonb_to_recordset(coalesce(state->'schedule', '[]'::jsonb)) as r(
    person_id        text,
    date             date,
    otl_project_code text,
    blocks           int,
    source           entry_source,
    override_blocks  int
  );

  -- `meta` is one row per owner, so it is upserted rather than deleted and
  -- re-inserted: DELETE + INSERT would be identical here, but the upsert says
  -- "there is exactly one of these" in the statement itself.
  --
  -- `state->>'hash'` yields SQL NULL for JSON null and '' for an empty
  -- string, and the two are NOT the same thing: null means "never
  -- calculated", '' is what an edit-before-any-recalculation leaves behind
  -- and is not a certificate (see src/storage/store.ts, `hasCertifiedSchedule`).
  -- The distinction has to survive the round trip, so nothing here coalesces.
  --
  -- `last_calculated_at` is bookkeeping the app does not read (v1's Meta tab
  -- carried only the hash). It tracks the hash: a null hash means no
  -- calculation is being certified, so there is no time to record.
  insert into meta (owner_id, model_hash, last_calculated_at)
  values (
    auth.uid(),
    state->>'hash',
    case when state->>'hash' is null then null else now() end
  )
  on conflict (owner_id) do update
    set model_hash         = excluded.model_hash,
        last_calculated_at = excluded.last_calculated_at;
end;
$$;

-- The app calls this as a signed-in user; `authenticated` is the only role
-- that should ever reach it. `anon` is deliberately not granted: an
-- unauthenticated caller has no `auth.uid()`, so every insert would be refused
-- anyway, but not offering the function at all is the clearer statement.
revoke execute on function replace_state(jsonb) from public;
grant execute on function replace_state(jsonb) to authenticated;
