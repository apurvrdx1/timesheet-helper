# Supabase — Timesheet Helper

Backend for the multi-admin build: one Postgres project, per-owner row isolation, no
localStorage. See `docs/superpowers/specs/2026-08-27-multi-admin-auth-design.md` for the
full design (sections 5–7 cover isolation, storage, and schema).

Project: https://qhgvkgayadeicnrnuiuu.supabase.co

## What's in this migration, and what isn't

`migrations/0001_schema.sql` creates the eight domain tables that every `Model` field
(`src/domain/types.ts`) round-trips through: `otls`, `people`, `stat_holidays`,
`allocations`, `leave_ranges`, `overrides`, `schedule`, `meta`.

It does **not** create the `profiles` table (email/approval/owner bookkeeping) and it does
**not** enable Row Level Security or write any policies. Both are later, separate tasks in
this plan, on purpose — RLS is the property the whole multi-admin design rests on and gets
its own review. **Do not point the app at this schema until RLS is applied**: without it,
any authenticated session can read and write any owner's rows.

## Applying migrations

Migrations live in `supabase/migrations/`, numbered, applied in order, never edited after
merge — new changes get a new numbered file.

Apply with the Supabase CLI (recommended, once the project is linked):

```bash
npx supabase link --project-ref qhgvkgayadeicnrnuiuu
npx supabase db push
```

Or paste the file's contents into the Supabase dashboard's SQL Editor (Project → SQL
Editor → New query) and run it. Either way, apply `0001_schema.sql` before any later
migration.

## Credentials

- **Publishable key** (formerly called the "anon" key; env var `VITE_SUPABASE_ANON_KEY`)
  is a client-side key scoped entirely by RLS. It is meant to be public and ships in the
  built app. Find it at Project Settings → API → the publishable/anon key. It **cannot**
  create or alter tables — it can only do what RLS policies allow once they exist.
- **`VITE_SUPABASE_URL`** is the project URL above.
- Both live in `.env.local` (already gitignored) for local dev, and must be set as build-time
  environment variables wherever the app is deployed.

**The service-role (secret) key must never be used by this app and must never be committed,
in this file or anywhere else.** It bypasses RLS entirely — anything holding it can read or
write every owner's data. Schema changes that require it (like this migration) are applied
by a human, from the dashboard or an authenticated `supabase` CLI session, never from
application code or CI secrets.

## `on delete cascade`

Every table's `owner_id` references `auth.users(id) on delete cascade`. Deleting a user row
in the Supabase dashboard (Authentication → Users) deletes every row that user owns across
all eight tables. This is deliberate and is the **only** path in the system that destroys
data — revoking an admin's access (setting `approved = false`, once `profiles`/RLS exist)
does not touch their rows. Treat deleting a user as irreversible.

## Verifying the applied schema

After applying `0001_schema.sql`, run in the SQL Editor:

```sql
-- Expect exactly these 8 rows
select table_name from information_schema.tables
where table_schema = 'public'
order by 1;
-- allocations, leave_ranges, meta, otls, overrides, people, schedule, stat_holidays

-- Expect the 4 enum types
select typname from pg_type
where typnamespace = 'public'::regnamespace and typtype = 'e'
order by 1;
-- entry_source, leave_subtype, otl_category, person_role

-- Sanity-check the composite primary keys are per-owner (owner_id is the
-- first column of every key) — should return 8 rows, one per table
select tc.table_name, kcu.column_name, kcu.ordinal_position
from information_schema.table_constraints tc
join information_schema.key_column_usage kcu
  on tc.constraint_name = kcu.constraint_name
where tc.constraint_type = 'PRIMARY KEY'
  and tc.table_schema = 'public'
  and kcu.ordinal_position = 1
order by 1;
-- every row's column_name should be owner_id

-- Exercise the two invariants that matter most:
-- 1) a null person_id (OTL monthly TOTAL) and a real person_id can coexist
--    for the same owner/month/otl_project_code
-- 2) override_blocks can never exceed blocks (pin_within_cell)
-- Run as an authenticated user (or temporarily insert a row into
-- auth.users and reference its id) — do not leave test rows behind.
```

## Bootstrapping the owner account

Not part of this migration (needs `profiles`, added in a later task) but documented here
since it's a manual, one-time step: the very first account cannot be approved by anyone,
because no owner exists yet. Its `approved` and `is_owner` flags must be set by hand in the
Supabase dashboard (Table Editor → `profiles`). There is deliberately no in-app path to
create an owner.
