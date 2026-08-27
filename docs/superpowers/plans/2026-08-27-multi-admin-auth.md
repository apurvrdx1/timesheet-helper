# Multi-Admin Auth and Supabase Storage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Timesheet Helper from a single-user tool into a portal several managers each use for their own team, with email/password login, owner-approved registration, database-enforced isolation, and per-person weekly export.

**Architecture:** Supabase (Postgres + Auth) replaces all three storage adapters. Isolation is a row-level security predicate, not application code. The storage adapter interface changes from a serialised spreadsheet payload to the typed domain `Model`, which deletes an entire class of defect rather than porting it. The domain layer is untouched.

**Tech Stack:** Supabase (Postgres, Auth, RLS), `@supabase/supabase-js`, React 19, TypeScript, Vite, Astryx, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-27-multi-admin-auth-design.md`

**Design system:** `./DESIGN.md` — authoritative for every visual decision. Read it before any UI task.

## Global Constraints

- TypeScript runs with `"strict": true` and `"noUncheckedIndexedAccess": true`. No `any`, no non-null assertions (`!`), no disabling flags.
- `npm run typecheck` runs `tsc -b` and is the real type check. `vitest` does NOT type-check.
- `npm run coverage` is the CI gate. Thresholds 80 lines / 80 functions / 75 branches / 80 statements. Do not lower them.
- The domain layer (`src/domain/`) is UNTOUCHED by this plan. If a task appears to require changing it, stop and report.
- Isolation is enforced by RLS, never by application code. A query that relies on the app filtering by owner is a defect.
- No credential is ever committed. Only `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` reach the bundle; both are public by design and grant nothing without RLS.
- Every regression test must be MEASURED failing before the fix — revert the hunk and run it. Do not assume.
- Immutability: never mutate `Model` in place.
- Every interactive element needs an accessible name; the E2E drives the app through them.
- Conventional commits.

---

## File Structure

```
supabase/migrations/0001_schema.sql      Tables, enums, constraints
supabase/migrations/0002_profiles.sql    profiles + the auth.users trigger
supabase/migrations/0003_rls.sql         RLS policies and the is_approved() helper
supabase/README.md                       Project setup + owner bootstrap

src/auth/client.ts                       Supabase client singleton
src/auth/useSession.ts                   Session + profile hook
src/auth/AuthGate.tsx                    Gates the app on session + approval
src/auth/SignInPage.tsx                  Sign in / sign up
src/auth/PendingApproval.tsx             Awaiting-approval screen

src/storage/adapter.ts                   MODIFIED: read(): Promise<Model>
src/storage/supabase.ts                  The one adapter: rows <-> Model
src/storage/store.ts                     MODIFIED: simplified, no tab machinery
src/storage/csv.ts                       CSV generation (all that survives of serialize.ts)

src/ui/pages/AdminPage.tsx               Owner-only: approve / revoke accounts
src/ui/components/ExportMenu.tsx         Copy-as-table / download CSV
src/ui/App.tsx                           MODIFIED: auth gate, owner tab

DELETED: src/storage/registry.ts, serialize.ts (sheet half), localCache.ts,
         adapters/{localOnly,google,microsoft,graph}.ts + tests,
         src/ui/components/ConnectionSettings.tsx, apps-script/,
         docs/microsoft-setup.md, @azure/msal-browser
```

---

# Phase 1 — Database

## Task 1: Supabase project and schema

**Do this first.** It needs a human to create the project, and everything else depends on its shape.

**Files:**
- Create: `supabase/migrations/0001_schema.sql`, `supabase/README.md`

**Interfaces:**
- Produces: the tables every later task reads and writes; `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` recorded by the human.

- [ ] **Step 1: Human creates the project**

Ask the human to create a free Supabase project and supply the project URL and the **anon** key (Project Settings → API). Do NOT ask for the service-role key — it bypasses RLS and must never be near this codebase.

- [ ] **Step 2: Write the schema**

```sql
-- supabase/migrations/0001_schema.sql
create type otl_category   as enum ('CAPEX', 'OPEX', 'LEAVE');
create type leave_subtype  as enum ('VACATION', 'STAT', 'PERSONAL', 'SICK');
create type person_role    as enum ('MANAGER', 'REPORT');
create type entry_source   as enum ('CALC', 'OVERRIDE', 'LEAVE');

create table otls (
  owner_id               uuid not null references auth.users(id) on delete cascade default auth.uid(),
  project_code           text not null,
  task_code              text not null default '',
  expenditure_type_code  text not null default '',
  time_reporting_code    text not null default '',
  category               otl_category not null,
  leave_subtype          leave_subtype,
  is_default_opex        boolean not null default false,
  color_index            int  not null default 0 check (color_index between 0 and 9),
  active                 boolean not null default true,
  primary key (owner_id, project_code),
  constraint leave_needs_subtype check (category <> 'LEAVE' or leave_subtype is not null),
  constraint only_opex_is_default check (not is_default_opex or category = 'OPEX')
);

create table people (
  owner_id   uuid not null references auth.users(id) on delete cascade default auth.uid(),
  id         text not null,
  name       text not null check (length(trim(name)) > 0),
  role       person_role not null,
  manager_id text,
  primary key (owner_id, id)
);

create table stat_holidays (
  owner_id         uuid not null references auth.users(id) on delete cascade default auth.uid(),
  date             date not null,
  name             text not null,
  otl_project_code text not null,
  primary key (owner_id, date)
);

create table allocations (
  owner_id         uuid not null references auth.users(id) on delete cascade default auth.uid(),
  month            text not null check (month ~ '^\d{4}-\d{2}$'),
  otl_project_code text not null,
  person_id        text,                      -- null marks the OTL's monthly TOTAL
  hours            numeric(8,2) not null check (hours >= 0),
  primary key (owner_id, month, otl_project_code, coalesce(person_id, ''))
);

create table leave_ranges (
  owner_id         uuid not null references auth.users(id) on delete cascade default auth.uid(),
  person_id        text not null,
  start_date       date not null,
  end_date         date not null check (end_date >= start_date),
  otl_project_code text not null,
  primary key (owner_id, person_id, start_date, otl_project_code)
);

create table overrides (
  owner_id         uuid not null references auth.users(id) on delete cascade default auth.uid(),
  person_id        text not null,
  date             date not null,
  otl_project_code text not null,
  hours            numeric(8,2) not null check (hours >= 0),
  primary key (owner_id, person_id, date, otl_project_code)
);

create table schedule (
  owner_id         uuid not null references auth.users(id) on delete cascade default auth.uid(),
  person_id        text not null,
  date             date not null,
  otl_project_code text not null,
  blocks           int not null check (blocks > 0),
  source           entry_source not null,
  override_blocks  int not null default 0 check (override_blocks >= 0),
  primary key (owner_id, person_id, date, otl_project_code),
  constraint pin_within_cell check (override_blocks <= blocks)
);

create table meta (
  owner_id            uuid primary key references auth.users(id) on delete cascade default auth.uid(),
  model_hash          text,
  last_calculated_at  timestamptz
);
```

Note `pin_within_cell`: the database now enforces the invariant that took a review round to discover. `on delete cascade` means removing a user in the dashboard removes their data — the only path that destroys data, and it is deliberate and manual.

- [ ] **Step 3: Apply it and verify**

Apply via the Supabase SQL editor. Verify with:
```sql
select table_name from information_schema.tables where table_schema='public' order by 1;
```
Expected: `allocations, leave_ranges, meta, otls, overrides, people, schedule, stat_holidays`.

- [ ] **Step 4: Write supabase/README.md**

Document: creating the project, applying migrations in order, where to find the anon key, and that the service-role key must never be used by this app.

- [ ] **Step 5: Commit**

```bash
git add supabase/
git commit -m "feat: supabase schema for per-owner timesheet data"
```

---

## Task 2: Profiles and the approval flag

**Files:**
- Create: `supabase/migrations/0002_profiles.sql`

**Interfaces:**
- Produces: `public.profiles(id, email, approved, is_owner, created_at)`; a trigger creating a row on sign-up.

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/0002_profiles.sql
create table profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  email      text not null,
  approved   boolean not null default false,
  is_owner   boolean not null default false,
  created_at timestamptz not null default now()
);

-- Exactly one owner, enforced by the database rather than by convention.
create unique index one_owner_only on profiles (is_owner) where is_owner;

create function handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email) values (new.id, new.email);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();
```

The partial unique index is the point: `one_owner_only` makes a second owner impossible at the database level, so no application bug can create one.

- [ ] **Step 2: Verify the trigger**

Create a test user via the dashboard (Authentication → Add user). Then:
```sql
select email, approved, is_owner from profiles;
```
Expected: one row, `approved = false`, `is_owner = false`. Delete the test user afterwards.

- [ ] **Step 3: Bootstrap the owner**

The human signs up with their own email, then runs ONCE in the SQL editor:
```sql
update profiles set approved = true, is_owner = true where email = 'THEIR_EMAIL';
```
Document this in `supabase/README.md` as a required one-time manual step. There is deliberately no in-app path to create an owner.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0002_profiles.sql supabase/README.md
git commit -m "feat: profiles table with approval and owner flags"
```

---

## Task 3: Row-level security — the task everything rests on

**Files:**
- Create: `supabase/migrations/0003_rls.sql`

**Interfaces:**
- Produces: `is_approved()`; RLS enabled with per-operation policies on all nine tables.

- [ ] **Step 1: Write the policies**

```sql
-- supabase/migrations/0003_rls.sql

-- SECURITY DEFINER so the check itself is not subject to profiles' own RLS,
-- which would recurse. STABLE so Postgres evaluates it once per statement.
create function is_approved() returns boolean
language sql security definer stable set search_path = public as $$
  select coalesce((select approved from profiles where id = auth.uid()), false);
$$;

alter table profiles enable row level security;

create policy profiles_self_read on profiles
  for select using (id = auth.uid());

create policy profiles_owner_reads_all on profiles
  for select using (
    coalesce((select is_owner from profiles p where p.id = auth.uid()), false)
  );

create policy profiles_owner_updates on profiles
  for update using (
    coalesce((select is_owner from profiles p where p.id = auth.uid()), false)
    and id <> auth.uid()          -- the owner cannot revoke themselves
  );
```

Then, for EACH of `otls`, `people`, `stat_holidays`, `allocations`, `leave_ranges`, `overrides`, `schedule`, `meta`, generate the identical four policies. Write them out per table — do not attempt a loop:

```sql
alter table <T> enable row level security;

create policy <T>_select on <T> for select
  using (owner_id = auth.uid() and is_approved());

create policy <T>_insert on <T> for insert
  with check (owner_id = auth.uid() and is_approved());

create policy <T>_update on <T> for update
  using (owner_id = auth.uid() and is_approved())
  with check (owner_id = auth.uid() and is_approved());

create policy <T>_delete on <T> for delete
  using (owner_id = auth.uid() and is_approved());
```

Both `using` AND `with check` on update. `using` alone would let a row be updated INTO another owner's id.

- [ ] **Step 2: Verify RLS is on everywhere**

```sql
select tablename, rowsecurity from pg_tables
where schemaname='public' order by 1;
```
Expected: `rowsecurity = true` for all nine tables. A false here is a data leak.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0003_rls.sql
git commit -m "feat: row-level security isolating every table per owner"
```

---

## Task 4: The isolation test suite

The highest-value tests in this plan. They test the assertion the whole design rests on, and they must run against a REAL Supabase instance — a mock would test the mock.

**Files:**
- Create: `src/storage/rls.integration.test.ts`, `vitest.integration.config.ts`
- Modify: `package.json` (add `test:integration`)

**Interfaces:**
- Consumes: the schema and policies from Tasks 1–3.

- [ ] **Step 1: Write the failing test**

```ts
// src/storage/rls.integration.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const URL = process.env.SUPABASE_URL ?? '';
const ANON = process.env.SUPABASE_ANON_KEY ?? '';

/** Two approved accounts and one unapproved, created fresh per run. */
let alice: SupabaseClient, bob: SupabaseClient, pending: SupabaseClient;

async function signInAs(email: string): Promise<SupabaseClient> {
  const c = createClient(URL, ANON);
  await c.auth.signUp({ email, password: 'test-password-1234' });
  await c.auth.signInWithPassword({ email, password: 'test-password-1234' });
  return c;
}

beforeAll(async () => {
  const stamp = Date.now();
  alice = await signInAs(`alice-${stamp}@example.test`);
  bob = await signInAs(`bob-${stamp}@example.test`);
  pending = await signInAs(`pending-${stamp}@example.test`);
  // alice and bob are approved out of band by the harness; pending is not.
  // See supabase/README.md for how the test harness approves them.
});

describe('row-level security', () => {
  it('lets an approved account write and read back its own row', async () => {
    const { error } = await alice.from('otls').insert({
      project_code: 'A-1', category: 'CAPEX',
    });
    expect(error).toBeNull();
    const { data } = await alice.from('otls').select('project_code');
    expect(data?.map((r) => r.project_code)).toContain('A-1');
  });

  it('does not return another account rows', async () => {
    const { data } = await bob.from('otls').select('project_code');
    expect(data?.map((r) => r.project_code)).not.toContain('A-1');
  });

  it('refuses to update another account row', async () => {
    const { error, data } = await bob.from('otls')
      .update({ task_code: 'HACKED' })
      .eq('project_code', 'A-1')
      .select();
    // RLS makes the row invisible, so the update matches nothing.
    expect(data ?? []).toHaveLength(0);
    expect(error).toBeNull();
    const { data: still } = await alice.from('otls')
      .select('task_code').eq('project_code', 'A-1').single();
    expect(still?.task_code).not.toBe('HACKED');
  });

  it('refuses to delete another account row', async () => {
    await bob.from('otls').delete().eq('project_code', 'A-1');
    const { data } = await alice.from('otls')
      .select('project_code').eq('project_code', 'A-1');
    expect(data).toHaveLength(1);
  });

  it('refuses to insert a row owned by someone else', async () => {
    const { data: { user } } = await alice.auth.getUser();
    const { error } = await bob.from('otls').insert({
      owner_id: user?.id, project_code: 'STOLEN', category: 'CAPEX',
    });
    expect(error).not.toBeNull();
  });

  it('refuses to move a row to another owner via update', async () => {
    const { data: { user: bobUser } } = await bob.auth.getUser();
    const { error } = await alice.from('otls')
      .update({ owner_id: bobUser?.id })
      .eq('project_code', 'A-1')
      .select();
    expect(error).not.toBeNull();
  });

  it('gives an unapproved account nothing, on every operation', async () => {
    const { data } = await pending.from('otls').select('project_code');
    expect(data ?? []).toHaveLength(0);
    const { error } = await pending.from('otls').insert({
      project_code: 'P-1', category: 'CAPEX',
    });
    expect(error).not.toBeNull();
  });

  it('does not let a non-owner read the profiles of others', async () => {
    const { data } = await bob.from('profiles').select('email');
    expect(data ?? []).toHaveLength(1);   // only their own
  });
});
```

- [ ] **Step 2: Run it and verify it fails**

Run: `npx vitest run --config vitest.integration.config.ts`
Expected: FAIL — no credentials configured, or the tables reject the connection.

- [ ] **Step 3: Configure and make it pass**

Add `vitest.integration.config.ts` (node environment, no jsdom, longer timeout), a `test:integration` script, and document the required env vars in `supabase/README.md`. These tests are NOT part of `npm test` — they need network and credentials. They run manually and in CI where secrets exist.

- [ ] **Step 4: Verify it passes**

Run: `npx vitest run --config vitest.integration.config.ts`
Expected: PASS, 8 tests.

**If any isolation test fails, STOP.** A failure here is a data leak between customers, not a bug to work around.

- [ ] **Step 5: Commit**

```bash
git add src/storage/rls.integration.test.ts vitest.integration.config.ts package.json supabase/README.md
git commit -m "test: prove row-level security isolates accounts"
```

---

# Phase 2 — Auth

## Task 5: Supabase client and session hook

**Files:**
- Create: `src/auth/client.ts`, `src/auth/useSession.ts`, `src/auth/useSession.test.ts`
- Modify: `.env.example`

**Interfaces:**
- Produces: `supabase` client; `useSession(): { session, profile, loading, signOut }` where `profile` is `{ id, email, approved, isOwner } | null`.

- [ ] **Step 1: Install**

```bash
npm install @supabase/supabase-js
```

- [ ] **Step 2: Write the client**

```ts
// src/auth/client.ts
import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  throw new Error(
    'VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY must be set. ' +
    'See supabase/README.md.',
  );
}

// The anon key is public by design — it grants nothing without RLS.
export const supabase = createClient(url, anonKey, {
  auth: { persistSession: true, autoRefreshToken: true },
});
```

- [ ] **Step 3: Write the failing hook test, then the hook**

Test that `useSession` reports `loading` first, then a session and its profile; that `signOut` clears both; and that a profile row failing to load yields `profile: null` rather than throwing. Mock `supabase.auth` and `supabase.from`.

- [ ] **Step 4: Verify and commit**

Run: `npx vitest run src/auth`
```bash
git add src/auth package.json package-lock.json .env.example
git commit -m "feat: supabase client and session hook"
```

---

## Task 6: Sign in, sign up, and the pending screen

**Files:**
- Create: `src/auth/SignInPage.tsx`, `src/auth/PendingApproval.tsx`, `src/auth/AuthGate.tsx`, and tests for each

**Interfaces:**
- Consumes: `useSession` from Task 5.
- Produces: `<AuthGate>{children}</AuthGate>` — renders children only for an approved session.

- [ ] **Step 1: Write the failing AuthGate test**

```tsx
// src/auth/AuthGate.test.tsx — the shape; fill in mocks for useSession
it('shows the sign-in page when there is no session', () => { /* ... */ });
it('shows the pending screen for a session whose profile is not approved', () => { /* ... */ });
it('renders the app for an approved session', () => { /* ... */ });
it('shows nothing but a loading state while the session resolves', () => { /* ... */ });
```

The third case is the one that matters: an unapproved session must NOT reach the app.

- [ ] **Step 2: Implement**

`SignInPage` — Astryx `Card` with email, password (`type="password"`), and a mode toggle between sign in and sign up. On sign-up, tell the user to check their email AND that an owner must approve them, so the wait is expected rather than mysterious.

`PendingApproval` — states plainly that the account exists and is awaiting approval, and offers sign-out. Per DESIGN.md §4: sentence case, no exclamation marks, name the actual situation.

`AuthGate` — `loading` → a spinner; no session → `SignInPage`; session without `profile.approved` → `PendingApproval`; otherwise children.

Follow `src/ui/pages/SetupPage.tsx` for Astryx usage. The theme provider export is `Theme` from `@astryxdesign/core/theme` — the package README's `XDSTheme` does not exist.

- [ ] **Step 3: Verify and commit**

Run: `npx vitest run src/auth`
```bash
git add src/auth
git commit -m "feat: auth gate with sign-in, sign-up and pending-approval screens"
```

---

## Task 7: Owner approval page

**Files:**
- Create: `src/ui/pages/AdminPage.tsx`, `src/ui/pages/AdminPage.test.tsx`

**Interfaces:**
- Consumes: `supabase`, `useSession`.
- Produces: `<AdminPage />` — owner-only list of accounts with approve and revoke.

- [ ] **Step 1: Write the failing test**

```tsx
it('lists accounts awaiting approval', async () => { /* ... */ });
it('approves an account', async () => { /* ... */ });
it('revokes an approved account behind a confirmation', async () => { /* ... */ });
it('does not offer to revoke the owner themselves', async () => { /* ... */ });
it('says so plainly when nobody is waiting', async () => { /* ... */ });
```

- [ ] **Step 2: Implement**

An Astryx `Table` of profiles, pending first. Approve is a primary action; revoke sits behind an `AlertDialog` because it removes someone's access.

The revoke copy must state what revocation does and does not do: access stops immediately, **their data is kept**, and re-approving restores it. Spec §4.4 — a user who believes revoke deletes data will avoid using it, or will use it and panic.

The owner's own row shows no revoke control. The database also refuses it (`id <> auth.uid()`), so this is the UI agreeing with the schema rather than being the only guard.

- [ ] **Step 3: Verify and commit**

Run: `npx vitest run src/ui/pages/AdminPage.test.tsx`
```bash
git add src/ui/pages/AdminPage.tsx src/ui/pages/AdminPage.test.tsx
git commit -m "feat: owner-only account approval page"
```

---

# Phase 3 — Storage

## Task 8: The Supabase adapter

**Files:**
- Create: `src/storage/supabase.ts`, `src/storage/supabase.test.ts`
- Modify: `src/storage/adapter.ts`

**Interfaces:**
- Produces: `supabaseAdapter: StorageAdapter` where `StorageAdapter` is now `{ read(): Promise<Model>; write(model: Model): Promise<void> }`.

- [ ] **Step 1: Change the interface**

```ts
// src/storage/adapter.ts — replaces the SheetPayload-based interface entirely
import type { Model } from '../domain/types';

export interface StorageAdapter {
  read(): Promise<Model>;
  write(model: Model): Promise<void>;
}
```

No `BackendConfig`, no `validate`, no `connect`/`disconnect` — identity is the session, and there is one backend.

- [ ] **Step 2: Write the failing round-trip test**

Assert that a `Model` containing every shape survives `write` then `read`: a CAPEX OTL and a LEAVE OTL with its subtype; a manager and a report; an allocation with a real `personId` AND one with `personId: null` (the OTL monthly total — the single most important case, because a null that round-trips wrong silently converts a team budget into an assignment for a person named "null"); a leave range; an override; and a schedule entry where `overrideBlocks` differs from `blocks`.

Mock `supabase.from` with an in-memory table so this runs in unit tests.

- [ ] **Step 3: Implement**

Map snake_case columns to camelCase domain fields explicitly — no automatic conversion, which silently mangles a field the day someone adds one. `numeric` comes back from PostgREST as a string: parse it, and assert in the test that hours are `number`, not `"40"`.

`write` replaces the owner's rows per table in a transaction-like sequence: delete then insert. RLS scopes both to the caller, so a delete cannot reach another account.

- [ ] **Step 4: Verify and commit**

Run: `npx vitest run src/storage/supabase.test.ts`
```bash
git add src/storage/adapter.ts src/storage/supabase.ts src/storage/supabase.test.ts
git commit -m "feat: supabase storage adapter mapping rows to the domain model"
```

---

## Task 9: Rewire the store and delete the old storage layer

The largest deletion in the plan. ~2,000 lines and ~180 tests come out.

**Files:**
- Modify: `src/storage/store.ts`, `src/ui/App.tsx`
- Delete: `src/storage/registry.ts` (+test), `src/storage/localCache.ts` (+test), `src/storage/adapters/` entirely, `src/ui/components/ConnectionSettings.tsx` (+test), the spreadsheet half of `serialize.ts`

**Interfaces:**
- Produces: `useStore()` exposing `{ model, result, isStale, status, notice, update, recalculate }`.

- [ ] **Step 1: Simplify the store**

Remove: `unreadableTabs`, `tabsToProtect`, `readVerdict`, `adoptVerdict`, `isEmptyInMemory`, `stillEmptyTabs`, `connect`, `disconnect`, `config`, and every backend-selection path.

**Those mechanisms existed to survive hostile spreadsheet data.** A typed column cannot present a renamed header or a stray padding cell, so the machinery has nothing left to defend against. Delete it rather than porting it — this is the plan's central simplification and it should not be quietly preserved "just in case."

Keep: the debounced write, `isStale` via `hashModel`, the recalculate guard and its `needsAllocation` empty state, and error surfacing through `notice`.

- [ ] **Step 2: Delete the old layer**

```bash
git rm -r src/storage/adapters src/storage/registry.ts src/storage/registry.test.ts \
          src/storage/localCache.ts src/storage/localCache.test.ts \
          src/ui/components/ConnectionSettings.tsx src/ui/components/ConnectionSettings.test.tsx
git rm -r apps-script docs/microsoft-setup.md
npm uninstall @azure/msal-browser
```

Reduce `serialize.ts` to CSV only, or move that into `src/storage/csv.ts` and delete `serialize.ts` — your call, but say which.

- [ ] **Step 3: Rewire App.tsx**

Wrap the app in `<AuthGate>`. Replace the connection-settings control with sign-out and the account's email. Add an **Admin** tab visible only when `profile.isOwner`.

- [ ] **Step 4: Verify**

Run: `npx vitest run` — expect a large drop in total; every remaining test must pass.
Run: `npm run typecheck` — clean. This will catch every dangling import from the deletion.
Run: `npm run coverage` — thresholds still met.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: supabase becomes the only backend; delete the spreadsheet storage layer"
```

---

# Phase 4 — Export and release

## Task 10: Per-person weekly export

**Files:**
- Create: `src/storage/csv.ts`, `src/storage/csv.test.ts`, `src/ui/components/ExportMenu.tsx` (+test)

**Interfaces:**
- Produces: `toCsv(rows: ExportRow[]): string`, `toHtmlTable(rows: ExportRow[]): string`, `<ExportMenu person week entries otls />`.

- [ ] **Step 1: Write the failing CSV test**

Cover: the four OTL identifier columns plus Mon–Fri and a total; one decimal place throughout; a field containing a comma or a quote correctly escaped (an OTL code with a comma would otherwise shift every following column); an empty cell rendered as empty rather than `0.0`; and a leave day.

- [ ] **Step 2: Implement both formats**

`toCsv` — RFC 4180 quoting. `toHtmlTable` — a real `<table>` so it pastes into email or Slack as a table rather than a wall of text.

`ExportMenu` — "Copy as table" writes both `text/html` and `text/plain` flavours to the clipboard so it degrades to readable text where HTML is unsupported; "Download CSV" saves a file named `<person>-<week>.csv`.

Both reuse `PersonWeekView`'s formatting: one decimal, right-aligned, em-dash for zero.

- [ ] **Step 3: Verify and commit**

Run: `npx vitest run src/storage/csv.test.ts src/ui/components/ExportMenu.test.tsx`
```bash
git add src/storage/csv.ts src/storage/csv.test.ts src/ui/components/ExportMenu.tsx src/ui/components/ExportMenu.test.tsx
git commit -m "feat: per-person weekly export as a pasteable table and CSV"
```

---

## Task 11: Keep-warm cron and paused-project handling

**Files:**
- Create: `.github/workflows/keepwarm.yml`
- Modify: `src/storage/store.ts`

- [ ] **Step 1: Add the workflow**

```yaml
name: Keep Supabase warm
on:
  schedule: [{ cron: '0 9 * * 1,4' }]   # Mondays and Thursdays, 09:00 UTC
  workflow_dispatch:
jobs:
  ping:
    runs-on: ubuntu-latest
    steps:
      - name: Touch the database
        run: |
          curl -sS -o /dev/null -w '%{http_code}\n' \
            -H "apikey: ${{ secrets.SUPABASE_ANON_KEY }}" \
            "${{ secrets.SUPABASE_URL }}/rest/v1/profiles?select=id&limit=1"
```

The human adds both repository secrets. The anon key is public by design, but a secret keeps it out of the logs.

- [ ] **Step 2: Detect a paused project**

A paused project fails DNS or returns 503. Surface that as a specific, actionable notice — *"The database is asleep. It usually wakes within a minute; try again shortly."* — not a generic sync error. Cron jobs fail; the fallback must not mystify.

- [ ] **Step 3: Verify and commit**

Add a store test asserting a 503 produces the paused message rather than the generic one.

```bash
git add .github/workflows/keepwarm.yml src/storage/store.ts src/storage/store.test.ts
git commit -m "feat: keep the database warm, and say so plainly when it is not"
```

---

## Task 12: End-to-end journey, authenticated

**Files:**
- Modify: `e2e/journey.spec.ts`, `playwright.config.ts`

- [ ] **Step 1: Add a sign-in step**

The existing journey starts at an unauthenticated app. Add a sign-in using a dedicated test account whose credentials come from env vars, then keep the rest of the journey as it is.

**Do not weaken any existing assertion.** The override-survival check — override a cell, recalculate, confirm the VALUE persists — is the most important assertion in the suite and took several review rounds to make honest.

- [ ] **Step 2: Add one new case**

An unapproved account signs in and sees the pending screen, not the planner. That is the auth equivalent of the isolation suite: it proves the gate holds through the real UI.

- [ ] **Step 3: Verify and commit**

Run: `npx playwright test`
```bash
git add e2e playwright.config.ts
git commit -m "test: end-to-end journey through an authenticated session"
```

---

## Task 13: CI and documentation

**Files:**
- Modify: `.github/workflows/deploy.yml`, `README.md`

- [ ] **Step 1: Wire the build secrets**

`VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` must be present at build time. Add them to the build step's `env`. Without them the app throws at startup — deliberately, since a silently unconfigured build would look broken for a reason nobody could see.

- [ ] **Step 2: Add the isolation suite to CI**

Run `npm run test:integration` in the build job, before the deploy. **A failing isolation test must block the deploy** — it means accounts can see each other.

- [ ] **Step 3: Rewrite the README**

Replace the storage section entirely: sign-up and approval, the one-time owner bootstrap, the Supabase project setup, and the export. Delete the Apps Script and Microsoft instructions.

Update **Known limitations**: remove the spreadsheet-specific entries, which no longer exist. Add that the app requires a network connection.

- [ ] **Step 4: Verify and commit**

Run: `npm run build` with the env vars set — succeeds.

```bash
git add .github/workflows/deploy.yml README.md
git commit -m "ci: build with supabase config and gate the deploy on isolation tests"
```

---

## Task 14: Manual verification before release

Not a coding task. Do it anyway — every automated check here runs against mocks or a test project.

- [ ] **Step 1: Two accounts, one browser each**

Sign up as two users. Approve both. In each, create an OTL with the SAME project code and different hours. Confirm neither sees the other's. This is the isolation suite again, by hand, in a real browser — where a session or cookie bug would show up and a mock never would.

- [ ] **Step 2: The approval gate**

Sign up a third account and do NOT approve it. Confirm it sees the pending screen and that its network requests return no data. Approve it; confirm it gets an empty planner.

- [ ] **Step 3: Revoke**

Revoke that account. Confirm access stops, then re-approve and confirm **its data came back** — the promise made in the revoke dialog.

- [ ] **Step 4: The export**

Export a week as a table and paste it into an email client. Confirm it arrives as a table with the four OTL columns intact. Download the CSV and open it in a spreadsheet.

- [ ] **Step 5: Record the outcome**

Write what you found into the ledger, including anything that worked differently from the plan.

---

## Self-Review

**Spec coverage.** §4.1 roles → Tasks 2, 7. §4.2 registration and approval → Tasks 2, 3, 6, 7. §4.3 owner bootstrap → Task 2. §4.4 revocation → Tasks 3, 7, 14. §5 isolation → Tasks 3, 4, 14. §6 storage and the interface change → Tasks 8, 9. §6.3 deletions → Task 9. §6.4 no offline → Tasks 9, 13. §7 schema → Task 1. §8 dormancy → Task 11. §9 export → Task 10. §10 security → Tasks 1, 3, 5, 13. §11 testing → Tasks 4, 8, 10, 12. §12 risks → Tasks 4, 11, 14.

**Placeholder scan.** Tasks 5, 6, 7, 8 and 10 describe test cases in prose rather than full source, because their mocking depends on `@supabase/supabase-js`'s runtime shape, which must be read from the installed package rather than guessed — this project has twice been burned by trusting documentation over the shipped library. Each names the exact cases required. The SQL and the isolation suite, which carry the real risk, are given in full.

**Type consistency.** `StorageAdapter` is redefined once in Task 8 and consumed in Task 9. `useSession`'s return shape is fixed in Task 5 and used in Tasks 6, 7 and 9. `profile.isOwner` is camelCase in TypeScript throughout, mapping to `is_owner` in SQL — the mapping is explicit in Task 8 and must not be automated.

---

# PLAN AMENDMENTS (2026-08-27)

A review of the unexecuted half returned **BLOCK** with 19 findings. Tasks 1–3 also
diverged from this plan in ways later tasks depend on. **These amendments supersede the
task text above.** Every dispatch must carry the amendments for its task.

## A1 — Task 8/9: the adapter interface cannot carry the schedule or the hash

`Model` (`src/domain/types.ts`) is exactly six arrays. It holds NO `ScheduleEntry[]` and
no hash. So `read(): Promise<Model>` cannot persist either — which would leave the
`schedule` and `meta` tables permanently empty, make `isStale` uncleara ble across a
reload, and rebuild v1's permanent-nag bug from scratch.

**SUPERSEDES Task 8 Step 1.** The interface is:

```ts
export interface StoredState {
  model: Model;
  entries: ScheduleEntry[];
  hash: string | null;
}
export interface StorageAdapter {
  read(): Promise<StoredState>;
  write(state: StoredState): Promise<void>;
}
```

`src/domain/` still does not change — `StoredState` lives in the storage layer.

## A2 — Task 8: `delete then insert` destroys data, and will fire

PostgREST gives ONE transaction PER REQUEST. A delete and a following insert are two
requests: if the insert fails, the delete has already committed and the rows are gone.
Reintroducing a data-loss path into the change whose purpose is deleting one is the worst
available outcome.

It will fire, because two applied primary keys are narrower than the UI produces:
`stat_holidays` is `(owner_id, date)` but two holidays on one date pointing at different
STAT OTLs is legal; `leave_ranges` omits `end_date` but two ranges starting the same day
is legal. Both are `23505` on write.

**SUPERSEDES Task 8 Step 3.** Two parts:
(a) New `supabase/migrations/0004_widen_keys.sql` — add `otl_project_code` to
    `stat_holidays`' PK and `end_date` to `leave_ranges`'.
(b) Replace the whole write with a SINGLE `security invoker` PL/pgSQL function taking the
    state as `jsonb`, called via `.rpc()`. One request, one transaction, atomic. `security
    invoker` so RLS still applies — do NOT use `security definer` here, which would bypass
    the isolation this project is built on.

## A3 — Task 9: the deletion list breaks the build

`tsconfig.app.json` includes all of `src`, so tests are type-checked. Missing from the list:
- `src/storage/store.test.ts` (1018 lines) — **REWRITE**, imports deleted modules but
  carries surviving assertions
- `src/storage/serialize.test.ts` (816 lines) — **DELETE**
- `src/ui/App.test.tsx` (493 lines) — **REWRITE**, three describe blocks assert on
  `dataNotice`/`unreadableTabs` which this task removes
Also update `vitest.config.ts`'s `exclude: ['apps-script/**']`, which goes stale.

## A4 — Task 9/10: `serialize.ts` contains no CSV code

`grep -ci csv src/storage/serialize.ts` returns 0. The plan's "all that survives of
serialize.ts" was invented. **`serialize.ts` is a FULL DELETE**; `src/storage/csv.ts` is
net-new in Task 10. Remove the "your call, but say which" choice — there is none.

## A5 — Task 9: the stated `useStore()` surface drops four fields App.tsx uses

**SUPERSEDES Task 9's Interfaces block.** Produces:
`{ model, result, isStale, needsAllocation, hasCertifiedSchedule, status, notice,
   dataNotice→REMOVED, update, cancelPendingPush, recalculate }`
Removed: `config`, `connect`, `disconnect`, `dataNotice`, `unreadableTabs`.
Keep: `cancelPendingPush` (the ErrorBoundary's "nothing was saved over" promise depends on
it), `needsAllocation` + `hasCertifiedSchedule` (the empty-state-vs-staleness split), and
the `monthsOf` named export (`WeeksPage.tsx` imports it).

## A6 — Task 12: the E2E is not idempotent

It passes once. On run two the test account's rows persist: `OPEX-ADMIN` collides on the
PK, a second "Alex" makes `getByLabel('Alex P-1001')` ambiguous, and the stale banner's
presence depends on leftover state. CI runs this on every push.
**ADD Task 12 Step 0:** sign up a fresh uniquely-stamped account per run, as
`rls.integration.test.ts` already does. Also name where the unapproved-account fixture
comes from and who keeps it unapproved.

## A7 — Task 13: the isolation suite needs the service-role key, which the plan forbids

The suite must approve accounts and delete users; the publishable key can do neither. But
`supabase/README.md` and Task 1 say the service-role key must never be used "or in CI
secrets". Flat contradiction.
**RULING:** the prohibition is amended to be precise rather than absolute — *never in the
bundle, never committed, never in application code; PERMITTED as a CI secret scoped to the
isolation job only.* Update `supabase/README.md` to say exactly that. Also map the names:
the suite reads `SUPABASE_URL`/`SUPABASE_ANON_KEY`, the repo secrets are
`VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY`; write both sides out.

## A8 — Task 13: env vars are wired to the wrong step

`src/auth/client.ts` throws at module scope when they are absent, and `npm run coverage`
and `npx playwright test` both run BEFORE the build step. Set
`VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` at **job** level, not on the build step.
**ADD to Task 5:** state that unit tests must `vi.mock('./client')` — after Task 9 wraps
App in `<AuthGate>`, that is every UI test.

## A9 — Task 11: the keep-warm cron cannot work and cannot fail

It references `secrets.SUPABASE_URL`/`SUPABASE_ANON_KEY`; the secrets that exist are
`VITE_`-prefixed. A missing secret interpolates to empty, so the request 401s without
touching Postgres — and `curl` without `--fail` means the job goes green anyway. The first
symptom would be the paused project it exists to prevent.
Use the `VITE_`-prefixed names and add `--fail-with-body`.

## A10 — Task 11: paused projects produce TWO error shapes, not one

Measured in `postgrest-js`: a fetch-level failure returns `status: 0` with
`'TypeError: Failed to fetch'`; an HTTP 503 returns `status: 503`. Also
`RETRYABLE_STATUS_CODES = [520, 503]` with retries ON by default and 1s/2s/4s backoff, so a
503 takes ~7s to surface.
Detect `status === 0 || status === 503 || status === 520`. Require TWO store tests, one per
shape. Do not word the notice as if it were instant.

## A11 — Task 8 commits a tree that cannot type-check

Replacing `adapter.ts` wholesale in Task 8 breaks seven files that survive until Task 9,
and Task 8's verification does not run `tsc`.
**Task 8 declares the new interface in a NEW file `src/storage/modelAdapter.ts`** and
leaves `adapter.ts` untouched; Task 9 deletes it. **ADD `npm run typecheck` to Task 8's
verification.**

## A12 — Task 10: nothing ever mounts `ExportMenu`

Create-only file list means a tested component unreachable from the app, and Task 14's
manual export check has nothing to click.
**ADD `Modify: src/ui/pages/WeeksPage.tsx`** (it already renders `PersonWeekView`), plus a
test asserting the export control is reachable from the person-week view.

## A13 — Task 10: underspecified enough to build two incompatible things

- `ExportRow` is never defined. **It is one OTL across a week:**
  `{ projectCode, taskCode, expenditureTypeCode, timeReportingCode, mon, tue, wed, thu, fri, total }`
  with the five day fields and `total` as `number`.
- The zero rendering contradicts itself. **The rule is:** CSV renders zero as an EMPTY
  cell (an em-dash in CSV becomes text, not a number, in a spreadsheet); the HTML table
  renders zero as an em-dash, matching `formatHoursCell`.
- jsdom implements neither `ClipboardItem`/`clipboard.write` nor `URL.createObjectURL`.
  Both must be stubbed; say so rather than letting the implementer discover it.

## A14 — Task 8: `allocations.person_key` is GENERATED ALWAYS STORED

Added in Task 1 to work around the invalid PK; absent from this plan. Writing it is a hard
error (`428C9`). **Select an explicit column list, never `*`. Never include `person_key` in
any insert or upsert payload.** `person_id` remains what the app reads and writes, and null
still means the OTL monthly total. If A2's RPC uses a conflict target it is
`owner_id,month,otl_project_code,person_key` — the generated column names the index but
must not appear in the payload.

## A15 — Task 8: "numeric comes back as a string" is an unverified memory claim

PostgREST serialises through Postgres' own JSON functions, which render `numeric` as an
unquoted number. **MEASURE IT against the live project before writing the mock** — insert
one row and log `typeof data[0].hours` — then build the mock to match. Coerce with
`Number(...)` regardless. A mock that does not match the server is a test that proves
nothing.

## A16 — Spec §4.2 step 5: owner notification is unbuilt

No task sends it, so approval depends on the owner spontaneously opening the Admin page.
**RULING: drop the email.** Adding mail infrastructure for a handful of admins is scope
creep. Instead **ADD to Task 9: a pending-count badge on the Admin tab**, so the owner sees
"2 waiting" without opening it. Amend spec §4.2 step 5 accordingly.

## A17 — Spec §10: two requirements unowned, one unenforceable

- **Rate limiting** is a Supabase dashboard setting nothing configures. **ADD a step to
  Task 14** documenting it (Auth → Rate Limits).
- **"Email verification required before approval" cannot be met** — verification lives in
  `auth.users.email_confirmed_at`, which is not on `profiles` and not visible to the
  client, so the owner cannot tell a verified account from an unverified one.
  **ADD to `0004_widen_keys.sql`: copy `email_confirmed_at` onto `profiles`** (trigger on
  `auth.users` update), and **Task 7 disables Approve until it is non-null.**

## A18 — Task 5: the async `onAuthStateChange` overload is deprecated

`auth-js` 2.112.4 marks it deprecated — async callbacks can deadlock on a nested refresh
from `TOKEN_REFRESHED`. **Use the synchronous callback**: set session state in it, and
fetch the profile from a `useEffect` keyed on the user id. **Read the profile with
`.maybeSingle()`, not `.single()`** — the `handle_new_user` trigger races the first client
read, and `.single()` returns `PGRST116` on zero rows, which would surface as an error
rather than the `profile: null` the task requires.

## A19 — Task 5: two factual slips

`@supabase/supabase-js` is ALREADY a dependency (Task 4 needed it) — do not reinstall.
`.env.example` does not exist; the Files line should read **Create**, not Modify.
**ADD to Global Constraints:** `import.meta.env.VITE_*` types as `any` through
`vite/client`'s index signature, so reading it directly violates the no-`any` rule. Use a
narrowing helper such as `function requireEnv(name: string): string`.
