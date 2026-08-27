import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Session, User } from '@supabase/supabase-js';
import { PostgrestError } from '@supabase/supabase-js';

// `client.ts` throws at module scope when the Supabase env vars are absent
// (true under `npx vitest run` with no `.env.local`). Any test whose import
// graph reaches it must mock it — see `src/auth/useSession.test.ts`, the
// pattern amendment A8 says to copy verbatim.
vi.mock('../../auth/client', () => ({
  supabase: {
    from: vi.fn(),
  },
}));

// `useSession`'s own mechanics (auth events, profile fetch race handling)
// are exhaustively covered by `useSession.test.ts`. Mocking it directly here
// keeps these tests focused on `AdminPage`'s own logic — which account is
// "self", approve/revoke gating, error handling — the same choice Task 6
// made for `AuthGate.test.tsx`.
vi.mock('../../auth/useSession', () => ({
  useSession: vi.fn(),
}));

import { supabase } from '../../auth/client';
import { useSession } from '../../auth/useSession';
import { AdminPage } from './AdminPage';

interface ProfileRow {
  id: string;
  email: string;
  approved: boolean;
  is_owner: boolean;
  created_at: string;
  email_confirmed_at: string | null;
}

interface ListResult {
  data: ProfileRow[] | null;
  error: PostgrestError | null;
}

interface UpdateResult {
  error: PostgrestError | null;
}

// Narrows the mocked client down to exactly the shape `AdminPage` calls,
// the same convention `useSession.test.ts` uses for its own mock.
interface MockedSupabase {
  from: Mock<
    (table: string) => {
      select: Mock<(columns: string) => { order: Mock<(...args: unknown[]) => unknown> }>;
      update: Mock<(payload: Record<string, unknown>) => { eq: Mock<(...args: unknown[]) => unknown> }>;
    }
  >;
}

const mockedSupabase = supabase as unknown as MockedSupabase;
const mockedUseSession = useSession as unknown as Mock<() => {
  session: Session | null;
  profile: null;
  loading: boolean;
  signOut: () => Promise<void>;
}>;

function makeUser(id: string): User {
  return {
    id,
    app_metadata: {},
    user_metadata: {},
    aud: 'authenticated',
    created_at: '2026-01-01T00:00:00.000Z',
  };
}

function makeSession(userId: string): Session {
  return {
    access_token: 'access-token',
    refresh_token: 'refresh-token',
    expires_in: 3600,
    token_type: 'bearer',
    user: makeUser(userId),
  };
}

function setCurrentUser(userId: string): void {
  mockedUseSession.mockReturnValue({
    session: makeSession(userId),
    profile: null,
    loading: false,
    signOut: vi.fn(),
  });
}

/** Wires `supabase.from('profiles').select(...).order(...).order(...)` (the
 * list fetch) and `.update(...).eq(...)` (approve/revoke) to the given
 * results, matching the real chain shape one call at a time. Returns the
 * `eq` spy so a test can reconfigure the update outcome mid-test. */
function mockFrom(
  list: ListResult,
  update: UpdateResult = { error: null },
): { eq: Mock<(...args: unknown[]) => Promise<UpdateResult>> } {
  const order2 = vi.fn().mockResolvedValue(list);
  const order1 = vi.fn().mockReturnValue({ order: order2 });
  const select = vi.fn().mockReturnValue({ order: order1 });

  const eq: Mock<(...args: unknown[]) => Promise<UpdateResult>> = vi.fn().mockResolvedValue(update);
  const updateFn = vi.fn().mockReturnValue({ eq });

  mockedSupabase.from.mockReturnValue({ select, update: updateFn });
  return { eq };
}

const OWNER: ProfileRow = {
  id: 'owner-1',
  email: 'owner@example.com',
  approved: true,
  is_owner: true,
  created_at: '2026-01-01T00:00:00.000Z',
  email_confirmed_at: '2026-01-01T00:00:00.000Z',
};

const PENDING_UNVERIFIED: ProfileRow = {
  id: 'pending-unverified-1',
  email: 'unverified@example.com',
  approved: false,
  is_owner: false,
  created_at: '2026-08-20T00:00:00.000Z',
  email_confirmed_at: null,
};

const PENDING_VERIFIED: ProfileRow = {
  id: 'pending-verified-1',
  email: 'verified-pending@example.com',
  approved: false,
  is_owner: false,
  created_at: '2026-08-21T00:00:00.000Z',
  email_confirmed_at: '2026-08-21T00:00:00.000Z',
};

const APPROVED_OTHER: ProfileRow = {
  id: 'approved-1',
  email: 'approved@example.com',
  approved: true,
  is_owner: false,
  created_at: '2026-01-05T00:00:00.000Z',
  email_confirmed_at: '2026-01-05T00:00:00.000Z',
};

afterEach(() => {
  vi.clearAllMocks();
});

describe('AdminPage', () => {
  it('lists accounts, pending first', async () => {
    setCurrentUser('owner-1');
    // The query itself orders pending-before-approved (Postgres sorts
    // `false` before `true`); this fixture mirrors what the server would
    // hand back, so the assertion is that rendering preserves that order.
    mockFrom({ data: [PENDING_UNVERIFIED, PENDING_VERIFIED, OWNER, APPROVED_OTHER], error: null });

    render(<AdminPage />);

    await waitFor(() => expect(screen.getByText(PENDING_UNVERIFIED.email)).toBeInTheDocument());

    const rows = screen.getAllByRole('row');
    const emailIndex = (email: string): number =>
      rows.findIndex((row) => within(row).queryByText(email) !== null);

    expect(emailIndex(PENDING_UNVERIFIED.email)).toBeGreaterThan(0);
    expect(emailIndex(PENDING_UNVERIFIED.email)).toBeLessThan(emailIndex(OWNER.email));
    expect(emailIndex(PENDING_VERIFIED.email)).toBeLessThan(emailIndex(APPROVED_OTHER.email));
  });

  it('approves an account', async () => {
    const user = userEvent.setup();
    setCurrentUser('owner-1');
    const { eq } = mockFrom({ data: [PENDING_VERIFIED], error: null });

    render(<AdminPage />);

    await waitFor(() => expect(screen.getByText(PENDING_VERIFIED.email)).toBeInTheDocument());
    expect(screen.getByText('Pending approval')).toBeInTheDocument();

    const approveButton = screen.getByRole('button', { name: `Approve ${PENDING_VERIFIED.email}` });
    expect(approveButton).not.toHaveAttribute('aria-disabled', 'true');
    expect(approveButton).not.toBeDisabled();

    await user.click(approveButton);

    await waitFor(() => expect(screen.getByText('Approved')).toBeInTheDocument());
    expect(screen.queryByText('Pending approval')).not.toBeInTheDocument();
    expect(eq).toHaveBeenCalledWith('id', PENDING_VERIFIED.id);
  });

  it('disables Approve for an unverified email, with a visible reason', async () => {
    setCurrentUser('owner-1');
    mockFrom({ data: [PENDING_UNVERIFIED], error: null });

    render(<AdminPage />);

    await waitFor(() => expect(screen.getByText(PENDING_UNVERIFIED.email)).toBeInTheDocument());

    const approveButton = screen.getByRole('button', { name: `Approve ${PENDING_UNVERIFIED.email}` });
    expect(approveButton).toHaveAttribute('aria-disabled', 'true');

    // The reason is rendered as plain text, not only a hover tooltip — a
    // greyed-out button with no visible explanation is a puzzle, not a
    // safeguard. (The button also carries the same text as a `tooltip`, so
    // more than one match is expected; what matters is that it is not
    // hover-only.)
    expect(screen.getAllByText('Waiting on email confirmation.').length).toBeGreaterThan(0);
  });

  it('puts revoke behind a confirmation whose copy says data is kept', async () => {
    const user = userEvent.setup();
    setCurrentUser('owner-1');
    mockFrom({ data: [APPROVED_OTHER], error: null });

    render(<AdminPage />);

    await waitFor(() => expect(screen.getByText(APPROVED_OTHER.email)).toBeInTheDocument());

    const revokeButton = screen.getByRole('button', { name: `Revoke ${APPROVED_OTHER.email}` });
    await user.click(revokeButton);

    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/data is kept/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/approving them again restores it/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/lose access immediately/i)).toBeInTheDocument();
  });

  it('shows no revoke control on the owner\'s own row', async () => {
    setCurrentUser('owner-1');
    mockFrom({ data: [OWNER], error: null });

    render(<AdminPage />);

    await waitFor(() => expect(screen.getByText(OWNER.email)).toBeInTheDocument());

    expect(screen.queryByRole('button', { name: `Revoke ${OWNER.email}` })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Revoke/ })).not.toBeInTheDocument();
  });

  it('says plainly when nobody is waiting', async () => {
    setCurrentUser('owner-1');
    mockFrom({ data: [OWNER, APPROVED_OTHER], error: null });

    render(<AdminPage />);

    await waitFor(() => expect(screen.getByText('Nobody is waiting for approval.')).toBeInTheDocument());
  });

  it('surfaces an error rather than silently doing nothing when approve fails', async () => {
    const user = userEvent.setup();
    setCurrentUser('owner-1');
    mockFrom(
      { data: [PENDING_VERIFIED], error: null },
      { error: new PostgrestError({ message: 'connection reset', details: '', hint: '', code: '08006' }) },
    );

    render(<AdminPage />);

    await waitFor(() => expect(screen.getByText(PENDING_VERIFIED.email)).toBeInTheDocument());

    const approveButton = screen.getByRole('button', { name: `Approve ${PENDING_VERIFIED.email}` });
    await user.click(approveButton);

    await waitFor(() =>
      expect(
        screen.getByText(`Could not approve ${PENDING_VERIFIED.email}: connection reset`),
      ).toBeInTheDocument(),
    );
    // The row must not have been silently marked approved.
    expect(screen.getByText('Pending approval')).toBeInTheDocument();
    expect(screen.queryByText('Approved')).not.toBeInTheDocument();
  });
});
