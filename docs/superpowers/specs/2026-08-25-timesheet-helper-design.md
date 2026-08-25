# Timesheet Helper — Design Spec

**Date:** 2026-08-25
**Status:** Approved
**Surface:** Static single-page web app hosted on GitHub Pages

---

## 1. Purpose

A single-user planning tool for a manager who receives monthly CAPEX hour budgets and must
turn them into weekly timesheets for themselves and their direct reports. The app takes
cost-centre codes, people, and monthly hour allocations, and produces an optimized
day-by-day schedule that respects a minimum OPEX commitment, daily and weekly capacity
limits, and time off.

The manager can override any figure by hand; overrides survive recalculation.

## 2. Scope

**In scope.** OTL/cost-centre setup, a manager-and-reports tree, stat holiday configuration,
monthly CAPEX allocation entry, schedule optimization, a weekly accordion view with
per-cell overrides and leave entry, a per-person weekly read-off view, and persistence to a
Google Sheet.

**Out of scope.** Multi-user access, authentication, reports viewing their own data,
importing budget spreadsheets, integration with any real timesheet system, part-time
employees, mid-period joiners and leavers, and mobile layouts.

## 3. Domain rules

These are the authoritative rules the optimizer implements.

### 3.1 Capacity

- A working day is **7.5 hours**; a working week is **37.5 hours**, Monday to Friday.
- All hours are multiples of **0.5**. Internally everything is integer half-hour **blocks**:
  a day is 15 blocks, a week is 75.
- Everyone is full-time and present for the entire period.

### 3.2 Entities

- Exactly **one manager** per instance, with reports as children. Reports can only be
  created under a manager.
- A person has a name and a manager. Nothing else.
- An **OTL** has four identifier fields — project code (primary key), task code,
  expenditure type code, time reporting code — plus a fifth field, **category**:
  `CAPEX` | `OPEX` | `LEAVE`.
- A `LEAVE` OTL carries a subtype: `VACATION` | `STAT` | `PERSONAL` | `SICK`.
- Exactly one `OPEX` OTL is flagged **default** ("Digital admin"). It absorbs both the
  minimum OPEX commitment and any CAPEX shortfall.

### 3.3 The OPEX floor

- Each person must book at least **40% of their weekly capacity** to the default OPEX code.
- The floor is computed **per week** and **scales with capacity**: a full week requires
  `ceil(0.4 × 75) = 30` blocks (15.0h); a week containing one stat holiday has 60 blocks of
  capacity and requires `ceil(0.4 × 60) = 24` blocks (12.0h).
- Ceiling rather than rounding, so a stated minimum is never undershot by half an hour.
- CAPEX room for the week is `capacity − floor`.

### 3.4 Weeks and months

- The **week is the unit of submission**. Weeks always run a full Monday to Friday and may
  straddle a month boundary; this is normal and acceptable.
- Each **day** belongs to its own calendar month for budget purposes. A day in the last week
  of September draws from September's allocations even when displayed inside October's view.
- Consequently a given week shows identical figures regardless of which month it is opened
  from. There is one continuous schedule; the month picker is a window onto it.

### 3.5 Allocations

- The manager enters, per month, per CAPEX OTL, per person, a number of **hours**.
- The manager also enters a **monthly total** per CAPEX OTL. The difference between that
  total and the sum of per-person assignments is *unassigned budget*.
- Values that are not multiples of 0.5 are accepted, flagged on entry, placed down to the
  nearest achievable block, and their residual is carried forward.

### 3.6 Leftovers, in priority order

1. **Unabsorbable hours** — a person is assigned more CAPEX than their room allows, given
   their floor and any leave. The excess leaves that person.
2. **Unassigned budget** — an OTL's monthly total exceeds the sum of assignments.
3. Both flow to the **manager**, who is filled the same way: floor first, then CAPEX up to
   their own ceiling.
4. Anything still unplaced is **carried forward** and displayed as available hours for the
   following week or month. It is never silently dropped.

### 3.7 Leave

- **Stat holidays** are configured once with a date and an OTL code, and apply to everyone
  automatically.
- **Vacation, personal and sick** days are entered per person as **date ranges** on the week
  view. Weekends and existing stat holidays are excluded from a range.
- A leave day consumes the whole 7.5h on its leave code and forces every other code on that
  day to zero.
- Leave reduces weekly capacity, which reduces the floor proportionally and shrinks CAPEX
  room — making overflow to the manager more likely.

### 3.8 Overrides

- Overrides are **per cell** — one person, one date, one OTL.
- An overridden cell is fixed. Recalculation treats it as an input and rebalances the rest
  of that day around it so the day still totals 7.5h.
- The user can revert a single cell or clear every override in a week.
- Overridden cells are visually distinct at rest, not on hover.

## 4. The optimizer

Pure, deterministic, integer-only. Same inputs always produce the same output; recalculating
twice must never yield two different timesheets.

### Algorithm, per person per week

1. Place **locked cells** first — leave days and manual overrides. These are inputs.
2. Compute **capacity** = 15 × working days not consumed by leave, minus blocks already
   consumed by overrides.
3. Compute **floor** = `ceil(0.4 × capacity)` and **CAPEX room** = `capacity − floor`.
4. Determine **demand**: for each month represented in the week, the person's remaining
   CAPEX assignment per OTL, paced evenly across the month's remaining days so early weeks
   do not exhaust the budget.
5. **Fill CAPEX** up to the room. Hours on a given day may only draw from that day's month's
   assignments. CAPEX is allowed to concentrate within a day — chunky, realistic blocks are
   preferred over an even smear across all five days. There is no cap on codes per day.
6. **Fill the remainder with OPEX** on the default code.

Because placed CAPEX never exceeds the room, the floor is satisfied by construction. No
constraint solver is required and an infeasible result is not reachable.

Ordering is by stable sort keys throughout, so output does not churn between runs.

### Validity invariants

Asserted in tests and checked at runtime:

- Every working day totals exactly 15 blocks, or 0 for a non-working day.
- A leave day contains exactly one entry of 15 blocks on a leave code.
- Weekly OPEX on the default code is ≥ the floor.
- No cell is negative; every cell is an integer number of blocks.
- Total placed CAPEX per person-month never exceeds that person's assignment.
- Every hour of every OTL's monthly total is either placed, carried forward, or explicitly
  reported as unassigned. Nothing vanishes.

## 5. Data model

Persisted to a Google Sheet, one tab per entity, long format throughout.

| Tab | Columns |
|---|---|
| `Meta` | `schemaVersion`, `lastCalculatedAt`, `inputHash` |
| `OTLs` | `projectCode` (PK), `taskCode`, `expenditureTypeCode`, `timeReportingCode`, `category`, `leaveSubtype`, `isDefaultOpex`, `colorIndex`, `active` |
| `People` | `id`, `name`, `role` (`MANAGER`\|`REPORT`), `managerId` |
| `StatHolidays` | `date`, `name`, `otlProjectCode` |
| `Allocations` | `month` (`YYYY-MM`), `otlProjectCode`, `personId` (empty = OTL monthly total row), `hours` |
| `Leave` | `personId`, `startDate`, `endDate`, `otlProjectCode` |
| `Overrides` | `personId`, `date`, `otlProjectCode`, `hours` |
| `Schedule` | `personId`, `date`, `otlProjectCode`, `hours`, `source` (`CALC`\|`OVERRIDE`\|`LEAVE`) |

Header rows are protected ranges so a stray paste cannot break the columns the app reads.

`Schedule` is regenerated wholesale on each recalculation. `Overrides` and `Leave` are
user-owned and never written by the optimizer.

## 6. Storage and sync

- **Durable store:** a Google Sheet on a personal Google account, reached through an Apps
  Script web app deployed with access set to *Anyone*. The script exposes `doGet` (read all
  tabs) and `doPost` (write a tab), exchanging JSON.
- **Requests use `Content-Type: text/plain`** to avoid a CORS preflight, which Apps Script
  handles poorly.
- **Working cache:** localStorage, written on every edit, so a refresh never loses work.
  Load prefers the Sheet and falls back to the cache when offline.
- **Shared secret:** the app prompts for it once and stores it in localStorage. It is
  deliberately *not* compiled into the bundle, since GitHub Pages serves the JavaScript
  publicly and a baked-in secret would protect nothing.
- **Fallback:** if the deployment is rejected or unreachable, the app runs on localStorage
  alone with JSON export/import. This must degrade cleanly, not crash.

### Staleness detection

A hash over people, OTLs, allocations, leave and overrides is stored at each calculation.
When the live hash differs, a Banner appears naming what changed with a **Recalculate**
action. Recalculation is local, synchronous and fast — no spinner, no dialog.

## 7. User interface

Three pages. All visual decisions are governed by `./DESIGN.md`, grounded in the Astryx
design system, `neutral` theme.

### Setup
OTL table with the five fields plus leave subtype and the default-OPEX flag; the
manager-and-reports tree, where a report can only be added under a manager; and the dated
stat holiday list.

### Allocations
Month picker, then a grid of people (rows) × CAPEX OTLs (columns) with `NumberInput` cells,
a monthly-total row per OTL, and live totals showing each person's committed CAPEX against
their available capacity, plus each OTL's unassigned remainder.

### Weeks
An accordion of Monday–Friday weeks. Each week header shows its date range, capacity, and a
status dot readable while collapsed. Inside, one table for the manager and one for the
reports: four sticky-left OTL identifier columns, then Mon–Fri, with a totals row.

Cells are editable, lock when overridden, and offer revert-one and clear-week. Leave is
applied by date range. A per-person weekly view can be opened for reading off into the real
timesheet system.

## 8. Technology

- React 19, TypeScript, Vite.
- `@astryxdesign/core`, `@astryxdesign/theme-neutral`, `@stylexjs/stylex`,
  `@astryxdesign/cli` (dev). Astryx ships pre-built CSS, so no build plugin is needed.
- Vitest and React Testing Library; Playwright for one end-to-end pass.
- GitHub Actions deploying to Pages. Vite `base` set to the repository path.

## 9. Testing strategy

Test-driven, domain layer first. The optimizer carries essentially all of the project's
risk and is testable without a browser, so it is written test-first with cases covering:
weeks straddling months, leave collapsing capacity and scaling the floor, overrides
constraining a day, cascading overflow to the manager, residual carry-forward, non-multiple
allocations, zero-allocation people, and determinism across repeated runs.

Property-based checks assert the §4 invariants over generated inputs. Component tests cover
each page; one Playwright journey covers setup → allocate → recalculate → override →
export. Target 80% overall, higher in `src/domain/`.

## 10. Build order

1. **Apps Script spike.** Deploy a hello-world web app, confirm the Pages origin can read
   and write. Deliberately first: it is the one assumption that could invalidate the
   storage design, and finding out later would be expensive.
2. Project scaffold, Astryx wired up, Pages deploy proven end to end with a stub page.
3. Domain types and the optimizer, test-first, no UI.
4. Storage layer with localStorage fallback.
5. Setup page.
6. Allocations page.
7. Weeks page — accordion, overrides, leave, recalculation banner.
8. Per-person weekly read-off view.
9. `impeccable` audit pass, accessibility and keyboard review.
10. Production deploy.

## 11. Risks

| Risk | Mitigation |
|---|---|
| Apps Script *Anyone* deployment blocked | Step 1 spike; localStorage + JSON export fallback |
| Astryx is beta; APIs may shift | Pin exact versions; keep domain layer UI-independent |
| Optimizer produces valid-but-unpleasant schedules | Invariant tests prove correctness; shape is tunable and isolated to one module |
| Sheet edited by hand into an invalid state | Protected header ranges; validate on load and report rather than crash |
| localStorage and Sheet diverge | Sheet wins on load; the cache is a working buffer, not a second source of truth |

## 12. Decisions deliberately made

- CAPEX concentrates within a day rather than spreading evenly across the week.
- `Schedule` is stored as long-format rows rather than an opaque JSON blob, so it stays
  debuggable and pasteable.
- The floor uses `ceil`, never `round`.
- Unplaced hours carry forward and are surfaced; they are never dropped.
