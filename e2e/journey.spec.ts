import { test, expect, type Page } from '@playwright/test';
import { createAccount, tearDownAccounts, type TestAccount } from './fixtures';
import { formatWeekRange, monthOf, weekDays, weeksTouchingMonth } from '../src/domain/calendar';
import type { IsoDate, IsoMonth } from '../src/domain/types';

/**
 * The real user journey, end to end, against a live Vite dev server (see
 * playwright.config.ts) and a live Supabase project (see e2e/fixtures.ts):
 * sign in, set up cost-centre codes and a team, allocate a month of CAPEX
 * hours, recalculate, read the resulting weekly timesheet, hand-override one
 * cell, and prove the override survives a second recalculation — the exact
 * behaviour that was broken until recently and the single most important
 * guarantee this app makes.
 *
 * Plus the gate itself: an unapproved account gets the pending screen and
 * NOT the planner. That is the auth equivalent of the isolation suite — the
 * unit tests prove `AuthGate` chooses correctly given a profile, and this
 * proves the whole stack, real session and real RLS included, agrees.
 *
 * Selector notes (see task-21-report.md for the full rationale):
 * - Astryx's `Selector` is a combobox, not a native `<select>` — every
 *   category/month pick opens the combobox trigger by accessible name, then
 *   clicks the resulting `role="option"`, mirroring the pattern Astryx's own
 *   Selector.test.tsx and this repo's SetupPage.test.tsx already use.
 * - The three primary nav items ("Setup", "Allocations", "Weeks") render as
 *   plain `role="button"` elements, not `role="tab"`: App.tsx's `TabList`
 *   never passes `role="tablist"`, so Astryx's Tab never adopts the ARIA
 *   tabs pattern (see Tab.tsx and App.test.tsx's `openTab` helper, which
 *   documents this as the app's existing, intentional nav-strip usage).
 * - Every screen renders behind `AuthGate` (App.tsx), and the planner mounts
 *   only once a session with an APPROVED profile exists, so the journey now
 *   starts at the sign-in form rather than on Setup. There is still no
 *   connect/import step: there is exactly one backend and the store reads the
 *   signed-in account on mount.
 * - The month is pinned to a known month, and the week to a known week inside
 *   it, rather than asserted against "whatever the current month happens to
 *   be": the app seeds its month picker from `new Date()` (App.tsx's
 *   `currentMonth`), so a date assertion that is not driven explicitly first
 *   only stays true for as long as the test happens to run in that month.
 *   Both are DERIVED FROM THE RUN DATE — see `PINNED_MONTH` below.
 */

/**
 * The month this journey drives the app to, and the week inside it that the
 * timesheet assertions read.
 *
 * Derived from the run date, not hard-coded (pre-merge review M4). The month
 * combobox offers a +/-18-month window around the month the app opened on
 * (`monthOptions` in AllocationsPage.tsx and WeeksPage.tsx), which is seeded
 * from today — so a hard-coded "September 2026" leaves the option list around
 * March 2028 and never comes back. The suite would then red on the calendar
 * rather than on the code, and `deploy.needs: [build, integration, e2e]` would
 * block every deploy from that day on, for a reason with nothing to do with
 * the app. A date-driven permanent red also teaches the team that red E2E
 * means "re-run it", which is how a real failure eventually gets waved through.
 *
 * NEXT month, not this one: a planner plans ahead, and it keeps the run clear
 * of any interaction with today's date. One month ahead is inside the window
 * by a wide margin however the local clock and the app's own `new Date()`
 * disagree about the month boundary.
 *
 * Nothing here weakens an assertion: the month and week are still exact, still
 * pinned before anything is read, and the labels are still compared with
 * `exact: true`. Only their VALUES now come from the calendar instead of from
 * 2026.
 */
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

/** `year`/`monthIndex` to `YYYY-MM`, carrying an overflowing index into the
 * next year — the same arithmetic `monthOptions` uses to walk its window. */
function isoMonth(year: number, monthIndex: number): IsoMonth {
  const total = year * 12 + monthIndex;
  const normalisedYear = Math.floor(total / 12);
  const normalisedMonth = ((total % 12) + 12) % 12;
  return `${normalisedYear}-${String(normalisedMonth + 1).padStart(2, '0')}` as IsoMonth;
}

/**
 * The combobox option's accessible name for a month.
 *
 * A third copy of the app's `monthLabel` (AllocationsPage.tsx and
 * WeeksPage.tsx already hold one each) rather than an import: those two live
 * in `.tsx` modules that pull in React and the whole Astryx component library,
 * which this Node-side test file must not load. Drift is loud, not silent — a
 * label that does not match leaves `getByRole('option', { name })` matching
 * nothing and the test fails naming the option it wanted.
 */
function monthLabel(month: IsoMonth): string {
  const [yearText, monthText] = month.split('-');
  const name = MONTH_NAMES[Number(monthText) - 1];
  return name ? `${name} ${yearText}` : month;
}

/**
 * The first Monday in `month` whose whole Mon–Fri week is also in `month`.
 *
 * The week the timesheet assertions read must not straddle a month boundary:
 * every one of its days has to be inside the allocated month for all five day
 * totals to be 7.5. Every month contains at least one such week (28 days is
 * enough), so the throw is unreachable in practice and exists so that a future
 * calendar change fails here, loudly, rather than in a click timeout.
 *
 * Uses the app's OWN calendar module — `weeksTouchingMonth` and `weekDays` are
 * what WeekAccordion builds its week rows from, and `formatWeekRange` is what
 * renders their labels, so the label this test clicks is produced by the code
 * under test rather than by a second spelling of it.
 */
function firstFullWeekMonday(month: IsoMonth): IsoDate {
  const monday = weeksTouchingMonth(month).find((candidate) =>
    weekDays(candidate).every((day) => monthOf(day) === month),
  );
  if (monday === undefined) {
    throw new Error(`no Mon-Fri week falls entirely inside ${month}`);
  }
  return monday;
}

/** The month to drive the app to, given the day the suite runs on. Takes
 * `today` rather than reading the clock so that it is checkable for any date,
 * not only the one the run happens to land on. */
function pinnedMonthFor(today: Date): IsoMonth {
  return isoMonth(today.getFullYear(), today.getMonth() + 1);
}

const PINNED_MONTH: IsoMonth = pinnedMonthFor(new Date());
const MONTH_LABEL = monthLabel(PINNED_MONTH);
const PINNED_WEEK_LABEL = formatWeekRange(firstFullWeekMonday(PINNED_MONTH));

/**
 * Sign-in, the account read and the profile read are real round trips to a
 * remote project, and they happen back to back with nothing on screen but a
 * spinner. The 5s default `expect` timeout is a budget for a local render, not
 * for that — so the first thing waited for after a sign-in gets its own.
 */
const SIGN_IN_TIMEOUT = 30_000;

/**
 * The run's own accounts, created in `beforeAll` and deleted in `afterAll`.
 * `journeyAccount` is approved; `pendingAccount` is not, and nothing in this
 * suite ever approves it — see the header of e2e/fixtures.ts.
 */
let journeyAccount: TestAccount;
let pendingAccount: TestAccount;

test.beforeAll(async () => {
  journeyAccount = await createAccount('journey', { approved: true });
  pendingAccount = await createAccount('pending', { approved: false });
});

test.afterAll(async () => {
  await tearDownAccounts();
});

async function chooseComboboxOption(
  page: Page,
  comboboxName: string,
  optionName: string,
): Promise<void> {
  await page.getByRole('combobox', { name: comboboxName }).click();
  await page.getByRole('option', { name: optionName, exact: true }).click();
}

/** Signs in through the real form — the path a person takes, not a token
 * planted into localStorage, which would skip the very screen being tested. */
async function signIn(page: Page, account: TestAccount): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible({
    timeout: SIGN_IN_TIMEOUT,
  });
  // Anchored regexes, not exact strings: Astryx's `TextInput` renders the
  // `isRequired` marker INSIDE the <label>, so the accessible name of the
  // email field is "Email Required", not "Email". `{ exact: true }` here
  // silently matches nothing and the test dies on a timeout that says only
  // "waiting for getByLabel('Email')" — verified against the running app.
  await page.getByLabel(/^Email/).fill(account.email);
  await page.getByLabel(/^Password/).fill(account.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

test('setup to timesheet, end to end', async ({ page }) => {
  await signIn(page, journeyAccount);

  const setupTab = page.getByRole('button', { name: 'Setup', exact: true });
  const allocationsTab = page.getByRole('button', { name: 'Allocations', exact: true });
  const weeksTab = page.getByRole('button', { name: 'Weeks', exact: true });

  // Reaching this at all is the proof that the gate let an approved account
  // through: `AuthGate` renders the sign-in form, then the account read's
  // spinner, and only then the planner.
  await expect(setupTab).toBeVisible({ timeout: SIGN_IN_TIMEOUT });

  // --- Setup: a default OPEX code, one CAPEX code, a manager and a report.

  await page.getByRole('button', { name: 'Add OTL' }).click();
  await page.getByLabel('Project code').fill('OPEX-ADMIN');
  await page.getByLabel('Task code').fill('T0');
  await page.getByLabel('Expenditure type code').fill('E0');
  await page.getByLabel('Time reporting code').fill('R0');
  await chooseComboboxOption(page, 'Category', 'OPEX');
  await page.getByRole('button', { name: 'Save' }).click();
  await page.getByRole('radio', { name: /default opex/i }).check();

  await page.getByRole('button', { name: 'Add OTL' }).click();
  await page.getByLabel('Project code').fill('P-1001');
  await page.getByLabel('Task code').fill('T1');
  await page.getByLabel('Expenditure type code').fill('E1');
  await page.getByLabel('Time reporting code').fill('R1');
  await chooseComboboxOption(page, 'Category', 'CAPEX');
  await page.getByRole('button', { name: 'Save' }).click();

  // Setup's stat-holiday form also has an always-present "Name" field, so
  // the manager/report dialog's own "Name" input needs the dialog as scope
  // to stay unambiguous.
  await page.getByRole('button', { name: 'Add manager' }).click();
  await page.getByRole('dialog').getByLabel('Name').fill('Manager');
  await page.getByRole('button', { name: 'Save' }).click();

  await page.getByRole('button', { name: 'Add report' }).click();
  await page.getByRole('dialog').getByLabel('Name').fill('Alex');
  await page.getByRole('button', { name: 'Save' }).click();

  // --- Allocations: pin a fixed month, then allocate 40h of CAPEX to Alex.

  await allocationsTab.click();
  await chooseComboboxOption(page, 'Month', MONTH_LABEL);
  await expect(page.getByRole('combobox', { name: 'Month' })).toHaveText(MONTH_LABEL);

  const allocationCell = page.getByLabel('Alex P-1001');
  await allocationCell.fill('40');
  await allocationCell.blur();

  // --- The stale banner appears; recalculate, and it clears.

  const recalculate = page.getByRole('button', { name: 'Recalculate' });
  await expect(recalculate).toBeVisible();
  await recalculate.click();
  await expect(recalculate).toBeHidden();

  // --- Weeks: the pinned month carries over (App.tsx owns it, not the
  //     page), and a week fully inside it totals every day to 7.5.

  await weeksTab.click();
  await expect(page.getByRole('combobox', { name: 'Month' })).toHaveText(MONTH_LABEL);

  await page.getByText(PINNED_WEEK_LABEL).click();
  const totals = await page.getByLabel('day total').all();
  expect(totals.length).toBeGreaterThan(0);
  for (const total of totals) {
    await expect(total).toHaveText('7.5');
  }

  // --- Override a cell: it locks, and survives a second recalculation —
  //     the behaviour that was genuinely broken until recently.

  // The manager carries no CAPEX, so this first cell is the default OPEX
  // code — the one case where the optimizer tops a pin back up to a full
  // 7.5h day. The cell total and the pinned figure therefore differ, and
  // asserting only that the padlock is still there would pass even if the
  // 4.0h pin had been silently replaced by the 7.5h the day adds up to.
  const cell = page.getByRole('spinbutton').first();
  await cell.fill('4');
  await cell.press('Enter');
  await expect(page.getByLabel(/manually set/i).first()).toBeVisible();
  await expect(page.getByLabel(/4\.0h manually set/i).first()).toBeVisible();

  await recalculate.click();
  await expect(page.getByLabel(/manually set/i).first()).toBeVisible();
  // The value itself, not just its marker: clicking Recalculate blurred the
  // field, so what it shows now is the committed override, and it is still
  // the 4.0h that was typed rather than the day total it sits inside.
  await expect(cell).toHaveValue('4.0');
  await expect(page.getByLabel(/4\.0h manually set/i).first()).toBeVisible();

  // --- A person's read-off view shows their week.

  await page.getByRole('button', { name: "View Alex's week" }).click();
  await expect(page.getByRole('heading', { name: "Alex's week" })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Alex week' })).toBeVisible();
});

test('an unapproved account gets the waiting screen, and not the planner', async ({ page }) => {
  // Registration is open (SignInPage's module doc), so this gate is the whole
  // security model for a stranger who signs up: a real, valid session that the
  // app answers with a waiting screen. `AuthGate.test.tsx` proves the
  // component chooses that branch given an unapproved profile; only this
  // proves that a real sign-in against the real project produces one.
  await signIn(page, pendingAccount);

  await expect(page.getByRole('heading', { name: 'Waiting for approval' })).toBeVisible({
    timeout: SIGN_IN_TIMEOUT,
  });
  await expect(page.getByText(`Signed in as ${pendingAccount.email}.`)).toBeVisible();

  // The half that actually matters. "The pending text is present" would pass
  // just as happily with the whole planner rendered underneath it, which is
  // the exact failure this test exists to catch — so the planner's own
  // heading and all three of its tabs must be ABSENT.
  await expect(page.getByRole('heading', { name: 'Timesheet helper' })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Setup', exact: true })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Allocations', exact: true })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Weeks', exact: true })).toBeHidden();

  // Still nothing after a reload: the persisted session is re-read from
  // scratch and lands on the same screen, rather than the gate happening to
  // hold only on the code path that just signed in.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Waiting for approval' })).toBeVisible({
    timeout: SIGN_IN_TIMEOUT,
  });
  await expect(page.getByRole('button', { name: 'Setup', exact: true })).toBeHidden();
});
