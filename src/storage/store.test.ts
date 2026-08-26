import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useStore } from './store';
import { loadCache, saveCache } from './localCache';
import { localOnlyAdapter } from './adapters/localOnly';
import type { Model } from '../domain/types';
import type { BackendConfig } from './adapter';

const LOCAL_ADAPTER_KEY = 'timesheet-helper:payload:v1';

const emptyModel: Model = {
  otls: [], people: [], statHolidays: [], allocations: [], leave: [], overrides: [],
};

function withOneAllocation(): Model {
  return {
    ...emptyModel,
    otls: [{
      projectCode: 'P-1001', taskCode: 'T1', expenditureTypeCode: 'E1',
      timeReportingCode: 'R1', category: 'CAPEX', leaveSubtype: null,
      isDefaultOpex: false, colorIndex: 1, active: true,
    }],
    allocations: [{ month: '2026-09', otlProjectCode: 'P-1001', personId: null, hours: 40 }],
  };
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('useStore: mount', () => {
  it('defaults to the local backend with an empty model when nothing is cached', async () => {
    const { result } = renderHook(() => useStore());
    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(result.current.config.backend).toBe('local');
    expect(result.current.model).toEqual(emptyModel);
  });

  it('reads through the configured (local) adapter on mount', async () => {
    // Written directly under the local adapter's own key — a different
    // store than localCache.ts's — to prove the read goes through the
    // adapter, not straight to the client-side cache.
    const model = withOneAllocation();
    localStorage.setItem(LOCAL_ADAPTER_KEY, JSON.stringify({
      OTLs: [
        ['projectCode', 'taskCode', 'expenditureTypeCode', 'timeReportingCode', 'category', 'leaveSubtype', 'isDefaultOpex', 'colorIndex', 'active'],
        ['P-1001', 'T1', 'E1', 'R1', 'CAPEX', '', 'FALSE', '1', 'TRUE'],
      ],
      Allocations: [
        ['month', 'otlProjectCode', 'personId', 'hours'],
        ['2026-09', 'P-1001', '', '40'],
      ],
    }));

    const { result } = renderHook(() => useStore());
    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(result.current.model).toEqual(model);
  });

  it('falls back to the local cache when the configured backend fails to read, without crashing', async () => {
    const cachedModel = withOneAllocation();
    const config: BackendConfig = { backend: 'google', location: 'https://script.google.com/macros/s/abc/exec', secret: 's' };
    saveCache(cachedModel, 'cached-hash', config);
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));

    const { result } = renderHook(() => useStore());
    await waitFor(() => expect(result.current.status).toBe('offline'));
    expect(result.current.model).toEqual(cachedModel);
    expect(result.current.config).toEqual(config);
  });
});

describe('useStore: isStale', () => {
  it('is true before anything has been calculated', async () => {
    const { result } = renderHook(() => useStore());
    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(result.current.isStale).toBe(true);
  });

  it('becomes false after recalculate and true again after update', async () => {
    const { result } = renderHook(() => useStore());
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
});

describe('useStore: update', () => {
  it('applies the change immutably — the previous model object is untouched', async () => {
    const { result } = renderHook(() => useStore());
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

  it('writes the new model to the local cache synchronously', async () => {
    const { result } = renderHook(() => useStore());
    await waitFor(() => expect(result.current.status).toBe('idle'));

    act(() => {
      result.current.update((model) => ({
        ...model,
        people: [{ id: 'p1', name: 'Alex', role: 'REPORT', managerId: null }],
      }));
    });

    expect(loadCache()?.model.people).toHaveLength(1);
  });

  it('pushes to the active adapter debounced at 2s, not immediately', async () => {
    vi.useFakeTimers();
    const writeSpy = vi.spyOn(localOnlyAdapter, 'write');
    const { result } = renderHook(() => useStore());
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });
    expect(result.current.status).toBe('idle');

    act(() => {
      result.current.update((model) => ({
        ...model,
        people: [{ id: 'p1', name: 'Alex', role: 'REPORT', managerId: null }],
      }));
    });
    expect(writeSpy).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(writeSpy).toHaveBeenCalledTimes(1);
  });
});

describe('useStore: recalculate', () => {
  it('runs scheduleAll and stores the new hash', async () => {
    const { result } = renderHook(() => useStore());
    await waitFor(() => expect(result.current.status).toBe('idle'));

    act(() => {
      result.current.recalculate();
    });

    await waitFor(() => expect(result.current.isStale).toBe(false));
    expect(result.current.result.entries).toEqual([]);
  });

  it('reports a scheduling failure as a notice instead of throwing, leaving the model stale', async () => {
    // scheduleAll throws when a person exists but no OTL is flagged as the
    // default OPEX code — reachable the moment Setup has added a manager
    // but not yet an OTL. Recalculate must never let that escape as an
    // uncaught exception (the app's one primary action, reachable from
    // every tab).
    const { result } = renderHook(() => useStore());
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

describe('useStore: connect/disconnect', () => {
  it('preserves the in-memory model when switching backends', async () => {
    const { result } = renderHook(() => useStore());
    await waitFor(() => expect(result.current.status).toBe('idle'));

    act(() => {
      result.current.update((model) => ({
        ...model,
        people: [{ id: 'p1', name: 'Alex', role: 'REPORT', managerId: null }],
      }));
    });
    const modelBeforeConnect = result.current.model;

    await act(async () => {
      await result.current.connect({ backend: 'local', location: '' });
    });

    expect(result.current.model).toEqual(modelBeforeConnect);
    expect(result.current.config.backend).toBe('local');
  });

  it('reverts to the local backend on disconnect', async () => {
    const { result } = renderHook(() => useStore());
    await waitFor(() => expect(result.current.status).toBe('idle'));

    await act(async () => {
      await result.current.disconnect();
    });

    expect(result.current.config.backend).toBe('local');
    expect(result.current.status).toBe('idle');
  });
});

// ---------------------------------------------------------------------------
// Data-loss regressions. Every case below reproduces a way the app used to
// replace the user's spreadsheet data with nothing.
// ---------------------------------------------------------------------------

const OTL_HEADER = [
  'projectCode', 'taskCode', 'expenditureTypeCode', 'timeReportingCode',
  'category', 'leaveSubtype', 'isDefaultOpex', 'colorIndex', 'active',
];
const PEOPLE_HEADER = ['id', 'name', 'role', 'managerId'];
const ALLOCATION_HEADER = ['month', 'otlProjectCode', 'personId', 'hours'];

/** The hand-edit that triggers the whole family: one capital R in `role`. */
const BROKEN_PEOPLE_HEADER = ['id', 'name', 'Role', 'managerId'];

const PEOPLE_ROW = ['p1', 'Alex', 'MANAGER', ''];

/** A payload the scheduler can actually place hours from. */
function schedulablePayload(peopleHeader: string[]): Record<string, string[][]> {
  return {
    OTLs: [OTL_HEADER, ['OPEX-ADMIN', 'T0', 'E0', 'R0', 'OPEX', '', 'TRUE', '1', 'TRUE']],
    People: [peopleHeader, PEOPLE_ROW],
    Allocations: [ALLOCATION_HEADER, ['2026-09', 'OPEX-ADMIN', 'p1', '40']],
  };
}

function storeLocalPayload(payload: Record<string, string[][]>): void {
  localStorage.setItem(LOCAL_ADAPTER_KEY, JSON.stringify(payload));
}

function readLocalPayload(): Record<string, string[][]> {
  const raw = localStorage.getItem(LOCAL_ADAPTER_KEY);
  return raw === null ? {} : (JSON.parse(raw) as Record<string, string[][]>);
}

const addAPerson = (model: Model): Model => ({
  ...model,
  people: [...model.people, { id: 'p2', name: 'Sam', role: 'REPORT', managerId: null }],
});

describe('useStore: a tab that failed to parse is never overwritten', () => {
  it('omits the unreadable tab from the debounced push, leaving the backend copy intact', async () => {
    storeLocalPayload(schedulablePayload(BROKEN_PEOPLE_HEADER));
    vi.useFakeTimers();
    const writeSpy = vi.spyOn(localOnlyAdapter, 'write');

    const { result } = renderHook(() => useStore());
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });

    // The header mismatch drops the whole tab, exactly as before — guessing
    // at column meaning would be worse.
    expect(result.current.model.people).toEqual([]);
    expect(result.current.unreadableTabs).toEqual(['People']);

    act(() => {
      result.current.update(addAPerson);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(writeSpy).toHaveBeenCalledTimes(1);
    const pushed = writeSpy.mock.calls[0]?.[1];
    expect(pushed).toBeDefined();
    expect(pushed && 'People' in pushed).toBe(false);
    expect(pushed && 'OTLs' in pushed).toBe(true);

    // And the backend still holds the user's rows — not a lone header row.
    expect(readLocalPayload().People).toEqual([BROKEN_PEOPLE_HEADER, PEOPLE_ROW]);
  });

  it('keeps the good cached model instead of overwriting it with the lossy read', async () => {
    const cachedModel = withOneAllocation();
    saveCache(cachedModel, 'cached-hash', { backend: 'local', location: '' });
    storeLocalPayload(schedulablePayload(BROKEN_PEOPLE_HEADER));

    const { result } = renderHook(() => useStore());
    await waitFor(() => expect(result.current.status).toBe('idle'));

    expect(loadCache()?.model).toEqual(cachedModel);
  });

  it('reports the unreadable tab as a data notice, separate from the sync notice', async () => {
    storeLocalPayload(schedulablePayload(BROKEN_PEOPLE_HEADER));

    const { result } = renderHook(() => useStore());
    await waitFor(() => expect(result.current.status).toBe('idle'));

    expect(result.current.dataNotice).toMatch(/People tab could not be read/i);
    expect(result.current.dataNotice).toMatch(/will not write over it/i);
    expect(result.current.notice).toBeNull();
    // The schedule is stale at the same time — the two must not compete.
    expect(result.current.isStale).toBe(true);
  });

  // N2(b): the generic wording is unactionable — it is said about headers
  // that look byte-perfect on screen. The discriminating detail already
  // exists in `problems`; it went only to console.warn.
  it('names the expected columns and the ones actually found', async () => {
    storeLocalPayload(schedulablePayload(BROKEN_PEOPLE_HEADER));

    const { result } = renderHook(() => useStore());
    await waitFor(() => expect(result.current.status).toBe('idle'));

    expect(result.current.dataNotice).toMatch(/expected columns \[id, name, role, managerId\]/);
    expect(result.current.dataNotice).toMatch(/got \[id, name, Role, managerId\]/);
  });

  // N2(c): "will not write over it" reads as pure protection and hides the
  // other half — the user's own edits to that tab are going nowhere.
  it('says the user\u2019s own changes to the tab are not being saved either', async () => {
    storeLocalPayload(schedulablePayload(BROKEN_PEOPLE_HEADER));

    const { result } = renderHook(() => useStore());
    await waitFor(() => expect(result.current.status).toBe('idle'));

    expect(result.current.dataNotice).toMatch(/your changes to that tab are NOT being saved/i);
  });
});

describe('useStore: the Schedule tab is never cleared by a result nobody computed', () => {
  it('omits Schedule from the push when the model implies one but none is calculated', async () => {
    // Model tabs load fine; the Schedule tab is absent, so `result` is empty
    // while the model plainly implies a non-empty schedule.
    storeLocalPayload(schedulablePayload(PEOPLE_HEADER));
    vi.useFakeTimers();
    const writeSpy = vi.spyOn(localOnlyAdapter, 'write');

    const { result } = renderHook(() => useStore());
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });
    expect(result.current.model.people).toHaveLength(1);
    expect(result.current.result.entries).toEqual([]);

    act(() => {
      result.current.update(addAPerson);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    const pushed = writeSpy.mock.calls[0]?.[1];
    expect(pushed && 'Schedule' in pushed).toBe(false);
    expect(pushed && 'People' in pushed).toBe(true);
  });

  it('restores a result — not EMPTY_RESULT — when the backend is unreachable', async () => {
    const cachedModel: Model = {
      ...emptyModel,
      otls: [{
        projectCode: 'OPEX-ADMIN', taskCode: 'T0', expenditureTypeCode: 'E0',
        timeReportingCode: 'R0', category: 'OPEX', leaveSubtype: null,
        isDefaultOpex: true, colorIndex: 1, active: true,
      }],
      people: [{ id: 'p1', name: 'Alex', role: 'MANAGER', managerId: null }],
      allocations: [{ month: '2026-09', otlProjectCode: 'OPEX-ADMIN', personId: 'p1', hours: 40 }],
    };
    const config: BackendConfig = {
      backend: 'google', location: 'https://script.google.com/macros/s/abc/exec', secret: 's',
    };
    saveCache(cachedModel, 'cached-hash', config);
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));

    const { result } = renderHook(() => useStore());
    await waitFor(() => expect(result.current.status).toBe('offline'));

    expect(result.current.result.entries.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// N1 regression, twice over.
//
// First: `unreadableTabs` was only ever SET (in loadInitial) and never
// cleared, so a verdict about the old spreadsheet followed the user to a new
// one. "Connect somewhere clean" is the intuitive escape hatch from a broken
// header, and it silently did not work.
//
// Then the fix for THAT retired the verdict by comparing `backend` +
// `location`. `location` is not target identity: the local adapter ignores it
// entirely (one fixed key), a Microsoft share link for one workbook differs
// textually run to run while Graph resolves them all to the same item, and a
// new Apps Script deployment mints a new /exec URL for the same spreadsheet.
// A false "different target" dropped the protection, and `connect` — which
// clears each tab before writing it — then wrote the app's own EMPTY copy of
// the unparseable tab over the user's rows. The verdict is now retired the
// way it was produced: by READING the target being landed on.
//
// Every case below asserts on what SURVIVED in the store, not merely on which
// keys were pushed. Checking what was sent rather than what is left is how
// the destroying behaviour got through review.
// ---------------------------------------------------------------------------

/**
 * A target that really IS a different, empty one. `localOnlyAdapter` has a
 * single fixed key, so "somewhere clean" can only be simulated at its `read`.
 * `write` is left alone and still lands in the real localStorage, so the
 * assertions below are about genuinely stored data.
 */
function readsAsAFreshTarget(): void {
  vi.spyOn(localOnlyAdapter, 'read').mockResolvedValue({});
}

describe('useStore: an unreadable verdict is retired by a read, not by comparing config strings', () => {
  it('leaves the unreadable tab intact when the new location merely looks different', async () => {
    storeLocalPayload(schedulablePayload(BROKEN_PEOPLE_HEADER));
    const { result } = renderHook(() => useStore());
    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(result.current.unreadableTabs).toEqual(['People']);

    act(() => {
      result.current.update(addAPerson);
    });

    // A location string the app has never seen — and, because the local
    // adapter ignores `location` altogether, the very same store.
    const writeSpy = vi.spyOn(localOnlyAdapter, 'write');
    await act(async () => {
      await result.current.connect({ backend: 'local', location: 'looks-different-is-not' });
    });

    // What SURVIVED, not what was sent: Alex's row is still in the store.
    expect(readLocalPayload().People).toEqual([BROKEN_PEOPLE_HEADER, PEOPLE_ROW]);
    const pushed = writeSpy.mock.calls[0]?.[1];
    expect(pushed && 'People' in pushed).toBe(false);
    expect(result.current.unreadableTabs).toEqual(['People']);
  });

  it('clears the verdict and pushes every tab when the target landed on reads clean', async () => {
    storeLocalPayload(schedulablePayload(BROKEN_PEOPLE_HEADER));
    const { result } = renderHook(() => useStore());
    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(result.current.unreadableTabs).toEqual(['People']);

    act(() => {
      result.current.update(addAPerson);
    });

    readsAsAFreshTarget();
    const writeSpy = vi.spyOn(localOnlyAdapter, 'write');
    await act(async () => {
      await result.current.connect({ backend: 'local', location: 'a-fresh-workbook' });
    });

    const pushed = writeSpy.mock.calls[0]?.[1];
    expect(pushed && 'People' in pushed).toBe(true);
    // And the escape hatch actually worked: the tab now holds the app's
    // people under the header the app expects.
    expect(readLocalPayload().People?.[0]).toEqual(PEOPLE_HEADER);
    expect(result.current.unreadableTabs).toEqual([]);
    expect(result.current.dataNotice).toBeNull();
  });

  it('keeps pushing the formerly-unreadable tab on every later push, not just the connect one', async () => {
    storeLocalPayload(schedulablePayload(BROKEN_PEOPLE_HEADER));
    vi.useFakeTimers();
    const { result } = renderHook(() => useStore());
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });
    expect(result.current.unreadableTabs).toEqual(['People']);

    // The model must hold People of its own before the verdict can retire:
    // a tab this session never loaded is EMPTY in memory, and writing that
    // emptiness over the target's rows is the very thing the protection
    // exists to stop (see 'a verdict is never retired for a tab the model is
    // still empty for'). Retirement is about a tab the app can actually
    // write something for.
    act(() => {
      result.current.update(addAPerson);
    });

    readsAsAFreshTarget();
    await act(async () => {
      await result.current.connect({ backend: 'local', location: 'a-fresh-workbook' });
    });

    const writeSpy = vi.spyOn(localOnlyAdapter, 'write');
    act(() => {
      result.current.update((model) => ({
        ...model,
        people: [...model.people, { id: 'p3', name: 'Robin', role: 'REPORT', managerId: null }],
      }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(writeSpy).toHaveBeenCalledTimes(1);
    const pushed = writeSpy.mock.calls[0]?.[1];
    expect(pushed && 'People' in pushed).toBe(true);
  });

  it('keeps the verdict when the new target cannot be read at all', async () => {
    // A read that fails is not evidence that the target is clean. Assuming
    // it is, is what destroys data; keeping the protection only costs the
    // user a tab that is not written, which is recoverable.
    storeLocalPayload(schedulablePayload(BROKEN_PEOPLE_HEADER));
    const { result } = renderHook(() => useStore());
    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(result.current.unreadableTabs).toEqual(['People']);

    vi.spyOn(localOnlyAdapter, 'read').mockRejectedValue(new Error('target unreachable'));
    const writeSpy = vi.spyOn(localOnlyAdapter, 'write');
    await act(async () => {
      await result.current.connect({ backend: 'local', location: 'unreadable-target' });
    });

    const pushed = writeSpy.mock.calls[0]?.[1];
    expect(pushed && 'People' in pushed).toBe(false);
    expect(result.current.unreadableTabs).toEqual(['People']);
    expect(readLocalPayload().People).toEqual([BROKEN_PEOPLE_HEADER, PEOPLE_ROW]);
  });

  it('still protects the tab when reconnecting to the very same target', async () => {
    // Re-reading the same sheet returns the same broken header, so the
    // evidence stands — clearing it here would push the app's own empty
    // People list over the rows the protection exists for.
    storeLocalPayload(schedulablePayload(BROKEN_PEOPLE_HEADER));
    const { result } = renderHook(() => useStore());
    await waitFor(() => expect(result.current.status).toBe('idle'));

    const writeSpy = vi.spyOn(localOnlyAdapter, 'write');
    await act(async () => {
      await result.current.connect({ backend: 'local', location: '' });
    });

    const pushed = writeSpy.mock.calls[0]?.[1];
    expect(pushed && 'People' in pushed).toBe(false);
    expect(result.current.unreadableTabs).toEqual(['People']);
    expect(readLocalPayload().People).toEqual([BROKEN_PEOPLE_HEADER, PEOPLE_ROW]);
  });

  it('keeps the verdict on disconnect, which lands on the very same local store', async () => {
    // This case used to rest on a comment claiming disconnect "lands on a
    // different store". It does not: `localOnlyAdapter` ignores `location`
    // and has exactly one key, so disconnecting from a named local workbook
    // lands on the same data — and `disconnect`'s fallback location is
    // hardcoded `''`, so ANY non-empty location read as "different". The
    // real UI reaches this routinely: the backend switcher carries the
    // previous backend's location across a backend change.
    const connected: BackendConfig = { backend: 'local', location: 'a-named-workbook' };
    saveCache(withOneAllocation(), 'cached-hash', connected);
    storeLocalPayload(schedulablePayload(BROKEN_PEOPLE_HEADER));

    vi.useFakeTimers();
    const { result } = renderHook(() => useStore());
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });
    expect(result.current.unreadableTabs).toEqual(['People']);

    await act(async () => {
      await result.current.disconnect();
    });
    expect(result.current.unreadableTabs).toEqual(['People']);

    const writeSpy = vi.spyOn(localOnlyAdapter, 'write');
    act(() => {
      result.current.update(addAPerson);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    const pushed = writeSpy.mock.calls[0]?.[1];
    expect(pushed && 'People' in pushed).toBe(false);
    expect(readLocalPayload().People).toEqual([BROKEN_PEOPLE_HEADER, PEOPLE_ROW]);
  });

  it('clears the verdict on disconnect when the store it lands on reads clean', async () => {
    const connected: BackendConfig = { backend: 'local', location: 'a-named-workbook' };
    saveCache(withOneAllocation(), 'cached-hash', connected);
    storeLocalPayload(schedulablePayload(BROKEN_PEOPLE_HEADER));

    const { result } = renderHook(() => useStore());
    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(result.current.unreadableTabs).toEqual(['People']);
    expect(result.current.dataNotice).not.toBeNull();

    // As above: the verdict can only retire for a tab the model holds
    // something for. Without this the app would still be holding the empty
    // People list `parseTab` produced, and the next push would write it.
    act(() => {
      result.current.update(addAPerson);
    });

    readsAsAFreshTarget();
    await act(async () => {
      await result.current.disconnect();
    });

    expect(result.current.unreadableTabs).toEqual([]);
    expect(result.current.dataNotice).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// N3 regression: `tabsToProtect` omitted `Schedule` when there was no result
// to write, but never `Meta` — so a push could leave the Schedule tab
// untouched while Meta's hash certified it as current. No later load would
// ever prompt a recalculation again.
// ---------------------------------------------------------------------------

/** People and overrides, but no allocations: `monthsOf` is empty, so
 *  `recalculate` schedules over zero weeks and produces no entries — while
 *  the Weeks page, whose window is `monthsOf(model) ∪ {month}`, shows a full
 *  schedule for the month on screen. */
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

describe('useStore: Meta never certifies a Schedule that was not written', () => {
  it('omits Meta from every push that omits Schedule', async () => {
    storeLocalPayload(schedulablePayload(PEOPLE_HEADER));
    vi.useFakeTimers();
    const writeSpy = vi.spyOn(localOnlyAdapter, 'write');

    const { result } = renderHook(() => useStore());
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });
    expect(result.current.result.entries).toEqual([]);

    act(() => {
      result.current.update(addAPerson);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    const pushed = writeSpy.mock.calls[0]?.[1];
    expect(pushed && 'Schedule' in pushed).toBe(false);
    expect(pushed && 'Meta' in pushed).toBe(false);
    expect(pushed && 'People' in pushed).toBe(true);
  });

  it('does not certify anything when a recalculation places nothing', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useStore());
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });

    act(() => {
      result.current.update(withOverridesButNoAllocations);
    });
    const writeSpy = vi.spyOn(localOnlyAdapter, 'write');

    act(() => {
      result.current.recalculate();
    });

    // The stale banner must stay up and the user must be told why, rather
    // than the app quietly declaring itself current.
    expect(result.current.isStale).toBe(true);
    expect(result.current.notice).toMatch(/could not recalculate/i);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    // And nothing certifying a schedule reached the backend.
    for (const call of writeSpy.mock.calls) {
      const pushed = call[1];
      expect(pushed && 'Meta' in pushed).toBe(false);
      expect(pushed && 'Schedule' in pushed).toBe(false);
    }
    expect('Meta' in readLocalPayload()).toBe(false);
  });

  it('still writes Schedule and Meta together when there is a real result', async () => {
    storeLocalPayload(schedulablePayload(PEOPLE_HEADER));
    vi.useFakeTimers();
    const writeSpy = vi.spyOn(localOnlyAdapter, 'write');

    const { result } = renderHook(() => useStore());
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });

    act(() => {
      result.current.recalculate();
    });
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });

    expect(result.current.result.entries.length).toBeGreaterThan(0);
    const pushed = writeSpy.mock.calls[0]?.[1];
    expect(pushed && 'Schedule' in pushed).toBe(true);
    expect(pushed && 'Meta' in pushed).toBe(true);
  });
});

describe('useStore: cancelPendingPush', () => {
  it('drops a queued push so the debounced write never leaves', async () => {
    vi.useFakeTimers();
    const writeSpy = vi.spyOn(localOnlyAdapter, 'write');
    const { result } = renderHook(() => useStore());
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });

    act(() => {
      result.current.update(addAPerson);
    });
    act(() => {
      result.current.cancelPendingPush();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('is safe to call when nothing is queued', async () => {
    const { result } = renderHook(() => useStore());
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
// true, a Recalculate button armed and failing on every press, and no `Meta`
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
    const { result } = renderHook(() => useStore());
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });

    act(() => {
      result.current.update(withOverridesButNoAllocations);
    });

    expect(result.current.needsAllocation).toBe(true);
  });

  it('stops reporting it as soon as one month has an allocation', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useStore());
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });

    act(() => {
      result.current.update((model) => ({
        ...withOverridesButNoAllocations(model),
        allocations: [
          { month: '2026-09', otlProjectCode: 'OPEX-ADMIN', personId: 'p1', hours: 40 },
        ],
      }));
    });

    expect(result.current.needsAllocation).toBe(false);
  });

  it('does not report it for a model that implies no schedule at all', async () => {
    // A brand-new model is not waiting for an allocation — it has nothing at
    // all, and recalculating it succeeds and clears the banner.
    const { result } = renderHook(() => useStore());
    await waitFor(() => expect(result.current.status).toBe('idle'));

    expect(result.current.needsAllocation).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// N4 regression: `readVerdict` answers "is the target parseable?", but the
// question `connect` must answer before overwriting a tab is "does the target
// hold rows the in-memory model does not?". The two coincide only while
// parseability is unchanged since the read that populated the model. They
// diverge in exactly one direction — unparseable -> parseable — and that is
// precisely the direction where the in-memory copy is EMPTY (`parseTab`
// dropped the tab) and the target is FULL.
//
// The trigger is the app's own advice: "Restore the header row in your
// spreadsheet, then reload this page." Restore it, then press Connect
// instead of reloading.
// ---------------------------------------------------------------------------

describe('useStore: a verdict is never retired for a tab the model is still empty for', () => {
  it('keeps the rows the user just repaired the header over, instead of writing a lone header row', async () => {
    storeLocalPayload(schedulablePayload(BROKEN_PEOPLE_HEADER));
    const { result } = renderHook(() => useStore());
    await waitFor(() => expect(result.current.status).toBe('idle'));
    // The tab was dropped whole, so the app holds NOTHING for People.
    expect(result.current.model.people).toEqual([]);
    expect(result.current.unreadableTabs).toEqual(['People']);

    // The user does exactly what the notice asks — in the spreadsheet.
    storeLocalPayload(schedulablePayload(PEOPLE_HEADER));

    // ...and then presses Connect instead of reloading the page.
    await act(async () => {
      await result.current.connect({ backend: 'local', location: '' });
    });

    // What SURVIVED, not which keys were pushed: Alex is still there.
    expect(readLocalPayload().People).toEqual([PEOPLE_HEADER, PEOPLE_ROW]);
  });

  it('tells the user the tab now reads correctly and a reload will load it', async () => {
    storeLocalPayload(schedulablePayload(BROKEN_PEOPLE_HEADER));
    const { result } = renderHook(() => useStore());
    await waitFor(() => expect(result.current.status).toBe('idle'));

    storeLocalPayload(schedulablePayload(PEOPLE_HEADER));
    await act(async () => {
      await result.current.connect({ backend: 'local', location: '' });
    });

    expect(result.current.unreadableTabs).toEqual(['People']);
    expect(result.current.dataNotice).toMatch(/now reads correctly/i);
    expect(result.current.dataNotice).toMatch(/reload this page/i);
    // And it must no longer claim the header is still broken.
    expect(result.current.dataNotice).not.toMatch(/does not match the columns/i);
  });

  it('survives a transient empty read of the very tab that was unreadable', async () => {
    // Reachable on Microsoft with NO user action: `readWorksheet` returns []
    // on a 404, and `parseTab` reads a zero-row tab as "empty", not
    // "unreadable" — a clean verdict with nothing in memory to replace it.
    storeLocalPayload(schedulablePayload(BROKEN_PEOPLE_HEADER));
    const { result } = renderHook(() => useStore());
    await waitFor(() => expect(result.current.status).toBe('idle'));

    vi.spyOn(localOnlyAdapter, 'read').mockResolvedValueOnce({});
    await act(async () => {
      await result.current.connect({ backend: 'local', location: '' });
    });

    expect(readLocalPayload().People).toEqual([BROKEN_PEOPLE_HEADER, PEOPLE_ROW]);
  });
});

// ---------------------------------------------------------------------------
// N4 regression: on a FIRST connect there is no standing verdict, so
// `verdict?.unreadableTabs ?? unreadableTabsRef.current` degraded to `?? []`
// and every tab was blind-written to a target the app could not read one row
// of. A target we could not read is the one we know least about.
// ---------------------------------------------------------------------------

describe('useStore: a target that could not be read is not written to', () => {
  it('leaves every tab of a first-ever target intact when the read fails', async () => {
    // A fresh app: empty model, no verdict to fall back on.
    const { result } = renderHook(() => useStore());
    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(result.current.unreadableTabs).toEqual([]);
    expect(result.current.model).toEqual(emptyModel);

    // The target the user points at already holds their data.
    storeLocalPayload(schedulablePayload(PEOPLE_HEADER));

    vi.spyOn(localOnlyAdapter, 'read').mockRejectedValue(new Error('consent required'));
    await act(async () => {
      await result.current.connect({ backend: 'local', location: 'their-real-workbook' });
    });

    // What SURVIVED: every tab, untouched.
    const stored = readLocalPayload();
    expect(stored.People).toEqual([PEOPLE_HEADER, PEOPLE_ROW]);
    expect(stored.OTLs).toEqual(schedulablePayload(PEOPLE_HEADER).OTLs);
    expect(stored.Allocations).toEqual(schedulablePayload(PEOPLE_HEADER).Allocations);
  });

  it('says the target could not be read instead of failing silently', async () => {
    const { result } = renderHook(() => useStore());
    await waitFor(() => expect(result.current.status).toBe('idle'));

    vi.spyOn(localOnlyAdapter, 'read').mockRejectedValue(new Error('consent required'));
    await act(async () => {
      await result.current.connect({ backend: 'local', location: 'their-real-workbook' });
    });

    expect(result.current.notice).toMatch(/could not be read/i);
    expect(result.current.notice).toMatch(/consent required/i);
    expect(result.current.notice).toMatch(/nothing was written/i);
  });
});

// ---------------------------------------------------------------------------
// N4 regression: `needsAllocation` is the right empty state for a model that
// was NEVER scheduled. For one that WAS scheduled and then had its
// allocations removed it over-suppresses: the backend still holds the
// schedule rows and Meta still certifies the old hash, while the screen
// recomputes from the current model — and nothing says so. Silent staleness.
// ---------------------------------------------------------------------------

describe('useStore: a certified schedule that lost its allocations is still reported', () => {
  it('reports the certificate alongside needsAllocation once a schedule was calculated', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useStore());
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });

    act(() => {
      result.current.update((model) => ({
        ...withOverridesButNoAllocations(model),
        allocations: [
          { month: '2026-09', otlProjectCode: 'OPEX-ADMIN', personId: 'p1', hours: 40 },
        ],
      }));
    });
    act(() => {
      result.current.recalculate();
    });
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });
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
    const { result } = renderHook(() => useStore());
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });

    act(() => {
      result.current.update(withOverridesButNoAllocations);
    });

    expect(result.current.needsAllocation).toBe(true);
    expect(result.current.hasCertifiedSchedule).toBe(false);
  });

  it('reports no certificate when the cache only ever held the empty placeholder hash', async () => {
    // `update` writes `hashRef.current ?? ''` — so an edit made before any
    // recalculation leaves `''` in the cache. That is "never certified",
    // not a hash.
    saveCache(withOverridesButNoAllocations(emptyModel), '', { backend: 'local', location: '' });
    vi.spyOn(localOnlyAdapter, 'read').mockRejectedValue(new Error('offline'));

    const { result } = renderHook(() => useStore());
    await waitFor(() => expect(result.current.status).toBe('offline'));

    expect(result.current.needsAllocation).toBe(true);
    expect(result.current.hasCertifiedSchedule).toBe(false);
  });
});
