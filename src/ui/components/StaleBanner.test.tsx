import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StaleBanner } from './StaleBanner';

describe('StaleBanner', () => {
  it('renders nothing when the schedule is current', () => {
    const { container } = render(<StaleBanner isStale={false} reason="" onRecalculate={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('names what went stale', () => {
    render(<StaleBanner isStale reason="Allocations changed for September" onRecalculate={vi.fn()} />);
    expect(screen.getByText(/Allocations changed for September/)).toBeInTheDocument();
  });

  it('calls back when recalculate is pressed', async () => {
    const onRecalculate = vi.fn();
    render(<StaleBanner isStale reason="x" onRecalculate={onRecalculate} />);
    await userEvent.click(screen.getByRole('button', { name: /recalculate/i }));
    expect(onRecalculate).toHaveBeenCalledOnce();
  });
});
