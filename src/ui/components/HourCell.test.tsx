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
});
