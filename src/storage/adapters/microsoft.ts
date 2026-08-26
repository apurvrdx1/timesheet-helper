/**
 * Microsoft 365 Excel backend: MSAL browser auth (PKCE, public client — a
 * static GitHub Pages site cannot keep a client secret) against the
 * Microsoft Graph Excel API.
 *
 * This backend differs from the Google one in a load-bearing way: there is
 * no anonymous endpoint to hit with a shared secret, because Graph requires
 * a signed-in user. Access is governed by the workbook's own sharing
 * permissions instead — genuinely better security than a shared secret, at
 * the cost of an interactive sign-in and an Entra app registration.
 *
 * - `connect()` is real here (unlike Google's no-op): it initialises MSAL,
 *   tries `acquireTokenSilent`, and falls back to `loginPopup`.
 * - `disconnect()` is real: `logoutPopup` plus clearing the cached workbook
 *   id, since a new sign-in may point at a different account/workbook.
 * - `validate()` never asks for a shared secret — there isn't one.
 */
import {
  PublicClientApplication,
  InteractionRequiredAuthError,
  type Configuration,
  type IPublicClientApplication,
} from '@azure/msal-browser';
import type { BackendConfig, StorageAdapter } from '../adapter';
import type { SheetPayload, TabName } from '../serialize';
import { resolveWorkbookId, readWorksheet, writeWorksheet } from './graph';

const SCOPES = ['Files.ReadWrite', 'User.Read'];
const DEFAULT_AUTHORITY = 'common';
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TABS: readonly TabName[] = [
  'OTLs',
  'People',
  'StatHolidays',
  'Allocations',
  'Leave',
  'Overrides',
  'Schedule',
  'Meta',
];

const CONSENT_FAILURE_MESSAGE =
  'Microsoft refused the sign-in. If this is a work or school account, an ' +
  'administrator may need to approve the app first.';

/** AADSTS codes that mean "an administrator has not approved this app yet". */
const CONSENT_ERROR_RE = /consent_required|AADSTS(65001|90094|900971|700016)/i;

// ---------------------------------------------------------------------------
// Lazily-constructed MSAL client, keyed on clientId + authority so a config
// change (e.g. switching accounts) gets a fresh client instead of a stale
// one built for a different app registration.
// ---------------------------------------------------------------------------

let cachedClient: { key: string; app: IPublicClientApplication } | undefined;

function authorityUrl(authority: string): string {
  return `https://login.microsoftonline.com/${authority}`;
}

function getClient(clientId: string, authority: string): IPublicClientApplication {
  const key = `${clientId}::${authority}`;
  if (cachedClient !== undefined && cachedClient.key === key) {
    return cachedClient.app;
  }
  const msalConfig: Configuration = {
    auth: {
      clientId,
      authority: authorityUrl(authority),
      // Must match the SPA redirect URI registered in Entra. Vite serves this
      // app under BASE_URL (/timesheet-helper/ on GitHub Pages), so the
      // registered URI is https://<user>.github.io/timesheet-helper/.
      redirectUri: window.location.origin + import.meta.env.BASE_URL,
    },
    cache: {
      cacheLocation: 'sessionStorage',
    },
  };
  const app = new PublicClientApplication(msalConfig);
  cachedClient = { key, app };
  return app;
}

function isConsentFailure(error: unknown): boolean {
  if (error instanceof InteractionRequiredAuthError) return true;
  const message = error instanceof Error ? error.message : String(error);
  return CONSENT_ERROR_RE.test(message);
}

function explainSignInFailure(error: unknown): Error {
  if (isConsentFailure(error)) {
    return new Error(CONSENT_FAILURE_MESSAGE);
  }
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`Microsoft sign-in failed: ${message}`);
}

async function acquireToken(config: BackendConfig): Promise<string> {
  const clientId = config.clientId ?? '';
  const authority = config.authority ?? DEFAULT_AUTHORITY;
  const app = getClient(clientId, authority);
  await app.initialize();

  const account = app.getActiveAccount() ?? app.getAllAccounts()[0];
  if (account !== undefined) {
    try {
      const result = await app.acquireTokenSilent({ scopes: SCOPES, account });
      app.setActiveAccount(result.account);
      return result.accessToken;
    } catch {
      // Fall through to interactive sign-in.
    }
  }

  try {
    const result = await app.loginPopup({ scopes: SCOPES });
    app.setActiveAccount(result.account);
    return result.accessToken;
  } catch (error) {
    throw explainSignInFailure(error);
  }
}

// ---------------------------------------------------------------------------
// Cache the resolved workbook item id per share-link location, so read()
// and write() don't re-resolve the share link on every call. Cleared on
// disconnect since a new sign-in may point at a different account.
// ---------------------------------------------------------------------------

const workbookIdCache = new Map<string, string>();

async function getWorkbookId(token: string, location: string): Promise<string> {
  const cached = workbookIdCache.get(location);
  if (cached !== undefined) return cached;
  const id = await resolveWorkbookId(token, location);
  workbookIdCache.set(location, id);
  return id;
}

export const microsoftAdapter: StorageAdapter = {
  id: 'microsoft',
  label: 'Microsoft 365 Excel',

  validate(config: BackendConfig): string[] {
    const problems: string[] = [];
    const clientId = config.clientId ?? '';
    if (!clientId) {
      problems.push('Enter the Entra app (client) id.');
    } else if (!GUID_RE.test(clientId)) {
      problems.push('The client id must be a GUID (from the app registration overview page).');
    }
    if (!config.location) {
      problems.push('Enter the sharing link to the workbook.');
    }
    return problems;
  },

  async connect(config: BackendConfig): Promise<void> {
    await acquireToken(config);
  },

  async disconnect(): Promise<void> {
    workbookIdCache.clear();
    if (cachedClient === undefined) return;
    const app = cachedClient.app;
    try {
      await app.initialize();
      await app.logoutPopup();
    } finally {
      cachedClient = undefined;
    }
  },

  async read(config: BackendConfig): Promise<Partial<SheetPayload>> {
    const token = await acquireToken(config);
    const itemId = await getWorkbookId(token, config.location);
    const entries = await Promise.all(
      TABS.map(async (tab) => [tab, await readWorksheet(token, itemId, tab)] as const),
    );
    return Object.fromEntries(entries) as Partial<SheetPayload>;
  },

  async write(config: BackendConfig, payload: SheetPayload): Promise<void> {
    const token = await acquireToken(config);
    const itemId = await getWorkbookId(token, config.location);
    for (const tab of TABS) {
      await writeWorksheet(token, itemId, tab, payload[tab]);
    }
  },
};
