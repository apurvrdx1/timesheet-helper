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
// N1 regression: `unreadableTabs` was only ever SET (in loadInitial) and
// never cleared, so a verdict about the old spreadsheet followed the user to
// a new one. "Connect somewhere clean" is the intuitive escape hatch from a
// broken header, and it silently did not work.
// ---------------------------------------------------------------------------

describe('useStore: an unreadable verdict does not follow the user to another backend', () => {
  it('pushes every tab to a newly connected backend, including the one that was unreadable', async () => {
    storeLocalPayload(schedulablePayload(BROKEN_PEOPLE_HEADER));
    const { result } = renderHook(() => useStore());
    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(result.current.unreadableTabs).toEqual(['People']);

    act(() => {
      result.current.update(addAPerson);
    });

    // A different target: same adapter, a location it has never read.
    const writeSpy = vi.spyOn(localOnlyAdapter, 'write');
    await act(async () => {
      await result.current.connect({ backend: 'local', location: 'a-fresh-workbook' });
    });

    const pushed = writeSpy.mock.calls[0]?.[1];
    expect(pushed).toBeDefined();
    expect(pushed && 'People' in pushed).toBe(true);
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

    await act(async () => {
      await result.current.connect({ backend: 'local', location: 'a-fresh-workbook' });
    });

    const writeSpy = vi.spyOn(localOnlyAdapter, 'write');
    act(() => {
      result.current.update(addAPerson);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(writeSpy).toHaveBeenCalledTimes(1);
    const pushed = writeSpy.mock.calls[0]?.[1];
    expect(pushed && 'People' in pushed).toBe(true);
  });

  it('still protects the tab when reconnecting to the very same target', async () => {
    // `connect` writes without re-reading, so the evidence about THIS sheet
    // still stands — clearing it here would push the app's own empty People
    // list over the rows the protection exists for.
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

  it('clears the verdict on disconnect, which lands on a different store', async () => {
    // Mounted against a named workbook; disconnect drops back to the
    // unnamed local-only store, which is a different copy of the data and
    // has not been read.
    const connected: BackendConfig = { backend: 'local', location: 'a-named-workbook' };
    saveCache(withOneAllocation(), 'cached-hash', connected);
    storeLocalPayload(schedulablePayload(BROKEN_PEOPLE_HEADER));

    const { result } = renderHook(() => useStore());
    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(result.current.unreadableTabs).toEqual(['People']);
    expect(result.current.dataNotice).not.toBeNull();

    await act(async () => {
      await result.current.disconnect();
    });

    expect(result.current.unreadableTabs).toEqual([]);
    expect(result.current.dataNotice).toBeNull();
  });
});
