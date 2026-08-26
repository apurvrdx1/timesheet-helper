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
