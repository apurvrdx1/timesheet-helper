import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

// `client.ts` throws at module scope when the Supabase env vars are absent —
// A8's rule: every test whose import graph reaches it must mock it.
vi.mock('./client', () => ({ supabase: { from: vi.fn() } }));

import { supabase } from './client';
import { usePendingCount } from './usePendingCount';

interface CountResult {
  count: number | null;
  error: { message: string } | null;
}

interface Recorder {
  select: Mock;
  eq: Mock;
  not: Mock;
}

/** A PostgREST builder stub that records how it was called and resolves to
 *  `result` whenever the caller awaits it. */
function stubQuery(result: CountResult): Recorder {
  const settled = Promise.resolve(result);
  const chain = {
    select: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    not: vi.fn(() => chain),
    then: (onFulfilled: unknown, onRejected: unknown) =>
      settled.then(
        onFulfilled as (value: CountResult) => unknown,
        onRejected as (reason: unknown) => unknown,
      ),
  };
  (supabase.from as unknown as Mock).mockReturnValue(chain);
  return chain;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('usePendingCount', () => {
  it('counts accounts that are waiting and can actually be approved', async () => {
    const chain = stubQuery({ count: 3, error: null });

    const { result } = renderHook(() => usePendingCount(true, 'setup'));
    await waitFor(() => expect(result.current).toBe(3));

    // A head-only exact count: the badge needs the number, never the rows.
    expect(chain.select).toHaveBeenCalledWith('id', { count: 'exact', head: true });
    expect(chain.eq).toHaveBeenCalledWith('approved', false);
    // The half that keeps the badge honest: AdminPage disables Approve until
    // the address is confirmed, so counting unconfirmed registrations would
    // put up a number no action can clear.
    expect(chain.not).toHaveBeenCalledWith('email_confirmed_at', 'is', null);
  });

  it('asks nothing at all when the account is not the owner', () => {
    stubQuery({ count: 3, error: null });

    const { result } = renderHook(() => usePendingCount(false, 'setup'));

    expect(supabase.from).not.toHaveBeenCalled();
    expect(result.current).toBeNull();
  });

  it('re-counts when the refresh key changes, so approving clears the badge', async () => {
    stubQuery({ count: 2, error: null });

    const { result, rerender } = renderHook(
      ({ tab }: { tab: string }) => usePendingCount(true, tab),
      { initialProps: { tab: 'admin' } },
    );
    await waitFor(() => expect(result.current).toBe(2));

    stubQuery({ count: 0, error: null });
    rerender({ tab: 'setup' });
    await waitFor(() => expect(result.current).toBe(0));
  });

  it('shows no number rather than a wrong one when the count fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubQuery({ count: null, error: { message: 'permission denied' } });

    const { result } = renderHook(() => usePendingCount(true, 'setup'));
    await waitFor(() => expect(warn).toHaveBeenCalled());

    expect(result.current).toBeNull();
  });
});
