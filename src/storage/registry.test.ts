import { describe, it, expect } from 'vitest';
import { getAdapter, listAdapters } from './registry';

describe('registry', () => {
  it('offers all three backends', () => {
    expect(listAdapters().map((a) => a.id).sort())
      .toEqual(['google', 'local', 'microsoft']);
  });

  it('gives every backend a human label', () => {
    for (const adapter of listAdapters()) {
      expect(adapter.label.length).toBeGreaterThan(0);
    }
  });

  it('resolves an adapter by id', () => {
    expect(getAdapter('google').id).toBe('google');
    expect(getAdapter('microsoft').id).toBe('microsoft');
  });

  it('throws on an unknown id rather than returning undefined', () => {
    expect(() => getAdapter('dropbox' as never)).toThrow(/unknown/i);
  });

  it('exposes the identical shape for every backend', () => {
    for (const adapter of listAdapters()) {
      expect(typeof adapter.validate).toBe('function');
      expect(typeof adapter.connect).toBe('function');
      expect(typeof adapter.read).toBe('function');
      expect(typeof adapter.write).toBe('function');
      expect(typeof adapter.disconnect).toBe('function');
    }
  });
});
