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
