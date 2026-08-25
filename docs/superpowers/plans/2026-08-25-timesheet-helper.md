# Timesheet Helper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a static web app that turns monthly CAPEX/OPEX hour budgets into optimized weekly timesheets for a manager and their reports, with hand-editable cells that survive recalculation, persisted to a Google Sheet.

**Architecture:** A pure, integer-only domain layer (`src/domain/`) holds the entire optimizer and is tested without a browser. A storage layer (`src/storage/`) sits behind a `StorageAdapter` interface with three interchangeable backends — Google Sheets, Microsoft 365 Excel, and localStorage only — so the choice of provider never leaks upward. A thin UI layer (`src/ui/`) renders three pages using Astryx components. The domain layer never imports React; the UI never contains scheduling logic.

**Tech Stack:** React 19, TypeScript, Vite, `@astryxdesign/core` + `@astryxdesign/theme-neutral` + `@stylexjs/stylex`, Vitest, React Testing Library, Playwright, GitHub Actions → GitHub Pages, Google Apps Script.

**Spec:** `docs/superpowers/specs/2026-08-25-timesheet-helper-design.md`

**Design system:** `./DESIGN.md` — authoritative for every visual decision. Read it before any UI task.

## Global Constraints

- React >= 19.0.0 (Astryx peer dependency). Do not downgrade.
- All hours are multiples of 0.5. Internally everything is **integer half-hour blocks**: `BLOCKS_PER_DAY = 15`, `BLOCKS_PER_WEEK = 75`. Never store hours as floats in domain logic.
- OPEX floor ratio is `0.4`, applied **per week**, computed with `Math.ceil`, never `Math.round`.
- Weeks are always full Monday–Friday and may straddle months. Each **day** belongs to its own calendar month for budget purposes.
- Exactly one manager per instance. Exactly one OTL flagged `isDefaultOpex`.
- The optimizer must be **deterministic**: identical inputs always produce byte-identical output. Use stable sort keys everywhere. Never use `Date.now()`, `Math.random()`, or unstable sorts inside `src/domain/`.
- No hex colours, raw px, or font sizes in component code — Astryx tokens only, per `DESIGN.md` §5 rule 2.
- Hours render to exactly one decimal place (`7.5`, `2.0`). Zero renders as an em-dash in disabled colour, never `0.0`.
- Numeric table columns are right-aligned with `font-variant-numeric: tabular-nums`.
- No layer above `src/storage/` may reference a specific backend. The UI drives its
  connection form from `adapter.validate()`, never from a `if (backend === ...)` ladder.
- Credentials (Google shared secret, Microsoft client id) live in localStorage only.
  Never compile one into the bundle — GitHub Pages serves the JavaScript publicly.
- Test coverage target: 80% overall, 95%+ in `src/domain/`.
- Conventional commits (`feat:`, `fix:`, `test:`, `chore:`, `docs:`). Commit at the end of every task.

---

## File Structure

```
.github/workflows/deploy.yml     GitHub Pages build + deploy
apps-script/Code.gs              Pasted into the Sheet, deployed as a web app
apps-script/README.md            Google backend setup for the human
docs/microsoft-setup.md          Microsoft 365 backend setup for the human

src/domain/                      PURE — no React, no I/O, no globals
  types.ts                       All domain types and constants
  blocks.ts                      hours <-> integer blocks, formatting
  calendar.ts                    Weeks, working days, month membership
  capacity.ts                    Per-person-week capacity, OPEX floor, CAPEX room
  demand.ts                      Monthly allocations -> per-week paced demand
  optimizer.ts                   scheduleWeek() — the core fill algorithm
  schedule.ts                    scheduleAll() — orchestration + leftovers
  invariants.ts                  Validity assertions used by tests and runtime
  hash.ts                        Stable input hash for staleness detection

src/storage/
  serialize.ts                   Model <-> flat tab rows (backend-agnostic)
  adapter.ts                     StorageAdapter interface + BackendConfig
  registry.ts                    BackendId -> adapter lookup
  adapters/localOnly.ts          localStorage only, always available
  adapters/google.ts             Google Sheets via an Apps Script web app
  adapters/microsoft.ts          Microsoft 365 via MSAL sign-in
  adapters/graph.ts              Graph Excel REST calls used by the above
  localCache.ts                  localStorage working cache + saved config
  store.ts                       React state container + sync orchestration

src/ui/
  App.tsx                        Shell, nav, routing
  pages/SetupPage.tsx
  pages/AllocationsPage.tsx
  pages/WeeksPage.tsx
  components/OtlTable.tsx
  components/PeopleTree.tsx
  components/StatHolidayList.tsx
  components/AllocationGrid.tsx
  components/WeekAccordion.tsx
  components/WeekTable.tsx
  components/HourCell.tsx
  components/LeaveDialog.tsx
  components/StaleBanner.tsx
  components/ConnectionSettings.tsx
  components/PersonWeekView.tsx
  format.ts                      Hour/date formatting shared by UI only
```

Tests are colocated: `src/domain/optimizer.test.ts` next to `src/domain/optimizer.ts`.

---

# Phase 1 — Foundations

## Task 1: Storage backend spike

Proves the assumptions that could invalidate the storage design. **Do this first.**
Both cloud backends have a way of being blocked by someone else's policy, and
finding out after the app is built is expensive.

- **Google** — a Workspace domain can forbid deploying an Apps Script web app with
  access set to *Anyone*. A personal Google account cannot.
- **Microsoft** — a work or school tenant can require an administrator to consent
  to the app registration before sign-in works. A personal Microsoft account
  self-consents.

Spike whichever backend the human intends to use first. If both are wanted, spike
both. If one fails, that backend is unavailable to them — say so plainly and carry
on; the local-only adapter always works and the other backend may still be fine.

**Files:**
- Create: `apps-script/Code.gs`
- Create: `apps-script/README.md`

**Interfaces:**
- Consumes: nothing
- Produces: a deployed web app URL and a shared secret, both recorded by the human

- [ ] **Step 1: Write the spike script**

```javascript
// apps-script/Code.gs  (spike version — replaced in full in Task 12)
function doGet(e) {
  return ContentService
    .createTextOutput(JSON.stringify({ ok: true, mode: 'get' }))
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  var body = JSON.parse(e.postData.contents);
  return ContentService
    .createTextOutput(JSON.stringify({ ok: true, mode: 'post', echo: body }))
    .setMimeType(ContentService.MimeType.JSON);
}
```

- [ ] **Step 2: Write deployment instructions**

```markdown
<!-- apps-script/README.md -->
# Sheet setup

1. Create a new Google Sheet on a **personal** Google account (not Workspace).
2. Extensions -> Apps Script. Delete the placeholder, paste `Code.gs`, save.
3. Deploy -> New deployment -> Web app.
   - Execute as: **Me**
   - Who has access: **Anyone**
4. Copy the `/exec` URL. This is `VITE_SHEET_URL`.
5. Invent a long random string. This is the shared secret; you will be
   prompted for it once in the app and it is stored in your browser only.
   It is deliberately NOT compiled into the bundle — GitHub Pages serves
   the JavaScript publicly.
```

- [ ] **Step 3: Human deploys and verifies**

Ask the human to deploy, then paste the `/exec` URL. Verify from a browser console on any `https://` origin:

```javascript
await (await fetch(URL)).json()
// Expected: { ok: true, mode: 'get' }

await (await fetch(URL, {
  method: 'POST',
  headers: { 'Content-Type': 'text/plain;charset=utf-8' },
  body: JSON.stringify({ hello: 'world' })
})).json()
// Expected: { ok: true, mode: 'post', echo: { hello: 'world' } }
```

`text/plain` is required — `application/json` triggers a CORS preflight that Apps Script does not answer.

**STOP if either call fails.** Report the exact error and do not proceed to Task 2.

- [ ] **Step 4: Spike the Microsoft backend, if wanted**

Only if the human wants the Microsoft 365 backend. Register an SPA app per
`docs/microsoft-setup.md` (written in full in Task 14), then from the browser
console on any `https://` origin confirm that a `loginPopup` completes and a
token comes back with the `Files.ReadWrite` scope.

**A consent error here means a tenant administrator must approve the app.** That
is not something the code can work around — report it and let the human decide
whether to pursue approval or use Google instead.

- [ ] **Step 5: Commit**

```bash
git add apps-script/
git commit -m "feat: storage backend spike with deployment instructions"
```

---

## Task 2: Project scaffold and proven Pages deploy

Gets a stub page live on GitHub Pages before any real code exists, so deployment is never the thing that breaks at the end.

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsconfig.node.json`, `vite.config.ts`, `vitest.config.ts`, `index.html`, `.gitignore`
- Create: `src/main.tsx`, `src/ui/App.tsx`, `src/globals.css`
- Create: `.github/workflows/deploy.yml`

**Interfaces:**
- Produces: `npm run dev`, `npm run build`, `npm test`, `npm run typecheck`

- [ ] **Step 1: Scaffold and install**

```bash
npm create vite@latest . -- --template react-ts
npm install @astryxdesign/core @astryxdesign/theme-neutral @stylexjs/stylex
npm install -D @astryxdesign/cli vitest @vitest/coverage-v8 jsdom \
  @testing-library/react @testing-library/user-event @testing-library/jest-dom
npx astryx init
```

Confirm React is >= 19 in `package.json`. If Vite scaffolded 18, upgrade:
```bash
npm install react@^19 react-dom@^19
```

- [ ] **Step 2: Wire the theme**

```css
/* src/globals.css */
@import '@astryxdesign/core/reset.css';
@import '@astryxdesign/core/astryx.css';
@import '@astryxdesign/theme-neutral/theme.css';

/* Project-wide: every figure in this app is compared vertically. */
.tabular { font-variant-numeric: tabular-nums; }
```

```tsx
// src/main.tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './globals.css';
import { App } from './ui/App';

createRoot(document.getElementById('root')!).render(
  <StrictMode><App /></StrictMode>
);
```

```tsx
// src/ui/App.tsx
export function App() {
  return <main><h1>Timesheet Helper</h1></main>;
}
```

- [ ] **Step 3: Configure Vite base path and Vitest**

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: '/timesheet-helper/',
});
```

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    coverage: {
      provider: 'v8',
      thresholds: { lines: 80, functions: 80, branches: 75, statements: 80 },
      exclude: ['**/*.test.ts', '**/*.test.tsx', 'src/test-setup.ts', 'apps-script/**'],
    },
  },
});
```

```ts
// src/test-setup.ts
import '@testing-library/jest-dom/vitest';
```

Add scripts to `package.json`:
```json
{
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "test": "vitest run",
    "test:watch": "vitest",
    "coverage": "vitest run --coverage",
    "typecheck": "tsc --noEmit"
  }
}
```

- [ ] **Step 4: Add the Pages workflow**

```yaml
# .github/workflows/deploy.yml
name: Deploy to GitHub Pages
on:
  push: { branches: [main] }
  workflow_dispatch:
permissions:
  contents: read
  pages: write
  id-token: write
concurrency:
  group: pages
  cancel-in-progress: true
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22', cache: 'npm' }
      - run: npm ci
      - run: npm run typecheck
      - run: npm test
      - run: npm run build
      - uses: actions/upload-pages-artifact@v3
        with: { path: ./dist }
  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - id: deployment
        uses: actions/deploy-pages@v4
```

- [ ] **Step 5: Verify locally, then deploy**

```bash
npm run typecheck && npm run build
```
Expected: clean build into `dist/`.

Push to `main`, then in the repo: Settings → Pages → Source: **GitHub Actions**. Confirm the stub page loads at the Pages URL with Astryx fonts applied (Figtree, not a system fallback).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: scaffold vite react ts app with astryx neutral and pages deploy"
```

---

# Phase 2 — Domain layer (pure, TDD, no UI)

## Task 3: Domain types and block arithmetic

**Files:**
- Create: `src/domain/types.ts`, `src/domain/blocks.ts`
- Test: `src/domain/blocks.test.ts`

**Interfaces:**
- Produces: every domain type used by all later tasks, plus
  `hoursToBlocks(hours: number): { blocks: number; residualHours: number }`,
  `blocksToHours(blocks: number): number`,
  `formatHours(hours: number): string`

- [ ] **Step 1: Write the types**

```ts
// src/domain/types.ts
export const BLOCKS_PER_DAY = 15;      // 7.5h in half-hour blocks
export const BLOCKS_PER_WEEK = 75;     // 37.5h
export const HOURS_PER_BLOCK = 0.5;
export const OPEX_FLOOR_RATIO = 0.4;

export type Blocks = number;    // always a non-negative integer
export type IsoDate = string;   // 'YYYY-MM-DD'
export type IsoMonth = string;  // 'YYYY-MM'
export type OtlCode = string;   // project code — primary key
export type PersonId = string;

export type OtlCategory = 'CAPEX' | 'OPEX' | 'LEAVE';
export type LeaveSubtype = 'VACATION' | 'STAT' | 'PERSONAL' | 'SICK';
export type Role = 'MANAGER' | 'REPORT';
export type EntrySource = 'CALC' | 'OVERRIDE' | 'LEAVE';
export type ResidualReason = 'UNABSORBED' | 'UNASSIGNED';

export interface Otl {
  projectCode: OtlCode;
  taskCode: string;
  expenditureTypeCode: string;
  timeReportingCode: string;
  category: OtlCategory;
  leaveSubtype: LeaveSubtype | null;
  isDefaultOpex: boolean;
  colorIndex: number;
  active: boolean;
}

export interface Person {
  id: PersonId;
  name: string;
  role: Role;
  managerId: PersonId | null;
}

export interface StatHoliday { date: IsoDate; name: string; otlProjectCode: OtlCode; }

/** personId === null means this row is the OTL's monthly total. */
export interface Allocation {
  month: IsoMonth;
  otlProjectCode: OtlCode;
  personId: PersonId | null;
  hours: number;
}

export interface LeaveRange {
  personId: PersonId;
  startDate: IsoDate;
  endDate: IsoDate;
  otlProjectCode: OtlCode;
}

export interface Override {
  personId: PersonId;
  date: IsoDate;
  otlProjectCode: OtlCode;
  hours: number;
}

export interface ScheduleEntry {
  personId: PersonId;
  date: IsoDate;
  otlProjectCode: OtlCode;
  blocks: Blocks;
  source: EntrySource;
}

export interface Residual {
  personId: PersonId | null;
  otlProjectCode: OtlCode;
  month: IsoMonth;
  blocks: Blocks;
  reason: ResidualReason;
}

export interface Violation {
  personId: PersonId;
  scope: IsoDate | IsoMonth;
  kind: 'DAY_NOT_FULL' | 'OPEX_FLOOR_BREACHED' | 'OVER_CAPACITY' | 'NEGATIVE';
  message: string;
}

export interface Model {
  otls: Otl[];
  people: Person[];
  statHolidays: StatHoliday[];
  allocations: Allocation[];
  leave: LeaveRange[];
  overrides: Override[];
}

export interface ScheduleResult {
  entries: ScheduleEntry[];
  residuals: Residual[];
  violations: Violation[];
}
```

- [ ] **Step 2: Write the failing test**

```ts
// src/domain/blocks.test.ts
import { describe, it, expect } from 'vitest';
import { hoursToBlocks, blocksToHours, formatHours } from './blocks';

describe('hoursToBlocks', () => {
  it('converts clean halves exactly with no residual', () => {
    expect(hoursToBlocks(7.5)).toEqual({ blocks: 15, residualHours: 0 });
    expect(hoursToBlocks(0)).toEqual({ blocks: 0, residualHours: 0 });
    expect(hoursToBlocks(100)).toEqual({ blocks: 200, residualHours: 0 });
  });

  it('floors a non-multiple and reports the residual', () => {
    expect(hoursToBlocks(96.3)).toEqual({ blocks: 192, residualHours: 0.3 });
    expect(hoursToBlocks(0.4)).toEqual({ blocks: 0, residualHours: 0.4 });
  });

  it('never returns a negative block count', () => {
    expect(hoursToBlocks(-5)).toEqual({ blocks: 0, residualHours: 0 });
  });

  it('is immune to float representation error', () => {
    // 0.1 + 0.2 style drift must not create a phantom residual
    expect(hoursToBlocks(37.5)).toEqual({ blocks: 75, residualHours: 0 });
    expect(hoursToBlocks(2.5 * 3)).toEqual({ blocks: 15, residualHours: 0 });
  });
});

describe('blocksToHours', () => {
  it('round-trips', () => {
    expect(blocksToHours(15)).toBe(7.5);
    expect(blocksToHours(0)).toBe(0);
  });
});

describe('formatHours', () => {
  it('always shows exactly one decimal place', () => {
    expect(formatHours(7.5)).toBe('7.5');
    expect(formatHours(2)).toBe('2.0');
    expect(formatHours(15)).toBe('15.0');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/domain/blocks.test.ts`
Expected: FAIL — `Failed to resolve import "./blocks"`

- [ ] **Step 4: Implement**

```ts
// src/domain/blocks.ts
import { HOURS_PER_BLOCK, type Blocks } from './types';

/**
 * Converts hours to whole half-hour blocks, flooring, and reports what
 * could not be represented. Rounds to 4dp first so float drift
 * (2.5 * 3 === 7.500000000000001) never manufactures a residual.
 */
export function hoursToBlocks(hours: number): { blocks: Blocks; residualHours: number } {
  if (!Number.isFinite(hours) || hours <= 0) return { blocks: 0, residualHours: 0 };
  const exact = Math.round(hours / HOURS_PER_BLOCK * 1e4) / 1e4;
  const blocks = Math.floor(exact);
  const residualHours = Math.round((hours - blocks * HOURS_PER_BLOCK) * 1e4) / 1e4;
  return { blocks, residualHours };
}

export function blocksToHours(blocks: Blocks): number {
  return blocks * HOURS_PER_BLOCK;
}

export function formatHours(hours: number): string {
  return hours.toFixed(1);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/domain/blocks.test.ts`
Expected: PASS, 8 tests

- [ ] **Step 6: Commit**

```bash
git add src/domain/types.ts src/domain/blocks.ts src/domain/blocks.test.ts
git commit -m "feat: domain types and integer block arithmetic"
```

---

## Task 4: Calendar

Weeks, working days, and month membership. All date maths uses UTC to avoid a timezone shifting a day into the wrong week.

**Files:**
- Create: `src/domain/calendar.ts`
- Test: `src/domain/calendar.test.ts`

**Interfaces:**
- Consumes: `IsoDate`, `IsoMonth` from `./types`
- Produces:
  `mondayOf(date: IsoDate): IsoDate`,
  `weekDays(monday: IsoDate): IsoDate[]` (always 5, Mon–Fri),
  `weeksTouchingMonth(month: IsoMonth): IsoDate[]` (Mondays, ascending),
  `monthOf(date: IsoDate): IsoMonth`,
  `datesInRange(start: IsoDate, end: IsoDate): IsoDate[]` (weekdays only),
  `addDays(date: IsoDate, n: number): IsoDate`,
  `formatDayHeader(date: IsoDate): string`,
  `formatWeekRange(monday: IsoDate): string`

- [ ] **Step 1: Write the failing test**

```ts
// src/domain/calendar.test.ts
import { describe, it, expect } from 'vitest';
import {
  mondayOf, weekDays, weeksTouchingMonth, monthOf,
  datesInRange, addDays, formatWeekRange,
} from './calendar';

describe('mondayOf', () => {
  it('returns the Monday of the containing week', () => {
    expect(mondayOf('2026-09-01')).toBe('2026-08-31'); // Tue -> prev Mon
    expect(mondayOf('2026-08-31')).toBe('2026-08-31'); // Mon -> itself
    expect(mondayOf('2026-09-04')).toBe('2026-08-31'); // Fri -> that Mon
  });

  it('treats Saturday and Sunday as belonging to the preceding week', () => {
    expect(mondayOf('2026-09-05')).toBe('2026-08-31'); // Sat
    expect(mondayOf('2026-09-06')).toBe('2026-08-31'); // Sun
  });
});

describe('weekDays', () => {
  it('returns exactly five weekdays', () => {
    expect(weekDays('2026-08-31')).toEqual([
      '2026-08-31', '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04',
    ]);
  });
});

describe('weeksTouchingMonth', () => {
  it('includes the week that starts in the previous month', () => {
    // Sept 2026 starts Tue 1st, so week 1 begins Mon Aug 31.
    const weeks = weeksTouchingMonth('2026-09');
    expect(weeks[0]).toBe('2026-08-31');
  });

  it('includes the week that runs into the next month', () => {
    // Sept 2026 ends Wed 30th; that week began Mon Sep 28.
    const weeks = weeksTouchingMonth('2026-09');
    expect(weeks[weeks.length - 1]).toBe('2026-09-28');
  });

  it('returns ascending Mondays with no duplicates', () => {
    const weeks = weeksTouchingMonth('2026-09');
    expect(weeks).toEqual([...weeks].sort());
    expect(new Set(weeks).size).toBe(weeks.length);
    expect(weeks.length).toBe(5);
  });
});

describe('monthOf', () => {
  it('assigns each day to its own calendar month', () => {
    expect(monthOf('2026-08-31')).toBe('2026-08');
    expect(monthOf('2026-09-01')).toBe('2026-09');
  });
});

describe('datesInRange', () => {
  it('expands a range to weekdays only', () => {
    expect(datesInRange('2026-09-14', '2026-09-18')).toEqual([
      '2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18',
    ]);
  });

  it('drops weekends inside the range', () => {
    expect(datesInRange('2026-09-04', '2026-09-07')).toEqual([
      '2026-09-04', '2026-09-07',
    ]);
  });

  it('returns empty when end precedes start', () => {
    expect(datesInRange('2026-09-10', '2026-09-01')).toEqual([]);
  });
});

describe('addDays', () => {
  it('crosses month and year boundaries', () => {
    expect(addDays('2026-08-31', 1)).toBe('2026-09-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-09-01', -1)).toBe('2026-08-31');
  });
});

describe('formatWeekRange', () => {
  it('spells out a straddling week', () => {
    expect(formatWeekRange('2026-08-31')).toBe('31 Aug – 4 Sep 2026');
  });

  it('omits the repeated month within one month', () => {
    expect(formatWeekRange('2026-09-07')).toBe('7 – 11 Sep 2026');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/domain/calendar.test.ts`
Expected: FAIL — cannot resolve `./calendar`

- [ ] **Step 3: Implement**

```ts
// src/domain/calendar.ts
import type { IsoDate, IsoMonth } from './types';

const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

/** All arithmetic is UTC so a local timezone can never shift a day into another week. */
function toUtc(date: IsoDate): Date {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function toIso(d: Date): IsoDate {
  return d.toISOString().slice(0, 10);
}

export function addDays(date: IsoDate, n: number): IsoDate {
  const d = toUtc(date);
  d.setUTCDate(d.getUTCDate() + n);
  return toIso(d);
}

/** 1 = Monday … 7 = Sunday */
function isoDayOfWeek(date: IsoDate): number {
  const dow = toUtc(date).getUTCDay();
  return dow === 0 ? 7 : dow;
}

export function isWeekend(date: IsoDate): boolean {
  return isoDayOfWeek(date) > 5;
}

export function mondayOf(date: IsoDate): IsoDate {
  return addDays(date, -(isoDayOfWeek(date) - 1));
}

export function weekDays(monday: IsoDate): IsoDate[] {
  return [0, 1, 2, 3, 4].map((i) => addDays(monday, i));
}

export function monthOf(date: IsoDate): IsoMonth {
  return date.slice(0, 7);
}

/** Every Monday whose Mon–Fri span contains at least one day of `month`. */
export function weeksTouchingMonth(month: IsoMonth): IsoDate[] {
  const [y, m] = month.split('-').map(Number);
  const first = toIso(new Date(Date.UTC(y, m - 1, 1)));
  const last = toIso(new Date(Date.UTC(y, m, 0)));
  const weeks: IsoDate[] = [];
  for (let monday = mondayOf(first); monday <= mondayOf(last); monday = addDays(monday, 7)) {
    if (weekDays(monday).some((d) => monthOf(d) === month)) weeks.push(monday);
  }
  return weeks;
}

/** Weekdays from start to end inclusive. Empty if end precedes start. */
export function datesInRange(start: IsoDate, end: IsoDate): IsoDate[] {
  if (end < start) return [];
  const out: IsoDate[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) {
    if (!isWeekend(d)) out.push(d);
  }
  return out;
}

export function formatDayHeader(date: IsoDate): string {
  const names = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const d = toUtc(date);
  return `${names[isoDayOfWeek(date) - 1]} ${d.getUTCDate()} ${MONTH_NAMES[d.getUTCMonth()]}`;
}

export function formatWeekRange(monday: IsoDate): string {
  const friday = addDays(monday, 4);
  const a = toUtc(monday);
  const b = toUtc(friday);
  const year = b.getUTCFullYear();
  if (a.getUTCMonth() === b.getUTCMonth()) {
    return `${a.getUTCDate()} – ${b.getUTCDate()} ${MONTH_NAMES[b.getUTCMonth()]} ${year}`;
  }
  return `${a.getUTCDate()} ${MONTH_NAMES[a.getUTCMonth()]} – ` +
         `${b.getUTCDate()} ${MONTH_NAMES[b.getUTCMonth()]} ${year}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/domain/calendar.test.ts`
Expected: PASS, 14 tests

- [ ] **Step 5: Commit**

```bash
git add src/domain/calendar.ts src/domain/calendar.test.ts
git commit -m "feat: calendar helpers for straddling mon-fri weeks"
```

---

## Task 5: Capacity and the OPEX floor

**Files:**
- Create: `src/domain/capacity.ts`
- Test: `src/domain/capacity.test.ts`

**Interfaces:**
- Consumes: `weekDays` from `./calendar`; `BLOCKS_PER_DAY`, `OPEX_FLOOR_RATIO` from `./types`
- Produces:
  `leaveDatesFor(personId: PersonId, dates: IsoDate[], model: Model): Map<IsoDate, OtlCode>`,
  `weekCapacity(leaveDates: Map<IsoDate, OtlCode>, dates: IsoDate[]): Blocks`,
  `opexFloor(capacity: Blocks): Blocks`,
  `capexRoom(capacity: Blocks): Blocks`

- [ ] **Step 1: Write the failing test**

```ts
// src/domain/capacity.test.ts
import { describe, it, expect } from 'vitest';
import { leaveDatesFor, weekCapacity, opexFloor, capexRoom } from './capacity';
import { weekDays } from './calendar';
import type { Model } from './types';

const emptyModel: Model = {
  otls: [], people: [], statHolidays: [], allocations: [], leave: [], overrides: [],
};

describe('opexFloor', () => {
  it('is 30 blocks (15.0h) for a full week', () => {
    expect(opexFloor(75)).toBe(30);
  });

  it('scales down with reduced capacity', () => {
    expect(opexFloor(60)).toBe(24); // one day off -> 12.0h
    expect(opexFloor(45)).toBe(18); // two days off -> 9.0h
  });

  it('uses ceiling so a stated minimum is never undershot', () => {
    // 0.4 * 15 = 6 exactly; 0.4 * 25 = 10 exactly; pick a case that is not whole
    expect(opexFloor(7)).toBe(3);  // 2.8 -> 3, not 2
    expect(opexFloor(13)).toBe(6); // 5.2 -> 6, not 5
  });

  it('is zero when there is no capacity', () => {
    expect(opexFloor(0)).toBe(0);
  });
});

describe('capexRoom', () => {
  it('is the complement of the floor', () => {
    expect(capexRoom(75)).toBe(45); // 22.5h
    expect(capexRoom(60)).toBe(36); // 18.0h
  });
});

describe('weekCapacity', () => {
  it('is 75 blocks with no leave', () => {
    expect(weekCapacity(new Map(), weekDays('2026-08-31'))).toBe(75);
  });

  it('drops 15 blocks per leave day', () => {
    const leave = new Map([['2026-09-01', 'STAT-01']]);
    expect(weekCapacity(leave, weekDays('2026-08-31'))).toBe(60);
  });

  it('is zero when the whole week is leave', () => {
    const leave = new Map(weekDays('2026-08-31').map((d) => [d, 'VAC-01']));
    expect(weekCapacity(leave, weekDays('2026-08-31'))).toBe(0);
  });
});

describe('leaveDatesFor', () => {
  it('applies stat holidays to everyone', () => {
    const model: Model = {
      ...emptyModel,
      statHolidays: [{ date: '2026-09-07', name: 'Labour Day', otlProjectCode: 'STAT-01' }],
    };
    const got = leaveDatesFor('p1', weekDays('2026-09-07'), model);
    expect(got.get('2026-09-07')).toBe('STAT-01');
    expect(got.size).toBe(1);
  });

  it('expands a personal leave range to weekdays', () => {
    const model: Model = {
      ...emptyModel,
      leave: [{
        personId: 'p1', startDate: '2026-09-14', endDate: '2026-09-18',
        otlProjectCode: 'VAC-01',
      }],
    };
    const got = leaveDatesFor('p1', weekDays('2026-09-14'), model);
    expect(got.size).toBe(5);
    expect(got.get('2026-09-16')).toBe('VAC-01');
  });

  it('ignores leave belonging to another person', () => {
    const model: Model = {
      ...emptyModel,
      leave: [{
        personId: 'p2', startDate: '2026-09-14', endDate: '2026-09-18',
        otlProjectCode: 'VAC-01',
      }],
    };
    expect(leaveDatesFor('p1', weekDays('2026-09-14'), model).size).toBe(0);
  });

  it('lets a stat holiday win over overlapping personal leave', () => {
    const model: Model = {
      ...emptyModel,
      statHolidays: [{ date: '2026-09-16', name: 'Stat', otlProjectCode: 'STAT-01' }],
      leave: [{
        personId: 'p1', startDate: '2026-09-14', endDate: '2026-09-18',
        otlProjectCode: 'VAC-01',
      }],
    };
    // You do not spend a vacation day on a day the company is closed.
    expect(leaveDatesFor('p1', weekDays('2026-09-14'), model).get('2026-09-16')).toBe('STAT-01');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/domain/capacity.test.ts`
Expected: FAIL — cannot resolve `./capacity`

- [ ] **Step 3: Implement**

```ts
// src/domain/capacity.ts
import { datesInRange } from './calendar';
import {
  BLOCKS_PER_DAY, OPEX_FLOOR_RATIO,
  type Blocks, type IsoDate, type Model, type OtlCode, type PersonId,
} from './types';

/**
 * Which of `dates` this person is away, and on which leave code.
 * Stat holidays override personal leave — a closed office does not
 * consume someone's vacation entitlement.
 */
export function leaveDatesFor(
  personId: PersonId, dates: IsoDate[], model: Model,
): Map<IsoDate, OtlCode> {
  const inWeek = new Set(dates);
  const out = new Map<IsoDate, OtlCode>();

  for (const range of model.leave) {
    if (range.personId !== personId) continue;
    for (const d of datesInRange(range.startDate, range.endDate)) {
      if (inWeek.has(d)) out.set(d, range.otlProjectCode);
    }
  }
  for (const holiday of model.statHolidays) {
    if (inWeek.has(holiday.date)) out.set(holiday.date, holiday.otlProjectCode);
  }
  return out;
}

export function weekCapacity(leaveDates: Map<IsoDate, OtlCode>, dates: IsoDate[]): Blocks {
  return dates.filter((d) => !leaveDates.has(d)).length * BLOCKS_PER_DAY;
}

/** Ceiling, never rounding — a minimum must never be undershot. */
export function opexFloor(capacity: Blocks): Blocks {
  return Math.ceil(capacity * OPEX_FLOOR_RATIO);
}

export function capexRoom(capacity: Blocks): Blocks {
  return capacity - opexFloor(capacity);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/domain/capacity.test.ts`
Expected: PASS, 12 tests

- [ ] **Step 5: Commit**

```bash
git add src/domain/capacity.ts src/domain/capacity.test.ts
git commit -m "feat: week capacity and scaling opex floor"
```

---

## Task 6: Demand pacing

Turns monthly per-person allocations into a per-week target so early weeks do not exhaust the month's budget.

**Files:**
- Create: `src/domain/demand.ts`
- Test: `src/domain/demand.test.ts`

**Interfaces:**
- Consumes: `monthOf` from `./calendar`; `hoursToBlocks` from `./blocks`
- Produces:
  `type DemandItem = { otlProjectCode: OtlCode; month: IsoMonth; blocks: Blocks }`,
  `assignmentBlocks(personId: PersonId, model: Model): Map<string, Blocks>` keyed `` `${month}|${otl}` ``,
  `pacedDemand(remaining: Map<string, Blocks>, weekDates: IsoDate[], remainingWorkdaysByMonth: Map<IsoMonth, number>, weekWorkdaysByMonth: Map<IsoMonth, number>): DemandItem[]`

- [ ] **Step 1: Write the failing test**

```ts
// src/domain/demand.test.ts
import { describe, it, expect } from 'vitest';
import { assignmentBlocks, pacedDemand } from './demand';
import type { Model } from './types';

const base: Model = {
  otls: [], people: [], statHolidays: [], allocations: [], leave: [], overrides: [],
};

describe('assignmentBlocks', () => {
  it('keys per-person allocations by month and OTL', () => {
    const model: Model = {
      ...base,
      allocations: [
        { month: '2026-09', otlProjectCode: 'P-1001', personId: 'p1', hours: 60 },
        { month: '2026-09', otlProjectCode: 'P-1002', personId: 'p1', hours: 30 },
      ],
    };
    const got = assignmentBlocks('p1', model);
    expect(got.get('2026-09|P-1001')).toBe(120);
    expect(got.get('2026-09|P-1002')).toBe(60);
  });

  it('excludes OTL monthly total rows, which have a null personId', () => {
    const model: Model = {
      ...base,
      allocations: [
        { month: '2026-09', otlProjectCode: 'P-1001', personId: null, hours: 300 },
        { month: '2026-09', otlProjectCode: 'P-1001', personId: 'p1', hours: 60 },
      ],
    };
    expect(assignmentBlocks('p1', model).get('2026-09|P-1001')).toBe(120);
  });

  it('excludes other people', () => {
    const model: Model = {
      ...base,
      allocations: [{ month: '2026-09', otlProjectCode: 'P-1001', personId: 'p2', hours: 60 }],
    };
    expect(assignmentBlocks('p1', model).size).toBe(0);
  });
});

describe('pacedDemand', () => {
  it('offers a proportional slice of the month, not the whole balance', () => {
    const remaining = new Map([['2026-09|P-1001', 120]]); // 60h left
    // 20 workdays left in the month, 5 of them in this week -> a quarter
    const got = pacedDemand(
      remaining, [], new Map([['2026-09', 20]]), new Map([['2026-09', 5]]),
    );
    expect(got).toEqual([{ otlProjectCode: 'P-1001', month: '2026-09', blocks: 30 }]);
  });

  it('offers the entire balance in the final week of the month', () => {
    const remaining = new Map([['2026-09|P-1001', 40]]);
    const got = pacedDemand(
      remaining, [], new Map([['2026-09', 3]]), new Map([['2026-09', 3]]),
    );
    expect(got[0].blocks).toBe(40);
  });

  it('rounds a fractional slice up so the month finishes on time', () => {
    const remaining = new Map([['2026-09|P-1001', 10]]);
    const got = pacedDemand(
      remaining, [], new Map([['2026-09', 4]]), new Map([['2026-09', 3]]),
    );
    expect(got[0].blocks).toBe(8); // ceil(10 * 3/4)
  });

  it('drops exhausted allocations', () => {
    const remaining = new Map([['2026-09|P-1001', 0]]);
    expect(pacedDemand(remaining, [], new Map([['2026-09', 5]]), new Map([['2026-09', 5]]))).toEqual([]);
  });

  it('sorts descending by blocks then by code, for determinism', () => {
    const remaining = new Map([
      ['2026-09|P-1001', 20], ['2026-09|P-1003', 40], ['2026-09|P-1002', 40],
    ]);
    const got = pacedDemand(
      remaining, [], new Map([['2026-09', 5]]), new Map([['2026-09', 5]]),
    );
    expect(got.map((d) => d.otlProjectCode)).toEqual(['P-1002', 'P-1003', 'P-1001']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/domain/demand.test.ts`
Expected: FAIL — cannot resolve `./demand`

- [ ] **Step 3: Implement**

```ts
// src/domain/demand.ts
import { hoursToBlocks } from './blocks';
import type { Blocks, IsoDate, IsoMonth, Model, OtlCode, PersonId } from './types';

export interface DemandItem {
  otlProjectCode: OtlCode;
  month: IsoMonth;
  blocks: Blocks;
}

export function keyOf(month: IsoMonth, otl: OtlCode): string {
  return `${month}|${otl}`;
}

/** Per-person CAPEX assignments as blocks. Rows with a null personId are OTL totals. */
export function assignmentBlocks(personId: PersonId, model: Model): Map<string, Blocks> {
  const out = new Map<string, Blocks>();
  for (const a of model.allocations) {
    if (a.personId !== personId) continue;
    const key = keyOf(a.month, a.otlProjectCode);
    out.set(key, (out.get(key) ?? 0) + hoursToBlocks(a.hours).blocks);
  }
  return out;
}

/**
 * The slice of each remaining allocation this week should absorb, so a
 * month's budget is spread rather than front-loaded. Rounds up so the
 * balance always lands before the month runs out of days.
 */
export function pacedDemand(
  remaining: Map<string, Blocks>,
  _weekDates: IsoDate[],
  remainingWorkdaysByMonth: Map<IsoMonth, number>,
  weekWorkdaysByMonth: Map<IsoMonth, number>,
): DemandItem[] {
  const items: DemandItem[] = [];

  for (const [key, blocks] of remaining) {
    if (blocks <= 0) continue;
    const [month, otlProjectCode] = key.split('|');
    const weekDays = weekWorkdaysByMonth.get(month) ?? 0;
    if (weekDays === 0) continue;

    const monthDays = remainingWorkdaysByMonth.get(month) ?? 0;
    const share = monthDays <= weekDays
      ? blocks
      : Math.min(blocks, Math.ceil(blocks * (weekDays / monthDays)));

    items.push({ otlProjectCode, month, blocks: share });
  }

  // Stable: biggest first, then alphabetical. Never rely on Map iteration order.
  items.sort((a, b) =>
    b.blocks - a.blocks ||
    a.otlProjectCode.localeCompare(b.otlProjectCode) ||
    a.month.localeCompare(b.month));
  return items;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/domain/demand.test.ts`
Expected: PASS, 8 tests

- [ ] **Step 5: Commit**

```bash
git add src/domain/demand.ts src/domain/demand.test.ts
git commit -m "feat: pace monthly allocations into weekly demand"
```

---

## Task 7: The week optimizer

The core algorithm. One person, one week.

**Files:**
- Create: `src/domain/optimizer.ts`
- Test: `src/domain/optimizer.test.ts`

**Interfaces:**
- Consumes: `opexFloor` from `./capacity`; `monthOf` from `./calendar`; `DemandItem` from `./demand`
- Produces:
  ```ts
  interface WeekInput {
    personId: PersonId;
    dates: IsoDate[];                       // exactly 5, Mon–Fri
    leaveDates: Map<IsoDate, OtlCode>;
    overrides: Override[];                  // this person, this week only
    demand: DemandItem[];                   // sorted, from pacedDemand
    defaultOpexCode: OtlCode;
    capexCodes: Set<OtlCode>;
  }
  interface WeekOutput {
    entries: ScheduleEntry[];
    consumed: Map<string, Blocks>;          // `${month}|${otl}` actually placed
    violations: Violation[];
  }
  scheduleWeek(input: WeekInput): WeekOutput
  ```

- [ ] **Step 1: Write the failing test**

```ts
// src/domain/optimizer.test.ts
import { describe, it, expect } from 'vitest';
import { scheduleWeek, type WeekInput } from './optimizer';
import { weekDays } from './calendar';

const OPEX = 'OPEX-ADMIN';

function input(over: Partial<WeekInput> = {}): WeekInput {
  return {
    personId: 'p1',
    dates: weekDays('2026-09-07'),
    leaveDates: new Map(),
    overrides: [],
    demand: [],
    defaultOpexCode: OPEX,
    capexCodes: new Set(['P-1001', 'P-1002']),
    ...over,
  };
}

function totalFor(out: ReturnType<typeof scheduleWeek>, date: string): number {
  return out.entries.filter((e) => e.date === date)
    .reduce((s, e) => s + e.blocks, 0);
}

function blocksOn(out: ReturnType<typeof scheduleWeek>, otl: string): number {
  return out.entries.filter((e) => e.otlProjectCode === otl)
    .reduce((s, e) => s + e.blocks, 0);
}

describe('scheduleWeek', () => {
  it('fills a week with pure OPEX when there is no CAPEX demand', () => {
    const out = scheduleWeek(input());
    expect(blocksOn(out, OPEX)).toBe(75);
    for (const d of weekDays('2026-09-07')) expect(totalFor(out, d)).toBe(15);
    expect(out.violations).toEqual([]);
  });

  it('never places CAPEX beyond the 45-block ceiling', () => {
    const out = scheduleWeek(input({
      demand: [{ otlProjectCode: 'P-1001', month: '2026-09', blocks: 999 }],
    }));
    expect(blocksOn(out, 'P-1001')).toBe(45); // 22.5h
    expect(blocksOn(out, OPEX)).toBe(30);     // exactly the 15.0h floor
  });

  it('lets CAPEX concentrate within a day rather than smearing', () => {
    const out = scheduleWeek(input({
      demand: [{ otlProjectCode: 'P-1001', month: '2026-09', blocks: 30 }],
    }));
    const mon = out.entries.filter((e) => e.date === '2026-09-07');
    // Monday should be wholly one CAPEX code, not a 40/60 split.
    expect(mon.length).toBe(1);
    expect(mon[0].otlProjectCode).toBe('P-1001');
    expect(mon[0].blocks).toBe(15);
  });

  it('draws each day only from its own month budget', () => {
    // Week of Mon 31 Aug: Monday is August, Tue–Fri are September.
    const out = scheduleWeek(input({
      dates: weekDays('2026-08-31'),
      demand: [{ otlProjectCode: 'P-1001', month: '2026-09', blocks: 45 }],
    }));
    const monday = out.entries.filter((e) => e.date === '2026-08-31');
    expect(monday.every((e) => e.otlProjectCode === OPEX)).toBe(true);
    expect(blocksOn(out, 'P-1001')).toBe(45);
  });

  it('scales the floor when a stat holiday shortens the week', () => {
    const out = scheduleWeek(input({
      leaveDates: new Map([['2026-09-07', 'STAT-01']]),
      demand: [{ otlProjectCode: 'P-1001', month: '2026-09', blocks: 999 }],
    }));
    expect(blocksOn(out, 'STAT-01')).toBe(15);
    expect(blocksOn(out, 'P-1001')).toBe(36); // capexRoom(60)
    expect(blocksOn(out, OPEX)).toBe(24);     // ceil(0.4 * 60)
  });

  it('gives a leave day the whole 7.5h and zeroes everything else', () => {
    const out = scheduleWeek(input({
      leaveDates: new Map([['2026-09-09', 'VAC-01']]),
    }));
    const wed = out.entries.filter((e) => e.date === '2026-09-09');
    expect(wed).toHaveLength(1);
    expect(wed[0]).toMatchObject({ otlProjectCode: 'VAC-01', blocks: 15, source: 'LEAVE' });
  });

  it('honours an override and rebalances the rest of that day to 7.5h', () => {
    const out = scheduleWeek(input({
      overrides: [{ personId: 'p1', date: '2026-09-08', otlProjectCode: 'P-1002', hours: 4 }],
    }));
    const tue = out.entries.filter((e) => e.date === '2026-09-08');
    expect(tue.find((e) => e.otlProjectCode === 'P-1002'))
      .toMatchObject({ blocks: 8, source: 'OVERRIDE' });
    expect(totalFor(out, '2026-09-08')).toBe(15);
  });

  it('counts an overridden CAPEX cell against the ceiling', () => {
    const out = scheduleWeek(input({
      overrides: [{ personId: 'p1', date: '2026-09-08', otlProjectCode: 'P-1002', hours: 7.5 }],
      demand: [{ otlProjectCode: 'P-1001', month: '2026-09', blocks: 999 }],
    }));
    expect(blocksOn(out, 'P-1002') + blocksOn(out, 'P-1001')).toBe(45);
  });

  it('reports how much of each allocation it actually placed', () => {
    const out = scheduleWeek(input({
      demand: [{ otlProjectCode: 'P-1001', month: '2026-09', blocks: 20 }],
    }));
    expect(out.consumed.get('2026-09|P-1001')).toBe(20);
  });

  it('flags a floor breach caused by overrides instead of silently moving them', () => {
    // The user pins 5 full CAPEX days. Their overrides win; we report the conflict.
    const out = scheduleWeek(input({
      overrides: weekDays('2026-09-07').map((date) => ({
        personId: 'p1', date, otlProjectCode: 'P-1001', hours: 7.5,
      })),
    }));
    expect(blocksOn(out, 'P-1001')).toBe(75);
    expect(out.violations.some((v) => v.kind === 'OPEX_FLOOR_BREACHED')).toBe(true);
  });

  it('flags overrides that exceed a day', () => {
    const out = scheduleWeek(input({
      overrides: [
        { personId: 'p1', date: '2026-09-08', otlProjectCode: 'P-1001', hours: 5 },
        { personId: 'p1', date: '2026-09-08', otlProjectCode: 'P-1002', hours: 5 },
      ],
    }));
    expect(out.violations.some((v) => v.kind === 'OVER_CAPACITY')).toBe(true);
  });

  it('produces byte-identical output when run twice', () => {
    const args = input({
      demand: [
        { otlProjectCode: 'P-1001', month: '2026-09', blocks: 22 },
        { otlProjectCode: 'P-1002', month: '2026-09', blocks: 13 },
      ],
    });
    expect(JSON.stringify(scheduleWeek(args).entries))
      .toBe(JSON.stringify(scheduleWeek(args).entries));
  });

  it('emits no zero-block entries', () => {
    const out = scheduleWeek(input({
      demand: [{ otlProjectCode: 'P-1001', month: '2026-09', blocks: 1 }],
    }));
    expect(out.entries.every((e) => e.blocks > 0)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/domain/optimizer.test.ts`
Expected: FAIL — cannot resolve `./optimizer`

- [ ] **Step 3: Implement**

```ts
// src/domain/optimizer.ts
import { hoursToBlocks } from './blocks';
import { monthOf } from './calendar';
import { opexFloor } from './capacity';
import type { DemandItem } from './demand';
import { keyOf } from './demand';
import {
  BLOCKS_PER_DAY,
  type Blocks, type IsoDate, type Override, type OtlCode,
  type PersonId, type ScheduleEntry, type Violation,
} from './types';

export interface WeekInput {
  personId: PersonId;
  dates: IsoDate[];
  leaveDates: Map<IsoDate, OtlCode>;
  overrides: Override[];
  demand: DemandItem[];
  defaultOpexCode: OtlCode;
  capexCodes: Set<OtlCode>;
}

export interface WeekOutput {
  entries: ScheduleEntry[];
  consumed: Map<string, Blocks>;
  violations: Violation[];
}

export function scheduleWeek(input: WeekInput): WeekOutput {
  const { personId, dates, leaveDates, overrides, demand,
          defaultOpexCode, capexCodes } = input;

  const entries: ScheduleEntry[] = [];
  const consumed = new Map<string, Blocks>();
  const violations: Violation[] = [];
  const dayRemaining = new Map<IsoDate, Blocks>();

  // 1. Leave takes whole days and removes them from capacity entirely.
  for (const date of dates) {
    const leaveCode = leaveDates.get(date);
    if (leaveCode) {
      entries.push({
        personId, date, otlProjectCode: leaveCode,
        blocks: BLOCKS_PER_DAY, source: 'LEAVE',
      });
      dayRemaining.set(date, 0);
    } else {
      dayRemaining.set(date, BLOCKS_PER_DAY);
    }
  }

  const capacity = dates.filter((d) => !leaveDates.has(d)).length * BLOCKS_PER_DAY;
  const floor = opexFloor(capacity);

  // 2. Overrides are inputs, not outputs. They win, even over the floor.
  let overriddenCapex = 0;
  const sortedOverrides = [...overrides].sort((a, b) =>
    a.date.localeCompare(b.date) || a.otlProjectCode.localeCompare(b.otlProjectCode));

  for (const o of sortedOverrides) {
    if (leaveDates.has(o.date)) continue;       // a leave day cannot hold anything else
    const blocks = hoursToBlocks(o.hours).blocks;
    if (blocks <= 0) continue;

    const left = dayRemaining.get(o.date) ?? 0;
    if (blocks > left) {
      violations.push({
        personId, scope: o.date, kind: 'OVER_CAPACITY',
        message: `Overrides on ${o.date} exceed 7.5h.`,
      });
    }
    const placed = Math.min(blocks, left);
    if (placed <= 0) continue;

    entries.push({
      personId, date: o.date, otlProjectCode: o.otlProjectCode,
      blocks: placed, source: 'OVERRIDE',
    });
    dayRemaining.set(o.date, left - placed);

    if (capexCodes.has(o.otlProjectCode)) {
      overriddenCapex += placed;
      const key = keyOf(monthOf(o.date), o.otlProjectCode);
      consumed.set(key, (consumed.get(key) ?? 0) + placed);
    }
  }

  // 3. Fill CAPEX up to the room the floor leaves, minus what overrides already took.
  let capexBudget = Math.max(0, capacity - floor - overriddenCapex);

  for (const item of demand) {
    if (capexBudget <= 0) break;
    let want = Math.min(item.blocks, capexBudget);

    for (const date of dates) {
      if (want <= 0) break;
      if (monthOf(date) !== item.month) continue;   // a day only spends its own month
      const left = dayRemaining.get(date) ?? 0;
      if (left <= 0) continue;

      const place = Math.min(left, want);           // greedy: fills the day, stays chunky
      entries.push({
        personId, date, otlProjectCode: item.otlProjectCode,
        blocks: place, source: 'CALC',
      });
      dayRemaining.set(date, left - place);
      want -= place;
      capexBudget -= place;

      const key = keyOf(item.month, item.otlProjectCode);
      consumed.set(key, (consumed.get(key) ?? 0) + place);
    }
  }

  // 4. Everything still open becomes default OPEX.
  for (const date of dates) {
    const left = dayRemaining.get(date) ?? 0;
    if (left > 0) {
      entries.push({
        personId, date, otlProjectCode: defaultOpexCode,
        blocks: left, source: 'CALC',
      });
      dayRemaining.set(date, 0);
    }
  }

  // 5. The floor holds by construction unless overrides broke it. Say so.
  const opexPlaced = entries
    .filter((e) => e.otlProjectCode === defaultOpexCode)
    .reduce((s, e) => s + e.blocks, 0);
  if (capacity > 0 && opexPlaced < floor) {
    violations.push({
      personId, scope: dates[0], kind: 'OPEX_FLOOR_BREACHED',
      message: `Overrides leave ${opexPlaced / 2}h on the default OPEX code; ` +
               `the week needs ${floor / 2}h.`,
    });
  }

  entries.sort((a, b) =>
    a.date.localeCompare(b.date) || a.otlProjectCode.localeCompare(b.otlProjectCode));
  return { entries, consumed, violations };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/domain/optimizer.test.ts`
Expected: PASS, 13 tests

- [ ] **Step 5: Commit**

```bash
git add src/domain/optimizer.ts src/domain/optimizer.test.ts
git commit -m "feat: week optimizer honouring floor, leave and overrides"
```

---

## Task 8: Full schedule orchestration and leftovers

Runs every person across every week, cascades unabsorbed and unassigned hours to the manager, and carries the rest forward.

**Files:**
- Create: `src/domain/schedule.ts`
- Test: `src/domain/schedule.test.ts`

**Interfaces:**
- Consumes: `scheduleWeek` from `./optimizer`; `assignmentBlocks`, `pacedDemand`, `keyOf` from `./demand`; `leaveDatesFor` from `./capacity`; `weeksTouchingMonth`, `weekDays`, `monthOf` from `./calendar`
- Produces: `scheduleAll(model: Model, months: IsoMonth[]): ScheduleResult`

- [ ] **Step 1: Write the failing test**

```ts
// src/domain/schedule.test.ts
import { describe, it, expect } from 'vitest';
import { scheduleAll } from './schedule';
import type { Model, Otl } from './types';

const opex: Otl = {
  projectCode: 'OPEX-ADMIN', taskCode: 'T0', expenditureTypeCode: 'E0',
  timeReportingCode: 'R0', category: 'OPEX', leaveSubtype: null,
  isDefaultOpex: true, colorIndex: 0, active: true,
};
const capex = (code: string, colorIndex: number): Otl => ({
  projectCode: code, taskCode: 'T1', expenditureTypeCode: 'E1',
  timeReportingCode: 'R1', category: 'CAPEX', leaveSubtype: null,
  isDefaultOpex: false, colorIndex, active: true,
});

const model = (over: Partial<Model> = {}): Model => ({
  otls: [opex, capex('P-1001', 1)],
  people: [
    { id: 'mgr', name: 'Manager', role: 'MANAGER', managerId: null },
    { id: 'p1', name: 'Alex', role: 'REPORT', managerId: 'mgr' },
  ],
  statHolidays: [], allocations: [], leave: [], overrides: [],
  ...over,
});

function hoursOn(r: ReturnType<typeof scheduleAll>, personId: string, otl: string): number {
  return r.entries.filter((e) => e.personId === personId && e.otlProjectCode === otl)
    .reduce((s, e) => s + e.blocks, 0) / 2;
}

describe('scheduleAll', () => {
  it('schedules every person for every day of every week touching the month', () => {
    const r = scheduleAll(model(), ['2026-09']);
    const alexDates = new Set(r.entries.filter((e) => e.personId === 'p1').map((e) => e.date));
    expect(alexDates.has('2026-08-31')).toBe(true); // week 1 starts in August
    expect(alexDates.has('2026-10-02')).toBe(true); // last week runs into October
  });

  it('places an allocation that comfortably fits', () => {
    const r = scheduleAll(model({
      allocations: [{ month: '2026-09', otlProjectCode: 'P-1001', personId: 'p1', hours: 40 }],
    }), ['2026-09']);
    expect(hoursOn(r, 'p1', 'P-1001')).toBe(40);
    expect(r.residuals).toEqual([]);
  });

  it('cascades hours a report cannot absorb to the manager', () => {
    // September 2026 has 22 workdays; Alex's CAPEX ceiling is well under 200h.
    const r = scheduleAll(model({
      allocations: [{ month: '2026-09', otlProjectCode: 'P-1001', personId: 'p1', hours: 200 }],
    }), ['2026-09']);
    expect(hoursOn(r, 'mgr', 'P-1001')).toBeGreaterThan(0);
  });

  it('cascades unassigned OTL budget to the manager', () => {
    const r = scheduleAll(model({
      allocations: [
        { month: '2026-09', otlProjectCode: 'P-1001', personId: null, hours: 100 },
        { month: '2026-09', otlProjectCode: 'P-1001', personId: 'p1', hours: 20 },
      ],
    }), ['2026-09']);
    expect(hoursOn(r, 'p1', 'P-1001')).toBe(20);
    expect(hoursOn(r, 'mgr', 'P-1001')).toBeGreaterThan(0);
  });

  it('reports a residual rather than dropping hours nobody can take', () => {
    const r = scheduleAll(model({
      allocations: [{ month: '2026-09', otlProjectCode: 'P-1001', personId: null, hours: 5000 }],
    }), ['2026-09']);
    const total = r.residuals.reduce((s, x) => s + x.blocks, 0);
    expect(total).toBeGreaterThan(0);
    expect(r.residuals[0].reason).toBe('UNASSIGNED');
  });

  it('gives everyone the stat holiday', () => {
    const r = scheduleAll(model({
      otls: [opex, capex('P-1001', 1), {
        projectCode: 'STAT-01', taskCode: 'T9', expenditureTypeCode: 'E9',
        timeReportingCode: 'R9', category: 'LEAVE', leaveSubtype: 'STAT',
        isDefaultOpex: false, colorIndex: 0, active: true,
      }],
      statHolidays: [{ date: '2026-09-07', name: 'Labour Day', otlProjectCode: 'STAT-01' }],
    }), ['2026-09']);
    expect(hoursOn(r, 'p1', 'STAT-01')).toBe(7.5);
    expect(hoursOn(r, 'mgr', 'STAT-01')).toBe(7.5);
  });

  it('is deterministic across runs', () => {
    const m = model({
      allocations: [
        { month: '2026-09', otlProjectCode: 'P-1001', personId: 'p1', hours: 37 },
      ],
    });
    expect(JSON.stringify(scheduleAll(m, ['2026-09'])))
      .toBe(JSON.stringify(scheduleAll(m, ['2026-09'])));
  });

  it('never double-books a day across overlapping month views', () => {
    const r = scheduleAll(model({
      allocations: [{ month: '2026-09', otlProjectCode: 'P-1001', personId: 'p1', hours: 40 }],
    }), ['2026-09', '2026-10']);
    const byDay = new Map<string, number>();
    for (const e of r.entries.filter((x) => x.personId === 'p1')) {
      byDay.set(e.date, (byDay.get(e.date) ?? 0) + e.blocks);
    }
    for (const [, blocks] of byDay) expect(blocks).toBe(15);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/domain/schedule.test.ts`
Expected: FAIL — cannot resolve `./schedule`

- [ ] **Step 3: Implement**

```ts
// src/domain/schedule.ts
import { hoursToBlocks } from './blocks';
import { monthOf, weekDays, weeksTouchingMonth } from './calendar';
import { leaveDatesFor } from './capacity';
import { assignmentBlocks, keyOf, pacedDemand, type DemandItem } from './demand';
import { scheduleWeek } from './optimizer';
import type {
  Blocks, IsoDate, IsoMonth, Model, PersonId, Residual, ScheduleResult,
} from './types';

/** Every Monday touching any requested month, ascending, deduplicated. */
function allWeeks(months: IsoMonth[]): IsoDate[] {
  const set = new Set<IsoDate>();
  for (const m of months) for (const w of weeksTouchingMonth(m)) set.add(w);
  return [...set].sort();
}

function workdayCountsByMonth(dates: IsoDate[]): Map<IsoMonth, number> {
  const out = new Map<IsoMonth, number>();
  for (const d of dates) out.set(monthOf(d), (out.get(monthOf(d)) ?? 0) + 1);
  return out;
}

/** Schedules one person across the weeks, returning entries and what was left over. */
function schedulePerson(
  personId: PersonId,
  weeks: IsoDate[],
  remaining: Map<string, Blocks>,
  model: Model,
) {
  const defaultOpex = model.otls.find((o) => o.isDefaultOpex);
  if (!defaultOpex) throw new Error('No OTL is flagged as the default OPEX code.');
  const capexCodes = new Set(
    model.otls.filter((o) => o.category === 'CAPEX').map((o) => o.projectCode));

  const entries = [];
  const violations = [];

  // Remaining workdays per month, so pacing knows how much runway is left.
  const runway = workdayCountsByMonth(weeks.flatMap(weekDays));

  for (const monday of weeks) {
    const dates = weekDays(monday);
    const leaveDates = leaveDatesFor(personId, dates, model);
    const workDates = dates.filter((d) => !leaveDates.has(d));
    const weekCounts = workdayCountsByMonth(workDates);

    const demand: DemandItem[] = pacedDemand(remaining, dates, runway, weekCounts);

    const out = scheduleWeek({
      personId, dates, leaveDates,
      overrides: model.overrides.filter(
        (o) => o.personId === personId && dates.includes(o.date)),
      demand, defaultOpexCode: defaultOpex.projectCode, capexCodes,
    });

    entries.push(...out.entries);
    violations.push(...out.violations);

    for (const [key, blocks] of out.consumed) {
      remaining.set(key, Math.max(0, (remaining.get(key) ?? 0) - blocks));
    }
    for (const [month, count] of weekCounts) {
      runway.set(month, Math.max(0, (runway.get(month) ?? 0) - count));
    }
  }

  return { entries, violations };
}

export function scheduleAll(model: Model, months: IsoMonth[]): ScheduleResult {
  const weeks = allWeeks(months);
  const manager = model.people.find((p) => p.role === 'MANAGER');
  const reports = model.people
    .filter((p) => p.role === 'REPORT')
    .sort((a, b) => a.id.localeCompare(b.id));   // stable ordering

  const entries = [];
  const violations = [];
  const residuals: Residual[] = [];

  // 1. Reports first — they have first claim on their own assignments.
  const unabsorbed = new Map<string, Blocks>();
  for (const person of reports) {
    const remaining = assignmentBlocks(person.id, model);
    const result = schedulePerson(person.id, weeks, remaining, model);
    entries.push(...result.entries);
    violations.push(...result.violations);

    for (const [key, blocks] of remaining) {
      if (blocks > 0) unabsorbed.set(key, (unabsorbed.get(key) ?? 0) + blocks);
    }
  }

  // 2. Unassigned budget: an OTL's monthly total minus what was handed out.
  const totals = new Map<string, Blocks>();
  const handedOut = new Map<string, Blocks>();
  for (const a of model.allocations) {
    const key = keyOf(a.month, a.otlProjectCode);
    const blocks = hoursToBlocks(a.hours).blocks;
    if (a.personId === null) totals.set(key, (totals.get(key) ?? 0) + blocks);
    else handedOut.set(key, (handedOut.get(key) ?? 0) + blocks);
  }
  const unassigned = new Map<string, Blocks>();
  for (const [key, total] of totals) {
    const gap = total - (handedOut.get(key) ?? 0);
    if (gap > 0) unassigned.set(key, gap);
  }

  // 3. The manager takes their own assignments, then the leftovers.
  if (manager) {
    const remaining = assignmentBlocks(manager.id, model);
    for (const source of [unabsorbed, unassigned]) {
      for (const [key, blocks] of source) {
        remaining.set(key, (remaining.get(key) ?? 0) + blocks);
      }
    }
    const result = schedulePerson(manager.id, weeks, remaining, model);
    entries.push(...result.entries);
    violations.push(...result.violations);

    // 4. Whatever the manager could not take carries forward.
    for (const [key, blocks] of remaining) {
      if (blocks <= 0) continue;
      const [month, otlProjectCode] = key.split('|');
      residuals.push({
        personId: null, otlProjectCode, month, blocks,
        reason: unassigned.has(key) ? 'UNASSIGNED' : 'UNABSORBED',
      });
    }
  }

  entries.sort((a, b) =>
    a.personId.localeCompare(b.personId) ||
    a.date.localeCompare(b.date) ||
    a.otlProjectCode.localeCompare(b.otlProjectCode));
  residuals.sort((a, b) =>
    a.month.localeCompare(b.month) || a.otlProjectCode.localeCompare(b.otlProjectCode));

  return { entries, residuals, violations };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/domain/schedule.test.ts`
Expected: PASS, 8 tests

- [ ] **Step 5: Commit**

```bash
git add src/domain/schedule.ts src/domain/schedule.test.ts
git commit -m "feat: full schedule orchestration with manager cascade and carry-forward"
```

---

## Task 9: Invariants and property tests

Proves the spec §4 guarantees hold across generated inputs, not just the cases someone thought to write.

**Files:**
- Create: `src/domain/invariants.ts`
- Test: `src/domain/invariants.test.ts`

**Interfaces:**
- Consumes: `ScheduleResult`, `Model` from `./types`
- Produces: `checkInvariants(model: Model, result: ScheduleResult, months: IsoMonth[]): Violation[]`

- [ ] **Step 1: Install the property testing library**

```bash
npm install -D fast-check
```

- [ ] **Step 2: Write the failing test**

```ts
// src/domain/invariants.test.ts
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { checkInvariants } from './invariants';
import { scheduleAll } from './schedule';
import type { Model, Otl } from './types';

const opex: Otl = {
  projectCode: 'OPEX-ADMIN', taskCode: 'T0', expenditureTypeCode: 'E0',
  timeReportingCode: 'R0', category: 'OPEX', leaveSubtype: null,
  isDefaultOpex: true, colorIndex: 0, active: true,
};
const capexOtl = (code: string): Otl => ({
  projectCode: code, taskCode: 'T1', expenditureTypeCode: 'E1',
  timeReportingCode: 'R1', category: 'CAPEX', leaveSubtype: null,
  isDefaultOpex: false, colorIndex: 1, active: true,
});

describe('checkInvariants', () => {
  it('passes a clean schedule', () => {
    const model: Model = {
      otls: [opex, capexOtl('P-1001')],
      people: [
        { id: 'mgr', name: 'M', role: 'MANAGER', managerId: null },
        { id: 'p1', name: 'A', role: 'REPORT', managerId: 'mgr' },
      ],
      statHolidays: [], leave: [], overrides: [],
      allocations: [{ month: '2026-09', otlProjectCode: 'P-1001', personId: 'p1', hours: 40 }],
    };
    const result = scheduleAll(model, ['2026-09']);
    expect(checkInvariants(model, result, ['2026-09'])).toEqual([]);
  });

  it('holds for arbitrary allocations', () => {
    fc.assert(fc.property(
      fc.array(fc.record({
        person: fc.constantFrom('p1', 'p2'),
        otl: fc.constantFrom('P-1001', 'P-1002'),
        halves: fc.integer({ min: 0, max: 400 }),
      }), { maxLength: 8 }),
      (rows) => {
        const model: Model = {
          otls: [opex, capexOtl('P-1001'), capexOtl('P-1002')],
          people: [
            { id: 'mgr', name: 'M', role: 'MANAGER', managerId: null },
            { id: 'p1', name: 'A', role: 'REPORT', managerId: 'mgr' },
            { id: 'p2', name: 'B', role: 'REPORT', managerId: 'mgr' },
          ],
          statHolidays: [], leave: [], overrides: [],
          allocations: rows.map((r) => ({
            month: '2026-09', otlProjectCode: r.otl,
            personId: r.person, hours: r.halves * 0.5,
          })),
        };
        const result = scheduleAll(model, ['2026-09']);
        expect(checkInvariants(model, result, ['2026-09'])).toEqual([]);
      },
    ), { numRuns: 200 });
  });

  it('holds when leave shrinks the week', () => {
    fc.assert(fc.property(
      fc.integer({ min: 0, max: 5 }),
      (leaveDays) => {
        const model: Model = {
          otls: [opex, capexOtl('P-1001'), {
            projectCode: 'VAC-01', taskCode: 'T9', expenditureTypeCode: 'E9',
            timeReportingCode: 'R9', category: 'LEAVE', leaveSubtype: 'VACATION',
            isDefaultOpex: false, colorIndex: 0, active: true,
          }],
          people: [
            { id: 'mgr', name: 'M', role: 'MANAGER', managerId: null },
            { id: 'p1', name: 'A', role: 'REPORT', managerId: 'mgr' },
          ],
          statHolidays: [], overrides: [],
          leave: leaveDays === 0 ? [] : [{
            personId: 'p1', startDate: '2026-09-07',
            endDate: `2026-09-${String(6 + leaveDays).padStart(2, '0')}`,
            otlProjectCode: 'VAC-01',
          }],
          allocations: [{
            month: '2026-09', otlProjectCode: 'P-1001', personId: 'p1', hours: 60,
          }],
        };
        const result = scheduleAll(model, ['2026-09']);
        expect(checkInvariants(model, result, ['2026-09'])).toEqual([]);
      },
    ), { numRuns: 50 });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/domain/invariants.test.ts`
Expected: FAIL — cannot resolve `./invariants`

- [ ] **Step 4: Implement**

```ts
// src/domain/invariants.ts
import { monthOf, weekDays, weeksTouchingMonth } from './calendar';
import { leaveDatesFor, opexFloor } from './capacity';
import {
  BLOCKS_PER_DAY,
  type IsoMonth, type Model, type ScheduleResult, type Violation,
} from './types';

/**
 * Checks the guarantees the optimizer claims to make. Violations caused
 * by user overrides are reported by the optimizer itself and excluded
 * here, so this only ever fires on a genuine scheduling bug.
 */
export function checkInvariants(
  model: Model, result: ScheduleResult, months: IsoMonth[],
): Violation[] {
  const problems: Violation[] = [];
  const defaultOpex = model.otls.find((o) => o.isDefaultOpex)?.projectCode;
  const hasOverrides = model.overrides.length > 0;

  // Every entry is a positive integer number of blocks.
  for (const e of result.entries) {
    if (!Number.isInteger(e.blocks) || e.blocks <= 0) {
      problems.push({
        personId: e.personId, scope: e.date, kind: 'NEGATIVE',
        message: `${e.otlProjectCode} on ${e.date} is ${e.blocks} blocks.`,
      });
    }
  }

  const mondays = new Set(months.flatMap((m) => weeksTouchingMonth(m)));

  for (const person of model.people) {
    for (const monday of [...mondays].sort()) {
      const dates = weekDays(monday);
      const leaveDates = leaveDatesFor(person.id, dates, model);
      const mine = result.entries.filter(
        (e) => e.personId === person.id && dates.includes(e.date));

      // Each working day totals exactly 7.5h.
      for (const date of dates) {
        const total = mine.filter((e) => e.date === date)
          .reduce((s, e) => s + e.blocks, 0);
        if (total !== BLOCKS_PER_DAY) {
          problems.push({
            personId: person.id, scope: date, kind: 'DAY_NOT_FULL',
            message: `${date} totals ${total / 2}h, expected 7.5h.`,
          });
        }
      }

      // A leave day holds exactly one entry.
      for (const [date] of leaveDates) {
        const onDay = mine.filter((e) => e.date === date);
        if (onDay.length !== 1 || onDay[0].source !== 'LEAVE') {
          problems.push({
            personId: person.id, scope: date, kind: 'DAY_NOT_FULL',
            message: `${date} is leave but holds ${onDay.length} entries.`,
          });
        }
      }

      // The OPEX floor holds, unless the user's own overrides broke it.
      if (!hasOverrides && defaultOpex) {
        const capacity = dates.filter((d) => !leaveDates.has(d)).length * BLOCKS_PER_DAY;
        const opexBlocks = mine.filter((e) => e.otlProjectCode === defaultOpex)
          .reduce((s, e) => s + e.blocks, 0);
        if (capacity > 0 && opexBlocks < opexFloor(capacity)) {
          problems.push({
            personId: person.id, scope: monday, kind: 'OPEX_FLOOR_BREACHED',
            message: `Week of ${monday}: ${opexBlocks / 2}h OPEX, ` +
                     `floor is ${opexFloor(capacity) / 2}h.`,
          });
        }
      }
    }
  }
  return problems;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/domain/invariants.test.ts`
Expected: PASS, 3 tests (the property tests run 250 generated cases)

If a property test fails, fast-check prints the minimal failing input. **That is a real optimizer bug** — fix `optimizer.ts` or `schedule.ts`, never weaken the invariant.

- [ ] **Step 6: Run the whole domain suite with coverage**

Run: `npx vitest run --coverage src/domain`
Expected: PASS, `src/domain/` above 95% lines

- [ ] **Step 7: Commit**

```bash
git add src/domain/invariants.ts src/domain/invariants.test.ts package.json package-lock.json
git commit -m "test: property-based invariant checks for the optimizer"
```

---

## Task 10: Input hash for staleness

**Files:**
- Create: `src/domain/hash.ts`
- Test: `src/domain/hash.test.ts`

**Interfaces:**
- Produces: `hashModel(model: Model): string`

- [ ] **Step 1: Write the failing test**

```ts
// src/domain/hash.test.ts
import { describe, it, expect } from 'vitest';
import { hashModel } from './hash';
import type { Model } from './types';

const base: Model = {
  otls: [], people: [], statHolidays: [],
  allocations: [{ month: '2026-09', otlProjectCode: 'P-1001', personId: 'p1', hours: 40 }],
  leave: [], overrides: [],
};

describe('hashModel', () => {
  it('is stable for identical input', () => {
    expect(hashModel(base)).toBe(hashModel({ ...base }));
  });

  it('ignores array ordering', () => {
    const a: Model = { ...base, people: [
      { id: 'p1', name: 'A', role: 'REPORT', managerId: 'm' },
      { id: 'p2', name: 'B', role: 'REPORT', managerId: 'm' },
    ] };
    const b: Model = { ...base, people: [...a.people].reverse() };
    expect(hashModel(a)).toBe(hashModel(b));
  });

  it('changes when an allocation changes', () => {
    const changed: Model = {
      ...base,
      allocations: [{ month: '2026-09', otlProjectCode: 'P-1001', personId: 'p1', hours: 40.5 }],
    };
    expect(hashModel(changed)).not.toBe(hashModel(base));
  });

  it('changes when an override is added', () => {
    const changed: Model = {
      ...base,
      overrides: [{ personId: 'p1', date: '2026-09-01', otlProjectCode: 'P-1001', hours: 4 }],
    };
    expect(hashModel(changed)).not.toBe(hashModel(base));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/domain/hash.test.ts`
Expected: FAIL — cannot resolve `./hash`

- [ ] **Step 3: Implement**

```ts
// src/domain/hash.ts
import type { Model } from './types';

/** Order-insensitive: sorting means reordering a table is not a change. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).sort().join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}:${canonical(v)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** FNV-1a. Not cryptographic — this only needs to detect edits. */
export function hashModel(model: Model): string {
  const text = canonical({
    otls: model.otls, people: model.people, statHolidays: model.statHolidays,
    allocations: model.allocations, leave: model.leave, overrides: model.overrides,
  });
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/domain/hash.test.ts`
Expected: PASS, 4 tests

- [ ] **Step 5: Commit**

```bash
git add src/domain/hash.ts src/domain/hash.test.ts
git commit -m "feat: stable model hash for staleness detection"
```

**Phase 2 gate:** `npx vitest run --coverage src/domain` — everything green, `src/domain/` above 95%. The optimizer is now a complete, proven library with no UI.

---

# Phase 3 — Storage

## Task 11: Serialization

**Files:**
- Create: `src/storage/serialize.ts`
- Test: `src/storage/serialize.test.ts`

**Interfaces:**
- Produces:
  `type TabName = 'OTLs'|'People'|'StatHolidays'|'Allocations'|'Leave'|'Overrides'|'Schedule'|'Meta'`,
  `type SheetPayload = Record<TabName, string[][]>`,
  `modelToRows(model: Model): SheetPayload`,
  `rowsToModel(payload: Partial<SheetPayload>): { model: Model; problems: string[] }`

- [ ] **Step 1: Write the failing test**

```ts
// src/storage/serialize.test.ts
import { describe, it, expect } from 'vitest';
import { modelToRows, rowsToModel } from './serialize';
import type { Model } from '../domain/types';

const model: Model = {
  otls: [{
    projectCode: 'P-1001', taskCode: 'T1', expenditureTypeCode: 'E1',
    timeReportingCode: 'R1', category: 'CAPEX', leaveSubtype: null,
    isDefaultOpex: false, colorIndex: 1, active: true,
  }],
  people: [{ id: 'p1', name: 'Alex', role: 'REPORT', managerId: 'mgr' }],
  statHolidays: [{ date: '2026-09-07', name: 'Labour Day', otlProjectCode: 'STAT-01' }],
  allocations: [
    { month: '2026-09', otlProjectCode: 'P-1001', personId: 'p1', hours: 60 },
    { month: '2026-09', otlProjectCode: 'P-1001', personId: null, hours: 300 },
  ],
  leave: [{
    personId: 'p1', startDate: '2026-09-14', endDate: '2026-09-18',
    otlProjectCode: 'VAC-01',
  }],
  overrides: [{ personId: 'p1', date: '2026-09-01', otlProjectCode: 'P-1001', hours: 4 }],
};

describe('serialize', () => {
  it('round-trips a model without loss', () => {
    const { model: back, problems } = rowsToModel(modelToRows(model));
    expect(problems).toEqual([]);
    expect(back).toEqual(model);
  });

  it('writes a header row on every tab', () => {
    const rows = modelToRows(model);
    expect(rows.OTLs[0][0]).toBe('projectCode');
    expect(rows.Allocations[0]).toContain('personId');
  });

  it('preserves a null personId as an empty cell, not the string "null"', () => {
    const rows = modelToRows(model);
    const totalRow = rows.Allocations.slice(1).find((r) => r[2] === '');
    expect(totalRow?.[3]).toBe('300');
  });

  it('reports a malformed row instead of throwing', () => {
    const { problems } = rowsToModel({
      OTLs: [['projectCode', 'taskCode'], ['P-1', 'T1']],
    });
    expect(problems.length).toBeGreaterThan(0);
  });

  it('returns an empty model for empty input', () => {
    const { model: empty } = rowsToModel({});
    expect(empty.otls).toEqual([]);
    expect(empty.people).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/storage/serialize.test.ts`
Expected: FAIL — cannot resolve `./serialize`

- [ ] **Step 3: Implement**

Write `src/storage/serialize.ts` exporting the interfaces above. Requirements:

- One `COLUMNS` constant per tab listing field names in order; the header row is written from it and validated on read.
- Booleans serialize as `TRUE`/`FALSE`; `null` serializes as `''`; numbers via `String(n)`.
- On read, a row whose length does not match its header pushes a descriptive string onto `problems` and is skipped — never throws, never crashes the app on a hand-edited Sheet.
- `rowsToModel` accepts a partial payload so a missing tab yields an empty array.
- Do not serialize `Schedule` or `Meta` here; they are handled in Task 15.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/storage/serialize.test.ts`
Expected: PASS, 5 tests

- [ ] **Step 5: Commit**

```bash
git add src/storage/serialize.ts src/storage/serialize.test.ts
git commit -m "feat: model to sheet row serialization"
```

---

## Task 12: Storage adapter interface and the local-only adapter

Defines the seam both cloud backends implement. Everything above this line —
the whole domain layer and the whole UI — is backend-agnostic and never learns
which provider is in use.

**Files:**
- Create: `src/storage/adapter.ts`, `src/storage/adapters/localOnly.ts`, `src/storage/registry.ts`
- Test: `src/storage/adapters/localOnly.test.ts`, `src/storage/registry.test.ts`

**Interfaces:**
- Consumes: `SheetPayload`, `TabName` from `./serialize`
- Produces:
  ```ts
  export type BackendId = 'google' | 'microsoft' | 'local';

  export interface BackendConfig {
    backend: BackendId;
    /** Google: the Apps Script /exec URL. Microsoft: the workbook share link. */
    location: string;
    /** Google: shared secret. Microsoft: unused (auth is interactive). */
    secret?: string;
    /** Microsoft only: Entra app (client) id. */
    clientId?: string;
    /** Microsoft only: 'common' | 'consumers' | 'organizations' | a tenant id. */
    authority?: string;
  }

  export interface StorageAdapter {
    readonly id: BackendId;
    readonly label: string;
    /** Human-readable check that config is complete. Empty array = ready. */
    validate(config: BackendConfig): string[];
    /** Interactive sign-in where the backend needs it. No-op otherwise. */
    connect(config: BackendConfig): Promise<void>;
    read(config: BackendConfig): Promise<Partial<SheetPayload>>;
    write(config: BackendConfig, payload: SheetPayload): Promise<void>;
    disconnect(): Promise<void>;
  }

  export function getAdapter(id: BackendId): StorageAdapter;
  export function listAdapters(): StorageAdapter[];
  ```

- [ ] **Step 1: Write the failing test**

```ts
// src/storage/registry.test.ts
import { describe, it, expect } from 'vitest';
import { getAdapter, listAdapters } from './registry';

describe('registry', () => {
  it('offers all three backends', () => {
    expect(listAdapters().map((a) => a.id).sort())
      .toEqual(['google', 'local', 'microsoft']);
  });

  it('gives every backend a human label', () => {
    for (const adapter of listAdapters()) {
      expect(adapter.label.length).toBeGreaterThan(0);
    }
  });

  it('resolves an adapter by id', () => {
    expect(getAdapter('google').id).toBe('google');
    expect(getAdapter('microsoft').id).toBe('microsoft');
  });

  it('throws on an unknown id rather than returning undefined', () => {
    expect(() => getAdapter('dropbox' as never)).toThrow(/unknown/i);
  });

  it('exposes the identical shape for every backend', () => {
    for (const adapter of listAdapters()) {
      expect(typeof adapter.validate).toBe('function');
      expect(typeof adapter.connect).toBe('function');
      expect(typeof adapter.read).toBe('function');
      expect(typeof adapter.write).toBe('function');
      expect(typeof adapter.disconnect).toBe('function');
    }
  });
});
```

```ts
// src/storage/adapters/localOnly.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { localOnlyAdapter } from './localOnly';

const config = { backend: 'local' as const, location: '' };

beforeEach(() => { localStorage.clear(); });

describe('localOnlyAdapter', () => {
  it('needs no configuration', () => {
    expect(localOnlyAdapter.validate(config)).toEqual([]);
  });

  it('round-trips a payload', async () => {
    const payload = { OTLs: [['projectCode'], ['P-1001']] } as never;
    await localOnlyAdapter.write(config, payload);
    expect(await localOnlyAdapter.read(config)).toEqual(payload);
  });

  it('returns an empty payload before anything is written', async () => {
    expect(await localOnlyAdapter.read(config)).toEqual({});
  });

  it('survives a throwing storage accessor', async () => {
    const original = Storage.prototype.getItem;
    Storage.prototype.getItem = () => { throw new Error('blocked'); };
    await expect(localOnlyAdapter.read(config)).resolves.toEqual({});
    Storage.prototype.getItem = original;
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/storage/registry.test.ts src/storage/adapters/localOnly.test.ts`
Expected: FAIL — cannot resolve `./registry`

- [ ] **Step 3: Implement**

```ts
// src/storage/adapter.ts
import type { SheetPayload } from './serialize';

export type BackendId = 'google' | 'microsoft' | 'local';

export interface BackendConfig {
  backend: BackendId;
  location: string;
  secret?: string;
  clientId?: string;
  authority?: string;
}

export interface StorageAdapter {
  readonly id: BackendId;
  readonly label: string;
  validate(config: BackendConfig): string[];
  connect(config: BackendConfig): Promise<void>;
  read(config: BackendConfig): Promise<Partial<SheetPayload>>;
  write(config: BackendConfig, payload: SheetPayload): Promise<void>;
  disconnect(): Promise<void>;
}
```

```ts
// src/storage/adapters/localOnly.ts
import type { StorageAdapter } from '../adapter';
import type { SheetPayload } from '../serialize';

const KEY = 'timesheet-helper:payload:v1';

/** The always-available fallback. No account, no network, this browser only. */
export const localOnlyAdapter: StorageAdapter = {
  id: 'local',
  label: 'This browser only',
  validate: () => [],
  connect: async () => {},
  disconnect: async () => {},

  async read() {
    try {
      const raw = localStorage.getItem(KEY);
      return raw ? (JSON.parse(raw) as Partial<SheetPayload>) : {};
    } catch {
      return {};   // private browsing, blocked site data, corrupt JSON
    }
  },

  async write(_config, payload) {
    try {
      localStorage.setItem(KEY, JSON.stringify(payload));
    } catch {
      throw new Error('This browser refused to save. Export a backup instead.');
    }
  },
};
```

`registry.ts` maps each `BackendId` to its adapter and throws `new Error(\`Unknown storage backend: ${id}\`)` for anything else. Import the Google and Microsoft adapters from Tasks 13 and 14 — write the registry last, or stub those two imports and fill them in as each lands.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/storage/registry.test.ts src/storage/adapters/localOnly.test.ts`
Expected: PASS, 9 tests

- [ ] **Step 5: Commit**

```bash
git add src/storage/adapter.ts src/storage/registry.ts src/storage/adapters/
git commit -m "feat: pluggable storage adapter interface with local-only backend"
```

---

## Task 13: Google Sheets adapter

**Files:**
- Modify: `apps-script/Code.gs` (replace the Task 1 spike entirely)
- Modify: `apps-script/README.md`
- Create: `src/storage/adapters/google.ts`
- Test: `src/storage/adapters/google.test.ts`

**Interfaces:**
- Consumes: `StorageAdapter`, `BackendConfig` from `../adapter`
- Produces: `googleAdapter: StorageAdapter`

- [ ] **Step 1: Write the full Apps Script**

```javascript
// apps-script/Code.gs
var SECRET = 'REPLACE_WITH_YOUR_SHARED_SECRET';
var TABS = ['OTLs','People','StatHolidays','Allocations','Leave','Overrides','Schedule','Meta'];

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  if (e.parameter.secret !== SECRET) return json_({ ok: false, error: 'unauthorized' });
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var out = {};
  TABS.forEach(function (name) {
    var sheet = ss.getSheetByName(name);
    out[name] = sheet ? sheet.getDataRange().getDisplayValues() : [];
  });
  return json_({ ok: true, payload: out });
}

function doPost(e) {
  var body = JSON.parse(e.postData.contents);
  if (body.secret !== SECRET) return json_({ ok: false, error: 'unauthorized' });

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var lock = LockService.getDocumentLock();
  lock.waitLock(20000);   // two tabs must never interleave mid-write
  try {
    Object.keys(body.payload).forEach(function (name) {
      var rows = body.payload[name];
      var sheet = ss.getSheetByName(name) || ss.insertSheet(name);
      sheet.clear();
      if (rows.length) {
        sheet.getRange(1, 1, rows.length, rows[0].length).setValues(rows);
        sheet.getRange(1, 1, 1, rows[0].length).setFontWeight('bold');
        sheet.setFrozenRows(1);
      }
    });
    return json_({ ok: true });
  } finally {
    lock.releaseLock();
  }
}
```

Update `apps-script/README.md`: the human replaces `SECRET` with their own string and redeploys via **Deploy → Manage deployments → Edit → New version**. Editing the script alone does not update the live URL — this catches people out every time.

- [ ] **Step 2: Write the failing test**

```ts
// src/storage/adapters/google.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { googleAdapter } from './google';

const config = {
  backend: 'google' as const,
  location: 'https://script.google.com/macros/s/abc/exec',
  secret: 'hunter2',
};

beforeEach(() => { vi.restoreAllMocks(); });

describe('googleAdapter.validate', () => {
  it('accepts a complete config', () => {
    expect(googleAdapter.validate(config)).toEqual([]);
  });

  it('rejects a missing URL', () => {
    expect(googleAdapter.validate({ ...config, location: '' })).toHaveLength(1);
  });

  it('rejects a missing secret', () => {
    expect(googleAdapter.validate({ ...config, secret: '' })).toHaveLength(1);
  });

  it('rejects a URL that is not an Apps Script exec endpoint', () => {
    expect(googleAdapter.validate({ ...config, location: 'https://example.com' }))
      .toHaveLength(1);
  });
});

describe('googleAdapter.read', () => {
  it('returns the payload on success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ ok: true, payload: { OTLs: [['projectCode']] } }),
    }));
    expect(await googleAdapter.read(config)).toEqual({ OTLs: [['projectCode']] });
  });

  it('passes the secret as a query parameter', async () => {
    const spy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, payload: {} }) });
    vi.stubGlobal('fetch', spy);
    await googleAdapter.read(config);
    expect(spy.mock.calls[0][0]).toContain('secret=hunter2');
  });

  it('throws a readable error when the script rejects the secret', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ ok: false, error: 'unauthorized' }),
    }));
    await expect(googleAdapter.read(config)).rejects.toThrow(/unauthorized/);
  });

  it('reports a network failure without leaking the raw error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(googleAdapter.read(config)).rejects.toThrow(/could not reach/i);
  });
});

describe('googleAdapter.write', () => {
  it('posts as text/plain to avoid a CORS preflight', async () => {
    const spy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal('fetch', spy);
    await googleAdapter.write(config, { OTLs: [['projectCode']] } as never);
    expect(spy.mock.calls[0][1].method).toBe('POST');
    expect(spy.mock.calls[0][1].headers['Content-Type']).toContain('text/plain');
  });

  it('sends the secret in the body, never the URL', async () => {
    const spy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal('fetch', spy);
    await googleAdapter.write(config, { OTLs: [] } as never);
    expect(spy.mock.calls[0][0]).not.toContain('hunter2');
    expect(JSON.parse(spy.mock.calls[0][1].body).secret).toBe('hunter2');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/storage/adapters/google.test.ts`
Expected: FAIL — cannot resolve `./google`

- [ ] **Step 4: Implement**

`read` issues `GET ${location}?secret=${encodeURIComponent(secret)}`. `write` issues a POST with `Content-Type: text/plain;charset=utf-8` — `application/json` triggers a CORS preflight Apps Script does not answer — and body `JSON.stringify({ secret, payload })`. Both throw `new Error(body.error)` when `ok` is false, and wrap a rejected fetch as `new Error('Could not reach the Apps Script endpoint. Check the URL and that the deployment is set to "Anyone".')`. `validate` requires a non-empty secret and a location matching `/^https:\/\/script\.google\.com\/macros\/s\/.+\/exec$/`. `connect` and `disconnect` are no-ops — this backend has no interactive session.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/storage/adapters/google.test.ts`
Expected: PASS, 10 tests

- [ ] **Step 6: Commit**

```bash
git add apps-script/ src/storage/adapters/google.ts src/storage/adapters/google.test.ts
git commit -m "feat: google sheets storage adapter via apps script"
```

---

## Task 14: Microsoft 365 Excel adapter

Uses MSAL browser auth (PKCE, public client — no client secret, which a static site could not keep anyway) and the Graph Excel API. The user signs in with Microsoft and the app reads the workbook as them.

**Files:**
- Create: `src/storage/adapters/microsoft.ts`, `src/storage/adapters/graph.ts`
- Create: `docs/microsoft-setup.md`
- Test: `src/storage/adapters/microsoft.test.ts`, `src/storage/adapters/graph.test.ts`

**Interfaces:**
- Consumes: `StorageAdapter`, `BackendConfig` from `../adapter`
- Produces:
  `microsoftAdapter: StorageAdapter`,
  `encodeShareUrl(url: string): string`,
  `resolveWorkbookId(token: string, shareUrl: string): Promise<string>`,
  `readWorksheet(token: string, itemId: string, name: string): Promise<string[][]>`,
  `writeWorksheet(token: string, itemId: string, name: string, rows: string[][]): Promise<void>`

- [ ] **Step 1: Install MSAL**

```bash
npm install @azure/msal-browser
```

- [ ] **Step 2: Write the setup guide**

```markdown
<!-- docs/microsoft-setup.md -->
# Microsoft 365 setup

1. Go to the Microsoft Entra admin centre -> App registrations -> New registration.
   - Name: Timesheet Helper
   - Supported account types: pick to match your workbook's account.
     Personal OneDrive -> "Personal Microsoft accounts only".
     Work/school -> "Accounts in this organizational directory only".
   - Redirect URI: **Single-page application (SPA)**, set to your Pages URL,
     e.g. `https://<user>.github.io/timesheet-helper/`.
     It MUST be registered as SPA, not Web — a Web redirect URI rejects
     the PKCE flow a static page uses.
2. Copy the **Application (client) ID**. This is `clientId` in the app.
3. API permissions -> Microsoft Graph -> Delegated -> `Files.ReadWrite`,
   `User.Read`. Grant consent.
   **If this is a work or school account, an administrator may have to
   approve this before sign-in will work.** Personal accounts self-consent.
4. Create an empty `.xlsx` workbook in OneDrive or SharePoint. Copy its
   sharing link. This is `location` in the app.
5. Authority: `consumers` for a personal account, your tenant id for a
   work account, or `common` to accept both.
```

- [ ] **Step 3: Write the failing Graph test**

```ts
// src/storage/adapters/graph.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { encodeShareUrl, resolveWorkbookId, readWorksheet, writeWorksheet } from './graph';

beforeEach(() => { vi.restoreAllMocks(); });

describe('encodeShareUrl', () => {
  it('produces a base64url token prefixed with u!', () => {
    const got = encodeShareUrl('https://contoso-my.sharepoint.com/x.xlsx');
    expect(got.startsWith('u!')).toBe(true);
    expect(got).not.toContain('=');   // padding stripped
    expect(got).not.toContain('+');   // base64url, not base64
    expect(got).not.toContain('/');
  });
});

describe('resolveWorkbookId', () => {
  it('turns a share link into a drive item id', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ id: 'ITEM123' }),
    }));
    expect(await resolveWorkbookId('tok', 'https://x/y.xlsx')).toBe('ITEM123');
  });

  it('explains a 404 in terms the user can act on', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 404, text: async () => 'not found',
    }));
    await expect(resolveWorkbookId('tok', 'https://x/y.xlsx'))
      .rejects.toThrow(/could not find that workbook/i);
  });
});

describe('readWorksheet', () => {
  it('returns the used range values', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ text: [['projectCode'], ['P-1001']] }),
    }));
    expect(await readWorksheet('tok', 'ITEM123', 'OTLs'))
      .toEqual([['projectCode'], ['P-1001']]);
  });

  it('returns an empty grid when the worksheet does not exist yet', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 404, text: async () => 'ItemNotFound',
    }));
    expect(await readWorksheet('tok', 'ITEM123', 'Missing')).toEqual([]);
  });

  it('requests the worksheet by name, url-encoded', async () => {
    const spy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ text: [] }) });
    vi.stubGlobal('fetch', spy);
    await readWorksheet('tok', 'ITEM123', 'Stat Holidays');
    expect(spy.mock.calls[0][0]).toContain("worksheets('Stat%20Holidays')");
  });
});

describe('writeWorksheet', () => {
  it('clears the sheet before writing so stale rows cannot survive', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      calls.push(url);
      return Promise.resolve({ ok: true, json: async () => ({}) });
    }));
    await writeWorksheet('tok', 'ITEM123', 'OTLs', [['a'], ['b']]);
    expect(calls.some((c) => c.includes('clear'))).toBe(true);
  });

  it('addresses the range by exact dimensions', async () => {
    const bodies: string[] = [];
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (init?.body) bodies.push(String(init.body));
      return Promise.resolve({ ok: true, json: async () => ({}) });
    }));
    // 2 rows x 3 columns -> A1:C2
    await writeWorksheet('tok', 'ITEM123', 'OTLs', [['a','b','c'], ['d','e','f']]);
    expect(bodies.some((b) => b.includes('"values"'))).toBe(true);
  });

  it('does nothing but clear when given no rows', async () => {
    const spy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal('fetch', spy);
    await writeWorksheet('tok', 'ITEM123', 'OTLs', []);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npx vitest run src/storage/adapters/graph.test.ts`
Expected: FAIL — cannot resolve `./graph`

- [ ] **Step 5: Implement the Graph layer**

```ts
// src/storage/adapters/graph.ts
const GRAPH = 'https://graph.microsoft.com/v1.0';

/** Graph addresses a shared file by a base64url token of its sharing URL. */
export function encodeShareUrl(url: string): string {
  const b64 = btoa(url);
  return 'u!' + b64.replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function call(
  token: string, path: string, init: RequestInit = {},
): Promise<Response> {
  return fetch(`${GRAPH}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
}

export async function resolveWorkbookId(token: string, shareUrl: string): Promise<string> {
  const res = await call(token, `/shares/${encodeShareUrl(shareUrl)}/driveItem`);
  if (!res.ok) {
    throw new Error(
      'Could not find that workbook. Check the sharing link, and that the ' +
      'signed-in account has access to it.');
  }
  return (await res.json()).id as string;
}

/** Used-range values as display text. An absent worksheet reads as empty. */
export async function readWorksheet(
  token: string, itemId: string, name: string,
): Promise<string[][]> {
  const sheet = encodeURIComponent(name);
  const res = await call(token,
    `/me/drive/items/${itemId}/workbook/worksheets('${sheet}')/usedRange(valuesOnly=true)`);
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`Could not read the "${name}" sheet.`);
  const body = await res.json();
  return (body.text ?? body.values ?? []) as string[][];
}

function columnName(n: number): string {
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

export async function writeWorksheet(
  token: string, itemId: string, name: string, rows: string[][],
): Promise<void> {
  const sheet = encodeURIComponent(name);
  const base = `/me/drive/items/${itemId}/workbook/worksheets('${sheet}')`;

  // Create on demand — a fresh workbook has none of our sheets.
  const clear = await call(token, `${base}/usedRange/clear`, {
    method: 'POST', body: JSON.stringify({ applyTo: 'contents' }),
  });
  if (clear.status === 404) {
    await call(token, `/me/drive/items/${itemId}/workbook/worksheets`, {
      method: 'POST', body: JSON.stringify({ name }),
    });
  }
  if (rows.length === 0) return;

  const address = `A1:${columnName(rows[0].length)}${rows.length}`;
  const res = await call(token, `${base}/range(address='${address}')`, {
    method: 'PATCH', body: JSON.stringify({ values: rows }),
  });
  if (!res.ok) throw new Error(`Could not write the "${name}" sheet.`);
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run src/storage/adapters/graph.test.ts`
Expected: PASS, 9 tests

- [ ] **Step 7: Write the failing adapter test**

```ts
// src/storage/adapters/microsoft.test.ts
import { describe, it, expect } from 'vitest';
import { microsoftAdapter } from './microsoft';

const config = {
  backend: 'microsoft' as const,
  location: 'https://contoso-my.sharepoint.com/personal/x/Doc.aspx?sourcedoc=1',
  clientId: '11111111-2222-3333-4444-555555555555',
  authority: 'consumers',
};

describe('microsoftAdapter.validate', () => {
  it('accepts a complete config', () => {
    expect(microsoftAdapter.validate(config)).toEqual([]);
  });

  it('requires a client id', () => {
    expect(microsoftAdapter.validate({ ...config, clientId: '' })).toHaveLength(1);
  });

  it('rejects a client id that is not a GUID', () => {
    expect(microsoftAdapter.validate({ ...config, clientId: 'not-a-guid' }))
      .toHaveLength(1);
  });

  it('requires a workbook link', () => {
    expect(microsoftAdapter.validate({ ...config, location: '' })).toHaveLength(1);
  });

  it('defaults the authority when it is absent', () => {
    expect(microsoftAdapter.validate({ ...config, authority: undefined })).toEqual([]);
  });

  it('never asks for a shared secret', () => {
    const problems = microsoftAdapter.validate({ ...config, secret: undefined });
    expect(problems.join(' ')).not.toMatch(/secret/i);
  });
});
```

- [ ] **Step 8: Run test to verify it fails**

Run: `npx vitest run src/storage/adapters/microsoft.test.ts`
Expected: FAIL — cannot resolve `./microsoft`

- [ ] **Step 9: Implement the adapter**

Hold a lazily-constructed `PublicClientApplication` keyed on `clientId` + `authority`. `connect` calls `initialize()`, then `acquireTokenSilent` falling back to `loginPopup` with scopes `['Files.ReadWrite', 'User.Read']`. Cache the resolved workbook item id per `location` so `read` and `write` do not re-resolve the share link on every call. `read` maps over the eight tab names via `readWorksheet`; `write` iterates `writeWorksheet`. `disconnect` calls `logoutPopup` and clears the cached id. `validate` requires a GUID `clientId` and a non-empty `location`, defaulting `authority` to `common`. Surface a consent failure as: *"Microsoft refused the sign-in. If this is a work or school account, an administrator may need to approve the app first."*

`msalConfig.auth.redirectUri` must be `window.location.origin + import.meta.env.BASE_URL` so it matches the registered SPA URI on Pages.

- [ ] **Step 10: Run test to verify it passes**

Run: `npx vitest run src/storage/adapters/microsoft.test.ts`
Expected: PASS, 6 tests

- [ ] **Step 11: Wire the registry and commit**

Fill in the real imports in `registry.ts`, then:

```bash
npx vitest run src/storage
git add src/storage/ docs/microsoft-setup.md package.json package-lock.json
git commit -m "feat: microsoft 365 excel storage adapter via msal and graph"
```

---

## Task 15: Store, sync and the connection settings UI

**Files:**
- Create: `src/storage/localCache.ts`, `src/storage/store.ts`, `src/ui/components/ConnectionSettings.tsx`
- Test: `src/storage/localCache.test.ts`, `src/ui/components/ConnectionSettings.test.tsx`

**Interfaces:**
- Consumes: `getAdapter`, `listAdapters` from `../storage/registry`; `modelToRows`, `rowsToModel` from `./serialize`; `hashModel` from `../domain/hash`; `scheduleAll` from `../domain/schedule`
- Produces:
  `loadCache(): { model: Model; hash: string; config: BackendConfig } | null`,
  `saveCache(model: Model, hash: string, config: BackendConfig): void`,
  `useStore()` exposing `{ model, result, config, isStale, status, update, recalculate, connect, disconnect }`

- [ ] **Step 1: Write the failing settings test**

```tsx
// src/ui/components/ConnectionSettings.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConnectionSettings } from './ConnectionSettings';

const google = { backend: 'google' as const, location: '', secret: '' };

describe('ConnectionSettings', () => {
  it('offers all three backends', () => {
    render(<ConnectionSettings config={google} onChange={vi.fn()} onConnect={vi.fn()} />);
    expect(screen.getByRole('option', { name: /google/i })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /microsoft/i })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /this browser/i })).toBeInTheDocument();
  });

  it('asks for a script URL and secret for Google', () => {
    render(<ConnectionSettings config={google} onChange={vi.fn()} onConnect={vi.fn()} />);
    expect(screen.getByLabelText(/script url/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/shared secret/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/client id/i)).not.toBeInTheDocument();
  });

  it('asks for a client id and workbook link for Microsoft', () => {
    render(<ConnectionSettings
      config={{ backend: 'microsoft', location: '' }}
      onChange={vi.fn()} onConnect={vi.fn()} />);
    expect(screen.getByLabelText(/client id/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/workbook link/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/shared secret/i)).not.toBeInTheDocument();
  });

  it('asks for nothing at all for local-only', () => {
    render(<ConnectionSettings
      config={{ backend: 'local', location: '' }}
      onChange={vi.fn()} onConnect={vi.fn()} />);
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('surfaces validation problems and blocks connecting', async () => {
    const onConnect = vi.fn();
    render(<ConnectionSettings config={google} onChange={vi.fn()} onConnect={onConnect} />);
    await userEvent.click(screen.getByRole('button', { name: /connect/i }));
    expect(onConnect).not.toHaveBeenCalled();
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('warns that a work account may need admin approval', async () => {
    render(<ConnectionSettings
      config={{ backend: 'microsoft', location: '' }}
      onChange={vi.fn()} onConnect={vi.fn()} />);
    expect(screen.getByText(/administrator/i)).toBeInTheDocument();
  });

  it('never renders the secret in a readable field', () => {
    render(<ConnectionSettings
      config={{ ...google, secret: 'hunter2' }}
      onChange={vi.fn()} onConnect={vi.fn()} />);
    expect(screen.getByLabelText(/shared secret/i)).toHaveAttribute('type', 'password');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/components/ConnectionSettings.test.tsx`
Expected: FAIL — cannot resolve `./ConnectionSettings`

- [ ] **Step 3: Implement**

`ConnectionSettings` is an Astryx `Dialog` with a backend `Selector` and **only the fields the chosen adapter needs** — the whole point of the adapter seam is that this form is driven by `adapter.validate`, never by a hardcoded `if (backend === 'google')` ladder in the UI. Problems from `validate` render in a `Banner` with `role="alert"` and block Connect. The Microsoft branch shows the admin-consent caveat inline and links `docs/microsoft-setup.md`; the Google branch links `apps-script/README.md`.

`localCache.ts` — key `timesheet-helper:v1`, storing `{ model, hash, config }`. The **secret and clientId are stored here and never compiled into the bundle**; GitHub Pages serves the JavaScript publicly. Every read is wrapped in try/catch returning `null`.

`store.ts` — `useStore()` holds `model`, `result`, `config`, `lastCalculatedHash`, and `status: 'idle' | 'syncing' | 'offline' | 'error'`. `isStale = hashModel(model) !== lastCalculatedHash`. `update(fn)` applies an **immutable** change, writes the cache, and pushes to the active adapter debounced at 2s. `recalculate()` runs `scheduleAll`, stores the new hash, and writes the `Schedule` tab. On mount: read through the configured adapter, fall back to the cache with a non-blocking notice on failure, and open `ConnectionSettings` when no backend is configured yet.

Switching backends must **not** lose data: on change, keep the in-memory model and offer to write it to the newly selected backend.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/storage src/ui/components/ConnectionSettings.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/storage/ src/ui/components/ConnectionSettings.tsx src/ui/components/ConnectionSettings.test.tsx
git commit -m "feat: store, sync and backend connection settings"
```

---

# Phase 4 — UI

**Before every task in this phase:** read `./DESIGN.md`. It is authoritative. Reach for the Astryx component before writing any custom CSS.

## Task 16: App shell and navigation

**Files:**
- Modify: `src/ui/App.tsx`
- Create: `src/ui/format.ts`, `src/ui/components/StaleBanner.tsx`
- Test: `src/ui/components/StaleBanner.test.tsx`

**Interfaces:**
- Produces: `formatHoursCell(hours: number): string` (em-dash for zero), `<StaleBanner isStale onRecalculate />`

- [ ] **Step 1: Write the failing test**

```tsx
// src/ui/components/StaleBanner.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StaleBanner } from './StaleBanner';

describe('StaleBanner', () => {
  it('renders nothing when the schedule is current', () => {
    const { container } = render(<StaleBanner isStale={false} reason="" onRecalculate={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('names what went stale', () => {
    render(<StaleBanner isStale reason="Allocations changed for September" onRecalculate={vi.fn()} />);
    expect(screen.getByText(/Allocations changed for September/)).toBeInTheDocument();
  });

  it('calls back when recalculate is pressed', async () => {
    const onRecalculate = vi.fn();
    render(<StaleBanner isStale reason="x" onRecalculate={onRecalculate} />);
    await userEvent.click(screen.getByRole('button', { name: /recalculate/i }));
    expect(onRecalculate).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/components/StaleBanner.test.tsx`
Expected: FAIL — cannot resolve `./StaleBanner`

- [ ] **Step 3: Implement**

`format.ts`:
```ts
export function formatHoursCell(hours: number): string {
  return hours === 0 ? '—' : hours.toFixed(1);
}
```

`StaleBanner.tsx` — Astryx `Banner`, `warning` variant, returning `null` when `!isStale`. Body text is the `reason`; the action is a primary `Button` labelled "Recalculate". Per `DESIGN.md` §3, only one banner shows at a time — merge concurrent reasons into one string upstream.

`App.tsx` — a `Section` shell with `Tab`/`TabList` for Setup / Allocations / Weeks, the `StaleBanner` pinned below the header, `max-width: 1440px` centred. Wire `useStore()`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/ui/components/StaleBanner.test.tsx`
Expected: PASS, 3 tests

- [ ] **Step 5: Commit**

```bash
git add src/ui/
git commit -m "feat: app shell, nav tabs and stale banner"
```

---

## Task 17: Setup page

**Files:**
- Create: `src/ui/pages/SetupPage.tsx`, `src/ui/components/OtlTable.tsx`, `src/ui/components/PeopleTree.tsx`, `src/ui/components/StatHolidayList.tsx`
- Test: `src/ui/pages/SetupPage.test.tsx`

**Interfaces:**
- Consumes: `useStore()` from `../../storage/store`

- [ ] **Step 1: Write the failing test**

```tsx
// src/ui/pages/SetupPage.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SetupPage } from './SetupPage';
import type { Model } from '../../domain/types';

const empty: Model = {
  otls: [], people: [], statHolidays: [], allocations: [], leave: [], overrides: [],
};

describe('SetupPage', () => {
  it('adds an OTL with all five fields', async () => {
    const update = vi.fn();
    render(<SetupPage model={empty} update={update} />);
    await userEvent.click(screen.getByRole('button', { name: /add otl/i }));
    await userEvent.type(screen.getByLabelText(/project code/i), 'P-1001');
    await userEvent.type(screen.getByLabelText(/task code/i), 'T1');
    await userEvent.type(screen.getByLabelText(/expenditure type/i), 'E1');
    await userEvent.type(screen.getByLabelText(/time reporting/i), 'R1');
    await userEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(update).toHaveBeenCalled();
  });

  it('rejects a duplicate project code, since it is the primary key', async () => {
    const model: Model = { ...empty, otls: [{
      projectCode: 'P-1001', taskCode: 'T1', expenditureTypeCode: 'E1',
      timeReportingCode: 'R1', category: 'CAPEX', leaveSubtype: null,
      isDefaultOpex: false, colorIndex: 1, active: true,
    }] };
    render(<SetupPage model={model} update={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /add otl/i }));
    await userEvent.type(screen.getByLabelText(/project code/i), 'P-1001');
    expect(await screen.findByText(/already exists/i)).toBeInTheDocument();
  });

  it('requires a leave subtype when the category is Leave', async () => {
    render(<SetupPage model={empty} update={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /add otl/i }));
    await userEvent.selectOptions(screen.getByLabelText(/category/i), 'LEAVE');
    expect(screen.getByLabelText(/subtype/i)).toBeInTheDocument();
  });

  it('only offers to add a report under a manager', async () => {
    render(<SetupPage model={empty} update={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /add report/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add manager/i })).toBeInTheDocument();
  });

  it('allows only one manager', async () => {
    const model: Model = { ...empty, people: [
      { id: 'm', name: 'Manager', role: 'MANAGER', managerId: null },
    ] };
    render(<SetupPage model={model} update={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /add manager/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add report/i })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/pages/SetupPage.test.tsx`
Expected: FAIL — cannot resolve `./SetupPage`

- [ ] **Step 3: Implement**

- `OtlTable` — Astryx `Table`; columns project / task / expenditure type / TRC in `Code` style, then category `Badge`, leave subtype, default-OPEX radio (exactly one selectable across all OPEX rows), and a delete `IconButton` with `Tooltip`. Add and edit open a `Dialog` with `FormLayout`. Duplicate project codes are rejected inline. Deleting an OTL that has hours against it opens an `AlertDialog`.
- `PeopleTree` — "Add manager" only while no manager exists; then reports nest under them. Reports cannot be created standalone.
- `StatHolidayList` — `DateInput` plus a name and a `Selector` restricted to `LEAVE`/`STAT` OTLs.
- Assign `colorIndex` on creation as `(count of existing CAPEX OTLs) % 10`, and never reassign it — `DESIGN.md` §2.1 requires a code keeps its colour for life.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/ui/pages/SetupPage.test.tsx`
Expected: PASS, 5 tests

- [ ] **Step 5: Commit**

```bash
git add src/ui/pages/SetupPage.tsx src/ui/components/ src/ui/pages/SetupPage.test.tsx
git commit -m "feat: setup page for otls, people and stat holidays"
```

---

## Task 18: Allocations page

**Files:**
- Create: `src/ui/pages/AllocationsPage.tsx`, `src/ui/components/AllocationGrid.tsx`
- Test: `src/ui/pages/AllocationsPage.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// src/ui/pages/AllocationsPage.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AllocationsPage } from './AllocationsPage';
import type { Model, Otl } from '../../domain/types';

const capex: Otl = {
  projectCode: 'P-1001', taskCode: 'T1', expenditureTypeCode: 'E1',
  timeReportingCode: 'R1', category: 'CAPEX', leaveSubtype: null,
  isDefaultOpex: false, colorIndex: 1, active: true,
};
const model: Model = {
  otls: [capex],
  people: [
    { id: 'mgr', name: 'Manager', role: 'MANAGER', managerId: null },
    { id: 'p1', name: 'Alex', role: 'REPORT', managerId: 'mgr' },
  ],
  statHolidays: [], allocations: [], leave: [], overrides: [],
};

describe('AllocationsPage', () => {
  it('renders a row per person and a column per CAPEX OTL', () => {
    render(<AllocationsPage model={model} month="2026-09" update={vi.fn()} onMonthChange={vi.fn()} />);
    expect(screen.getByText('Alex')).toBeInTheDocument();
    expect(screen.getByText('P-1001')).toBeInTheDocument();
  });

  it('writes an allocation on entry', async () => {
    const update = vi.fn();
    render(<AllocationsPage model={model} month="2026-09" update={update} onMonthChange={vi.fn()} />);
    await userEvent.type(screen.getByLabelText(/Alex.*P-1001/i), '60');
    await userEvent.tab();
    expect(update).toHaveBeenCalled();
  });

  it('flags an allocation that is not a multiple of 0.5', async () => {
    render(<AllocationsPage model={model} month="2026-09" update={vi.fn()} onMonthChange={vi.fn()} />);
    await userEvent.type(screen.getByLabelText(/Alex.*P-1001/i), '96.3');
    await userEvent.tab();
    expect(await screen.findByText(/0\.3h/)).toBeInTheDocument();
  });

  it('shows unassigned budget against the OTL monthly total', () => {
    const withTotal: Model = { ...model, allocations: [
      { month: '2026-09', otlProjectCode: 'P-1001', personId: null, hours: 300 },
      { month: '2026-09', otlProjectCode: 'P-1001', personId: 'p1', hours: 240 },
    ] };
    render(<AllocationsPage model={withTotal} month="2026-09" update={vi.fn()} onMonthChange={vi.fn()} />);
    expect(screen.getByText(/60\.0h unassigned/i)).toBeInTheDocument();
  });

  it('warns when a person is allocated beyond their monthly capacity', () => {
    const over: Model = { ...model, allocations: [
      { month: '2026-09', otlProjectCode: 'P-1001', personId: 'p1', hours: 500 },
    ] };
    render(<AllocationsPage model={over} month="2026-09" update={vi.fn()} onMonthChange={vi.fn()} />);
    expect(screen.getByText(/over capacity/i)).toBeInTheDocument();
  });

  it('excludes OPEX and Leave codes from the grid', () => {
    const withOpex: Model = { ...model, otls: [capex, {
      ...capex, projectCode: 'OPEX-ADMIN', category: 'OPEX', isDefaultOpex: true,
    }] };
    render(<AllocationsPage model={withOpex} month="2026-09" update={vi.fn()} onMonthChange={vi.fn()} />);
    expect(screen.queryByText('OPEX-ADMIN')).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/pages/AllocationsPage.test.tsx`
Expected: FAIL — cannot resolve `./AllocationsPage`

- [ ] **Step 3: Implement**

`Selector` month picker; `Table` with people as rows and active CAPEX OTLs as columns; each cell an Astryx `NumberInput` with `step={0.5}` and an accessible label of `` `${person.name} ${otl.projectCode}` ``. A monthly-total row per OTL, plus a per-column footer reading `N unassigned` in `--color-warning` when positive. A per-row footer compares committed CAPEX against that person's monthly capacity — workdays in the month × 4.5h, less leave — showing "over capacity" in `--color-error`. Non-multiples of 0.5 are accepted and flagged with `Supporting` helper text naming the residual. All updates immutable.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/ui/pages/AllocationsPage.test.tsx`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add src/ui/pages/AllocationsPage.tsx src/ui/components/AllocationGrid.tsx src/ui/pages/AllocationsPage.test.tsx
git commit -m "feat: monthly allocations grid with capacity and unassigned warnings"
```

---

## Task 19: Weeks page

The main view: accordion, editable cells, overrides, leave.

**Files:**
- Create: `src/ui/pages/WeeksPage.tsx`, `src/ui/components/WeekAccordion.tsx`, `src/ui/components/WeekTable.tsx`, `src/ui/components/HourCell.tsx`, `src/ui/components/LeaveDialog.tsx`
- Test: `src/ui/components/HourCell.test.tsx`, `src/ui/pages/WeeksPage.test.tsx`

- [ ] **Step 1: Write the failing HourCell test**

```tsx
// src/ui/components/HourCell.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HourCell } from './HourCell';

const base = {
  personId: 'p1', date: '2026-09-07', otlProjectCode: 'P-1001',
  hours: 2.5, source: 'CALC' as const,
  onOverride: vi.fn(), onRevert: vi.fn(),
};

describe('HourCell', () => {
  it('shows one decimal place', () => {
    render(<HourCell {...base} />);
    expect(screen.getByText('2.5')).toBeInTheDocument();
  });

  it('shows an em-dash for zero, never 0.0', () => {
    render(<HourCell {...base} hours={0} />);
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.queryByText('0.0')).not.toBeInTheDocument();
  });

  it('marks an overridden cell as locked without needing hover', () => {
    render(<HourCell {...base} source="OVERRIDE" />);
    expect(screen.getByLabelText(/manually set/i)).toBeInTheDocument();
  });

  it('offers revert only on an overridden cell', () => {
    const { rerender } = render(<HourCell {...base} />);
    expect(screen.queryByRole('button', { name: /revert/i })).not.toBeInTheDocument();
    rerender(<HourCell {...base} source="OVERRIDE" />);
    expect(screen.getByRole('button', { name: /revert/i })).toBeInTheDocument();
  });

  it('commits an edit on Enter', async () => {
    const onOverride = vi.fn();
    render(<HourCell {...base} onOverride={onOverride} />);
    await userEvent.click(screen.getByRole('spinbutton'));
    await userEvent.clear(screen.getByRole('spinbutton'));
    await userEvent.type(screen.getByRole('spinbutton'), '4{Enter}');
    expect(onOverride).toHaveBeenCalledWith(4);
  });

  it('reverts on Escape without committing', async () => {
    const onOverride = vi.fn();
    const onRevert = vi.fn();
    render(<HourCell {...base} onOverride={onOverride} onRevert={onRevert} />);
    await userEvent.click(screen.getByRole('spinbutton'));
    await userEvent.type(screen.getByRole('spinbutton'), '9{Escape}');
    expect(onOverride).not.toHaveBeenCalled();
  });

  it('is not editable on a leave day', async () => {
    render(<HourCell {...base} source="LEAVE" hours={7.5} />);
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/components/HourCell.test.tsx`
Expected: FAIL — cannot resolve `./HourCell`

- [ ] **Step 3: Implement HourCell**

Per `DESIGN.md` §3: plain text at rest; `NumberInput` with `step={0.5}` on focus; a 3px `--color-accent` left border plus a lock icon and `Tooltip` reading "Manually set — recalculation will preserve this" when `source === 'OVERRIDE'`; em-dash in `--color-text-disabled` for zero; non-editable on `LEAVE`. Enter commits, Escape reverts, Tab moves across the person's days.

- [ ] **Step 4: Write the failing WeeksPage test**

```tsx
// src/ui/pages/WeeksPage.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WeeksPage } from './WeeksPage';
import type { Model, Otl } from '../../domain/types';

const opex: Otl = {
  projectCode: 'OPEX-ADMIN', taskCode: 'T0', expenditureTypeCode: 'E0',
  timeReportingCode: 'R0', category: 'OPEX', leaveSubtype: null,
  isDefaultOpex: true, colorIndex: 0, active: true,
};
const model: Model = {
  otls: [opex],
  people: [
    { id: 'mgr', name: 'Manager', role: 'MANAGER', managerId: null },
    { id: 'p1', name: 'Alex', role: 'REPORT', managerId: 'mgr' },
  ],
  statHolidays: [], allocations: [], leave: [], overrides: [],
};

describe('WeeksPage', () => {
  it('shows a week per accordion panel labelled by date range', () => {
    render(<WeeksPage model={model} month="2026-09" update={vi.fn()} onMonthChange={vi.fn()} />);
    expect(screen.getByText(/31 Aug – 4 Sep 2026/)).toBeInTheDocument();
  });

  it('shows week status in the header while collapsed', () => {
    render(<WeeksPage model={model} month="2026-09" update={vi.fn()} onMonthChange={vi.fn()} />);
    expect(screen.getAllByLabelText(/week status/i).length).toBeGreaterThan(0);
  });

  it('renders separate tables for the manager and the reports', async () => {
    render(<WeeksPage model={model} month="2026-09" update={vi.fn()} onMonthChange={vi.fn()} />);
    await userEvent.click(screen.getByText(/31 Aug – 4 Sep 2026/));
    expect(screen.getByRole('table', { name: /manager/i })).toBeInTheDocument();
    expect(screen.getByRole('table', { name: /reports/i })).toBeInTheDocument();
  });

  it('totals every day to 7.5', async () => {
    render(<WeeksPage model={model} month="2026-09" update={vi.fn()} onMonthChange={vi.fn()} />);
    await userEvent.click(screen.getByText(/7 – 11 Sep 2026/));
    const totals = screen.getAllByLabelText(/day total/i);
    for (const t of totals) expect(t).toHaveTextContent('7.5');
  });

  it('writes an override when a cell is edited', async () => {
    const update = vi.fn();
    render(<WeeksPage model={model} month="2026-09" update={update} onMonthChange={vi.fn()} />);
    await userEvent.click(screen.getByText(/7 – 11 Sep 2026/));
    const cells = screen.getAllByRole('spinbutton');
    await userEvent.clear(cells[0]);
    await userEvent.type(cells[0], '4{Enter}');
    expect(update).toHaveBeenCalled();
  });

  it('adds leave for a date range and zeroes the other codes that day', async () => {
    const update = vi.fn();
    render(<WeeksPage model={model} month="2026-09" update={update} onMonthChange={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /add leave/i }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('offers to clear every override in a week', async () => {
    const withOverride: Model = { ...model, overrides: [
      { personId: 'p1', date: '2026-09-08', otlProjectCode: 'OPEX-ADMIN', hours: 4 },
    ] };
    render(<WeeksPage model={withOverride} month="2026-09" update={vi.fn()} onMonthChange={vi.fn()} />);
    await userEvent.click(screen.getByText(/7 – 11 Sep 2026/));
    expect(screen.getByRole('button', { name: /clear overrides/i })).toBeInTheDocument();
  });

  it('shows carried-forward residuals', () => {
    const over: Model = { ...model, otls: [opex, {
      ...opex, projectCode: 'P-1001', category: 'CAPEX', isDefaultOpex: false,
    }], allocations: [
      { month: '2026-09', otlProjectCode: 'P-1001', personId: null, hours: 5000 },
    ] };
    render(<WeeksPage model={over} month="2026-09" update={vi.fn()} onMonthChange={vi.fn()} />);
    expect(screen.getByText(/carried forward/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 5: Run test to verify it fails**

Run: `npx vitest run src/ui/pages/WeeksPage.test.tsx`
Expected: FAIL — cannot resolve `./WeeksPage`

- [ ] **Step 6: Implement the page**

`CollapsibleGroup` of weeks from `weeksTouchingMonth(month)`. Each header carries `formatWeekRange`, the week's capacity, and a status dot (success balanced, warning residual, error violation) with an accessible name of "week status". Inside: a `WeekTable` for the manager and one for the reports, each with an accessible name, four sticky-left OTL columns, Mon–Fri `HourCell`s, and a day-total row labelled "day total". Header actions: "Add leave" opening `LeaveDialog` with a `DateRangeInput` and a subtype `Selector`, and "Clear overrides" behind an `AlertDialog` when the week has any. Residuals render as a `Badge` reading "carried forward". Open/collapsed state persists in localStorage inside try/catch.

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run src/ui`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/ui/
git commit -m "feat: weeks page with accordion, editable cells, overrides and leave"
```

---

## Task 20: Per-person weekly read-off view

**Files:**
- Create: `src/ui/components/PersonWeekView.tsx`
- Test: `src/ui/components/PersonWeekView.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// src/ui/components/PersonWeekView.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PersonWeekView } from './PersonWeekView';
import type { ScheduleEntry } from '../../domain/types';

const entries: ScheduleEntry[] = [
  { personId: 'p1', date: '2026-09-07', otlProjectCode: 'P-1001', blocks: 15, source: 'CALC' },
  { personId: 'p1', date: '2026-09-08', otlProjectCode: 'OPEX-ADMIN', blocks: 15, source: 'CALC' },
];

describe('PersonWeekView', () => {
  it('names the person and the week', () => {
    render(<PersonWeekView personName="Alex" monday="2026-09-07" entries={entries} otls={[]} />);
    expect(screen.getByText('Alex')).toBeInTheDocument();
    expect(screen.getByText(/7 – 11 Sep 2026/)).toBeInTheDocument();
  });

  it('shows the four OTL identifier fields for each row', () => {
    render(<PersonWeekView personName="Alex" monday="2026-09-07" entries={entries} otls={[{
      projectCode: 'P-1001', taskCode: 'T1', expenditureTypeCode: 'E1',
      timeReportingCode: 'R1', category: 'CAPEX', leaveSubtype: null,
      isDefaultOpex: false, colorIndex: 1, active: true,
    }]} />);
    expect(screen.getByText('T1')).toBeInTheDocument();
    expect(screen.getByText('E1')).toBeInTheDocument();
    expect(screen.getByText('R1')).toBeInTheDocument();
  });

  it('shows a weekly total', () => {
    render(<PersonWeekView personName="Alex" monday="2026-09-07" entries={entries} otls={[]} />);
    expect(screen.getByText('15.0')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/components/PersonWeekView.test.tsx`
Expected: FAIL — cannot resolve `./PersonWeekView`

- [ ] **Step 3: Implement**

A read-only `Card` opened from a person's row: their name, the week range, the four OTL columns, Mon–Fri figures, and daily and weekly totals. No editing. Include `@media print` rules so it prints on one page — the point is reading numbers off it while typing into another system.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/ui/components/PersonWeekView.test.tsx`
Expected: PASS, 3 tests

- [ ] **Step 5: Commit**

```bash
git add src/ui/components/PersonWeekView.tsx src/ui/components/PersonWeekView.test.tsx
git commit -m "feat: per-person weekly read-off view"
```

---

# Phase 5 — Verification and release

## Task 21: End-to-end journey, audit and deploy

**Files:**
- Create: `playwright.config.ts`, `e2e/journey.spec.ts`
- Modify: `.github/workflows/deploy.yml`

- [ ] **Step 1: Install Playwright**

```bash
npm install -D @playwright/test
npx playwright install chromium
```

- [ ] **Step 2: Write the end-to-end journey**

```ts
// e2e/journey.spec.ts
import { test, expect } from '@playwright/test';

test('setup to timesheet, end to end', async ({ page }) => {
  await page.goto('/');

  // Setup: a default OPEX code, one CAPEX code, a manager and one report.
  await page.getByRole('tab', { name: 'Setup' }).click();
  await page.getByRole('button', { name: 'Add OTL' }).click();
  await page.getByLabel('Project code').fill('OPEX-ADMIN');
  await page.getByLabel('Task code').fill('T0');
  await page.getByLabel('Expenditure type code').fill('E0');
  await page.getByLabel('Time reporting code').fill('R0');
  await page.getByLabel('Category').selectOption('OPEX');
  await page.getByRole('button', { name: 'Save' }).click();
  await page.getByRole('radio', { name: /default opex/i }).check();

  await page.getByRole('button', { name: 'Add OTL' }).click();
  await page.getByLabel('Project code').fill('P-1001');
  await page.getByLabel('Task code').fill('T1');
  await page.getByLabel('Expenditure type code').fill('E1');
  await page.getByLabel('Time reporting code').fill('R1');
  await page.getByLabel('Category').selectOption('CAPEX');
  await page.getByRole('button', { name: 'Save' }).click();

  await page.getByRole('button', { name: 'Add manager' }).click();
  await page.getByLabel('Name').fill('Manager');
  await page.getByRole('button', { name: 'Save' }).click();
  await page.getByRole('button', { name: 'Add report' }).click();
  await page.getByLabel('Name').fill('Alex');
  await page.getByRole('button', { name: 'Save' }).click();

  // Allocate.
  await page.getByRole('tab', { name: 'Allocations' }).click();
  await page.getByLabel(/Alex.*P-1001/).fill('40');
  await page.getByLabel(/Alex.*P-1001/).blur();

  // The stale banner appears; recalculate.
  await expect(page.getByRole('button', { name: 'Recalculate' })).toBeVisible();
  await page.getByRole('button', { name: 'Recalculate' }).click();
  await expect(page.getByRole('button', { name: 'Recalculate' })).toBeHidden();

  // Weeks: every day totals 7.5.
  await page.getByRole('tab', { name: 'Weeks' }).click();
  await page.getByText(/7 – 11 Sep/).click();
  for (const total of await page.getByLabel('day total').all()) {
    await expect(total).toHaveText('7.5');
  }

  // Override a cell; it locks and survives recalculation.
  const cell = page.getByRole('spinbutton').first();
  await cell.fill('4');
  await cell.press('Enter');
  await expect(page.getByLabel(/manually set/i).first()).toBeVisible();
  await page.getByRole('button', { name: 'Recalculate' }).click();
  await expect(page.getByLabel(/manually set/i).first()).toBeVisible();
});
```

- [ ] **Step 3: Run the journey**

Run: `npx playwright test`
Expected: PASS. If a selector misses, fix the **component's** accessible name rather than loosening the selector — an element the test cannot name is one a screen reader cannot either.

- [ ] **Step 4: Run the audit skill**

Invoke `impeccable` against the three pages. Check specifically, from `DESIGN.md` §6: no nested cards, no centred numbers, no `0.0` cells, no colour-only encoding, no animated figure changes, no shadows on tables. Fix what it finds.

- [ ] **Step 5: Verify coverage and types**

```bash
npm run typecheck && npm run coverage
```
Expected: no type errors; 80%+ overall, 95%+ in `src/domain/`.

- [ ] **Step 6: Verify both colour schemes**

Load the app with the OS in light mode and again in dark mode. Every custom treatment — the lock border, leave wash, status dots, category colours — must remain legible in both. `DESIGN.md` §5 rule 10.

- [ ] **Step 7: Add the E2E job to CI**

Add a `playwright` step to `.github/workflows/deploy.yml` after `npm test`:

```yaml
      - run: npx playwright install --with-deps chromium
      - run: npx playwright test
```

- [ ] **Step 8: Commit and deploy**

```bash
git add -A
git commit -m "test: end-to-end journey and ci integration"
git push
```

Confirm the Actions run is green and the live Pages URL works: enter the secret, load from the Sheet, recalculate, and confirm the Sheet's tabs populate.

---

## Self-Review

**Spec coverage.** §3.1 capacity → Tasks 3, 5. §3.2 entities → Tasks 3, 17. §3.3 floor
→ Task 5. §3.4 weeks and months → Tasks 4, 7. §3.5 allocations → Tasks 6, 18. §3.6
leftovers → Task 8. §3.7 leave → Tasks 5, 19. §3.8 overrides → Tasks 7, 19. §4 optimizer
and invariants → Tasks 7, 8, 9. §5 data model → Tasks 3, 11. §6 storage and staleness →
Tasks 1, 10, 12–15. §7 UI → Tasks 16–20. §8 technology → Task 2. §9 testing → throughout,
plus Task 21. §10 build order → task order. §11 risks → Task 1 spike, Task 12 local-only
fallback.

**Amendment (pluggable backends).** The spec was written against a single Google Sheets
backend. Tasks 12–15 generalise this to a `StorageAdapter` interface with Google,
Microsoft 365 and local-only implementations. Nothing in Tasks 3–11 or 16–21 changes —
the domain layer and UI never learn which backend is active. Spec §6 has been updated to
match.

**Placeholder scan.** No TBDs. Tasks 11, 14 (adapter half), 15, 17, 18, 19 and 20 state
implementation requirements in prose rather than full component source, because the exact
Astryx and MSAL APIs must be read from live docs at implementation time; each is pinned by
a complete failing test that defines the contract precisely.

**Type consistency.** `Blocks`, `IsoDate`, `IsoMonth`, `OtlCode`, `PersonId` defined once
in Task 3 and used unchanged throughout. `keyOf(month, otl)` defined in Task 6, used in
Tasks 7 and 8. `scheduleWeek` signature fixed in Task 7, consumed unchanged in Task 8.
`ScheduleResult` defined in Task 3, produced in Task 8, consumed in Tasks 9, 15 and 19.
`StorageAdapter` and `BackendConfig` defined in Task 12, implemented identically in Tasks
12, 13 and 14, consumed in Task 15. `SheetPayload` defined in Task 11 and is the only type
crossing the storage boundary.
