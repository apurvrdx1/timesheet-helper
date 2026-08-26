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

  // N3: a model with people but nothing allocated in any month has no window
  // for the schedule to be built over. That used to surface only as a stale
  // banner whose Recalculate button failed on every press; it is an empty
  // state, and it belongs here, where the user can act on it.
  it('names the missing allocation as an empty state when nothing is allocated', () => {
    render(<AllocationsPage model={model} month="2026-09" update={vi.fn()} onMonthChange={vi.fn()} />);
    expect(screen.getByText(/allocate hours to a month to see them scheduled/i)).toBeInTheDocument();
    // The grid stays underneath: it is the way out of the empty state.
    expect(screen.getByLabelText(/Alex.*P-1001/i)).toBeInTheDocument();
  });

  it('drops the empty state once a month has an allocation', () => {
    const allocated: Model = { ...model, allocations: [
      { month: '2026-09', otlProjectCode: 'P-1001', personId: 'p1', hours: 40 },
    ] };
    render(<AllocationsPage model={allocated} month="2026-09" update={vi.fn()} onMonthChange={vi.fn()} />);
    expect(screen.queryByText(/allocate hours to a month/i)).not.toBeInTheDocument();
  });

  it('excludes OPEX and Leave codes from the grid', () => {
    const withOpex: Model = { ...model, otls: [capex, {
      ...capex, projectCode: 'OPEX-ADMIN', category: 'OPEX', isDefaultOpex: true,
    }] };
    render(<AllocationsPage model={withOpex} month="2026-09" update={vi.fn()} onMonthChange={vi.fn()} />);
    expect(screen.queryByText('OPEX-ADMIN')).not.toBeInTheDocument();
  });

  // I5: the grid's optimistic overlay (AllocationGrid's `localHours`) must
  // not survive a month switch. AllocationGrid is never remounted when only
  // its `month` prop changes, so a stale entry left keyed by person+OTL
  // alone would both display under the new month and — because the input's
  // own displayed value is that stale figure — write for real into the new
  // month on the very next edit.
  it('does not leak a value typed for one month into a different month', async () => {
    const update = vi.fn();
    const { rerender } = render(
      <AllocationsPage model={model} month="2026-09" update={update} onMonthChange={vi.fn()} />,
    );

    await userEvent.type(screen.getByLabelText(/Alex.*P-1001/i), '40');
    await userEvent.tab();

    rerender(<AllocationsPage model={model} month="2026-10" update={update} onMonthChange={vi.fn()} />);

    const octoberCell = screen.getByLabelText(/Alex.*P-1001/i);
    expect(octoberCell).toHaveValue('—');

    update.mockClear();
    // A single step (arrow-up on the focused field, no visible stepper
    // button needed) is enough to turn the stale displayed value into a
    // real write — this is the "one click makes them real" half of I5.
    await userEvent.click(octoberCell);
    await userEvent.keyboard('{ArrowUp}');

    expect(update).toHaveBeenCalledTimes(1);
    const [writtenModel] = update.mock.calls[0] as [Model];
    expect(writtenModel.allocations).toEqual([
      { month: '2026-10', otlProjectCode: 'P-1001', personId: 'p1', hours: 0.5 },
    ]);
  });
});
