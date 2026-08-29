-- Multi-admin Timesheet Helper: three corrections to 0005.
--
-- All three came out of the Task 8 review, and all three were MEASURED against
-- the live project before this file was written. Each is recorded below with
-- the measurement, because two of them contradict something an earlier file
-- asserts, and a correction that does not say what it is correcting just
-- replaces one confident claim with another.
--
-- ===========================================================================
-- 1. CORRECTION TO 0005: `anon` COULD execute `replace_state`
-- ===========================================================================
--
-- `0005_widen_keys.sql` ends with
--
--     revoke execute on function replace_state(jsonb) from public;
--     grant  execute on function replace_state(jsonb) to authenticated;
--
-- and comments it "`anon` is deliberately not granted ... not offering the
-- function at all is the clearer statement." **That comment was false the
-- moment it was applied, and 0005 is left exactly as it was applied — this
-- file is the correction, not an edit to the record.**
--
-- The revoke is a no-op against the grant that actually exists. Supabase ships
--
--     alter default privileges in schema public
--       grant all on functions to anon, authenticated, service_role;
--
-- from BOTH `postgres` and `supabase_admin` (measured, `pg_default_acl`), so
-- `create function` produced an EXPLICIT grant to the named role `anon`.
-- Revoking from the `PUBLIC` pseudo-role does not touch an explicit grant to a
-- named role. Measured on the deployed function, `pg_proc.proacl`:
--
--     replace_state(state jsonb)
--       postgres=X/postgres | anon=X/postgres | authenticated=X/postgres | service_role=X/postgres
--
-- Note what IS missing there: the bare `=X/postgres` PUBLIC entry. The 0005
-- revoke did exactly what it said and nothing that mattered.
--
-- Reproduced from the outside as well, with the publishable key and no session.
-- A control call to a function that does not exist establishes what
-- "unreachable" looks like, so a refusal can be told apart from a 404:
--
--     rpc(definitely_not_a_function_xyz)  -> PGRST202  (does not exist)
--     rpc(replace_state, {not_the_param}) -> PGRST202  (wrong signature)
--     rpc(replace_state, {state: {...}})  -> 42501 new row violates row-level
--                                            security policy for table "otls"
--
-- `42501` is not `PGRST202`: the function RAN, as `anon`, through all seven
-- DELETEs (matching nothing — `auth.uid()` is NULL) and was stopped only by
-- `otls_insert`'s `with check`. Not exploitable for data, because `owner_id` is
-- `not null` and defaults to a NULL `auth.uid()`. But the defence-in-depth
-- layer 0005 claims to have did not exist, on the only write path in the
-- system, and there is no reason to leave an unauthenticated caller able to
-- make the server open a transaction and plan seven DELETEs.
--
-- The fix is at the bottom of this file, after the function is recreated —
-- ordering matters, see there.
--
-- The other four functions this project creates were swept at the same time.
-- All four are `security definer` and all four are anon-executable for the same
-- default-privileges reason. Left alone deliberately:
--
--   is_approved()                 -> anon gets `false`. It is the expression
--   is_account_owner()               every RLS policy already evaluates on
--                                    anon's behalf; refusing to answer it
--                                    would hide nothing.
--   handle_new_user()             -> trigger functions. Calling one directly
--   handle_user_email_confirmed()    outside a trigger errors on the missing
--                                    trigger context; they leak nothing and
--                                    they change nothing.
--
-- `alter default privileges ... revoke execute on functions from anon` would
-- stop this recurring for FUTURE functions, and is deliberately not done here:
-- it is a project-wide change to how every schema-public function is created,
-- including ones no migration in this repo owns, and it belongs in a decision
-- of its own rather than smuggled into a fix for one function.
--
-- ===========================================================================
-- 2. `hours` was `numeric(8,2)`, and the domain does not round
-- ===========================================================================
--
-- `src/ui/components/AllocationGrid.tsx` states it in its file header: "Hours
-- are never rounded. A non-multiple of 0.5 is accepted and stored as typed."
-- Nothing on any entry path validates precision — `serialize.ts` checks only
-- `Number.isFinite`. So the domain admits any finite number and 0001's column
-- admitted two decimal places.
--
-- Measured on this database, through the exact coercion `replace_state` uses
-- (`jsonb_to_recordset(...) as r(hours numeric(8,2))`):
--
--     sent by the app      numeric(8,2)   plain numeric
--     1.005                1.01           1.005
--     12.3456              12.35          12.3456
--     0.30000000000000004  0.30           0.30000000000000004
--     7.25                 7.25           7.25
--
-- So write-then-read is not an identity, and that is not a rounding nit: the
-- model that comes back differs from the model that was hashed, so `hashModel`
-- disagrees with the stored hash and the staleness banner reappears after a
-- reload the user did nothing to cause. Measured:
--
--     hashModel(hours = 1.005, as typed)          = 9b5a66b7
--     hashModel(hours = 1.01,  as read back)      = c79fdbd5
--
-- That is v1's permanent-nag bug, which amendment A1 exists to prevent,
-- rebuilt through the storage layer instead of through `Meta`.
--
-- Widened to unconstrained `numeric` rather than to a wider fixed scale,
-- because ANY fixed scale still rounds something and picking one is a guess
-- about what a user will type. `0.30000000000000004` above is not a contrived
-- value — it is what `0.1 + 0.2` serialises to, and only unconstrained
-- `numeric` returns it unchanged. Postgres `numeric` stores the exact decimal
-- it was given, so the round trip is an identity for every finite double the
-- app can hold.
--
-- What is given up: `numeric(8,2)` also bounded the magnitude at 999999.99 and
-- raised `22003` above it. That was never a domain rule — nothing in `src/`
-- enforces it — and it presented as "this account cannot be saved" rather than
-- as a rejected keystroke. The `check (hours >= 0)` constraints from 0001 are
-- untouched and still apply.
--
-- ===========================================================================
-- 3. `replace_state(null)` was a one-call self-wipe
-- ===========================================================================
--
-- `coalesce(state->'x', '[]'::jsonb)` is right for a MISSING KEY — a state
-- that omits a collection means "no rows of that kind", which must clear the
-- table. But if `state` itself is SQL NULL, every collection coalesces to `[]`,
-- the seven DELETEs run against real rows, and the account empties in one call.
-- Only ever the caller's own account, so this is robustness rather than a
-- security hole, and the adapter never does it. Guarded anyway, at the top,
-- because a whole-account delete should not be reachable by passing nothing.
--
-- (`{"otls": null}` — JSON null, not SQL NULL — already fails correctly out of
-- `jsonb_to_recordset` and rolls the transaction back. Both cases were traced;
-- only the first one needed a guard.)


-- ---------------------------------------------------------------------------
-- 2. Widen the two `hours` columns
-- ---------------------------------------------------------------------------
--
-- Widening a numeric can only accept values the narrower type rejected or
-- rounded, so no stored row can become illegal. Both tables are keyed on
-- `owner_id` and neither column is in any index or generated expression, so
-- this is a plain rewrite.

alter table allocations alter column hours type numeric;
alter table overrides   alter column hours type numeric;


-- ---------------------------------------------------------------------------
-- 1 + 2 + 3. Recreate `replace_state`
-- ---------------------------------------------------------------------------
--
-- `create or replace`, and the body below is 0005's body with exactly two
-- changes: the null guard at the top, and `hours numeric` in place of
-- `hours numeric(8,2)` in the `allocations` and `overrides` recordsets.
-- Everything else — the seven DELETEs, the insert order, the explicit
-- `auth.uid()`, the `meta` upsert, `security invoker`, `set search_path` — is
-- unchanged and is unchanged deliberately: the review approved that design.
--
-- SECURITY INVOKER is restated rather than inherited. It is the default, but a
-- SECURITY DEFINER version of this function would run as its owner (`postgres`,
-- which owns all eight tables and is not subject to their policies, since
-- nothing here uses `force row level security`) and would be a hole straight
-- through every guarantee 0003_rls.sql establishes. Verified on the deployed
-- function before this file: `pg_proc.prosecdef = false`.

create or replace function replace_state(state jsonb) returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  -- See section 3 in the header. A NULL state is not "an empty account"; it is
  -- a caller that sent nothing, and the seven DELETEs below must not run for it.
  if state is null then
    raise exception 'replace_state(state) requires a state object; got SQL NULL'
      using errcode = 'null_value_not_allowed';
  end if;

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
  --
  -- `hours numeric`, not `numeric(8,2)`: see section 2 in the header.
  insert into allocations (owner_id, month, otl_project_code, person_id, hours)
  select auth.uid(), r.month, r.otl_project_code, r.person_id, r.hours
  from jsonb_to_recordset(coalesce(state->'allocations', '[]'::jsonb)) as r(
    month            text,
    otl_project_code text,
    person_id        text,
    hours            numeric
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
    hours            numeric
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


-- ---------------------------------------------------------------------------
-- 1. Actually take the grant away from `anon`
-- ---------------------------------------------------------------------------
--
-- AFTER the create, not before. `create or replace` preserves an existing ACL,
-- but a future `drop` + `create` would re-apply the default privileges
-- measured in the header and hand `anon` EXECUTE straight back — so the revoke
-- belongs at the end of whatever statement created the function, every time.
--
-- Named-role revoke, because that is the grant that exists. The `from public`
-- in 0005 was aimed at a grant that was never the problem; it is repeated here
-- only so this file leaves nothing to infer.
--
-- Verified after applying, with the same probe as the header:
--   rpc(replace_state, {state: {...}}) as anon -> 42501 before, permission
--   denied after, with PGRST202 still meaning "no such function".

revoke execute on function public.replace_state(jsonb) from anon;
revoke execute on function public.replace_state(jsonb) from public;
grant  execute on function public.replace_state(jsonb) to authenticated;
