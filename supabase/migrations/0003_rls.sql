-- Multi-admin Timesheet Helper: row-level security.
--
-- This is the migration the whole design rests on. Isolation between admins is
-- a property of the database, not of application code: a bug in a query cannot
-- leak another account's rows, because the restriction sits below anything the
-- application writes. See docs/superpowers/specs/2026-08-27-multi-admin-auth-design.md
-- §4 (accounts and access), §4.4 (revocation) and §5 (isolation).
--
-- Two invariants are enforced here, on every table, for every operation:
--
--   1. `owner_id = auth.uid()`  -- you only ever touch your own rows.
--   2. `is_approved()`          -- and only once the owner has approved you.
--
-- The second is not decoration. Registration is open, so without it a stranger
-- would have a working, fully functional instance the moment they signed up.
-- The approval gate is a database predicate, not a UI check: an unapproved
-- account holds a valid session and Postgres still returns nothing and accepts
-- nothing from it. Revocation (§4.4) works by the same mechanism -- flipping
-- `approved` back to false takes effect on the account's next query, with no
-- session to invalidate separately and no window where a revoked account can
-- still read.
--
-- Note on what was already true: Supabase ships an `ensure_rls` event trigger
-- (`rls_auto_enable`) that runs `alter table ... enable row level security` on
-- every table created in `public`, so RLS was already ON for the nine tables
-- from 0001/0002 -- with no policies, which means default-deny. The
-- `alter table ... enable row level security` statements below are therefore
-- re-assertions rather than changes. They are kept because the isolation model
-- must be legible from this file alone, and must not depend on a
-- platform-provided trigger continuing to exist.

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- SECURITY DEFINER so the check itself is not subject to profiles' own RLS.
-- Without it, a policy on a domain table that calls this function would read
-- `profiles`, which would apply profiles' policies, which is both a needless
-- second gate and -- for the profiles policies below -- outright recursion.
--
-- STABLE so Postgres may evaluate it once per statement instead of once per
-- row. On `schedule`, which holds one row per person per day per OTL, that is
-- the difference between one lookup and thousands.
--
-- `set search_path = public` is not optional: omitting it on a SECURITY
-- DEFINER function is a known privilege-escalation vector, since a caller who
-- can manipulate the search path could get this elevated function to resolve
-- to their own objects instead of the intended ones.
--
-- `coalesce(..., false)` matters: a caller with no profiles row at all (an
-- anonymous session, or a user whose profile was removed) must read as NOT
-- approved, never as null. A null predicate is not true, so it would deny
-- anyway -- but relying on that is relying on an accident.
create function is_approved() returns boolean
language sql security definer stable set search_path = public as $$
  select coalesce((select p.approved from profiles p where p.id = auth.uid()), false);
$$;

-- Same reasoning, for the single owner account. This one is load-bearing in a
-- second way: it is called from policies ON `profiles` itself. Written inline
-- as a subquery -- `(select is_owner from profiles where id = auth.uid())` --
-- inside a policy on `profiles`, Postgres re-applies profiles' policies while
-- evaluating them and aborts the query with
-- `42P17: infinite recursion detected in policy for relation "profiles"`.
-- Routing it through a SECURITY DEFINER function is what breaks the cycle.
--
-- Named `is_account_owner` rather than `is_owner` so it can never be confused,
-- by a reader or by the parser, with the `profiles.is_owner` column it reads.
create function is_account_owner() returns boolean
language sql security definer stable set search_path = public as $$
  select coalesce((select p.is_owner from profiles p where p.id = auth.uid()), false);
$$;

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------
--
-- Deliberately asymmetric, and the only table whose policies are not the
-- standard four.
--
-- Reads: an admin sees exactly one row, their own -- admins cannot see each
-- other at all (§4.1). Note there is no `is_approved()` term here: an
-- unapproved account MUST be able to read its own row, or the app could not
-- tell it apart from an approved one and could not show the "awaiting
-- approval" screen (§4.2 step 4).
--
-- Writes: only the owner, only on other people's rows. `id <> auth.uid()` is
-- the whole of §4.4's last line -- the owner cannot revoke themselves. If they
-- could, one mis-click would leave the instance with no one able to administer
-- it and no recovery path short of hand-editing the database.
--
-- There is no insert policy and no delete policy, so nobody -- owner included
-- -- can create or destroy a profile through the API. Rows appear only via the
-- `handle_new_user()` trigger from 0002 (SECURITY DEFINER, so it is not
-- subject to these policies) and disappear only by `on delete cascade` when
-- the auth.users row is deleted from the dashboard. Permanently removing an
-- account is a deliberate out-of-app action, by design (§4.4).

alter table profiles enable row level security;

create policy profiles_self_read on profiles
  for select using (id = auth.uid());

create policy profiles_owner_reads_all on profiles
  for select using (is_account_owner());

-- Both `using` and `with check`, for the same reason as every table below:
-- `using` picks which rows the owner may target, `with check` constrains what
-- those rows may become. Postgres would default `with check` to the `using`
-- expression here, but writing it out means the guarantee is readable rather
-- than inferred.
create policy profiles_owner_updates on profiles
  for update
  using (is_account_owner() and id <> auth.uid())
  with check (is_account_owner() and id <> auth.uid());

-- ---------------------------------------------------------------------------
-- The eight domain tables
-- ---------------------------------------------------------------------------
--
-- Identical four policies each, written out per table rather than generated in
-- a DO-block loop. Nine tables times four operations is verbose, and that is
-- the point: this is the code standing between one manager's team data and
-- another's, and verbose-and-auditable beats clever-and-opaque. A reviewer can
-- read any one table's block in isolation and see the entire guarantee.
--
-- Every update policy carries BOTH `using` and `with check`. This is the
-- single most commonly missed thing in RLS. With `using` alone, an attacker
-- may target only their own rows -- but nothing constrains the resulting row,
-- so they can `update ... set owner_id = '<someone else>'` and hand their row
-- to another account, or, in a schema where they could guess a key, walk a row
-- out of someone else's account into their own. `with check` is what makes
-- `owner_id` immutable in practice.
--
-- Insert has only `with check` because there is no existing row to test; the
-- same predicate is what stops a caller from writing a row stamped with
-- someone else's owner_id, notwithstanding the `default auth.uid()` on the
-- column, which a caller is free to override.

-- otls
create policy otls_select on otls for select
  using (owner_id = auth.uid() and is_approved());

create policy otls_insert on otls for insert
  with check (owner_id = auth.uid() and is_approved());

create policy otls_update on otls for update
  using (owner_id = auth.uid() and is_approved())
  with check (owner_id = auth.uid() and is_approved());

create policy otls_delete on otls for delete
  using (owner_id = auth.uid() and is_approved());

-- people
create policy people_select on people for select
  using (owner_id = auth.uid() and is_approved());

create policy people_insert on people for insert
  with check (owner_id = auth.uid() and is_approved());

create policy people_update on people for update
  using (owner_id = auth.uid() and is_approved())
  with check (owner_id = auth.uid() and is_approved());

create policy people_delete on people for delete
  using (owner_id = auth.uid() and is_approved());

-- stat_holidays
create policy stat_holidays_select on stat_holidays for select
  using (owner_id = auth.uid() and is_approved());

create policy stat_holidays_insert on stat_holidays for insert
  with check (owner_id = auth.uid() and is_approved());

create policy stat_holidays_update on stat_holidays for update
  using (owner_id = auth.uid() and is_approved())
  with check (owner_id = auth.uid() and is_approved());

create policy stat_holidays_delete on stat_holidays for delete
  using (owner_id = auth.uid() and is_approved());

-- allocations
create policy allocations_select on allocations for select
  using (owner_id = auth.uid() and is_approved());

create policy allocations_insert on allocations for insert
  with check (owner_id = auth.uid() and is_approved());

create policy allocations_update on allocations for update
  using (owner_id = auth.uid() and is_approved())
  with check (owner_id = auth.uid() and is_approved());

create policy allocations_delete on allocations for delete
  using (owner_id = auth.uid() and is_approved());

-- leave_ranges
create policy leave_ranges_select on leave_ranges for select
  using (owner_id = auth.uid() and is_approved());

create policy leave_ranges_insert on leave_ranges for insert
  with check (owner_id = auth.uid() and is_approved());

create policy leave_ranges_update on leave_ranges for update
  using (owner_id = auth.uid() and is_approved())
  with check (owner_id = auth.uid() and is_approved());

create policy leave_ranges_delete on leave_ranges for delete
  using (owner_id = auth.uid() and is_approved());

-- overrides
create policy overrides_select on overrides for select
  using (owner_id = auth.uid() and is_approved());

create policy overrides_insert on overrides for insert
  with check (owner_id = auth.uid() and is_approved());

create policy overrides_update on overrides for update
  using (owner_id = auth.uid() and is_approved())
  with check (owner_id = auth.uid() and is_approved());

create policy overrides_delete on overrides for delete
  using (owner_id = auth.uid() and is_approved());

-- schedule
create policy schedule_select on schedule for select
  using (owner_id = auth.uid() and is_approved());

create policy schedule_insert on schedule for insert
  with check (owner_id = auth.uid() and is_approved());

create policy schedule_update on schedule for update
  using (owner_id = auth.uid() and is_approved())
  with check (owner_id = auth.uid() and is_approved());

create policy schedule_delete on schedule for delete
  using (owner_id = auth.uid() and is_approved());

-- meta
create policy meta_select on meta for select
  using (owner_id = auth.uid() and is_approved());

create policy meta_insert on meta for insert
  with check (owner_id = auth.uid() and is_approved());

create policy meta_update on meta for update
  using (owner_id = auth.uid() and is_approved())
  with check (owner_id = auth.uid() and is_approved());

create policy meta_delete on meta for delete
  using (owner_id = auth.uid() and is_approved());

-- Re-assert RLS on all eight domain tables. Already true via Supabase's
-- ensure_rls event trigger; stated here so the guarantee survives that trigger
-- and does not depend on it.
alter table otls          enable row level security;
alter table people        enable row level security;
alter table stat_holidays enable row level security;
alter table allocations   enable row level security;
alter table leave_ranges  enable row level security;
alter table overrides     enable row level security;
alter table schedule      enable row level security;
alter table meta          enable row level security;
