import { describe, it, expect, vi, beforeEach } from 'vitest';
import { googleAdapter } from './google';

const config = {
  backend: 'google' as const,
  location: 'https://script.google.com/macros/s/abc/exec',
  secret: 'hunter2',
};

beforeEach(() => { vi.restoreAllMocks(); });

describe('googleAdapter.validate', () => {
  it('accepts a complete config', () => {
    expect(googleAdapter.validate(config)).toEqual([]);
  });

  it('rejects a missing URL', () => {
    expect(googleAdapter.validate({ ...config, location: '' })).toHaveLength(1);
  });

  it('rejects a missing secret', () => {
    expect(googleAdapter.validate({ ...config, secret: '' })).toHaveLength(1);
  });

  it('rejects a URL that is not an Apps Script exec endpoint', () => {
    expect(googleAdapter.validate({ ...config, location: 'https://example.com' }))
      .toHaveLength(1);
  });
});

describe('googleAdapter.read', () => {
  it('returns the payload on success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ ok: true, payload: { OTLs: [['projectCode']] } }),
    }));
    expect(await googleAdapter.read(config)).toEqual({ OTLs: [['projectCode']] });
  });

  it('passes the secret as a query parameter', async () => {
    const spy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, payload: {} }) });
    vi.stubGlobal('fetch', spy);
    await googleAdapter.read(config);
    expect(spy.mock.calls[0]?.[0]).toContain('secret=hunter2');
  });

  it('throws a readable error when the script rejects the secret', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ ok: false, error: 'unauthorized' }),
    }));
    await expect(googleAdapter.read(config)).rejects.toThrow(/unauthorized/);
  });

  it('reports a network failure without leaking the raw error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(googleAdapter.read(config)).rejects.toThrow(/could not reach/i);
  });
});

describe('googleAdapter.write', () => {
  it('posts as text/plain to avoid a CORS preflight', async () => {
    const spy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal('fetch', spy);
    await googleAdapter.write(config, { OTLs: [['projectCode']] } as never);
    expect(spy.mock.calls[0]?.[1].method).toBe('POST');
    expect(spy.mock.calls[0]?.[1].headers['Content-Type']).toContain('text/plain');
  });

  it('sends the secret in the body, never the URL', async () => {
    const spy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal('fetch', spy);
    await googleAdapter.write(config, { OTLs: [] } as never);
    expect(spy.mock.calls[0]?.[0]).not.toContain('hunter2');
    expect(JSON.parse(spy.mock.calls[0]?.[1].body).secret).toBe('hunter2');
  });
});
