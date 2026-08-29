# Timesheet Helper

Turns monthly CAPEX hour budgets into an optimized week-by-week timesheet for a manager
and their direct reports.

You enter cost-centre codes, your team, and how many hours each person is allocated
against each CAPEX code this month. The app produces a Monday-to-Friday schedule that
respects a minimum OPEX commitment, fills every day to 7.5 hours, works around leave, and
preserves any figure you set by hand.

Several managers can use one deployment. Each has their own account and sees only their own
codes, people and schedules — the isolation is enforced by Postgres row-level security, not
by the app. It is a static site in front of a Supabase project: no server of ours, but an
account and a network connection are both required.

---

## Accounts and access

Signing up does not get you in. Three things have to be true before an account can use the
app, and they happen in this order:

1. **Register.** Anyone can, from the sign-in screen. It collects an email and password and
   grants nothing.
2. **Confirm the email address.** Supabase sends the link. Until it is clicked the owner
   cannot approve the account — the Admin page shows the approve button disabled, with the
   reason next to it.
3. **Be approved by the owner.** One person holds the owner role. They see an **Admin** tab,
   listing every account with a badge for how many are waiting, and approve or revoke from
   there.

Until step 3, the account signs in successfully and gets a waiting screen rather than the
planner. That is deliberate: every row-level-security policy in the schema requires
`approved = true`, so an unapproved account handed the planner would meet a page where every
query returned nothing.

Revoking is not deleting. It stops access immediately and keeps every row the account owns;
re-approving restores the data exactly as it was. **Deleting a user from the Supabase
dashboard destroys their data** and is the only thing in the system that does — see
[`supabase/README.md`](supabase/README.md) § "`on delete cascade`".

### Bootstrapping the owner — the one-time step without which nothing works

The first account cannot be approved by anybody, because approval is the owner's action and
there is no owner yet. **A fresh deployment is a locked door for everyone, including the
person who deployed it,** until this is run once by hand.

There is deliberately no in-app path to create an owner: an app that can mint its own owner
can be talked into minting someone else's.

1. Sign up through the app with the email that will own the instance, and confirm it.
2. In the Supabase dashboard → SQL Editor, run **once**:

   ```sql
   update profiles set approved = true, is_owner = true where email = 'THEIR_EMAIL';
   ```

3. Check it took:

   ```sql
   select email, approved, is_owner from profiles where email = 'THEIR_EMAIL';
   -- expect approved = true, is_owner = true
   ```

Reload the app and the Admin tab appears. Everyone else is approved from there.

Only one owner may ever exist — a `one_owner_only` index refuses a second. Handing the role
to someone else means clearing the flag on the current owner in the same statement. The
longer version, including how to find a user id, is in
[`supabase/README.md`](supabase/README.md) § "Bootstrapping the owner account".

---

## Quick start

The app talks to a Supabase project at every start-up and will not run without one. Set up
the project first — [`supabase/README.md`](supabase/README.md) covers creating it, applying
the migrations in order, and where to find the two values below.

```bash
npm install
# create .env.local with the two values below, then:
npm run dev
```

`.env.local` (gitignored) needs exactly two lines:

```
VITE_SUPABASE_URL=https://<your-project>.supabase.co
VITE_SUPABASE_ANON_KEY=<the publishable / anon key>
```

Both are safe to hold in a browser — the publishable key grants nothing on its own; every
table it can reach is gated by row-level security. Without them the app throws on load with
a message naming the missing variable, rather than rendering something broken. **The
service-role key is not one of these and must never appear here** — Vite inlines
`VITE_`-prefixed values into the published bundle.

| Command | What it does |
|---|---|
| `npm run dev` | Development server |
| `npm run build` | Type-check and build to `dist/` |
| `npm test` | The unit and component suite — no network, no credentials |
| `npm run coverage` | The same suite plus coverage thresholds (this is the CI gate) |
| `npm run typecheck` | `tsc -b` — the real type check |
| `npm run test:integration` | Row-level-security isolation, against the real project |
| `npx playwright test` | The end-to-end journey, in a real browser |

The last two need credentials including a service-role key and are documented in
[`supabase/README.md`](supabase/README.md). The first four need nothing.

Requires Node 22+ and React 19.

---

## First run

**Create an OPEX code and flag it as default before anything else.** The whole optimizer
keys off it: the minimum OPEX commitment and every CAPEX shortfall land on that code.
Without one, the Weeks tab shows an empty state saying so — correct behaviour, but easy to
misread as broken.

Then, in order:

1. **Setup** — add your OTL codes, your team, and any stat holidays
2. **Allocations** — pick a month and enter hours per person per CAPEX code
3. **Weeks** — press Recalculate, and read off the schedule

### What an OTL is

A cost centre, identified by four codes — project, task, expenditure type, and time
reporting — where the **project code is the primary key**. Each one also carries a
category:

- **CAPEX** — project work, drawn from the monthly budgets you enter
- **OPEX** — overhead. Exactly one OPEX code is flagged **default**; it absorbs both the
  minimum commitment and any CAPEX shortfall
- **LEAVE** — with a subtype of `VACATION`, `STAT`, `PERSONAL` or `SICK`

Stat holidays are configured once with a date and apply to everyone automatically.
Vacation, personal and sick days are entered per person as date ranges on the Weeks page.

---

## The rules it enforces

- A working day is **7.5 hours**; a full week is **37.5**, Monday to Friday
- Everyone books at least **40% of their weekly capacity** to the default OPEX code. A
  full week needs 15.0h; a week with a stat holiday scales down to 12.0h
- All hours are multiples of **0.5**
- **Weeks are always full Monday-to-Friday and may straddle two months**, because the week
  is the unit you submit. Each *day* draws only from its own month's budget, so a day in
  late August cannot spend September's allocation
- Hours a report cannot absorb, and budget you never handed out, **cascade to the
  manager**. Anything still unplaceable is reported as carried forward — never silently
  dropped
- **A cell you edit is fixed.** Recalculation treats it as an input and rebalances the rest
  of that day around it. Overridden cells are marked with a lock and survive every
  recalculation

That last one is the point of the app, and it is the behaviour most heavily tested.

---

## Getting a week out

Each person's week on the Weeks page has an **Export** menu with two options, because the
week leaves for two different destinations:

- **Copy as table** puts the week on the clipboard as both HTML and plain text, so it
  arrives in email or Slack as a real table with all four OTL identifier columns intact.
  This is the daily path — someone reads it and types the figures into the corporate system.
- **Download CSV** saves `<person>-<monday>.csv` for a spreadsheet.

A zero is an em-dash in the copied table, matching the screen, and an **empty cell** in the
CSV. That difference is deliberate: an em-dash in a CSV is text to a spreadsheet, and one of
them breaks every formula in its column.

---

## How it is built

```
src/domain/     Pure TypeScript. The optimizer. No React, no I/O, no randomness.
src/auth/       The Supabase client, the session hook, and the sign-in / waiting gate.
src/storage/    The single Supabase adapter, and the store that owns the write rule.
src/ui/         Astryx components. Four pages, one of them owner-only.
supabase/       Numbered migrations, and the schema and RLS documentation.
e2e/            The Playwright journey, against a real project in a real browser.
```

The domain layer is the interesting part. Everything is **integer half-hour blocks** — a
day is 15, a week is 75 — so scheduling is exact rather than approximate, and identical
inputs always produce byte-identical output. It carries a runtime conservation check that
reconciles hours placed plus hours carried forward against hours available; during
development that check caught two bugs nobody had in mind when it was written.

`src/storage/store.ts` is the other place worth reading before changing anything. A save is
a whole-account replace inside one transaction, which makes writing a state the app invented
— an empty model shown while a read was failing, say — not a partial save but a deletion of
everything the account had. The store therefore refuses to write any state that does not
descend from a completed, authorised read, and the comment at the top of the file explains
why a boolean was not enough to prove that.

Isolation is the database's job, not the app's. Nothing in `src/` filters by account: RLS
policies in `supabase/migrations/0003_rls.sql` decide which rows a query can see at all, and
[`supabase/README.md`](supabase/README.md) documents them along with the queries that verify
they are applied.

Visual decisions are governed by [`DESIGN.md`](DESIGN.md), grounded in the Astryx design
system.

---

## Known limitations

- **The app needs a network connection and an approved account.** There is no offline mode
  and no local fallback. If the account read fails, the app shows a banner saying so and
  refuses to save anything you do afterwards — a save replaces the whole account, so writing
  a state that never came from a successful read would delete everything in it. Nothing is
  lost from the database, but nothing typed in that state is kept either.
- **On the free Supabase tier the project sleeps after about a week idle**, and the first
  visitor then meets a "could not reach the database" notice for the minute it takes to wake.
  `.github/workflows/keepwarm.yml` pings it twice a week to prevent this; if that workflow is
  disabled or its secrets are rotated, the pausing comes back.
- **Two tabs on one account is last-writer-wins, and it loses more than the cell.** Because a
  save replaces the whole account, the losing tab discards every change the other tab made
  since they diverged, not just the field being edited. Accepted debt for this release; the
  fix (an optimistic-concurrency check on `meta.model_hash`) is described in
  `src/storage/store.ts`.
- **People cannot be renamed.** Delete-and-re-add would orphan that person's allocations,
  which key on their id.
- The Weeks page recomputes its own schedule rather than rendering the stored one. The two
  agree in every state that has been tested, but they are two computations of the same
  thing.

---

## Deploying

Pushing to `main` builds and publishes to GitHub Pages via
[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml). Three jobs must pass before
it will deploy: the type check and coverage gate, the row-level-security isolation suite, and
the end-to-end journey. A regression blocks the release rather than shipping.

Three repository secrets are needed, and a missing one is the empty string rather than an
error, so the names matter:

| Secret | Used by |
|---|---|
| `VITE_SUPABASE_URL` | The build, the test suites, and the keep-warm ping |
| `VITE_SUPABASE_ANON_KEY` | The same three |
| `SUPABASE_SERVICE_ROLE_KEY` | The isolation and end-to-end jobs **only** — never the build |

The build job checks the first two are non-empty before it runs, because Vite would
otherwise happily produce a bundle that is blank for every visitor and report success. The
service-role key is scoped away from the job that produces the bundle on purpose;
[`supabase/README.md`](supabase/README.md) § "The service-role key" states the rule and why.

**GitHub Pages must be enabled first:** Settings → Pages → Source: **GitHub Actions**.
Until it is, the build succeeds and the deploy step fails with *"Ensure GitHub Pages has
been enabled"*.
