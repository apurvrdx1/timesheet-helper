import { describe, it, expect } from 'vitest';
import { getAdapter, listAdapters, getConnectionFields, getConnectionNotice } from './registry';

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

// -----------------------------------------------------------------------
// Task 15: connection-form metadata. This is the only place allowed to
// know which fields/notices belong to which backend id, so the UI can
// render a form without ever branching on a backend name itself.
// -----------------------------------------------------------------------

describe('registry: connection fields', () => {
  it('asks for nothing for local-only', () => {
    expect(getConnectionFields('local')).toEqual([]);
  });

  it('asks for a script url and a password-type secret for google', () => {
    const fields = getConnectionFields('google');
    expect(fields.find((f) => /script url/i.test(f.label))).toBeDefined();
    const secret = fields.find((f) => /shared secret/i.test(f.label));
    expect(secret?.type).toBe('password');
    expect(fields.some((f) => /client id/i.test(f.label))).toBe(false);
  });

  it('asks for a client id and a workbook link for microsoft', () => {
    const fields = getConnectionFields('microsoft');
    expect(fields.some((f) => /client id/i.test(f.label))).toBe(true);
    expect(fields.some((f) => /workbook link/i.test(f.label))).toBe(true);
    expect(fields.some((f) => /shared secret/i.test(f.label))).toBe(false);
  });

  it('gives every field a config key that round-trips through BackendConfig', () => {
    for (const adapter of listAdapters()) {
      for (const field of getConnectionFields(adapter.id)) {
        expect(['location', 'secret', 'clientId']).toContain(field.key);
      }
    }
  });
});

describe('registry: connection notices', () => {
  it('has no notice for local-only', () => {
    expect(getConnectionNotice('local')).toBeUndefined();
  });

  it('warns that microsoft work accounts may need admin approval', () => {
    const notice = getConnectionNotice('microsoft');
    expect(notice?.message).toMatch(/administrator/i);
    expect(notice?.href).toBe('docs/microsoft-setup.md');
  });

  it('points google at the apps script setup guide', () => {
    const notice = getConnectionNotice('google');
    expect(notice?.href).toBe('apps-script/README.md');
  });
});
