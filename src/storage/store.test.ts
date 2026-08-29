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

// ---------------------------------------------------------------------------
// Task 9, review finding F1.
//
// The flag proves that A read succeeded. It does not prove that the state
// being written DESCENDS FROM that read, and only the second claim is safe.
// An edit typed while the mount read is still in flight captures a PRE-READ
// model in the debounce closure; if the read resolves before the timer fires,
// the flag is true by the time the guard is consulted and the pre-read model
// — the app's own empty placeholder plus one keystroke — is sent to a write
// that replaces the WHOLE account.
// ---------------------------------------------------------------------------

/** A read the test resolves by hand, so the in-flight window stays open. */
function adapterWithHeldRead(): FakeAdapter & { resolveRead: (state: StoredState) => void } {
  let release: ((state: StoredState) => void) | null = null;
  const read = vi.fn(
    () => new Promise<StoredState>((resolve) => {
      release = resolve;
    }),
  );
  return {
    read,
    write: vi.fn(async () => {}),
    resolveRead(state: StoredState): void {
      if (release === null) throw new Error('read() has not been called yet');
      release(state);
    },
  };
}

describe('useStore: an edit made while the mount read is still in flight', () => {
  const STORED: StoredState = {
    model: withOneAllocation(emptyModel),
    entries: [STORED_ENTRY],
    hash: 'stored-hash',
  };

  it('never writes a state that predates the read which authorised the write', async () => {
    vi.useFakeTimers();
    const adapter = adapterWithHeldRead();

    const { result } = renderHook(() => useStore(adapter));
    // The window: the read is in flight, so nothing on screen came from it.
    expect(result.current.isSafeToWrite).toBe(false);

    // The user types into the apparently-empty planner. This schedules a push
    // carrying the model AS IT IS NOW — the empty placeholder plus the edit.
    act(() => {
      result.current.update((model) => ({
        ...model,
        people: [{ id: 'typed', name: 'Typed while loading', role: 'MANAGER', managerId: null }],
      }));
    });

    // The read resolves. The account's real state — 1 OTL, 1 person, 1
    // allocation — replaces the screen, and the store becomes safe to write.
    await act(async () => {
      adapter.resolveRead(STORED);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.isSafeToWrite).toBe(true);
    expect(result.current.model.allocations).toHaveLength(1);

    // The debounce fires, consults the flag, and finds it true.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    // The finding: `write` is an unconditional whole-account replace, so
    // sending the pre-read model deletes the OTL, the allocation and the real
    // person, atomically, and leaves a hash certifying the destroyed model.
    const sentModels = adapter.write.mock.calls.map((call) => call[0].model);
    expect(sentModels.some((model) => model.people.some((p) => p.id === 'typed'))).toBe(false);
    expect(sentModels.some((model) => model.allocations.length === 0)).toBe(false);
    // Refusal, not substitution: the queued push descends from a state the
    // read has already thrown away, so there is nothing left to save.
    expect(adapter.write).not.toHaveBeenCalled();
    // And the account still holds what the read found.
    expect(result.current.model.people).toHaveLength(1);
    expect(result.current.model.otls).toHaveLength(1);
  });

  it('still writes an edit made after the read resolved', async () => {
    // The guard is about DESCENT, not about having ever been unsafe: a mount
    // that once had a pre-read edit must not be poisoned for the rest of its
    // life. Edits made on top of the read still save.
    vi.useFakeTimers();
    const adapter = adapterWithHeldRead();
    const { result } = renderHook(() => useStore(adapter));

    act(() => {
      result.current.update((model) => ({
        ...model,
        people: [{ id: 'typed', name: 'Typed while loading', role: 'MANAGER', managerId: null }],
      }));
    });
    await act(async () => {
      adapter.resolveRead(STORED);
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(adapter.write).not.toHaveBeenCalled();

    act(() => {
      result.current.update(addAPerson);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(adapter.write).toHaveBeenCalledTimes(1);
    const sent = adapter.write.mock.calls[0]?.[0];
    // Descends from the read: the account's own person plus the new one.
    expect(sent?.model.people).toHaveLength(2);
    expect(sent?.model.allocations).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Review finding F2.
//
// Ported from the suite Task 9 deleted along with v1's storage layer — see
// `git show f3ea6fb:src/storage/store.test.ts`, describe blocks "the Schedule
// tab is never cleared by a result nobody computed" and "Meta never certifies
// a Schedule that was not written". The tabs are gone; the invariant they
// protected is not, and nothing in the surviving suite held it.
//
// v1 pushed one tab at a time and kept the invariant by OMITTING `Schedule`
// and `Meta` from a push that had neither. There are no partial writes any
// more: `StorageAdapter.write` is a whole-account replace and every push
// carries all three parts of `StoredState` — model, entries, hash. So the
// same invariant now reads:
//
//   EVERY PUSH CARRIES THE ENTRIES AND THE HASH THE STORE IS CURRENTLY
//   HOLDING — the ones the last completed calculation (or the load) left
//   behind — AND THE TWO TRAVEL TOGETHER.
//
// Both halves are silent data loss when broken, and neither is a line
// coverage can reach: `src/storage` sat at 100% line coverage with both of
// the mutations below green.
//
//   * entries dropped (`pushToAdapter(..., [], hash)`): every keystroke
//     deletes every schedule row the account owns, while the hash it sends
//     goes on certifying them. The Schedule the user calculated is gone and
//     nothing says so.
//   * hash dropped (`pushToAdapter(..., entries, null)`): every keystroke
//     destroys the certificate. That is v1's permanent-nag staleness bug
//     (amendment A1) rebuilt from scratch — the schedule rows survive, the
//     proof that they match the model does not, and after a reload the stale
//     banner can never be cleared for a model that really is up to date.
// ---------------------------------------------------------------------------

/** The stored state of an account that calculated a schedule last session. */
const STORED_STATE: StoredState = {
  model: withOneAllocation(emptyModel),
  entries: [STORED_ENTRY],
  hash: 'stored-hash',
};

/** Undoes `addAPerson`, landing back on exactly the model that was loaded. */
const removeThatPerson = (model: Model): Model => ({
  ...model,
  people: model.people.filter((person) => person.id !== 'p2'),
});

describe('useStore: a push never clears a schedule nobody recalculated', () => {
  it('sends the loaded schedule with a keystroke that recalculated nothing', async () => {
    vi.useFakeTimers();
    const adapter = adapterReading(STORED_STATE);
    const { result } = renderHook(() => useStore(adapter));
    await settle();
    // The load restored last session's schedule. Nothing has recalculated.
    expect(result.current.result.entries).toEqual([STORED_ENTRY]);

    act(() => {
      result.current.update(addAPerson);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(adapter.write).toHaveBeenCalledTimes(1);
    const sent = adapter.write.mock.calls[0]?.[0];
    // The finding: `write` replaces the whole account, so an empty `entries`
    // here is not "no schedule sent", it is every schedule row deleted by a
    // keystroke that never asked for a recalculation.
    expect(sent?.entries).toEqual([STORED_ENTRY]);
  });

  it('sends the recalculated schedule with the keystroke that follows a recalculate', async () => {
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

    const recalculated = adapter.write.mock.calls[0]?.[0];
    expect(recalculated?.entries.length).toBeGreaterThan(0);

    // A single keystroke on top of a fresh calculation.
    act(() => {
      result.current.update(addAPerson);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    const sent = adapter.write.mock.calls[1]?.[0];
    expect(sent?.entries).toEqual(recalculated?.entries);
  });

  it('sends an empty schedule only when the store genuinely holds one', async () => {
    // The other direction, so the assertions above cannot be satisfied by a
    // store that simply always sends something: a brand-new account has no
    // schedule, and the push must say so rather than invent one.
    vi.useFakeTimers();
    const adapter = adapterReading();
    const { result } = renderHook(() => useStore(adapter));
    await settle();
    expect(result.current.result.entries).toEqual([]);

    act(() => {
      result.current.update(addAPerson);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(adapter.write.mock.calls[0]?.[0].entries).toEqual([]);
  });
});

describe('useStore: a push never destroys the certificate of a schedule it kept', () => {
  it('sends the loaded hash with a keystroke that recalculated nothing', async () => {
    vi.useFakeTimers();
    const adapter = adapterReading(STORED_STATE);
    const { result } = renderHook(() => useStore(adapter));
    await settle();

    act(() => {
      result.current.update(addAPerson);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    const sent = adapter.write.mock.calls[0]?.[0];
    // A `null` here would be a keystroke telling the database that a schedule
    // it is still storing was never calculated.
    expect(sent?.hash).toBe('stored-hash');
  });

  it('keeps the hash and the entries it certifies in the same write', async () => {
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
    const recalculated = adapter.write.mock.calls[0]?.[0];

    act(() => {
      result.current.update(addAPerson);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    const sent = adapter.write.mock.calls[1]?.[0];
    // The pair moves as a pair. Splitting them — either half without the
    // other — is how the store ends up storing a schedule it cannot vouch
    // for, or a certificate for rows that are no longer there.
    expect(sent?.hash).toBe(recalculated?.hash);
    expect(sent?.entries).toEqual(recalculated?.entries);
  });

  it('sends a null hash only when nothing has ever been calculated', async () => {
    // `null` is a real, distinct fact (`StoredState.hash`), so the guard
    // above must not be satisfiable by never sending one.
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

    expect(adapter.write.mock.calls[0]?.[0].hash).toBeNull();
  });

  it('leaves what a keystroke wrote reloadable, so the stale banner still clears', async () => {
    // The harm, end to end and in the user's terms. Take what a plain
    // keystroke actually pushed, reload from it, and undo the keystroke: the
    // model is once again exactly the one the stored hash certifies, so the
    // banner must go away and last session's schedule must still be on
    // screen. Drop either half of the push and this session can never be
    // told its schedule is current again — v1's permanent nag, rebuilt.
    vi.useFakeTimers();
    const { hashModel } = await import('../domain/hash');
    const model = withOneAllocation(emptyModel);
    const certified: StoredState = { model, entries: [STORED_ENTRY], hash: hashModel(model) };

    const adapter = adapterReading(certified);
    const first = renderHook(() => useStore(adapter));
    await settle();
    expect(first.result.current.isStale).toBe(false);

    act(() => {
      first.result.current.update(addAPerson);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    const persisted = adapter.write.mock.calls[0]?.[0];
    if (persisted === undefined) throw new Error('expected the keystroke to have been pushed');
    first.unmount();

    // Next session, reading back exactly what that keystroke stored.
    const reloaded = renderHook(() => useStore(adapterReading(persisted)));
    await settle();

    act(() => {
      reloaded.result.current.update(removeThatPerson);
    });

    expect(reloaded.result.current.isStale).toBe(false);
    expect(reloaded.result.current.result.entries).toEqual([STORED_ENTRY]);
    expect(reloaded.result.current.hasCertifiedSchedule).toBe(true);
  });
});

/**
 * A sleeping database is not a broken one, and the difference is actionable.
 *
 * The Supabase project this app runs on is a free one, and a free project is
 * paused after about a week idle. `.github/workflows/keepwarm.yml` exists to
 * stop that happening, but a cron job is a thing that can fail — a rotated
 * secret, a repository with Actions disabled, a run that was skipped — and
 * when it does, the paused project is what every user meets on load. Telling
 * them "could not load your data (TypeError: Failed to fetch)" is true and
 * useless; the fallback for a failed cron must not mystify.
 *
 * Two shapes, because that is what the failure actually looks like — a fetch
 * that never lands reports status 0, a gateway that answers for a database
 * that cannot reports 503 (or 520 from Cloudflare). The status is the only
 * thing that separates them from a broken database, since neither carries a
 * SQLSTATE.
 */
describe('useStore: a database that cannot be reached', () => {
  /** The shape postgrest-js produces when the fetch itself never landed. */
  const fetchFailed = (): StorageError =>
    new StorageError('TypeError: Failed to fetch', { code: '', status: 0 });

  /** The shape it produces when something answered but the database did not. */
  const unavailable = (status: number): StorageError =>
    new StorageError('<html>503 Service Unavailable</html>', { status });

  it('names the sleeping database when the fetch never landed (status 0)', async () => {
    const adapter = adapterFailingToRead(fetchFailed());
    const { result } = renderHook(() => useStore(adapter));
    await waitFor(() => expect(result.current.status).toBe('error'));

    expect(result.current.notice).toMatch(/asleep|sleep/i);
    // Not approval, and not a fault the user can do anything else about.
    expect(result.current.notice).not.toMatch(/not approved/i);
    expect(result.current.isSafeToWrite).toBe(false);
  });

  it('names it for a 503 too — the same failure, a different shape', async () => {
    const adapter = adapterFailingToRead(unavailable(503));
    const { result } = renderHook(() => useStore(adapter));
    await waitFor(() => expect(result.current.status).toBe('error'));

    expect(result.current.notice).toMatch(/asleep|sleep/i);
    expect(result.current.isSafeToWrite).toBe(false);
  });

  it('names it for a 520 — Cloudflare in front of the same dead database', async () => {
    const adapter = adapterFailingToRead(unavailable(520));
    const { result } = renderHook(() => useStore(adapter));
    await waitFor(() => expect(result.current.status).toBe('error'));

    expect(result.current.notice).toMatch(/asleep|sleep/i);
  });

  it('does not promise an instant answer', async () => {
    // Waking a paused project takes about a minute, and postgrest-js retries a
    // 503 three times with 1s/2s/4s backoff before the failure even surfaces.
    // "Try again" with no sense of the wait is a message the user experiences
    // as a hang, so the notice has to name the delay.
    const adapter = adapterFailingToRead(fetchFailed());
    const { result } = renderHook(() => useStore(adapter));
    await waitFor(() => expect(result.current.status).toBe('error'));

    expect(result.current.notice).toMatch(/minute/i);
  });

  it('leaves a genuinely broken database as the generic error', async () => {
    // 500 is the server failing, not the server being absent. Nothing here
    // suggests waiting a minute would help, so nothing here should say so.
    const adapter = adapterFailingToRead(unavailable(500));
    const { result } = renderHook(() => useStore(adapter));
    await waitFor(() => expect(result.current.status).toBe('error'));

    expect(result.current.notice).not.toMatch(/asleep|sleep/i);
    expect(result.current.notice).toMatch(/could not load/i);
  });

  it('branches on the status, never on the message', async () => {
    // The same trap the 42501 branch has a test for. This error SAYS the
    // database is asleep and is not: it is a 500, and matching on prose would
    // report a broken server as a sleeping one and tell the user to wait.
    const adapter = adapterFailingToRead(
      new StorageError('the database is asleep and will wake in a minute', { status: 500 }),
    );
    const { result } = renderHook(() => useStore(adapter));
    await waitFor(() => expect(result.current.status).toBe('error'));

    expect(result.current.notice).toMatch(/could not load/i);
  });

  it('leaves an adapter-raised failure — no status at all — as the generic error', async () => {
    // A torn or short read. `status` is null, not 0, and the two must not be
    // conflated: this read reached the database perfectly well.
    const adapter = adapterFailingToRead(
      new StorageError('could not read schedule from Supabase: the row count changed'),
    );
    const { result } = renderHook(() => useStore(adapter));
    await waitFor(() => expect(result.current.status).toBe('error'));

    expect(result.current.notice).not.toMatch(/asleep|sleep/i);
  });

  it('still reports 42501 as forbidden, whatever status came with it', async () => {
    // Ordering matters. RLS refusals arrive as 403s, and "not approved" is the
    // more specific and more actionable fact — an unreachable-database notice
    // would send the user to wait for a database that is answering fine.
    const adapter = adapterFailingToRead(
      new StorageError('refused', { code: INSUFFICIENT_PRIVILEGE, status: 403 }),
    );
    const { result } = renderHook(() => useStore(adapter));
    await waitFor(() => expect(result.current.status).toBe('forbidden'));

    expect(result.current.notice).toMatch(/not approved/i);
  });

  it('never sends the debounced push after an unreachable read', async () => {
    vi.useFakeTimers();
    const adapter = adapterFailingToRead(fetchFailed());
    const { result } = renderHook(() => useStore(adapter));
    await settle();
    expect(result.current.status).toBe('error');

    act(() => {
      result.current.update(addAPerson);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    // The load epoch is untouched by the new branch, so the write guard is
    // exactly as it was.
    expect(adapter.write).not.toHaveBeenCalled();
  });

  it('says so on a failed save too, and keeps the edits in the tab', async () => {
    vi.useFakeTimers();
    const adapter = adapterReading();
    adapter.write.mockRejectedValueOnce(unavailable(503));
    const { result } = renderHook(() => useStore(adapter));
    await settle();

    act(() => {
      result.current.update(addAPerson);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(result.current.status).toBe('error');
    expect(result.current.notice).toMatch(/asleep|sleep/i);
    expect(result.current.notice).toMatch(/minute/i);
    // Not a revocation, and not a reason to throw the user's work away.
    expect(result.current.model.people).toHaveLength(1);
    expect(result.current.isSafeToWrite).toBe(true);
  });

  it('still saves once the database answers again', async () => {
    // The failed save must not have moved the load epoch or cleared
    // `isSafeToWrite`: the state on screen still descends from the read.
    vi.useFakeTimers();
    const adapter = adapterReading();
    adapter.write.mockRejectedValueOnce(unavailable(503));
    const { result } = renderHook(() => useStore(adapter));
    await settle();

    act(() => {
      result.current.update(addAPerson);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    act(() => {
      result.current.update(addAPerson);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(adapter.write).toHaveBeenCalledTimes(2);
    expect(result.current.status).toBe('idle');
    expect(result.current.notice).toBeNull();
  });
});
