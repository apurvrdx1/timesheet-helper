import { test, expect, type Page } from '@playwright/test';

/**
 * The real user journey, end to end, against a live Vite dev server (see
 * playwright.config.ts): set up cost-centre codes and a team, allocate a
 * month of CAPEX hours, recalculate, read the resulting weekly timesheet,
 * hand-override one cell, and prove the override survives a second
 * recalculation — the exact behaviour that was broken until recently and
 * the single most important guarantee this app makes.
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
 * - The app defaults to the local backend with no first-run modal (see
 *   store.ts's `DEFAULT_CONFIG`), so the journey starts directly on Setup —
 *   no connect/import step needed before any of this is reachable.
 * - The month is pinned to a fixed, known month (September 2026) rather
 *   than asserted against "whatever the current month happens to be": the
 *   app seeds its month picker from `new Date()` (App.tsx's `currentMonth`),
 *   so an assertion against a hardcoded date range only stays true for as
 *   long as this test happens to run in that same month unless the month is
 *   driven explicitly first.
 */

const MONTH_LABEL = 'September 2026';
const PINNED_WEEK_LABEL = '7 – 11 Sep 2026';

async function chooseComboboxOption(
  page: Page,
  comboboxName: string,
  optionName: string,
): Promise<void> {
  await page.getByRole('combobox', { name: comboboxName }).click();
  await page.getByRole('option', { name: optionName, exact: true }).click();
}

test('setup to timesheet, end to end', async ({ page }) => {
  await page.goto('/');

  const setupTab = page.getByRole('button', { name: 'Setup', exact: true });
  const allocationsTab = page.getByRole('button', { name: 'Allocations', exact: true });
  const weeksTab = page.getByRole('button', { name: 'Weeks', exact: true });

  await expect(setupTab).toBeVisible();

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
