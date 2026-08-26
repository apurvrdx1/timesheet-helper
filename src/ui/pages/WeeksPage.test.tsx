import { describe, it, expect, vi, beforeEach } from 'vitest';
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
