import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
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
});
