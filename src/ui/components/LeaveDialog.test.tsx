import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LeaveDialog } from './LeaveDialog';
import type { Otl, Person } from '../../domain/types';

const person: Person = { id: 'p1', name: 'Ada Lovelace', role: 'MANAGER', managerId: null };
const vacationOtl: Otl = {
  projectCode: 'LEAVE-VAC', taskCode: 'T', expenditureTypeCode: 'E', timeReportingCode: 'R',
  category: 'LEAVE', leaveSubtype: 'VACATION', isDefaultOpex: false, colorIndex: 0, active: true,
};

/** Two days in the current month, far enough apart to be unambiguous, and
 * far from month boundaries so navigation is never required regardless of
 * what day of the month the suite happens to run on. */
function currentMonthDays(): { early: string; late: string } {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  return { early: `${year}-${month}-05`, late: `${year}-${month}-15` };
}

async function openRange(): Promise<void> {
  await userEvent.click(screen.getByRole('button', { name: /date range/i }));
}

describe('LeaveDialog', () => {
  it('submits a well-formed LeaveRange when everything is filled in', async () => {
    const onSubmit = vi.fn();
    const { container } = render(
      <LeaveDialog isOpen onOpenChange={vi.fn()} people={[person]} leaveOtls={[vacationOtl]} onSubmit={onSubmit} />,
    );

    await userEvent.click(screen.getByRole('combobox', { name: /^person/i }));
    await userEvent.click(await screen.findByRole('option', { name: /ada lovelace/i }));

    const { early, late } = currentMonthDays();
    await openRange();
    // Astryx's Calendar day buttons carry `data-date` (an ISO string) as a
    // stable, locale-independent hook — the accessible name is a formatted,
    // locale-dependent sentence, so `data-date` is the reliable selector.
    // The two picks must go through `userEvent.click` (awaited, one at a
    // time) rather than a raw DOM `.click()`: React 18 batches state updates
    // from unawaited native events, so two synchronous raw clicks can both
    // land before a re-render and get treated as two "first" picks instead
    // of a start-then-end pair.
    await userEvent.click(container.querySelector(`[data-date="${early}"]`) as HTMLElement);
    await userEvent.click(container.querySelector(`[data-date="${late}"]`) as HTMLElement);

    await userEvent.click(screen.getByRole('combobox', { name: /leave type/i }));
    await userEvent.click(await screen.findByRole('option', { name: /vacation/i }));

    await userEvent.click(screen.getByRole('button', { name: /add leave/i }));

    expect(onSubmit).toHaveBeenCalledWith({
      personId: 'p1',
      startDate: early,
      endDate: late,
      otlProjectCode: 'LEAVE-VAC',
    });
  });

  it('refuses to submit when the form is incomplete', async () => {
    const onSubmit = vi.fn();
    render(
      <LeaveDialog isOpen onOpenChange={vi.fn()} people={[person]} leaveOtls={[vacationOtl]} onSubmit={onSubmit} />,
    );

    // Nothing chosen at all: person, range, and leave type all missing.
    await userEvent.click(screen.getByRole('button', { name: /add leave/i }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(await screen.findByText(/choose a person, a date range, and a leave type/i)).toBeInTheDocument();
  });

  it('normalizes a reverse pick so the range is always chronological, never end-before-start', async () => {
    // Astryx's Calendar itself enforces start <= end: picking the later day
    // first and the earlier day second still produces a chronologically
    // ordered {start, end} (it swaps internally). So "end precedes start"
    // can never reach handleSubmit through real interaction — this test
    // proves that guarantee holds through LeaveDialog rather than assuming
    // it, by clicking the later day first.
    const onSubmit = vi.fn();
    const { container } = render(
      <LeaveDialog isOpen onOpenChange={vi.fn()} people={[person]} leaveOtls={[vacationOtl]} onSubmit={onSubmit} />,
    );

    await userEvent.click(screen.getByRole('combobox', { name: /^person/i }));
    await userEvent.click(await screen.findByRole('option', { name: /ada lovelace/i }));

    const { early, late } = currentMonthDays();
    await openRange();
    await userEvent.click(container.querySelector(`[data-date="${late}"]`) as HTMLElement);
    await userEvent.click(container.querySelector(`[data-date="${early}"]`) as HTMLElement);

    await userEvent.click(screen.getByRole('combobox', { name: /leave type/i }));
    await userEvent.click(await screen.findByRole('option', { name: /vacation/i }));

    await userEvent.click(screen.getByRole('button', { name: /add leave/i }));

    expect(onSubmit).toHaveBeenCalledWith({
      personId: 'p1',
      startDate: early,
      endDate: late,
      otlProjectCode: 'LEAVE-VAC',
    });
  });
});
