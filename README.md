# Timesheet Helper

Turns monthly CAPEX hour budgets into an optimized week-by-week timesheet for a manager
and their direct reports.

You enter cost-centre codes, your team, and how many hours each person is allocated
against each CAPEX code this month. The app produces a Monday-to-Friday schedule that
respects a minimum OPEX commitment, fills every day to 7.5 hours, works around leave, and
preserves any figure you set by hand.

> **⚠️ This README is out of date and is being rewritten.**
> The app has moved to multi-admin accounts backed by Supabase. The three storage
> backends described below — Google Sheets, Microsoft 365, and browser-local — have
> been **deleted**, along with the setup instructions and links to them further down.
> Sign-in is now required. See `supabase/README.md` for how the current data layer
> works until this page is replaced.

Single user, no server, no database. It runs entirely in your browser and stores its data
wherever you point it — a Google Sheet, a Microsoft 365 workbook, or just the browser
itself.

---

## Quick start

```bash
npm install
npm run dev
```

That's it. The app opens on browser-local storage and is immediately usable — no account,
no configuration. Connecting a spreadsheet is optional and can be done later without
losing anything.

| Command | What it does |
|---|---|
| `npm run dev` | Development server |
| `npm run build` | Type-check and build to `dist/` |
| `npm test` | Run the test suite |
| `npm run coverage` | Tests plus coverage thresholds (this is the CI gate) |
| `npm run typecheck` | `tsc -b` — the real type check |
| `npx playwright test` | The end-to-end journey, in a real browser |

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

## Connecting a spreadsheet

Optional. The app works fully without one; this is for keeping data across machines.

Both backends use the **same eight tabs with the same columns**, so a Sheet and a workbook
hold interchangeable data.

### Google Sheets

Full instructions in [`apps-script/README.md`](apps-script/README.md). In short:

1. New Sheet → **Extensions → Apps Script**
2. Paste [`apps-script/Code.gs`](apps-script/Code.gs)
3. **Project Settings → Script properties** → add `SHARED_SECRET` with a long random
   string
4. **Deploy → New deployment → Web app**, execute as **Me**, access **Anyone**. Keep the
   `/exec` URL

Then open connection settings in the app and paste the URL and the same secret.

> **The secret never goes in the code.** It lives in Script Properties on Google's side and
> in your browser's local storage on this side. This repository is public, and the file you
> paste is byte-identical to the one committed here — there is nothing to accidentally
> commit. Changing the secret later takes effect immediately, with no redeployment.

*Caveat:* a Workspace domain may forbid deploying with access set to *Anyone*. Personal
accounts do not.

### Microsoft 365

Full instructions in [`docs/microsoft-setup.md`](docs/microsoft-setup.md). Uses MSAL
sign-in and the Graph Excel API, so access is governed by the workbook's own sharing rather
than a shared secret.

Two things that catch everyone:

- The Entra app registration's redirect URI **must be registered as "Single-page
  application", not "Web".** A Web redirect rejects the PKCE flow a static site has to use,
  and the error does not say so.
- On a **work or school account an administrator may need to approve the app** before
  sign-in works. Personal Microsoft accounts self-consent. No code can route around this.

MSAL loads on demand, so it costs nothing unless you actually pick this backend.

---

## How it is built

```
src/domain/     Pure TypeScript. The optimizer. No React, no I/O, no randomness.
src/storage/    One StorageAdapter interface, three backends behind it.
src/ui/         Astryx components. Three pages.
apps-script/    The script you paste into your Sheet.
```

The domain layer is the interesting part. Everything is **integer half-hour blocks** — a
day is 15, a week is 75 — so scheduling is exact rather than approximate, and identical
inputs always produce byte-identical output. It carries a runtime conservation check that
reconciles hours placed plus hours carried forward against hours available; during
development that check caught two bugs nobody had in mind when it was written.

Storage is genuinely modular: the connection form is generated from each adapter's own
`validate()` and field list, and no backend name appears anywhere under `src/ui/`. Adding a
fourth provider means touching `src/storage/` and nothing else.

Visual decisions are governed by [`DESIGN.md`](DESIGN.md), grounded in the Astryx design
system.

---

## Known limitations

- **People cannot be renamed.** Delete-and-re-add would orphan that person's allocations,
  which key on their id.
- **If a sheet header breaks, repair it and *reload* — do not press Connect.** The app
  protects a tab it cannot read, but if you edited that data in the app first, connecting
  will write your in-app version over the repaired rows. Reloading loads the sheet
  correctly.
- **`apps-script/Code.gs` has no automated tests.** It runs in Google's runtime and cannot
  be exercised from this repository. It is also the code that clears and rewrites your
  spreadsheet, which makes it the first thing worth hardening.
- The Weeks page recomputes its own schedule rather than rendering the stored one. The two
  agree in every state that has been tested, but they are two computations of the same
  thing.

---

## Deploying

Pushing to `main` builds and publishes to GitHub Pages via
[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml). The workflow runs
type-checking, the coverage gate and the end-to-end journey before it will deploy, so a
regression blocks the release rather than shipping.

**GitHub Pages must be enabled first:** Settings → Pages → Source: **GitHub Actions**.
Until it is, the build succeeds and the deploy step fails with *"Ensure GitHub Pages has
been enabled"*.
