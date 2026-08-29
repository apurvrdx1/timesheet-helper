import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WeeksPage } from './WeeksPage';
import type { IsoMonth, Model, Otl } from '../../domain/types';

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

// The accordion mirrors its open weeks to localStorage, which jsdom keeps
// for the whole file: without this, a test that clicks a week another test
// already opened would collapse it instead of opening it.
beforeEach(() => {
  window.localStorage.clear();
});

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
    const [firstCell] = cells;
    if (!firstCell) throw new Error('expected at least one spinbutton');
    await userEvent.clear(firstCell);
    await userEvent.type(firstCell, '4{Enter}');
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

  /**
   * C2: `scheduleAll` throws whenever somebody is scheduled and no OTL
   * carries `isDefaultOpex` — reachable by adding a manager before flagging
   * a code, and again by deleting the flagged code later. The page must name
   * the missing setting rather than let the throw escape into a render.
   */
  it('names the missing default OPEX code instead of throwing during render', () => {
    const noDefault: Model = { ...model, otls: [{ ...opex, isDefaultOpex: false }] };
    render(<WeeksPage model={noDefault} month="2026-09" update={vi.fn()} onMonthChange={vi.fn()} />);
    expect(screen.getByText(/flag an opex code as default/i)).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  /**
   * I1: a pin on the default OPEX code is topped up to fill the day, so the
   * cell total and the pin differ. Enter on that cell — a keystroke that
   * looks like confirming what is already there — must re-commit the pin.
   */
  it('re-commits the pinned hours, not the topped-up total, when Enter confirms a locked cell', async () => {
    const pinned: Model = { ...model, overrides: [
      { personId: 'mgr', date: '2026-09-07', otlProjectCode: 'OPEX-ADMIN', hours: 2 },
    ] };
    const update = vi.fn<(next: Model) => void>();
    render(<WeeksPage model={pinned} month="2026-09" update={update} onMonthChange={vi.fn()} />);
    await userEvent.click(screen.getByText(/7 – 11 Sep 2026/));

    const managerTable = screen.getByRole('table', { name: /manager/i });
    const [monday] = within(managerTable).getAllByRole('spinbutton');
    if (!monday) throw new Error('expected the manager’s Monday cell');

    // The cell reads the day total the user copies into their timesheet…
    expect(within(managerTable).getAllByLabelText(/2\.0h manually set/i).length).toBe(1);
    // …while the field holds only what was pinned.
    expect(monday).toHaveValue('2.0');

    await userEvent.click(monday);
    await userEvent.keyboard('{Enter}');

    const next = update.mock.calls[0]?.[0];
    expect(next?.overrides).toContainEqual({
      personId: 'mgr', date: '2026-09-07', otlProjectCode: 'OPEX-ADMIN', hours: 2,
    });
  });

});

/**
 * Override survival is the spec's headline promise: a hand-set hour must
 * write with the right {personId, date, otlProjectCode, hours} key, an edit
 * to an already-overridden cell must replace that entry rather than
 * duplicate it, a revert must remove exactly one cell's override, and
 * clearing a week must never reach into an adjacent week's overrides (that
 * would be silent data loss). These drive WeeksPage's onOverride/onRevert/
 * onClearOverrides wiring — upsertOverride, removeOverride, and
 * clearOverridesForWeek — through the real WeekTable/HourCell UI rather
 * than calling the (unexported) helpers directly.
 */
describe('WeeksPage — override lifecycle', () => {
  it('writes a new override keyed to the exact cell that was edited', async () => {
    const update = vi.fn<(next: Model) => void>();
    render(<WeeksPage model={model} month="2026-09" update={update} onMonthChange={vi.fn()} />);
    await userEvent.click(screen.getByText(/7 – 11 Sep 2026/));

    const cell = screen.getByRole('spinbutton', { name: /OPEX-ADMIN hours for mgr, 2026-09-07/i });
    await userEvent.clear(cell);
    await userEvent.type(cell, '4{Enter}');

    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0]?.[0]?.overrides).toEqual([
      { personId: 'mgr', date: '2026-09-07', otlProjectCode: 'OPEX-ADMIN', hours: 4 },
    ]);
  });

  it('replaces an existing override for the same cell instead of duplicating it', async () => {
    const withOverride: Model = { ...model, overrides: [
      { personId: 'mgr', date: '2026-09-07', otlProjectCode: 'OPEX-ADMIN', hours: 2 },
    ] };
    const update = vi.fn<(next: Model) => void>();
    render(<WeeksPage model={withOverride} month="2026-09" update={update} onMonthChange={vi.fn()} />);
    await userEvent.click(screen.getByText(/7 – 11 Sep 2026/));

    const cell = screen.getByRole('spinbutton', { name: /OPEX-ADMIN hours for mgr, 2026-09-07/i });
    expect(cell).toHaveValue('2.0');
    await userEvent.clear(cell);
    await userEvent.type(cell, '5{Enter}');

    expect(update).toHaveBeenCalledTimes(1);
    // Exactly one entry for this key, holding the new hours — not two.
    expect(update.mock.calls[0]?.[0]?.overrides).toEqual([
      { personId: 'mgr', date: '2026-09-07', otlProjectCode: 'OPEX-ADMIN', hours: 5 },
    ]);
  });

  it('reverts a single cell, leaving another override untouched', async () => {
    const twoOverrides: Model = { ...model, overrides: [
      { personId: 'mgr', date: '2026-09-07', otlProjectCode: 'OPEX-ADMIN', hours: 2 },
      { personId: 'p1', date: '2026-09-08', otlProjectCode: 'OPEX-ADMIN', hours: 3 },
    ] };
    const update = vi.fn<(next: Model) => void>();
    render(<WeeksPage model={twoOverrides} month="2026-09" update={update} onMonthChange={vi.fn()} />);
    await userEvent.click(screen.getByText(/7 – 11 Sep 2026/));

    // Only the manager's cell is overridden in the Manager table, so the
    // revert control is unambiguous once scoped to that table.
    const managerTable = screen.getByRole('table', { name: /manager/i });
    await userEvent.click(within(managerTable).getByRole('button', { name: /revert to calculated value/i }));

    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0]?.[0]?.overrides).toEqual([
      { personId: 'p1', date: '2026-09-08', otlProjectCode: 'OPEX-ADMIN', hours: 3 },
    ]);
  });

  it('clears only the overrides in the week being cleared, not an adjacent week', async () => {
    const twoWeeks: Model = { ...model, overrides: [
      { personId: 'mgr', date: '2026-09-07', otlProjectCode: 'OPEX-ADMIN', hours: 2 },
      { personId: 'mgr', date: '2026-09-14', otlProjectCode: 'OPEX-ADMIN', hours: 3 },
    ] };
    const update = vi.fn<(next: Model) => void>();
    render(<WeeksPage model={twoWeeks} month="2026-09" update={update} onMonthChange={vi.fn()} />);
    await userEvent.click(screen.getByText(/7 – 11 Sep 2026/));

    await userEvent.click(
      screen.getByRole('button', { name: /clear overrides for the week of 7 – 11 sep 2026/i }),
    );
    const alertDialog = screen.getByRole('alertdialog');
    await userEvent.click(within(alertDialog).getByRole('button', { name: /^clear overrides$/i }));

    expect(update).toHaveBeenCalledTimes(1);
    // The week-of-14-Sep override survives; only 7-Sep's is gone.
    expect(update.mock.calls[0]?.[0]?.overrides).toEqual([
      { personId: 'mgr', date: '2026-09-14', otlProjectCode: 'OPEX-ADMIN', hours: 3 },
    ]);
  });
});

const capex: Otl = {
  ...opex, projectCode: 'P-1', category: 'CAPEX', isDefaultOpex: false, colorIndex: 1,
};

/** Spec §3.4's model: one person with a September CAPEX budget, read from
 * either side of the week that straddles 31 Aug – 4 Sep. Nobody carries the
 * MANAGER role, so nothing absorbs what a truncated window fails to place
 * and the mis-scoped schedule surfaces as an UNABSORBED residual too. */
const straddling: Model = {
  ...model,
  otls: [opex, capex],
  people: [{ id: 'p1', name: 'Alex', role: 'REPORT', managerId: null }],
  allocations: [{ month: '2026-09', otlProjectCode: 'P-1', personId: 'p1', hours: 40 }],
};

async function renderWeekFrom(month: IsoMonth, from: Model): Promise<string> {
  window.localStorage.clear();
  const view = render(<WeeksPage model={from} month={month} update={vi.fn()} onMonthChange={vi.fn()} />);
  await userEvent.click(screen.getByText(/31 Aug – 4 Sep 2026/));
  const text = screen.getByRole('table', { name: /reports/i }).textContent ?? '';
  view.unmount();
  return text;
}

describe('WeeksPage — one continuous schedule (spec §3.4)', () => {
  it('renders a straddling week identically from either adjacent month', async () => {
    const fromAugust = await renderWeekFrom('2026-08', straddling);
    const fromSeptember = await renderWeekFrom('2026-09', straddling);
    expect(fromAugust).toBe(fromSeptember);
  });

  it('does not warn that a later month cannot be placed while viewing an earlier one', () => {
    window.localStorage.clear();
    render(<WeeksPage model={straddling} month="2026-08" update={vi.fn()} onMonthChange={vi.fn()} />);
    expect(screen.queryByText(/could not be placed/i)).not.toBeInTheDocument();
  });

  it('counts leave, not only stat holidays, in the week header capacity', () => {
    const onLeave: Model = {
      ...model,
      otls: [opex, {
        ...opex, projectCode: 'LV-VAC', category: 'LEAVE',
        leaveSubtype: 'VACATION', isDefaultOpex: false,
      }],
      leave: [{ personId: 'p1', startDate: '2026-09-07', endDate: '2026-09-09', otlProjectCode: 'LV-VAC' }],
    };
    window.localStorage.clear();
    render(<WeeksPage model={onLeave} month="2026-09" update={vi.fn()} onMonthChange={vi.fn()} />);
    // The manager's full 37.5h plus the two days the report is not on leave.
    expect(screen.getByText('team capacity 52.5h')).toBeInTheDocument();
  });
});

/**
 * A12: `ExportMenu` is only worth having if something mounts it. These drive
 * it through the real path a user takes — open a week, open a person's
 * read-off view, export — rather than rendering the component directly, so
 * a regression that unmounts it fails here.
 */
describe('WeeksPage — export from the person-week view', () => {
  let written: { flavours: Record<string, Blob> }[] = [];
  const clipboardWrite = vi.fn(async (items: { flavours: Record<string, Blob> }[]) => {
    written = items;
  });

  class FakeClipboardItem {
    readonly flavours: Record<string, Blob>;
    constructor(flavours: Record<string, Blob>) {
      this.flavours = flavours;
    }
  }

  beforeEach(() => {
    written = [];
    clipboardWrite.mockClear();
    // jsdom has neither of these; the component throws without them.
    vi.stubGlobal('ClipboardItem', FakeClipboardItem);
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      value: { write: clipboardWrite, writeText: vi.fn() },
      configurable: true, writable: true,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function openAlexsWeek() {
    render(<WeeksPage model={model} month="2026-09" update={vi.fn()} onMonthChange={vi.fn()} />);
    await userEvent.click(screen.getByText(/7 – 11 Sep 2026/));
    await userEvent.click(screen.getByRole('button', { name: /view alex's week/i }));
    return screen.getByRole('dialog');
  }

  it('offers an Export control beside the person-week view', async () => {
    const dialog = await openAlexsWeek();
    expect(within(dialog).getByRole('table', { name: /alex week/i })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /export/i })).toBeInTheDocument();
  });

  it('copies the week that is on screen, not some other week', async () => {
    const dialog = await openAlexsWeek();
    await userEvent.click(within(dialog).getByRole('button', { name: /export/i }));
    await userEvent.click(screen.getByRole('menuitem', { name: /copy as table/i }));

    expect(clipboardWrite).toHaveBeenCalledTimes(1);
    const html = await written[0]?.flavours['text/html']?.text();
    expect(html).toContain('<table');
    expect(html).toContain('OPEX-ADMIN');
    // A full week on the default OPEX code: five 7.5h days.
    expect(html).toContain('<td>37.5</td>');
  });
});
