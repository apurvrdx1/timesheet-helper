import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

// `client.ts` throws at module scope when the Supabase env vars are absent
// (true under `npx vitest run` with no `.env.local`). `store.ts` reaches it
// to build its default adapter, so any test whose import graph touches the
// store must mock it — the pattern amendment A8 says to copy verbatim.
// Every test below injects its own fake adapter, so nothing here is called.
vi.mock('../auth/client', () => ({ supabase: {} }));

import { useStore } from './store';
import { INSUFFICIENT_PRIVILEGE, StorageError } from './modelAdapter';
import type { StorageAdapter, StoredState } from './modelAdapter';
import type { Model, ScheduleEntry } from '../domain/types';

const emptyModel: Model = {
  otls: [], people: [], statHolidays: [], allocations: [], leave: [], overrides: [],
};

const EMPTY_STATE: StoredState = { model: emptyModel, entries: [], hash: null };

interface FakeAdapter extends StorageAdapter {
  read: Mock<() => Promise<StoredState>>;
  write: Mock<(state: StoredState) => Promise<void>>;
}

function adapterReading(state: StoredState = EMPTY_STATE): FakeAdapter {
  return {
    read: vi.fn(async () => state),
    write: vi.fn(async () => {}),
  };
}

function adapterFailingToRead(error: unknown): FakeAdapter {
  return {
    read: vi.fn(async () => {
      throw error;
    }),
    write: vi.fn(async () => {}),
  };
}

const notApproved = (): StorageError =>
  new StorageError('this account is not approved to read its state', {
    code: INSUFFICIENT_PRIVILEGE,
  });

const addAPerson = (model: Model): Model => ({
  ...model,
  people: [...model.people, { id: 'p2', name: 'Sam', role: 'REPORT', managerId: null }],
});

/** A model that plainly implies a schedule but has nothing allocated. */
const withOverridesButNoAllocations = (model: Model): Model => ({
  ...model,
  otls: [{
    projectCode: 'OPEX-ADMIN', taskCode: 'T0', expenditureTypeCode: 'E0',
    timeReportingCode: 'R0', category: 'OPEX', leaveSubtype: null,
    isDefaultOpex: true, colorIndex: 1, active: true,
  }],
  people: [{ id: 'p1', name: 'Alex', role: 'MANAGER', managerId: null }],
  overrides: [{ personId: 'p1', date: '2026-09-07', otlProjectCode: 'OPEX-ADMIN', hours: 7.5 }],
});

const withOneAllocation = (model: Model): Model => ({
  ...withOverridesButNoAllocations(model),
  allocations: [{ month: '2026-09', otlProjectCode: 'OPEX-ADMIN', personId: 'p1', hours: 40 }],
});

const STORED_ENTRY: ScheduleEntry = {
  personId: 'p1', date: '2026-09-07', otlProjectCode: 'OPEX-ADMIN',
  blocks: 15, source: 'OVERRIDE', overrideBlocks: 15,
};

/** Lets the mount read resolve under fake timers. */
async function settle(): Promise<void> {
  await act(async () => {
    await vi.runOnlyPendingTimersAsync();
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('useStore: mount', () => {
  it('loads the account’s whole stored state through the adapter', async () => {
    const adapter = adapterReading({
      model: withOneAllocation(emptyModel),
      entries: [STORED_ENTRY],
      hash: 'stored-hash',
    });

    const { result } = renderHook(() => useStore(adapter));
    await waitFor(() => expect(result.current.status).toBe('idle'));

    expect(adapter.read).toHaveBeenCalledTimes(1);
    expect(result.current.model.people).toHaveLength(1);
    // The stored schedule, restored — not an empty result that the next push
    // would then write over the account's schedule rows.
    expect(result.current.result.entries).toEqual([STORED_ENTRY]);
  });

  it('treats an account with no rows as an empty state, not as a failure', async () => {
    const adapter = adapterReading();
    const { result } = renderHook(() => useStore(adapter));
    await waitFor(() => expect(result.current.status).toBe('idle'));

    expect(result.current.model).toEqual(emptyModel);
    expect(result.current.notice).toBeNull();
    // The point of the distinction: a genuinely empty account is safe to
    // write, so the user can start filling it in.
    expect(result.current.isSafeToWrite).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Task 8, review finding F3.
//
// `write` is an unconditional whole-account replace, so writing a state the
// app made up is not a partial save — it deletes everything the account has.
// `read()` therefore THROWS 42501 for an unapproved or revoked account rather
// than resolving to an empty state, and the store must never write anything
// that did not come from a resolved, complete, authorised read.
// ---------------------------------------------------------------------------

describe('useStore: an unapproved account is not an empty account', () => {
  it('reports a 42501 read as forbidden, naming the approval rather than a fault', async () => {
    const adapter = adapterFailingToRead(notApproved());
    const { result } = renderHook(() => useStore(adapter));
    await waitFor(() => expect(result.current.status).toBe('forbidden'));

    expect(result.current.notice).toMatch(/not approved/i);
    expect(result.current.notice).toMatch(/ask the owner/i);
    expect(result.current.isSafeToWrite).toBe(false);
  });

  it('branches on the SQLSTATE, never on the message', async () => {
    // Same English a real RLS refusal carries, but a different code. It is a
    // fault, not a pending approval, and must not be reported as one.
    const adapter = adapterFailingToRead(
      new StorageError('new row violates row-level security policy for table "otls"', {
        code: '08006',
      }),
    );
    const { result } = renderHook(() => useStore(adapter));
    await waitFor(() => expect(result.current.status).toBe('error'));

    expect(result.current.notice).not.toMatch(/not approved/i);
    expect(result.current.isSafeToWrite).toBe(false);
  });

  it('never sends the debounced push after a forbidden read', async () => {
    vi.useFakeTimers();
    const adapter = adapterFailingToRead(notApproved());
    const { result } = renderHook(() => useStore(adapter));
    await settle();
    expect(result.current.status).toBe('forbidden');

    act(() => {
      result.current.update(addAPerson);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    // The whole finding: this write would have replaced every row the account
    // owns with the empty placeholder the app is showing.
    expect(adapter.write).not.toHaveBeenCalled();
    expect(result.current.notice).toMatch(/not being saved/i);
  });

  it('never sends the debounced push after a read that failed for any other reason', async () => {
    // A short read, a torn read and an unreachable server all land here. The
    // state on screen did not come from a complete read either way.
    vi.useFakeTimers();
    const adapter = adapterFailingToRead(
      new StorageError('could not read schedule from Supabase: the row count changed'),
    );
    const { result } = renderHook(() => useStore(adapter));
    await settle();
    expect(result.current.status).toBe('error');

    act(() => {
      result.current.update(addAPerson);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(adapter.write).not.toHaveBeenCalled();
  });

  it('does not let recalculate push either, though it still computes locally', async () => {
    vi.useFakeTimers();
    const adapter = adapterFailingToRead(notApproved());
    const { result } = renderHook(() => useStore(adapter));
    await settle();

    act(() => {
      result.current.update(withOneAllocation);
    });
    act(() => {
      result.current.recalculate();
    });
    await settle();

    expect(adapter.write).not.toHaveBeenCalled();
    // Still usable on screen: the user's own edits are not thrown away, they
    // are simply not being persisted, and the notice says exactly that.
    expect(result.current.model.people).toHaveLength(1);
    expect(result.current.notice).toMatch(/not being saved/i);
  });

  it('does write once a read has resolved', async () => {
    vi.useFakeTimers();
    const adapter = adapterReading();
    const { result } = renderHook(() => useStore(adapter));
    await settle();

    act(() => {
      result.current.update(addAPerson);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(adapter.write).toHaveBeenCalledTimes(1);
    expect(adapter.write.mock.calls[0]?.[0].model.people).toHaveLength(1);
  });
});

describe('useStore: access withdrawn mid-session', () => {
  it('reports a 42501 write as withdrawn access, not as a broken database', async () => {
    vi.useFakeTimers();
    const adapter = adapterReading();
    adapter.write.mockRejectedValue(
      new StorageError('could not write state to Supabase: new row violates row-level security policy', {
        code: INSUFFICIENT_PRIVILEGE,
      }),
    );

    const { result } = renderHook(() => useStore(adapter));
    await settle();

    act(() => {
      result.current.update(addAPerson);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(result.current.status).toBe('forbidden');
    expect(result.current.notice).toMatch(/access was withdrawn/i);
  });

  it('keeps the state writable, so re-approval saves the edits instead of stranding them', async () => {
    // The rule is about where the state CAME FROM, and this state still came
    // from a resolved, authorised read plus the user's own edits. Dropping the
    // flag here would lose every edit made since the revocation.
    vi.useFakeTimers();
    const adapter = adapterReading();
    adapter.write.mockRejectedValueOnce(
      new StorageError('refused', { code: INSUFFICIENT_PRIVILEGE }),
    );

    const { result } = renderHook(() => useStore(adapter));
    await settle();

    act(() => {
      result.current.update(addAPerson);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(result.current.status).toBe('forbidden');

    act(() => {
      result.current.update((model) => ({ ...model, statHolidays: [] }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(adapter.write).toHaveBeenCalledTimes(2);
    expect(result.current.status).toBe('idle');
  });

  it('reports an ordinary write failure as a save problem, keeping the changes in the tab', async () => {
    vi.useFakeTimers();
    const adapter = adapterReading();
    adapter.write.mockRejectedValue(new Error('network down'));

    const { result } = renderHook(() => useStore(adapter));
    await settle();

    act(() => {
      result.current.update(addAPerson);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(result.current.status).toBe('error');
    expect(result.current.notice).toMatch(/could not save/i);
    expect(result.current.notice).toMatch(/network down/);
  });
});

describe('useStore: isStale', () => {
  it('is true before anything has been calculated', async () => {
    const { result } = renderHook(() => useStore(adapterReading()));
    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(result.current.isStale).toBe(true);
  });

  it('becomes false after recalculate and true again after update', async () => {
    const { result } = renderHook(() => useStore(adapterReading()));
    await waitFor(() => expect(result.current.status).toBe('idle'));

    act(() => {
      result.current.recalculate();
    });
    await waitFor(() => expect(result.current.isStale).toBe(false));

    act(() => {
      result.current.update((model) => ({
        ...model,
        people: [...model.people, { id: 'p1', name: 'Alex', role: 'REPORT', managerId: null }],
      }));
    });
    expect(result.current.isStale).toBe(true);
  });

  it('is false on load when the stored hash certifies the stored model', async () => {
    // The reload half of the permanent-nag fix: the hash survives the round
    // trip, so a schedule calculated in a previous session does not come back
    // announcing itself as out of date.
    const { hashModel } = await import('../domain/hash');
    const model = withOneAllocation(emptyModel);
    const { result } = renderHook(() =>
      useStore(adapterReading({ model, entries: [STORED_ENTRY], hash: hashModel(model) })),
    );
    await waitFor(() => expect(result.current.status).toBe('idle'));

    expect(result.current.isStale).toBe(false);
  });
});

describe('useStore: update', () => {
  it('applies the change immutably — the previous model object is untouched', async () => {
    const { result } = renderHook(() => useStore(adapterReading()));
    await waitFor(() => expect(result.current.status).toBe('idle'));
    const before = result.current.model;

    act(() => {
      result.current.update((model) => ({
        ...model,
        people: [...model.people, { id: 'p1', name: 'Alex', role: 'REPORT', managerId: null }],
      }));
    });

    expect(before.people).toEqual([]);
    expect(result.current.model.people).toHaveLength(1);
    expect(result.current.model).not.toBe(before);
  });

  it('pushes to the adapter debounced at 2s, not immediately', async () => {
    vi.useFakeTimers();
    const adapter = adapterReading();
    const { result } = renderHook(() => useStore(adapter));
    await settle();
    expect(result.current.status).toBe('idle');

    act(() => {
      result.current.update((model) => ({
        ...model,
        people: [{ id: 'p1', name: 'Alex', role: 'REPORT', managerId: null }],
      }));
    });
    expect(adapter.write).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(adapter.write).toHaveBeenCalledTimes(1);
  });

  it('collapses a burst of edits into one write', async () => {
    vi.useFakeTimers();
    const adapter = adapterReading();
    const { result } = renderHook(() => useStore(adapter));
    await settle();

    act(() => {
      result.current.update(addAPerson);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    act(() => {
      result.current.update((model) => ({ ...model, statHolidays: [] }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(adapter.write).toHaveBeenCalledTimes(1);
  });
});

describe('useStore: recalculate', () => {
  it('runs scheduleAll and stores the new hash', async () => {
    const { result } = renderHook(() => useStore(adapterReading()));
    await waitFor(() => expect(result.current.status).toBe('idle'));

    act(() => {
      result.current.recalculate();
    });

    await waitFor(() => expect(result.current.isStale).toBe(false));
    expect(result.current.result.entries).toEqual([]);
  });

  it('pushes immediately rather than on the typing debounce', async () => {
    vi.useFakeTimers();
    const adapter = adapterReading();
    const { result } = renderHook(() => useStore(adapter));
    await settle();

    act(() => {
      result.current.update(withOneAllocation);
    });
    act(() => {
      result.current.recalculate();
    });
    await settle();

    expect(adapter.write).toHaveBeenCalledTimes(1);
    const written = adapter.write.mock.calls[0]?.[0];
    // The hash travels with the entries it certifies, in the one atomic write.
    expect(written?.hash).not.toBeNull();
    expect(written?.entries.length).toBeGreaterThan(0);
  });

  it('reports a scheduling failure as a notice instead of throwing, leaving the model stale', async () => {
    // scheduleAll throws when a person exists but no OTL is flagged as the
    // default OPEX code — reachable the moment Setup has added a manager
    // but not yet an OTL. Recalculate must never let that escape as an
    // uncaught exception (the app's one primary action, reachable from
    // every tab).
    const { result } = renderHook(() => useStore(adapterReading()));
    await waitFor(() => expect(result.current.status).toBe('idle'));

    act(() => {
      result.current.update((model) => ({
        ...model,
        people: [{ id: 'p1', name: 'Alex', role: 'REPORT', managerId: null }],
      }));
    });

    expect(() => {
      act(() => {
        result.current.recalculate();
      });
    }).not.toThrow();

    expect(result.current.isStale).toBe(true);
    expect(result.current.notice).toMatch(/could not recalculate/i);
  });
});

describe('useStore: cancelPendingPush', () => {
  it('drops a queued push so the debounced write never leaves', async () => {
    vi.useFakeTimers();
    const adapter = adapterReading();
    const { result } = renderHook(() => useStore(adapter));
    await settle();

    act(() => {
      result.current.update(addAPerson);
    });
    act(() => {
      result.current.cancelPendingPush();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(adapter.write).not.toHaveBeenCalled();
  });

  it('is safe to call when nothing is queued', async () => {
    const { result } = renderHook(() => useStore(adapterReading()));
    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(() => {
      act(() => {
        result.current.cancelPendingPush();
      });
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// N3 regression: `recalculate` refused to record a hash whenever a model that
// implies a schedule placed nothing — which, for a model with people and
// leave but nothing allocated, is EVERY time, because `monthsOf` is derived
// from ALLOCATIONS ONLY. The result was a permanent nag: `isStale` stuck
// true, a Recalculate button armed and failing on every press, and no hash
// ever written, so a reload reproduced it exactly. Meanwhile the Weeks page,
// whose window is `monthsOf(model) ∪ {month}`, rendered a full schedule.
//
// An empty scheduling window is an EMPTY STATE. The store names the cause so
// the UI can point at the missing allocation instead of offering an action
// that can only fail.
// ---------------------------------------------------------------------------

describe('useStore: a model with no allocated month is an empty state, not a stale schedule', () => {
  it('reports needsAllocation for people plus an override with nothing allocated', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useStore(adapterReading()));
    await settle();

    act(() => {
      result.current.update(withOverridesButNoAllocations);
    });

    expect(result.current.needsAllocation).toBe(true);
  });

  it('stops reporting it as soon as one month has an allocation', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useStore(adapterReading()));
    await settle();

    act(() => {
      result.current.update(withOneAllocation);
    });

    expect(result.current.needsAllocation).toBe(false);
  });

  it('does not report it for a model that implies no schedule at all', async () => {
    // A brand-new model is not waiting for an allocation — it has nothing at
    // all, and recalculating it succeeds and clears the banner.
    const { result } = renderHook(() => useStore(adapterReading()));
    await waitFor(() => expect(result.current.status).toBe('idle'));

    expect(result.current.needsAllocation).toBe(false);
  });

  it('refuses to certify anything when a recalculation has no month to place into', async () => {
    vi.useFakeTimers();
    const adapter = adapterReading();
    const { result } = renderHook(() => useStore(adapter));
    await settle();

    act(() => {
      result.current.update(withOverridesButNoAllocations);
    });
    act(() => {
      result.current.recalculate();
    });

    // Recording a hash here would clear the stale banner and certify a
    // schedule nobody wrote. Asserted before the queued debounce runs, which
    // would clear the notice on its own successful write.
    expect(result.current.isStale).toBe(true);
    expect(result.current.notice).toMatch(/no allocated months/i);
    await settle();
    expect(adapter.write).toHaveBeenCalledTimes(1);
  });
});

describe('useStore: a certified schedule that lost its allocations is still reported', () => {
  it('reports the certificate alongside needsAllocation once a schedule was calculated', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useStore(adapterReading()));
    await settle();

    act(() => {
      result.current.update(withOneAllocation);
    });
    act(() => {
      result.current.recalculate();
    });
    await settle();
    expect(result.current.isStale).toBe(false);
    expect(result.current.result.entries.length).toBeGreaterThan(0);
    expect(result.current.hasCertifiedSchedule).toBe(true);

    // The allocations are removed afterwards.
    act(() => {
      result.current.update((model) => ({ ...model, allocations: [] }));
    });

    expect(result.current.isStale).toBe(true);
    expect(result.current.needsAllocation).toBe(true);
    // The discriminator: something WAS certified, so this is not the
    // never-scheduled empty state.
    expect(result.current.hasCertifiedSchedule).toBe(true);
  });

  it('reports no certificate for a model that has never been calculated', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useStore(adapterReading()));
    await settle();

    act(() => {
      result.current.update(withOverridesButNoAllocations);
    });

    expect(result.current.needsAllocation).toBe(true);
    expect(result.current.hasCertifiedSchedule).toBe(false);
  });

  it('reports no certificate when the stored hash is the empty placeholder', async () => {
    // `StoredState.hash` keeps `''` distinct from `null` on purpose. Neither
    // is a certificate — `hashModel` never produces an empty string — so a
    // stored `''` must not be mistaken for one.
    const { result } = renderHook(() =>
      useStore(adapterReading({
        model: withOverridesButNoAllocations(emptyModel),
        entries: [],
        hash: '',
      })),
    );
    await waitFor(() => expect(result.current.status).toBe('idle'));

    expect(result.current.needsAllocation).toBe(true);
    expect(result.current.hasCertifiedSchedule).toBe(false);
  });
});
