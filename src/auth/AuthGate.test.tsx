import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Session, User } from '@supabase/supabase-js';

// AuthGate's import graph reaches `./client` via both `useSession` and
// `SignInPage` (which calls `supabase.auth.*` directly) — A8 requires it be
// mocked even though this file drives the gate through a mocked
// `useSession` rather than the real client calls.
vi.mock('./client', () => ({
  supabase: {
    auth: {
      onAuthStateChange: vi.fn(),
      signOut: vi.fn(),
      signInWithPassword: vi.fn(),
      signUp: vi.fn(),
    },
    from: vi.fn(),
  },
}));

vi.mock('./useSession', () => ({ useSession: vi.fn() }));

import { useSession } from './useSession';
import type { Profile, UseSessionResult } from './useSession';
import { AuthGate } from './AuthGate';

const mockedUseSession = useSession as unknown as Mock<() => UseSessionResult>;

function makeUser(id: string, email: string): User {
  return {
    id,
    email,
    app_metadata: {},
    user_metadata: {},
    aud: 'authenticated',
    created_at: '2026-01-01T00:00:00.000Z',
  };
}

function makeSession(id: string, email: string): Session {
  return {
    access_token: 'access-token',
    refresh_token: 'refresh-token',
    expires_in: 3600,
    token_type: 'bearer',
    user: makeUser(id, email),
  };
}

function makeProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    id: 'user-1',
    email: 'alice@example.com',
    approved: false,
    isOwner: false,
    ...overrides,
  };
}

function setSession(result: Partial<UseSessionResult>): void {
  mockedUseSession.mockReturnValue({
    session: null,
    profile: null,
    loading: false,
    databaseUnreachable: false,
    signOut: vi.fn(),
    ...result,
  });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('AuthGate', () => {
  it('shows the sign-in page when there is no session', () => {
    setSession({ session: null, profile: null, loading: false });

    render(
      <AuthGate>
        <div>App content</div>
      </AuthGate>,
    );

    expect(screen.getByRole('heading', { name: /^sign in$/i })).toBeInTheDocument();
    expect(screen.queryByText('App content')).not.toBeInTheDocument();
  });

  it('shows the pending screen for a session whose profile is not approved', () => {
    const session = makeSession('user-1', 'alice@example.com');
    setSession({ session, profile: makeProfile({ approved: false }), loading: false });

    render(
      <AuthGate>
        <div>App content</div>
      </AuthGate>,
    );

    expect(screen.getByRole('heading', { name: /waiting for approval/i })).toBeInTheDocument();
    expect(screen.queryByText('App content')).not.toBeInTheDocument();
  });

  it('shows the pending screen, not the app, for a session whose profile is null', () => {
    // The row can be null because the sign-up trigger hasn't written it yet,
    // or because the fetch failed — either way it must not reach children.
    const session = makeSession('brand-new-user', 'brand-new@example.com');
    setSession({ session, profile: null, loading: false });

    render(
      <AuthGate>
        <div>App content</div>
      </AuthGate>,
    );

    expect(screen.getByRole('heading', { name: /waiting for approval/i })).toBeInTheDocument();
    expect(screen.queryByText('App content')).not.toBeInTheDocument();
  });

  it('shows the database-asleep screen, NOT the pending screen, when the profile fetch could not reach the database', () => {
    // H1. A paused Supabase project fails the profile fetch, which used to
    // collapse to `profile: null` and render "Waiting for approval" — telling
    // the OWNER to wait for an approval only they can give, from behind a gate
    // only they can pass. The two causes are now distinct, and so is the copy.
    const session = makeSession('owner-1', 'owner@example.com');
    setSession({ session, profile: null, databaseUnreachable: true, loading: false });

    render(
      <AuthGate>
        <div>App content</div>
      </AuthGate>,
    );

    expect(screen.getByRole('heading', { name: /could not reach the database/i })).toBeInTheDocument();
    expect(screen.getByText(/asleep|sleep/i)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /waiting for approval/i })).not.toBeInTheDocument();
    expect(screen.queryByText('App content')).not.toBeInTheDocument();
  });

  it('shows the pending screen, not the asleep screen, for a null profile from a fetch that succeeded', () => {
    // The handle_new_user trigger race: the fetch worked, there was no row.
    // This must keep its original behaviour — the asleep screen would be a
    // lie, and would hide a genuinely pending account from its own message.
    const session = makeSession('brand-new-user', 'brand-new@example.com');
    setSession({ session, profile: null, databaseUnreachable: false, loading: false });

    render(
      <AuthGate>
        <div>App content</div>
      </AuthGate>,
    );

    expect(screen.getByRole('heading', { name: /waiting for approval/i })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /could not reach the database/i })).not.toBeInTheDocument();
    expect(screen.queryByText('App content')).not.toBeInTheDocument();
  });

  it('renders the app for an approved session', () => {
    const session = makeSession('user-1', 'alice@example.com');
    setSession({ session, profile: makeProfile({ approved: true }), loading: false });

    render(
      <AuthGate>
        <div>App content</div>
      </AuthGate>,
    );

    expect(screen.getByText('App content')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /^sign in$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /waiting for approval/i })).not.toBeInTheDocument();
  });

  it('shows nothing but a loading state while the session resolves', () => {
    setSession({ session: null, profile: null, loading: true });

    render(
      <AuthGate>
        <div>App content</div>
      </AuthGate>,
    );

    expect(screen.queryByText('App content')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /^sign in$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /waiting for approval/i })).not.toBeInTheDocument();
    expect(screen.getByRole('status', { name: /loading/i })).toBeInTheDocument();
  });
});
