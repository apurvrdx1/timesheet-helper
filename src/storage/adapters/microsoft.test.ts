import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { microsoftAdapter } from './microsoft';
import type { SheetPayload } from '../serialize';

// ---------------------------------------------------------------------------
// A hand-rolled MSAL mock. `microsoft.ts` loads `@azure/msal-browser` via a
// dynamic `import()`, so `vi.mock` intercepts it the same way it would a
// static import. Methods are shared `vi.fn()`s (not per-instance) so tests
// can configure behaviour before calling the adapter and assert on calls
// afterwards without reaching into `PublicClientApplication` instances.
// ---------------------------------------------------------------------------
const {
  pcaConstructions,
  constructionBehavior,
  mockMethods,
  MockPublicClientApplication,
  MockInteractionRequiredAuthError,
} = vi.hoisted(() => {
  class MockInteractionRequiredAuthError extends Error {
    errorCode = 'interaction_required';
  }

  const pcaConstructions: unknown[] = [];
  const constructionBehavior = { shouldFail: false };

  const mockMethods = {
    initialize: vi.fn(),
    getActiveAccount: vi.fn(),
    getAllAccounts: vi.fn(),
    setActiveAccount: vi.fn(),
    acquireTokenSilent: vi.fn(),
    loginPopup: vi.fn(),
    logoutPopup: vi.fn(),
  };

  class MockPublicClientApplication {
    config: unknown;
    initialize = mockMethods.initialize;
    getActiveAccount = mockMethods.getActiveAccount;
    getAllAccounts = mockMethods.getAllAccounts;
    setActiveAccount = mockMethods.setActiveAccount;
    acquireTokenSilent = mockMethods.acquireTokenSilent;
    loginPopup = mockMethods.loginPopup;
    logoutPopup = mockMethods.logoutPopup;
    constructor(config: unknown) {
      if (constructionBehavior.shouldFail) throw new Error('mock MSAL construction failure');
      this.config = config;
      pcaConstructions.push(config);
    }
  }

  return {
    pcaConstructions,
    constructionBehavior,
    mockMethods,
    MockPublicClientApplication,
    MockInteractionRequiredAuthError,
  };
});

vi.mock('@azure/msal-browser', () => ({
  PublicClientApplication: MockPublicClientApplication,
  InteractionRequiredAuthError: MockInteractionRequiredAuthError,
}));

const config = {
  backend: 'microsoft' as const,
  location: 'https://contoso-my.sharepoint.com/personal/x/Doc.aspx?sourcedoc=1',
  clientId: '11111111-2222-3333-4444-555555555555',
  authority: 'consumers',
};

const account = { homeAccountId: 'home-1' };

function ok(body: unknown): { ok: true; status: 200; json: () => Promise<unknown> } {
  return { ok: true, status: 200, json: async () => body };
}

/** Routes every fetch call by a regex match against the URL. */
function stubFetch(
  handlers: ReadonlyArray<{ match: RegExp; respond: () => unknown }>,
): ReturnType<typeof vi.fn> {
  const spy = vi.fn().mockImplementation(async (url: string) => {
    const handler = handlers.find((h) => h.match.test(url));
    if (handler === undefined) throw new Error(`Unhandled fetch in test: ${url}`);
    return handler.respond();
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

beforeEach(() => {
  mockMethods.initialize.mockReset().mockResolvedValue(undefined);
  mockMethods.getActiveAccount.mockReset().mockReturnValue(null);
  mockMethods.getAllAccounts.mockReset().mockReturnValue([]);
  mockMethods.setActiveAccount.mockReset();
  mockMethods.acquireTokenSilent.mockReset().mockRejectedValue(new Error('no silent session'));
  mockMethods.loginPopup.mockReset().mockRejectedValue(new Error('no popup configured in test'));
  mockMethods.logoutPopup.mockReset().mockResolvedValue(undefined);
  pcaConstructions.length = 0;
  constructionBehavior.shouldFail = false;
});

afterEach(async () => {
  // Bring module-scope caches back to empty so tests don't leak into each
  // other: logoutPopup/initialize are reset to succeed so disconnect()
  // itself cannot throw during cleanup.
  mockMethods.initialize.mockResolvedValue(undefined);
  mockMethods.logoutPopup.mockResolvedValue(undefined);
  await microsoftAdapter.disconnect();
  vi.unstubAllGlobals();
});

describe('microsoftAdapter.validate', () => {
  it('accepts a complete config', () => {
    expect(microsoftAdapter.validate(config)).toEqual([]);
  });

  it('requires a client id', () => {
    expect(microsoftAdapter.validate({ ...config, clientId: '' })).toHaveLength(1);
  });

  it('rejects a client id that is not a GUID', () => {
    expect(microsoftAdapter.validate({ ...config, clientId: 'not-a-guid' }))
      .toHaveLength(1);
  });

  it('requires a workbook link', () => {
    expect(microsoftAdapter.validate({ ...config, location: '' })).toHaveLength(1);
  });

  it('defaults the authority when it is absent', () => {
    expect(microsoftAdapter.validate({ ...config, authority: undefined })).toEqual([]);
  });

  it('never asks for a shared secret', () => {
    const problems = microsoftAdapter.validate({ ...config, secret: undefined });
    expect(problems.join(' ')).not.toMatch(/secret/i);
  });
});

describe('microsoftAdapter.connect', () => {
  it('acquires a token silently when a cached account exists, without popping up', async () => {
    mockMethods.getActiveAccount.mockReturnValue(account);
    mockMethods.acquireTokenSilent.mockResolvedValue({ accessToken: 'silent-tok', account });

    await microsoftAdapter.connect(config);

    expect(mockMethods.acquireTokenSilent).toHaveBeenCalledTimes(1);
    expect(mockMethods.loginPopup).not.toHaveBeenCalled();
    expect(mockMethods.setActiveAccount).toHaveBeenCalledWith(account);
  });

  it('falls back to loginPopup when there is no cached account', async () => {
    mockMethods.loginPopup.mockResolvedValue({ accessToken: 'popup-tok', account });

    await microsoftAdapter.connect(config);

    expect(mockMethods.loginPopup).toHaveBeenCalledTimes(1);
  });

  it('falls back to loginPopup when the silent acquire rejects', async () => {
    mockMethods.getActiveAccount.mockReturnValue(account);
    mockMethods.acquireTokenSilent.mockRejectedValue(new Error('interaction required'));
    mockMethods.loginPopup.mockResolvedValue({ accessToken: 'popup-tok', account });

    await microsoftAdapter.connect(config);

    expect(mockMethods.loginPopup).toHaveBeenCalledTimes(1);
  });

  it('constructs only one MSAL client for two concurrent connect() calls', async () => {
    mockMethods.loginPopup.mockResolvedValue({ accessToken: 'popup-tok', account });

    await Promise.all([microsoftAdapter.connect(config), microsoftAdapter.connect(config)]);

    expect(pcaConstructions).toHaveLength(1);
  });

  it('constructs a fresh client when clientId/authority changes', async () => {
    mockMethods.loginPopup.mockResolvedValue({ accessToken: 'popup-tok', account });

    await microsoftAdapter.connect(config);
    await microsoftAdapter.connect({ ...config, authority: 'organizations' });

    expect(pcaConstructions).toHaveLength(2);
  });

  it('does not cache a rejected client forever — a failed construction can be retried', async () => {
    constructionBehavior.shouldFail = true;
    await expect(microsoftAdapter.connect(config)).rejects.toThrow(/mock MSAL construction failure/);
    expect(pcaConstructions).toHaveLength(0);

    constructionBehavior.shouldFail = false;
    mockMethods.loginPopup.mockResolvedValue({ accessToken: 'popup-tok', account });
    await microsoftAdapter.connect(config);
    expect(pcaConstructions).toHaveLength(1);
  });
});

describe('sign-in failure classification', () => {
  it('classifies InteractionRequiredAuthError as a consent failure', async () => {
    mockMethods.loginPopup.mockRejectedValue(new MockInteractionRequiredAuthError('need consent'));

    await expect(microsoftAdapter.connect(config))
      .rejects.toThrow(/administrator may need to approve/i);
  });

  it('classifies an AADSTS consent error code as a consent failure', async () => {
    mockMethods.loginPopup.mockRejectedValue(new Error('AADSTS65001: user or admin has not consented'));

    await expect(microsoftAdapter.connect(config))
      .rejects.toThrow(/administrator may need to approve/i);
  });

  it('classifies a blocked popup with an actionable message', async () => {
    const error = new Error('Error opening popup window');
    (error as Error & { errorCode: string }).errorCode = 'popup_window_error';
    mockMethods.loginPopup.mockRejectedValue(error);

    await expect(microsoftAdapter.connect(config))
      .rejects.toThrow(/browser blocked the sign-in window/i);
  });

  it('classifies a network failure with an actionable message', async () => {
    mockMethods.loginPopup.mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(microsoftAdapter.connect(config))
      .rejects.toThrow(/could not reach microsoft/i);
  });

  it('falls back to a generic actionable message without leaking exception text', async () => {
    const secretInternal = 'some obscure MSAL internal detail nobody should see';
    mockMethods.loginPopup.mockRejectedValue(new Error(secretInternal));

    await expect(microsoftAdapter.connect(config)).rejects.toThrow(/sign-in failed/i);
    try {
      await microsoftAdapter.connect(config);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain(secretInternal);
      expect((error as Error).cause).toBeInstanceOf(Error);
      expect(((error as Error).cause as Error).message).toBe(secretInternal);
    }
  });
});

describe('microsoftAdapter.read / write URL shapes', () => {
  beforeEach(() => {
    mockMethods.loginPopup.mockResolvedValue({ accessToken: 'tok', account });
  });

  it('resolves the workbook once, then reads each of the 8 tabs by name', async () => {
    const spy = stubFetch([
      { match: /\/shares\//, respond: () => ok({ id: 'ITEM1' }) },
      { match: /usedRange/, respond: () => ok({ text: [['a']] }) },
    ]);

    const payload = await microsoftAdapter.read(config);

    const urls = spy.mock.calls.map((c) => String(c[0]));
    expect(urls.filter((u) => u.includes('/shares/'))).toHaveLength(1);
    expect(urls.some((u) => u.includes("/me/drive/items/ITEM1/workbook/worksheets('OTLs')/usedRange(valuesOnly=true)"))).toBe(true);
    expect(urls.some((u) => u.includes("worksheets('Meta')/usedRange"))).toBe(true);
    expect(payload.OTLs).toEqual([['a']]);
  });

  it('writes each of the 8 tabs, clearing an explicit range address rather than usedRange/clear', async () => {
    const spy = stubFetch([
      { match: /\/shares\//, respond: () => ok({ id: 'ITEM1' }) },
      { match: /usedRange/, respond: () => ok({ address: 'Sheet1!A1:A1' }) },
      { match: /\/clear$/, respond: () => ok({}) },
      { match: /range\(address=/, respond: () => ok({}) },
      { match: /\/worksheets$/, respond: () => ok({}) },
    ]);

    const payload: SheetPayload = {
      OTLs: [['h'], ['1']],
      People: [['h'], ['1']],
      StatHolidays: [],
      Allocations: [],
      Leave: [],
      Overrides: [],
      Schedule: [],
      Meta: [],
    };

    await microsoftAdapter.write(config, payload);

    const urls = spy.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes('usedRange/clear'))).toBe(false);
    expect(urls.some((u) => u.includes("worksheets('OTLs')/range(address='A1:A2')"))).toBe(true);
  });

  it('never touches a tab the payload omits — the write clears before it writes', async () => {
    const spy = stubFetch([
      { match: /\/shares\//, respond: () => ok({ id: 'ITEM1' }) },
      { match: /usedRange/, respond: () => ok({ address: 'Sheet1!A1:A1' }) },
      { match: /\/clear$/, respond: () => ok({}) },
      { match: /range\(address=/, respond: () => ok({}) },
      { match: /\/worksheets$/, respond: () => ok({}) },
    ]);

    await microsoftAdapter.write(config, { OTLs: [['h'], ['1']] });

    const urls = spy.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("worksheets('OTLs')"))).toBe(true);
    expect(urls.some((u) => u.includes("worksheets('People')"))).toBe(false);
  });
});

describe('workbook id cache', () => {
  beforeEach(() => {
    mockMethods.loginPopup.mockResolvedValue({ accessToken: 'tok', account });
  });

  it('resolves the share link once across multiple read() calls to the same location', async () => {
    const spy = stubFetch([
      { match: /\/shares\//, respond: () => ok({ id: 'ITEM1' }) },
      { match: /usedRange/, respond: () => ok({ text: [] }) },
    ]);

    await microsoftAdapter.read(config);
    await microsoftAdapter.read(config);

    const resolveCalls = spy.mock.calls.filter((c) => String(c[0]).includes('/shares/'));
    expect(resolveCalls).toHaveLength(1);
  });

  it('re-resolves the workbook id after disconnect()', async () => {
    const spy = stubFetch([
      { match: /\/shares\//, respond: () => ok({ id: 'ITEM1' }) },
      { match: /usedRange/, respond: () => ok({ text: [] }) },
    ]);

    await microsoftAdapter.read(config);
    await microsoftAdapter.disconnect();
    await microsoftAdapter.read(config);

    const resolveCalls = spy.mock.calls.filter((c) => String(c[0]).includes('/shares/'));
    expect(resolveCalls).toHaveLength(2);
  });
});

describe('microsoftAdapter.disconnect', () => {
  it('logs out of MSAL and forces a fresh client on the next connect()', async () => {
    mockMethods.loginPopup.mockResolvedValue({ accessToken: 'tok', account });

    await microsoftAdapter.connect(config);
    expect(pcaConstructions).toHaveLength(1);

    await microsoftAdapter.disconnect();
    expect(mockMethods.logoutPopup).toHaveBeenCalledTimes(1);

    await microsoftAdapter.connect(config);
    expect(pcaConstructions).toHaveLength(2);
  });

  it('does nothing when nothing has connected yet', async () => {
    await expect(microsoftAdapter.disconnect()).resolves.toBeUndefined();
    expect(mockMethods.logoutPopup).not.toHaveBeenCalled();
  });

  it('does not throw when the cached client failed to construct', async () => {
    constructionBehavior.shouldFail = true;
    await expect(microsoftAdapter.connect(config)).rejects.toThrow();
    // getClient already clears a rejected construction from the cache, so
    // there is nothing left for disconnect() to log out of — this should
    // resolve cleanly either way.
    await expect(microsoftAdapter.disconnect()).resolves.toBeUndefined();
    expect(mockMethods.logoutPopup).not.toHaveBeenCalled();
  });
});
