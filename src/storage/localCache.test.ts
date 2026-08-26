import { describe, it, expect, beforeEach, vi } from 'vitest';
import { loadCache, saveCache } from './localCache';
import type { Model } from '../domain/types';
import type { BackendConfig } from './adapter';

const model: Model = {
  otls: [], people: [], statHolidays: [], allocations: [], leave: [], overrides: [],
};
const config: BackendConfig = { backend: 'google', location: 'https://example.com', secret: 's3cr3t' };

describe('localCache', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns null when nothing has been cached', () => {
    expect(loadCache()).toBeNull();
  });

  it('round-trips model, hash and config', () => {
    saveCache(model, 'abc123', config);
    expect(loadCache()).toEqual({ model, hash: 'abc123', config });
  });

  it('writes under the versioned key', () => {
    saveCache(model, 'abc123', config);
    expect(localStorage.getItem('timesheet-helper:v1')).not.toBeNull();
  });

  it('returns null instead of throwing on corrupt JSON', () => {
    localStorage.setItem('timesheet-helper:v1', 'not json{{{');
    expect(loadCache()).toBeNull();
  });

  it('returns null instead of throwing when localStorage.getItem throws', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(loadCache()).toBeNull();
    spy.mockRestore();
  });

  it('does not throw when localStorage.setItem throws', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });
    expect(() => saveCache(model, 'abc123', config)).not.toThrow();
    spy.mockRestore();
  });

  it('persists the secret and clientId locally, not just non-sensitive fields', () => {
    const msConfig: BackendConfig = {
      backend: 'microsoft', location: 'https://example.com/wb', clientId: 'guid-1234',
    };
    saveCache(model, 'abc123', msConfig);
    expect(loadCache()?.config).toEqual(msConfig);
  });
});
