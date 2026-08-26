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

  /**
   * The regression for the split between `source` (lock this cell) and
   * `overrideBlocks` (this much was typed). The optimizer may top a pinned
   * default-OPEX cell up to a full 7.5h day, so the cell total and the pin
   * legitimately differ — and Enter on a pinned cell must re-commit the pin,
   * never the total the optimizer arrived at.
   */
  it('commits the pinned hours, not the topped-up total, when Enter confirms a locked cell', async () => {
    const onOverride = vi.fn();
    render(
      <HourCell {...base} hours={7.5} source="OVERRIDE" overrideHours={2} onOverride={onOverride} />,
    );
    await userEvent.click(screen.getByRole('spinbutton'));
    await userEvent.keyboard('{Enter}');
    expect(onOverride).toHaveBeenCalledWith(2);
  });

  it('reads the cell total at rest while the lock names the hours actually pinned', () => {
    render(<HourCell {...base} hours={7.5} source="OVERRIDE" overrideHours={2} />);
    expect(screen.getByText('7.5')).toBeInTheDocument();
    expect(screen.getByLabelText(/2\.0h manually set/i)).toBeInTheDocument();
    expect(screen.getByRole('spinbutton')).toHaveValue('2.0');
  });

  it('keeps the plain lock wording when the whole cell is the pin', () => {
    render(<HourCell {...base} hours={4} source="OVERRIDE" overrideHours={4} />);
    expect(screen.getByLabelText('Manually set — recalculation will preserve this')).toBeInTheDocument();
  });

  // N8: the visible span carries the TOTAL and is aria-hidden; the input's
  // accessible value is the PIN. Where the two differ, a screen-reader user
  // heard "2.0" for a cell a sighted user reads as "7.5", with nothing in
  // the announcement to reconcile them.
  it('names both the pin and the cell total on the field itself when they differ', () => {
    render(<HourCell {...base} hours={7.5} source="OVERRIDE" overrideHours={2} />);

    const field = screen.getByRole('spinbutton');
    expect(field).toHaveAccessibleName(/2\.0h you set/i);
    expect(field).toHaveAccessibleName(/totals 7\.5h/i);
    // The cell it belongs to is still identified.
    expect(field).toHaveAccessibleName(/P-1001 hours for p1, 2026-09-07/);
  });

  it('leaves the field name plain when the pin is the whole cell', () => {
    render(<HourCell {...base} hours={4} source="OVERRIDE" overrideHours={4} />);
    expect(screen.getByRole('spinbutton'))
      .toHaveAccessibleName('P-1001 hours for p1, 2026-09-07');
  });

  it('leaves the field name plain on a calculated cell', () => {
    render(<HourCell {...base} />);
    expect(screen.getByRole('spinbutton'))
      .toHaveAccessibleName('P-1001 hours for p1, 2026-09-07');
  });
});
