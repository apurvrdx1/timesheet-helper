import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PendingApproval } from './PendingApproval';

// This component takes its data and its sign-out action as props — it never
// reaches `./client` itself, so unlike SignInPage/AuthGate it needs no
// `vi.mock('./client', ...)` (see A8 in the plan amendments).

describe('PendingApproval', () => {
  it('states plainly that the account is waiting for approval', () => {
    render(<PendingApproval email="alice@example.com" onSignOut={vi.fn()} />);

    expect(screen.getByRole('heading', { name: /waiting for approval/i })).toBeInTheDocument();
    expect(screen.getByText(/waiting for an owner to approve it/i)).toBeInTheDocument();
    expect(screen.getByText(/alice@example.com/)).toBeInTheDocument();
  });

  it('offers sign-out, and calls it when clicked', async () => {
    const onSignOut = vi.fn().mockResolvedValue(undefined);
    render(<PendingApproval email="alice@example.com" onSignOut={onSignOut} />);

    await userEvent.click(screen.getByRole('button', { name: /sign out/i }));

    expect(onSignOut).toHaveBeenCalledTimes(1);
  });

  it('does not render the account email when it is unknown', () => {
    render(<PendingApproval email="" onSignOut={vi.fn()} />);

    expect(screen.queryByText(/signed in as/i)).not.toBeInTheDocument();
  });
});
