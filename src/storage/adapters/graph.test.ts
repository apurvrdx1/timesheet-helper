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
  /** A fetch stub for the common case: the worksheet already exists. */
  function existingSheetFetch(usedRangeAddress = 'OTLs!A1:B2') {
    return vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (typeof url === 'string' && url.includes('usedRange')) {
        return Promise.resolve({ ok: true, json: async () => ({ address: usedRangeAddress }) });
      }
      return Promise.resolve({ ok: true, json: async () => ({}), init });
    });
  }

  it('clears the sheet by an explicit range address, not usedRange/clear', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.includes('usedRange')) {
        return Promise.resolve({ ok: true, json: async () => ({ address: 'OTLs!A1:B2' }) });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    }));
    await writeWorksheet('tok', 'ITEM123', 'OTLs', [['a'], ['b']]);

    // The endpoint the plan's reference code used does not exist on Graph.
    expect(calls.some((c) => c.url.includes('usedRange/clear'))).toBe(false);

    const clearCall = calls.find((c) => c.url.includes('/clear'));
    expect(clearCall).toBeDefined();
    expect(clearCall?.url).toContain("range(address='A1:B2')/clear");
    expect(clearCall?.init?.method).toBe('POST');
    expect(String(clearCall?.init?.body)).toContain('"applyTo":"contents"');
  });

  it('strips the sheet-name prefix from the usedRange address before clearing', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      calls.push(url);
      if (url.includes('usedRange')) {
        return Promise.resolve({ ok: true, json: async () => ({ address: 'Stat Holidays!C3:E9' }) });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    }));
    await writeWorksheet('tok', 'ITEM123', 'StatHolidays', []);
    expect(calls.some((c) => c.includes("range(address='C3:E9')/clear"))).toBe(true);
    expect(calls.some((c) => c.includes('Stat Holidays!'))).toBe(false);
  });

  it('creates the worksheet when usedRange 404s, and does not try to clear', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      calls.push(url);
      if (url.includes('usedRange')) {
        return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    }));
    await writeWorksheet('tok', 'ITEM123', 'OTLs', [['a']]);
    expect(calls.some((c) => c.endsWith('/workbook/worksheets'))).toBe(true);
    expect(calls.some((c) => c.includes('/clear'))).toBe(false);
  });

  it('throws an actionable error when worksheet creation fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('usedRange')) {
        return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
      }
      return Promise.resolve({ ok: false, status: 500, json: async () => ({}) });
    }));
    await expect(writeWorksheet('tok', 'ITEM123', 'OTLs', [['a']]))
      .rejects.toThrow(/could not create the "otls" sheet/i);
  });

  it('throws when the clear itself fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('usedRange')) {
        return Promise.resolve({ ok: true, json: async () => ({ address: 'OTLs!A1:B2' }) });
      }
      if (typeof url === 'string' && url.includes('/clear')) {
        return Promise.resolve({ ok: false, status: 500, json: async () => ({}) });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    }));
    await expect(writeWorksheet('tok', 'ITEM123', 'OTLs', [['a']]))
      .rejects.toThrow(/could not clear the "otls" sheet/i);
  });

  it('addresses the range by exact dimensions', async () => {
    const bodies: string[] = [];
    vi.stubGlobal('fetch', existingSheetFetch());
    const spy = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (init?.body) bodies.push(String(init.body));
      if (url.includes('usedRange')) return Promise.resolve({ ok: true, json: async () => ({ address: 'OTLs!A1:B2' }) });
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    vi.stubGlobal('fetch', spy);
    // 2 rows x 3 columns -> A1:C2
    await writeWorksheet('tok', 'ITEM123', 'OTLs', [['a', 'b', 'c'], ['d', 'e', 'f']]);
    expect(bodies.some((b) => b.includes('"values"'))).toBe(true);
    expect(spy.mock.calls.some((c) => String(c[0]).includes("range(address='A1:C2')"))).toBe(true);
  });

  it('does nothing but check + clear when given no rows', async () => {
    const spy = existingSheetFetch();
    vi.stubGlobal('fetch', spy);
    await writeWorksheet('tok', 'ITEM123', 'OTLs', []);
    // usedRange GET + clear POST, no write PATCH.
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
