import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { WeekAccordion } from './WeekAccordion';
import type { Model, Person, Role, ScheduleResult } from '../../domain/types';

const emptyResult: ScheduleResult = { entries: [], residuals: [], violations: [] };

const manager: Person = { id: 'p1', name: 'Alex', role: 'MANAGER', managerId: null };
const report: Person = { id: 'p2', name: 'Sam', role: 'REPORT', managerId: 'p1' };

/**
 * A person carrying a role neither table renders. `Role` is a closed union
 * today, but the scheduler deliberately places hours for such a person
 * (schedule.ts: "filtering on role would drop the rest of them from the
 * schedule entirely"), so the panel must not let one inflate a figure they
 * never appear beneath.
 */
const contractor: Person = { id: 'p3', name: 'Kim', role: 'CONTRACTOR' as Role, managerId: null };

function modelWith(people: Person[]): Model {
  return { otls: [], people, statHolidays: [], allocations: [], leave: [], overrides: [] };
}

const noop = (): void => {};

function renderAccordion(model: Model) {
  render(
    <WeekAccordion
      weeks={['2026-09-07']}
      model={model}
      scheduleResult={emptyResult}
      onOverride={noop}
      onRevert={noop}
      onClearOverrides={noop}
      onViewPerson={noop}
    />,
  );
}

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('WeekAccordion: team capacity counts exactly the people on show', () => {
  it('sums the manager and report tables', () => {
    renderAccordion(modelWith([manager, report]));
    // Two people, five clear weekdays: 2 x 37.5h.
    expect(screen.getByText('team capacity 75.0h')).toBeInTheDocument();
  });

  it('does not count a person neither table renders', () => {
    renderAccordion(modelWith([manager, report, contractor]));
    expect(screen.getByText('team capacity 75.0h')).toBeInTheDocument();
    expect(screen.queryByText('team capacity 112.5h')).not.toBeInTheDocument();
  });
});
