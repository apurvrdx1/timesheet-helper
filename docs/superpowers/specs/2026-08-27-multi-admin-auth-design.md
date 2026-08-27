# Multi-Admin Authentication and Supabase Storage — Design Spec

**Date:** 2026-08-27
**Status:** Awaiting review
**Supersedes:** the storage section (§6) of `2026-08-25-timesheet-helper-design.md`

---

## 1. Purpose

Turn Timesheet Helper from a single-user planning tool into a portal several managers can
each use for their own team, with their own login and their own completely isolated data.

Reports never log in. They receive their weekly assignments from their manager as a
pasteable table or a CSV file.

## 2. What is NOT changing

The scheduling domain is untouched. `src/domain/` — the optimizer, the OPEX floor, leave
handling, override survival, the conservation check, all 122 of its tests — is unchanged.
So are the three pages, `DESIGN.md`, and the Astryx UI.

This is a storage and access-control change with an auth gate in front of it.

## 3. Scope

**In scope.** Email/password accounts; open self-registration behind an owner-approval
gate; per-account data isolation enforced by the database; a Supabase Postgres backend
replacing all existing storage; an in-app approval screen for the owner; per-person weekly
export as both a pasteable table and a CSV.

**Out of scope.** Reports logging in. Any sharing between admins — no shared OTL catalogue,
no shared holidays, no pooled budgets. Offline use. Password-less or social sign-in.

## 4. Accounts and access

### 4.1 Roles

Two, and only two:

- **Owner** — exactly one account, held by the person running the instance. Can approve or
  revoke other accounts. Otherwise identical to an admin.
- **Admin** — a manager. Sees and edits only their own OTLs, people, allocations, leave,
  overrides and schedule.

There is deliberately no role hierarchy beyond this. Admins cannot see each other at all.

### 4.2 Registration and approval

Anyone may register. Registration alone grants nothing.

1. A visitor signs up with an email and password and verifies their email address.
2. Their `profiles` row is created with `approved = false`.
3. **Every row-level security policy requires `approved = true`.** An unapproved account
   therefore holds a valid session and the database returns nothing and accepts nothing
   from it.
4. The app shows that account a clear "awaiting approval" screen — not an empty planner.
5. The owner receives an email that someone has registered.
6. The owner approves them from an in-app screen. They then have a normal, empty instance.

The critical property: **approval is enforced in the database, not in the UI.** An
unapproved account that bypasses the front end entirely still receives nothing, because
Postgres refuses the query.

### 4.3 Bootstrapping the owner

The first account cannot be approved by anyone, because no owner exists yet. Its
`approved` and `is_owner` flags are set once, by hand, in the Supabase dashboard. This is a
one-time setup step and must be documented in the README.

There is no in-app path to create an owner. That is intentional: an app that can mint its
own owner can be tricked into minting someone else's.

### 4.4 Revocation

The owner can revoke an approved account, which sets `approved = false`. Because every RLS
policy tests that flag, revocation takes effect on the account's next query — there is no
session to invalidate separately and no window where a revoked account still has access.

**Revocation does not delete data.** The account's rows remain, owned by them and reachable
by nobody, and re-approving restores access exactly as it was. Deleting a person's work
because their access was suspended would be a destructive act triggered by an
administrative one, and those should never be the same button.

Permanently removing an account and its data is a deliberate, separate action, performed in
the Supabase dashboard rather than in the app. There is no in-app path that destroys
another account's data.

The owner cannot revoke themselves — the app would become unadministrable, and recovering
would mean editing the database by hand.

## 5. Isolation

Every domain table carries `owner_id uuid not null references auth.users(id)`, defaulting
to `auth.uid()`.

Every table has RLS enabled with policies of the form:

```sql
using (owner_id = auth.uid() and (select approved from profiles where id = auth.uid()))
```

applied to select, insert, update and delete.

Isolation is therefore a property of the schema rather than of application code. A bug in a
query cannot leak another account's rows, because the restriction sits below anything the
application writes.

**This is the assertion the whole design rests on, so it gets its own test suite** —
explicit "account A cannot read, write, update or delete account B's rows" cases, plus
"an unapproved account can do nothing at all", run against a real Supabase instance.

## 6. Storage

### 6.1 The adapter interface changes

Today an adapter returns `Partial<SheetPayload>` — tab names mapped to `string[][]` —
because a spreadsheet has no types. Persisting that shape into Postgres would be
pointless indirection.

The interface becomes:

```ts
read(): Promise<Model>
write(model: Model): Promise<void>
```

The Supabase adapter maps typed tables directly to the domain `Model`.

### 6.2 What this deletes, and why it matters

`src/storage/serialize.ts` exists largely to survive *hostile spreadsheet data*: a header
row with a renamed column, a stray note padding every row with a trailing blank, text in a
numeric field, a row of the wrong length. A typed database column cannot present any of
those.

The entire class of data-loss defect found across five review rounds — unreadable tabs,
protection verdicts, clear-before-write, header tolerance — **cannot occur against
Postgres.** Those mechanisms are removed rather than ported.

`serialize.ts` is reduced to one job: producing CSV.

### 6.3 Removed

- `src/storage/adapters/localOnly.ts`, `google.ts`, `microsoft.ts`, `graph.ts`
- `src/storage/localCache.ts`
- `apps-script/` in its entirety
- `docs/microsoft-setup.md`
- `@azure/msal-browser`
- the spreadsheet half of `serialize.ts` and its tests
- the `unreadableTabs` protection machinery, which has no meaning against a typed store

Roughly 2,000 lines and ~180 tests.

### 6.4 Consequence: the app requires a network

Removing localStorage removes offline use. This is accepted deliberately. If it later
matters, the answer is a read-through cache, added as its own change rather than retrofitted.

## 7. Schema

One table per domain collection, each with `owner_id`:

| Table | Columns |
|---|---|
| `profiles` | `id` (= auth.users.id), `email`, `approved`, `is_owner`, `created_at` |
| `otls` | `owner_id`, `project_code`, `task_code`, `expenditure_type_code`, `time_reporting_code`, `category`, `leave_subtype`, `is_default_opex`, `color_index`, `active` |
| `people` | `owner_id`, `id`, `name`, `role`, `manager_id` |
| `stat_holidays` | `owner_id`, `date`, `name`, `otl_project_code` |
| `allocations` | `owner_id`, `month`, `otl_project_code`, `person_id` (nullable — null marks an OTL monthly total), `hours` |
| `leave_ranges` | `owner_id`, `person_id`, `start_date`, `end_date`, `otl_project_code` |
| `overrides` | `owner_id`, `person_id`, `date`, `otl_project_code`, `hours` |
| `schedule` | `owner_id`, `person_id`, `date`, `otl_project_code`, `blocks`, `source`, `override_blocks` |
| `meta` | `owner_id`, `model_hash`, `last_calculated_at` |

Primary keys are composite on `owner_id` plus the entity's natural key, so one admin's
`P-1001` never collides with another's.

Database-level constraints replace checks the app previously had to perform: `hours >= 0`,
`blocks` a non-negative integer, `category` and `leave_subtype` as enums, `override_blocks
<= blocks`.

## 8. Dormancy

Supabase's free tier pauses a project after roughly seven days without database activity.
Usage here is monthly, so this would fire most months.

- A GitHub Action on a cron issues a trivial query twice weekly.
- The app **also** detects a paused or unreachable project and says so plainly, because
  cron jobs fail and the failure must not be mysterious.

Both, not either. The ping is the prevention; the message is the fallback.

## 9. Export

Per person, per week, in two forms:

- **Pasteable table** — rich text placed on the clipboard so it arrives in email or chat as
  a real table with the four OTL identifier columns intact. This is the daily path: a
  report reads it and types the figures into the corporate system.
- **CSV download** — for when a file is wanted.

Both are built on the existing `PersonWeekView` and share its formatting rules: one decimal
place, right-aligned figures, an em-dash for zero.

## 10. Security posture

- Passwords are never handled by application code; Supabase Auth owns hashing, sessions and
  reset flows. Rolling this by hand was explicitly rejected.
- Email verification is required before an account can be approved.
- Rate limiting on sign-up, so an open door cannot be scripted into thousands of accounts.
- Only the Supabase anon key ships in the bundle. It is designed to be public; it grants
  nothing on its own because RLS gates every table.
- Sessions expire.
- No credential of any kind is committed. The anon key and project URL are build-time
  configuration, not secrets.

## 11. Testing

- **Domain tests unchanged** — 122 tests, untouched.
- **RLS suite** — cross-account read/write/update/delete denial, and unapproved-account
  denial, against a real instance. This is the highest-value new test surface in the design.
- **Auth flows** — sign-up, verification, the pending state, approval, revocation, sign-out.
- **Adapter round-trip** — `Model` out and back unchanged, including `overrideBlocks` and
  the null `person_id` that marks an OTL monthly total.
- **Export** — table and CSV content, including a person with leave and with overrides.
- **End-to-end** — the existing journey, re-pointed at an authenticated session.

Coverage thresholds and the CI gate stay as they are.

## 12. Risks

| Risk | Mitigation |
|---|---|
| RLS misconfigured, leaking data between admins | Dedicated cross-account test suite; policies applied per-operation, not just on select |
| Free-tier pause makes the app look broken | Keep-warm cron plus explicit in-app detection |
| Open registration abused | Approval gate, email verification, sign-up rate limiting |
| Owner bootstrap misunderstood | Documented in the README as a required one-time manual step |
| Deleting 180 tests removes real coverage | The deleted tests cover failure modes that cannot occur against a typed store; the RLS suite replaces them with tests of the risk that now exists |
| No offline use | Accepted; a read-through cache is the answer if it ever matters |

## 13. Decisions deliberately made

- Admins are fully independent. No shared OTL catalogue, no shared holidays, no pooled
  budgets — despite pooling being the more interesting scheduling problem.
- Supabase only. No fallback backend, no offline mode.
- The adapter interface returns `Model` rather than a serialised payload, which deletes the
  spreadsheet-hostility problem outright rather than carrying it forward.
- Approval is a database predicate, not a UI check.
- Exactly one owner, bootstrapped by hand.
