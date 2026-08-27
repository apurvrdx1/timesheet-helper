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

## `migrations/0002_profiles.sql`

Creates `profiles(id, email, approved, is_owner, created_at)` and a trigger that inserts a
row whenever someone signs up (`auth.users` insert → `handle_new_user()` → `profiles`
insert). Every new row defaults to `approved = false, is_owner = false` — registration
grants nothing until the owner approves it.

A partial unique index, `one_owner_only`, makes a second `is_owner = true` row impossible at
the database level: `create unique index one_owner_only on profiles (is_owner) where
is_owner;`. This is not application-level validation — Postgres rejects the write outright
with a `23505 duplicate key value violates unique constraint "one_owner_only"` error.

`handle_new_user()` is `security definer` with `set search_path = public`, because it writes
to `public.profiles` from a trigger on `auth.users`, a table the signing-up user cannot
otherwise touch. Omitting the explicit `search_path` on a `security definer` function is a
known privilege-escalation vector and must not be dropped in a future edit.

This migration does **not** enable RLS or write policies on `profiles` — that is Task 3,
deliberately separate so the isolation model gets its own review. Until then, `profiles` is
readable by anyone holding a valid session, the same known gap already noted above for the
eight domain tables. **Do not point the app at this schema until RLS is applied.**

## Bootstrapping the owner account

The first account cannot be approved by anyone, because no owner exists yet. This is a
required, one-time, by-hand step, and there is deliberately no in-app path to create an
owner — an app that can mint its own owner can be tricked into minting someone else's.

1. Have the person who will run this instance sign up normally through the app (or via
   Authentication → Add user in the dashboard) with their real email.
2. Find their user id — either Authentication → Users in the dashboard, or in the SQL
   Editor:
   ```sql
   select id, email from auth.users where email = 'THEIR_EMAIL';
   ```
3. In the SQL Editor, run once:
   ```sql
   update profiles set approved = true, is_owner = true where email = 'THEIR_EMAIL';
   ```
4. Confirm it took:
   ```sql
   select email, approved, is_owner from profiles where email = 'THEIR_EMAIL';
   -- expect approved = true, is_owner = true
   ```

If this is run a second time against a different email while an owner already exists, the
`one_owner_only` index refuses the write — see `migrations/0002_profiles.sql` above. That
failure is expected: only one owner may ever exist, and changing who holds the role means
first clearing the flag on the current owner in the same session.
