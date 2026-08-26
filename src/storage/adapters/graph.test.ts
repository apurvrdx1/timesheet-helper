import { describe, it, expect, vi, beforeEach } from 'vitest';
import { encodeShareUrl, resolveWorkbookId, readWorksheet, writeWorksheet } from './graph';

beforeEach(() => { vi.restoreAllMocks(); });

describe('encodeShareUrl', () => {
  it('produces a base64url token prefixed with u!', () => {
    const got = encodeShareUrl('https://contoso-my.sharepoint.com/x.xlsx');
    expect(got.startsWith('u!')).toBe(true);
    expect(got).not.toContain('=');   // padding stripped
    expect(got).not.toContain('+');   // base64url, not base64
    expect(got).not.toContain('/');
  });
});

describe('resolveWorkbookId', () => {
  it('turns a share link into a drive item id', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ id: 'ITEM123' }),
    }));
    expect(await resolveWorkbookId('tok', 'https://x/y.xlsx')).toBe('ITEM123');
  });

  it('explains a 404 in terms the user can act on', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 404, text: async () => 'not found',
    }));
    await expect(resolveWorkbookId('tok', 'https://x/y.xlsx'))
      .rejects.toThrow(/could not find that workbook/i);
  });
});

describe('readWorksheet', () => {
  it('returns the used range values', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ text: [['projectCode'], ['P-1001']] }),
    }));
    expect(await readWorksheet('tok', 'ITEM123', 'OTLs'))
      .toEqual([['projectCode'], ['P-1001']]);
  });

  it('returns an empty grid when the worksheet does not exist yet', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 404, text: async () => 'ItemNotFound',
    }));
    expect(await readWorksheet('tok', 'ITEM123', 'Missing')).toEqual([]);
  });

  it('requests the worksheet by name, url-encoded', async () => {
    const spy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ text: [] }) });
    vi.stubGlobal('fetch', spy);
    await readWorksheet('tok', 'ITEM123', 'Stat Holidays');
    expect(spy.mock.calls[0]?.[0]).toContain("worksheets('Stat%20Holidays')");
  });
});

describe('writeWorksheet', () => {
  it('clears the sheet before writing so stale rows cannot survive', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      calls.push(url);
      return Promise.resolve({ ok: true, json: async () => ({}) });
    }));
    await writeWorksheet('tok', 'ITEM123', 'OTLs', [['a'], ['b']]);
    expect(calls.some((c) => c.includes('clear'))).toBe(true);
  });

  it('addresses the range by exact dimensions', async () => {
    const bodies: string[] = [];
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.body) bodies.push(String(init.body));
      return Promise.resolve({ ok: true, json: async () => ({}) });
    }));
    // 2 rows x 3 columns -> A1:C2
    await writeWorksheet('tok', 'ITEM123', 'OTLs', [['a', 'b', 'c'], ['d', 'e', 'f']]);
    expect(bodies.some((b) => b.includes('"values"'))).toBe(true);
  });

  it('does nothing but clear when given no rows', async () => {
    const spy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal('fetch', spy);
    await writeWorksheet('tok', 'ITEM123', 'OTLs', []);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
