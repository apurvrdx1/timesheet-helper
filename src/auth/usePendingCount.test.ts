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
  is: Mock;
}

/** A PostgREST builder stub that records how it was called and resolves to
 *  `result` whenever the caller awaits it. */
function stubQuery(result: CountResult): Recorder {
  const settled = Promise.resolve(result);
  const chain = {
    select: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    not: vi.fn(() => chain),
    is: vi.fn(() => chain),
    then: (onFulfilled: unknown, onRejected: unknown) =>
      settled.then(
        onFulfilled as (value: CountResult) => unknown,
        onRejected as (reason: unknown) => unknown,
      ),
  };
  (supabase.from as unknown as Mock).mockReturnValue(chain);
  return chain;
}

/** One `profiles` row, in the shape the badge's query filters on. */
interface ProfileRow {
  approved: boolean;
  email_confirmed_at: string | null;
  revoked_at: string | null;
}

/**
 * A PostgREST stub that actually APPLIES the filters it is given to a set of
 * rows, rather than only recording them.
 *
 * `stubQuery` above proves which filters were requested; this proves what they
 * select. The bug it exists for (pre-merge review M1) was not a missing call
 * but a wrong result: `approved = false AND email_confirmed_at IS NOT NULL`
 * reads as "waiting" and matches a REVOKED account too, so revoking someone
 * left a "1 waiting" badge that no action but re-approving them could clear.
 * Only a stub that filters rows can tell those two apart.
 */
function stubRows(rows: ProfileRow[]): void {
  const filters: ((row: ProfileRow) => boolean)[] = [];
  const value = (row: ProfileRow, column: string): unknown =>
    (row as unknown as Record<string, unknown>)[column];
  const chain = {
    select: vi.fn(() => chain),
    eq: vi.fn((column: string, expected: unknown) => {
      filters.push((row) => value(row, column) === expected);
      return chain;
    }),
    not: vi.fn((column: string, operator: string, expected: unknown) => {
      if (operator !== 'is') throw new Error(`unsupported operator: ${operator}`);
      filters.push((row) => value(row, column) !== expected);
      return chain;
    }),
    is: vi.fn((column: string, expected: unknown) => {
      filters.push((row) => value(row, column) === expected);
      return chain;
    }),
    then: (onFulfilled: unknown, onRejected: unknown) =>
      Promise.resolve({
        count: rows.filter((row) => filters.every((match) => match(row))).length,
        error: null,
      }).then(
        onFulfilled as (value: CountResult) => unknown,
        onRejected as (reason: unknown) => unknown,
      ),
  };
  (supabase.from as unknown as Mock).mockReturnValue(chain);
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
    // The other half: a revoked account is not waiting for anything.
    expect(chain.is).toHaveBeenCalledWith('revoked_at', null);
  });

  it('does not count an account that was approved and then revoked', async () => {
    // M1. A revoked account has `approved = false` and a confirmed address,
    // exactly like one that has never been decided on — so the badge counted
    // it forever, and the only in-app action that cleared it was re-approving
    // the person just revoked. "Waiting" means awaiting a FIRST decision.
    stubRows([
      { approved: false, email_confirmed_at: '2026-08-01T00:00:00Z', revoked_at: null },
      { approved: false, email_confirmed_at: '2026-08-01T00:00:00Z', revoked_at: '2026-08-20T00:00:00Z' },
    ]);

    const { result } = renderHook(() => usePendingCount(true, 'setup'));

    await waitFor(() => expect(result.current).toBe(1));
  });

  it('counts nothing at all once the only waiting account is revoked', async () => {
    // The badge has to reach zero, or it is a nag no action can clear —
    // this project's named recurring failure mode.
    stubRows([
      { approved: false, email_confirmed_at: '2026-08-01T00:00:00Z', revoked_at: '2026-08-20T00:00:00Z' },
      { approved: true, email_confirmed_at: '2026-08-01T00:00:00Z', revoked_at: null },
      { approved: false, email_confirmed_at: null, revoked_at: null },
    ]);

    const { result } = renderHook(() => usePendingCount(true, 'setup'));

    await waitFor(() => expect(result.current).toBe(0));
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
