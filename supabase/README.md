# Supabase — Timesheet Helper

Backend for the multi-admin build: one Postgres project, per-owner row isolation, no
localStorage. See `docs/superpowers/specs/2026-08-27-multi-admin-auth-design.md` for the
full design (sections 5–7 cover isolation, storage, and schema).

Project: https://qhgvkgayadeicnrnuiuu.supabase.co

## The migrations, in order

`migrations/0001_schema.sql` creates the eight domain tables that every `Model` field
(`src/domain/types.ts`) round-trips through: `otls`, `people`, `stat_holidays`,
`allocations`, `leave_ranges`, `overrides`, `schedule`, `meta`.

`migrations/0002_profiles.sql` adds `profiles` (email/approval/owner bookkeeping) and the
sign-up trigger that populates it.

`migrations/0003_rls.sql` enables Row Level Security and writes the policies. Each was a
separate task on purpose — RLS is the property the whole multi-admin design rests on and
got its own review.

`migrations/0005_widen_keys.sql` widens two of 0001's primary keys, which were narrower
than the domain allows, and adds `replace_state(jsonb)` — the single `security invoker`
function through which the app performs every write.

**Until `0003_rls.sql` is applied, do not point the app at this schema.** Without policies,
isolation between admins does not exist.

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

- **Publishable key** (formerly called the "anon" key) is a client-side key scoped entirely
  by RLS. It is meant to be public and ships in the built app. Find it at Project Settings →
  API → the publishable/anon key. It **cannot** create or alter tables — it can only do what
  RLS policies allow once they exist.
- **Project URL** is the URL above.
- Both live in `.env.local` (already gitignored) for local dev, and must be set as build-time
  environment variables wherever the app is deployed.

### Two names for the same two values

Vite only inlines environment variables whose names begin with `VITE_`, so the pair the
browser needs must carry that prefix. The Node-side suites are not built by Vite and read
the unprefixed names. **The GitHub repository secrets use the `VITE_` names**, and the
workflows map across where a suite wants the other spelling.

| Value | Repository secret | App / `playwright.config.ts` read | Node suites read |
|---|---|---|---|
| Project URL | `VITE_SUPABASE_URL` | `VITE_SUPABASE_URL` | `SUPABASE_URL`, falling back to `VITE_SUPABASE_URL` |
| Publishable key | `VITE_SUPABASE_ANON_KEY` | `VITE_SUPABASE_ANON_KEY` | `SUPABASE_ANON_KEY`, falling back to `VITE_SUPABASE_ANON_KEY` |
| Service-role key | `SUPABASE_SERVICE_ROLE_KEY` | *never — see below* | `SUPABASE_SERVICE_ROLE_KEY` |

The fallbacks are `fromEnv()` in `vitest.integration.config.ts` and in `e2e/env.ts`; in both,
a real environment variable beats `.env.local`, which is what lets CI inject secrets as
environment variables and never as files.

Read that table before adding a secret to a workflow. **A GitHub secret that does not exist
interpolates to the empty string rather than failing**, so a misspelled name produces a green
job that did nothing — which is precisely what happened to the keep-warm workflow, and why
`.github/workflows/keepwarm.yml` now opens with an explicit emptiness check on both values.

### The service-role key

It bypasses RLS entirely: anything holding it can read and write every owner's data, and
delete accounts. The rule is **not** "never use it" — CI genuinely requires it, and a rule
that has to be broken to ship is a rule that teaches people to ignore rules. It is:

- **Never in the bundle.** Never under a `VITE_` name, never in `.env.local`, never anywhere
  Vite can see it, because Vite inlines `VITE_`-prefixed values into the published
  JavaScript. Publishing it would hand every visitor every account's data.
- **Never committed.** Not in this file, not in a workflow file, not in a fixture, not in a
  test. It is a repository secret or a shell variable for one command, and nothing else.
- **Never printed.** Not to a log, not to a CI annotation, not into an error message.
- **Never in application code.** Nothing under `src/` outside the `*.integration.test.ts`
  files reads it. Schema changes that need it — the migrations above — are applied by a human
  from the dashboard or an authenticated `supabase` CLI session.
- **Permitted as a CI secret, scoped to the jobs that need it and to no others.**

Two jobs need it. Both are test-only, and both need it for the same reason: they create and
destroy throwaway accounts, and *approving* an account is reserved to the owner while
*deleting* one is reserved to an admin credential — neither is something the publishable key
can do, by design.

| Suite | Job in `deploy.yml` | What it does with the key |
|---|---|---|
| Isolation suite (`npm run test:integration`) | `integration` | Fixture setup and teardown only; never in an assertion. See [Why the service-role key, and why it cannot be avoided](#why-the-service-role-key-and-why-it-cannot-be-avoided) |
| End-to-end journey (`npx playwright test`) | `e2e` | Creates the run's accounts, flips `profiles.approved`, deletes them afterwards |

`.github/workflows/deploy.yml` gives `SUPABASE_SERVICE_ROLE_KEY` to those two jobs and to
nothing else. **The `build` job that compiles and uploads the published bundle does not have
it**, so the artifact that reaches a browser could not carry it even by mistake. Keep that
separation: it is the property this whole section exists to protect.

## `on delete cascade`

Every table's `owner_id` references `auth.users(id) on delete cascade`. Deleting a user row
in the Supabase dashboard (Authentication → Users) deletes every row that user owns across
all eight tables. This is deliberate and is the **only** path in the system that destroys
data — revoking an admin's access (setting `profiles.approved = false`) does not touch their
rows; it only makes them unreachable, and re-approving restores access exactly as it was.
Treat deleting a user as irreversible.

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

After applying `0003_rls.sql`, also run:

```sql
-- Expect rowsecurity = true for all 9 tables. A false here is a data leak.
select tablename, rowsecurity from pg_tables
where schemaname = 'public' order by 1;

-- Expect 35 policies: 4 on each of the 8 domain tables, 3 on profiles.
select tablename, policyname, cmd, qual, with_check from pg_policies
where schemaname = 'public' order by tablename, policyname;

-- Expect prosecdef = t, provolatile = s, proconfig = {search_path=public}
-- for both. Any of the three missing is a real weakness, not a nit.
select proname, prosecdef, provolatile, proconfig from pg_proc
where proname in ('is_approved', 'is_account_owner') order by 1;
```

To test isolation by hand, impersonate a user in the SQL Editor rather than trusting the
app — the SQL Editor connects as a superuser, which **bypasses RLS entirely**, so a query
run plainly there proves nothing:

```sql
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"<a user id>","role":"authenticated"}';
select * from people;   -- only that user's rows, and only if they are approved
rollback;
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

This migration does not enable RLS or write policies on `profiles` — that is
`migrations/0003_rls.sql`, deliberately separate so the isolation model got its own review.

## `migrations/0003_rls.sql`

Row Level Security and the policies. This is the migration the whole design rests on:
isolation between admins is a property of the database, not of application code.

Two helper functions, both `security definer stable set search_path = public`:

- `is_approved()` — reads `profiles.approved` for `auth.uid()`, defaulting to false.
- `is_account_owner()` — reads `profiles.is_owner` for `auth.uid()`, defaulting to false.

`security definer` is required, not stylistic: the functions read `profiles`, which itself
has RLS, so an inline subquery would either apply a second needless gate or — inside the
policies on `profiles` — abort the query with
`42P17: infinite recursion detected in policy for relation "profiles"`. `stable` lets
Postgres evaluate the check once per statement rather than once per row, which matters on
`schedule`. The explicit `search_path` is a privilege-escalation guard and must not be
dropped in a future edit.

Each of the eight domain tables gets four policies — select, insert, update, delete — all
testing `owner_id = auth.uid() and is_approved()`. Update policies carry **both** `using`
and `with check`: `using` decides which rows may be targeted, `with check` decides what
they may become. With `using` alone, an admin could `update ... set owner_id = <someone
else>` and move a row into another account. The policies are written out per table rather
than generated in a loop, so any one table's guarantee is readable in isolation.

**Do not delete a `with check` clause because the tests stay green without it.** Two
things hide it. First, an UPDATE policy with no `with check` at all is not weaker: Postgres
falls back to the `using` expression, so dropping the clause changes nothing. Second — and
this is the trap — relaxing it to something permissive is *also* invisible through
PostgREST today, because Postgres additionally applies the SELECT policy to the row an
UPDATE produces whenever the statement carries a RETURNING clause, and PostgREST always
emits one. `otls_select` and `otls_update`'s `with check` are the same expression, so the
select policy silently covers for a broken update policy. Verified against the live
project: with `otls_update ... with check (true)` the whole isolation suite still passed;
relaxing `otls_select` to `using (true)` as well, and the row moved to the other account.
The `with check` is what guards the plain-SQL path, which has no RETURNING, and it is the
only thing that would still hold if `otls_select` were ever broadened (a shared or
team-wide read policy, say). It is load-bearing precisely where nothing is watching.

`profiles` is deliberately different — three policies, not four:

- `profiles_self_read` — anyone reads their own row. Note there is **no** `is_approved()`
  term: an unapproved account must be able to read its own row, or the app cannot tell it
  apart from an approved one and cannot show the "awaiting approval" screen.
- `profiles_owner_reads_all` — the owner reads every row (the approval queue).
- `profiles_owner_updates` — the owner updates other people's rows only. The
  `id <> auth.uid()` term is what stops the owner revoking themselves, which would leave
  the instance unadministrable with no recovery path short of hand-editing the database.

There is no insert and no delete policy on `profiles`, so no one can create or destroy a
profile through the API. Rows appear only via `handle_new_user()` (`security definer`, so
not subject to these policies) and disappear only by `on delete cascade` when the
`auth.users` row is deleted from the dashboard.

Note: Supabase ships an `ensure_rls` event trigger (`rls_auto_enable`) that runs
`alter table ... enable row level security` on every table created in `public`, so RLS was
already on for all nine tables before this migration — with no policies, which is
default-deny. `0003_rls.sql` re-asserts `enable row level security` anyway, so the guarantee
is legible from that one file and does not depend on a platform trigger continuing to exist.

## `migrations/0005_widen_keys.sql`

Two changes, one migration, because the second cannot be correct without the first.

**The widened keys.** `stat_holidays` was keyed `(owner_id, date)` — "one holiday per day".
The domain disagrees: a `StatHoliday` names an `otl_project_code`, and two holidays on one
date booking to different STAT OTLs is ordinary input. `leave_ranges` was keyed
`(owner_id, person_id, start_date, otl_project_code)`, which omits `end_date`, so one
person could not have two ranges starting the same day — which is exactly what splitting a
week of vacation produces. Both were verified against the live project before the fix:
each returned `23505 duplicate key value violates unique constraint`. The keys are now
`(owner_id, date, otl_project_code)` and
`(owner_id, person_id, start_date, end_date, otl_project_code)`. Widening a key can only
accept rows a narrower one rejected, so it cannot fail on existing data.

**`replace_state(jsonb)`.** The whole of the app's write, as one function. PostgREST gives
one transaction per *request*, so a client that cleared the account with `.delete()` and
then wrote it with `.insert()` would be making two of them: an insert that failed — on
the 23505 above, on a dropped connection, on a closed laptop — would leave the delete
committed and the account empty. That is a data-loss path, and removing one is the point of
this whole schema. One `.rpc()` call is one request and one transaction: the account's
entire state is replaced, or nothing changes.

It is **`security invoker`**, and that is not a style choice. `security definer` would run
the body as the function's owner, and an owner bypasses row-level security — every
guarantee in `0003_rls.sql` would simply not apply inside it, and this one function would
be a hole straight through the isolation model. As `security invoker` it runs as the
caller, so the policies apply to its DELETEs and INSERTs exactly as they do to any other
statement. Verified against the live project:

| Attempt | Result |
|---|---|
| Unapproved account calls it | `42501 new row violates row-level security policy for table "otls"` |
| Account B writes a state naming account A's project codes | Rows created, all owned by B; A's rows untouched |
| Revoked account calls it | Refused, and the rows it already owns survive |
| Write whose `schedule` rows violate `blocks > 0` | `23514`, and the prior state is intact — the DELETEs rolled back with it |

`person_key` appears nowhere in the function. It is
`generated always as (coalesce(person_id, '')) stored`, and naming it in an INSERT is
`428C9 cannot insert a non-DEFAULT value into column "person_key"`. For the same reason
`src/storage/supabase.ts` never uses `select('*')` — a star select returns the generated
column, and a naive round trip would try to write it back.

`execute` is granted to `authenticated` and revoked from `public`. **That revoke did not do
what 0005's comment says it did** — see `0006_lock_down_replace_state.sql` below, which is
the file that actually takes the grant away from `anon`.

## `migrations/0006_lock_down_replace_state.sql`

Three corrections to 0005, all measured against the live project before being written.

**`anon` could execute `replace_state`, and 0005's comment said it could not.** Supabase's
`alter default privileges in schema public grant all on functions to anon, authenticated,
service_role` means `create function` produced an *explicit* grant to the named role `anon`.
`revoke ... from public` removes the `PUBLIC` pseudo-role's grant and leaves an explicit
named-role grant exactly where it was. Measured on the deployed function:

```
replace_state(state jsonb) proacl:
  postgres=X/postgres | anon=X/postgres | authenticated=X/postgres | service_role=X/postgres
```

and reproduced from outside with the publishable key and no session, using a control call
so that "refused" can be told apart from "does not exist":

```
rpc(definitely_not_a_function_xyz)  -> PGRST202   (this is what unreachable looks like)
rpc(replace_state, {not_the_param}) -> PGRST202   (wrong signature, same code)
rpc(replace_state, {state: {...}})  -> 42501 new row violates row-level security
                                       policy for table "otls"
```

`42501` is not `PGRST202`: the function **ran**, as `anon`, through all seven DELETEs
(matching nothing, since `auth.uid()` is NULL) and was stopped only by `otls_insert`'s
`with check`. Never exploitable for data — `owner_id` is `not null` and would have been
NULL — but the defence-in-depth layer 0005 claimed did not exist, on the only write path in
the system. 0006 revokes execute from `anon` by name.

The other four functions this repo creates (`is_approved`, `is_account_owner`,
`handle_new_user`, `handle_user_email_confirmed`) are anon-executable for the same reason
and are left that way on purpose: the first two are the expressions the policies already
evaluate on anon's behalf and return `false`, and the last two are trigger functions that
error outside a trigger context. 0006 does **not** change `alter default privileges`
project-wide; that would affect every future function in `public`, including ones no
migration here owns.

**`hours` was `numeric(8,2)`, and the domain never rounds.** `AllocationGrid.tsx` says so in
its file header and nothing validates precision anywhere on the entry path. Measured through
the exact coercion `replace_state` uses:

| sent by the app | `numeric(8,2)` | plain `numeric` |
|---|---|---|
| `1.005` | `1.01` | `1.005` |
| `12.3456` | `12.35` | `12.3456` |
| `0.30000000000000004` | `0.30` | `0.30000000000000004` |

So write-then-read was not an identity, `hashModel` came back different from what was
stored (`9b5a66b7` vs `c79fdbd5` for that first row), and the staleness banner would return
after a reload the user did nothing to cause — v1's permanent-nag bug, which A1 exists to
prevent. Both `hours` columns are now unconstrained `numeric`, which stores the exact
decimal it is given. A wider *fixed* scale was rejected because any fixed scale still rounds
something, and `0.30000000000000004` is just what `0.1 + 0.2` serialises to.

**`replace_state(null)` was a one-call self-wipe.** `coalesce(state->'x', '[]'::jsonb)` is
right for a missing key, but for a SQL-NULL `state` every collection coalesced to `[]`, the
seven DELETEs ran, and the account emptied. Only ever the caller's own account, and the
adapter never did it. Guarded now with a `raise exception` at the top of the function.


## Running the isolation suite

`src/storage/rls.integration.test.ts` is the automated proof that the policies above
actually isolate one admin from another. It runs against the **real** project — nothing in
it is mocked, because a mock of the database would be a mock of the thing that enforces
isolation, and it would pass just as happily with every policy dropped.

`src/storage/supabase.integration.test.ts` runs alongside it, on the same fixtures pattern,
and proves the storage adapter against the same real schema: the full state round trip, a
null `Allocation.personId` surviving as null, `replace_state`'s atomicity forced by a
constraint violation, and that the new RPC opened no cross-account path.

```bash
npm run test:integration
```

It is deliberately **not** part of `npm test`. It needs network and credentials, and a
developer who has neither should not be looking at red. `vitest.config.ts` excludes
`*.integration.test.ts`; `vitest.integration.config.ts` is the only thing that runs it
(node environment, not jsdom, and a 60s timeout for real round trips).

### Environment variables

| Variable | Where it comes from | What the suite does with it |
|---|---|---|
| `SUPABASE_URL` *(or `VITE_SUPABASE_URL`)* | Project URL, above | Connects |
| `SUPABASE_ANON_KEY` *(or `VITE_SUPABASE_ANON_KEY`)* | Publishable key | **Every assertion.** Each test account is a real session on this key — the exact path the shipped app takes |
| `SUPABASE_SERVICE_ROLE_KEY` | Project Settings → API → service_role | Fixture setup and teardown only. Never used in an assertion |

The first two are already in `.env.local` for `npm run dev`, and the suite reads that file,
so in practice only the third has to be supplied. Real environment variables win over
`.env.local`, which is what lets CI inject all three as secrets.

Locally, keep the service-role key out of files entirely by passing it for one command:

```bash
SUPABASE_SERVICE_ROLE_KEY="$(npx supabase projects api-keys \
  --project-ref qhgvkgayadeicnrnuiuu | jq -r '.keys[]|select(.name=="service_role")|.api_key')" \
  npm run test:integration
```

In CI it is a repository secret, and `.github/workflows/deploy.yml` gives it to the
`integration` job **only** — the job that builds and publishes the bundle does not have it.
It must never be committed, never printed to a log, and never added to any `VITE_`-prefixed
variable, because Vite inlines those into the built bundle, which would publish it. See
[The service-role key](#the-service-role-key) for the rule in full.

### Why the service-role key, and why it cannot be avoided

The suite needs two accounts that are **approved**, and approval is by design impossible
for the publishable key to grant: `profiles_owner_updates` reserves it to the single owner
account. A throwaway run cannot create an owner either — `one_owner_only` permits exactly
one across the whole project, so a suite that minted one could not run twice concurrently,
and a permanent owner would be shared mutable state between runs.

Teardown settles it independently. A run must leave nothing behind, and deleting an
`auth.users` row (which cascades through `profiles` and all eight domain tables) is not
something any client-side key can do. Both jobs need admin access, so the suite uses the
narrowest credential that has it: the project's service-role key, in `beforeAll` and
`afterAll` only. Every isolation claim is made through the publishable key.

### What a run does to the project

Creates four users (`rls-<run-id>-{alice,bob,pending,revoked}@example.test`) plus three
more for the storage suite (`storage-<run-id>-{alice,bob,pending}@example.test`), approves
five of the seven, writes a handful of rows stamped with a per-run id, and deletes all
seven users at the end — then verifies no profile or domain row survived, failing loudly if one
did. Every identifier is unique per run, so two runs at once cannot collide. A completed
run leaves the project exactly as it found it:

```sql
select (select count(*) from auth.users) as users,
       (select count(*) from profiles) as profiles,
       (select count(*) from profiles where is_owner) as owners,
       (select count(*) from otls) as otls;
-- all zero on an otherwise-empty project
```

If the suite is interrupted, teardown may not run. Sweep leftovers with:

```sql
delete from auth.users where email like 'rls-%@example.test'
                       or email like 'storage-%@example.test';
```

## Running the end-to-end journey

`e2e/journey.spec.ts` is the browser-level counterpart: Playwright drives the shipped app
against a live Vite dev server and this project. Two tests — the full planner journey
(setup, allocate, recalculate, override, prove the override survives a second
recalculation), and the auth gate itself, where an unapproved account gets the waiting
screen and *not* the planner.

```bash
npx playwright test
```

Like the isolation suite it builds its own throwaway accounts and deletes them afterwards
(`e2e/fixtures.ts`), for the same reason: it runs on every push, and a suite that wrote
into a standing account would pass exactly once — the second run's `OPEX-ADMIN` collides on
the primary key and its second "Alex" makes the allocation cell ambiguous.

### Environment variables

| Variable | Where it comes from | What the suite does with it |
|---|---|---|
| `VITE_SUPABASE_URL` *(or `SUPABASE_URL`)* | Project URL, above | Passed to the dev server `playwright.config.ts` starts, and used by the fixtures |
| `VITE_SUPABASE_ANON_KEY` *(or `SUPABASE_ANON_KEY`)* | Publishable key | Passed to the dev server. **Every assertion** goes through it, because every assertion goes through the browser |
| `SUPABASE_SERVICE_ROLE_KEY` | Project Settings → API → service_role | Fixture setup and teardown only: create a user, flip `profiles.approved`, delete the user |

The first two are already in `.env.local`; only the third has to be supplied, exactly as
for the isolation suite, and the same warnings apply — never committed, never logged, never
under a `VITE_` name. There is **no skip path**: a missing variable fails the run loudly
with a message naming it (`e2e/env.ts`), because a journey that quietly did not run looks
identical to one that ran and passed.

In CI it is a repository secret, and `.github/workflows/deploy.yml` gives it to the `e2e`
and `integration` jobs **only** — the job that builds and publishes the bundle does not
have it.

### The account that must stay unapproved

The gate test needs an account that is signed in and not approved. It is created by
`createAccount('pending', { approved: false })` in `e2e/fixtures.ts`, it is fresh in every
run, and **nothing approves it** — not the suite, not a migration, not the owner. The
fixture reads its `profiles` row back after creating it and fails if `approved` is anything
but `false`, so the test cannot silently degrade into asserting nothing.

It is deliberately not a standing login. A permanent "pending" account is precisely the
fixture someone approves by accident while debugging, and the test would keep passing for
months afterwards while proving the opposite of what it claims. If that test fails, read
the trace — do not approve an account to find out what happens.

### What a run does to the project

Creates two users (`e2e-<run-id>-{journey,pending}@example.test`), approves one, writes the
planner rows the journey creates, and deletes both users at the end — then verifies no
profile or domain row survived, failing loudly if one did.

If a run is interrupted, teardown may not run. Sweep leftovers with:

```sql
delete from auth.users where email like 'e2e-%@example.test';
```

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
