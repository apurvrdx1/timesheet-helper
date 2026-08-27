import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { AuthChangeEvent, Session, Subscription, User } from '@supabase/supabase-js';
import { PostgrestError } from '@supabase/supabase-js';

// `client.ts` throws at module scope when the Supabase env vars are absent,
// which they are under `npx vitest run` (no `.env.local` in CI). Any test
// whose import graph reaches `./client` — this one, and every later test
// that imports something built on `useSession` — must mock it exactly this
// way rather than let the real module load.
vi.mock('./client', () => ({
  supabase: {
    auth: {
      onAuthStateChange: vi.fn(),
      signOut: vi.fn(),
    },
    from: vi.fn(),
  },
}));

import { supabase } from './client';
import { useSession } from './useSession';

interface ProfileRow {
  id: string;
  email: string;
  approved: boolean;
  is_owner: boolean;
}

type MaybeSingleResult = { data: ProfileRow | null; error: PostgrestError | null };

type OnAuthStateChangeCallback = (event: AuthChangeEvent, session: Session | null) => void;

// The real `supabase` export is a fully-typed `SupabaseClient`, whose
// `.from()`/`.auth.onAuthStateChange()` overloads are too elaborate to hand
// a plain mock implementation without lying about types. This narrows the
// mocked module down to exactly the three methods this hook calls, typed
// as vitest mocks rather than `any`.
interface MockedSupabase {
  auth: {
    onAuthStateChange: Mock<(callback: OnAuthStateChangeCallback) => {
      data: { subscription: Subscription };
    }>;
    signOut: Mock<() => Promise<{ error: PostgrestError | null }>>;
  };
  from: Mock<(table: string) => { select: Mock<(columns: string) => unknown> }>;
}

const mockedSupabase = supabase as unknown as MockedSupabase;

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

/** Wires `supabase.from('profiles').select(...).eq(...).maybeSingle()` to
 * resolve with `result`, matching the real chain shape one call at a time. */
function mockFromChain(result: MaybeSingleResult): void {
  const maybeSingle = vi.fn().mockResolvedValue(result);
  const eq = vi.fn().mockReturnValue({ maybeSingle });
  const select = vi.fn().mockReturnValue({ eq });
  mockedSupabase.from.mockReturnValue({ select });
}

/** Captures the sync callback passed to `onAuthStateChange` so a test can
 * fire auth events by hand, and returns the `unsubscribe` spy alongside it. */
function mockAuthStateChange(): {
  emit: (event: AuthChangeEvent, session: Session | null) => void;
  unsubscribe: Mock<() => void>;
} {
  const unsubscribe: Mock<() => void> = vi.fn();
  let callback: OnAuthStateChangeCallback | null = null;

  mockedSupabase.auth.onAuthStateChange.mockImplementation((cb) => {
    callback = cb;
    return { data: { subscription: { id: 'sub-1', callback: cb, unsubscribe } } };
  });

  return {
    emit: (event, session) => {
      if (callback === null) {
        throw new Error('onAuthStateChange callback was never registered');
      }
      act(() => {
        (callback as OnAuthStateChangeCallback)(event, session);
      });
    },
    unsubscribe,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('useSession', () => {
  it('reports loading first, then resolves to a session and its profile', async () => {
    const { emit } = mockAuthStateChange();
    mockFromChain({
      data: { id: 'user-1', email: 'alice@example.com', approved: true, is_owner: false },
      error: null,
    });

    const { result } = renderHook(() => useSession());

    expect(result.current.loading).toBe(true);
    expect(result.current.session).toBeNull();
    expect(result.current.profile).toBeNull();

    emit('INITIAL_SESSION', makeSession('user-1'));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.session?.user.id).toBe('user-1');
    expect(result.current.profile).toEqual({
      id: 'user-1',
      email: 'alice@example.com',
      approved: true,
      isOwner: false,
    });
  });

  it('signOut clears both the session and the profile', async () => {
    const { emit } = mockAuthStateChange();
    mockFromChain({
      data: { id: 'user-1', email: 'alice@example.com', approved: true, is_owner: true },
      error: null,
    });
    mockedSupabase.auth.signOut.mockResolvedValue({ error: null });

    const { result } = renderHook(() => useSession());
    emit('INITIAL_SESSION', makeSession('user-1'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.session).not.toBeNull();
    expect(result.current.profile).not.toBeNull();

    await act(async () => {
      await result.current.signOut();
    });

    expect(result.current.session).toBeNull();
    expect(result.current.profile).toBeNull();
    expect(mockedSupabase.auth.signOut).toHaveBeenCalledTimes(1);
  });

  it('yields profile: null, not a throw, when the profile row does not exist yet', async () => {
    // The handle_new_user trigger races the first client read after
    // sign-up. `.maybeSingle()` returns { data: null, error: null } for
    // zero rows — this must not be treated as a failure.
    const { emit } = mockAuthStateChange();
    mockFromChain({ data: null, error: null });

    const { result } = renderHook(() => useSession());
    emit('INITIAL_SESSION', makeSession('brand-new-user'));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.profile).toBeNull();
    expect(result.current.session?.user.id).toBe('brand-new-user');
  });

  it('yields profile: null and does not crash when the profile fetch errors', async () => {
    const { emit } = mockAuthStateChange();
    mockFromChain({
      data: null,
      error: new PostgrestError({
        message: 'permission denied',
        details: '',
        hint: '',
        code: '42501',
      }),
    });

    const { result } = renderHook(() => useSession());

    expect(() => emit('INITIAL_SESSION', makeSession('user-1'))).not.toThrow();

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.profile).toBeNull();
  });

  it('unsubscribes from auth changes on unmount', () => {
    const { unsubscribe } = mockAuthStateChange();
    mockFromChain({ data: null, error: null });

    const { unmount } = renderHook(() => useSession());
    expect(unsubscribe).not.toHaveBeenCalled();

    unmount();

    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
