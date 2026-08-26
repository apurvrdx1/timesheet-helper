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
 *
 * MSAL (~900 KB) is loaded with a dynamic `import()`, not a static one, so
 * it lands in its own chunk instead of the main bundle. Most visitors to
 * this single-user GitHub Pages site use the Google or local-only backend
 * and never need it; only `connect()`/`read()`/`write()`/`disconnect()` on
 * this adapter trigger the fetch, and only the first call pays for it —
 * the resolved module and the client built from it are cached in module
 * scope (see `cachedClientPromise` below).
 */
import type { Configuration, IPublicClientApplication } from '@azure/msal-browser';
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

const POPUP_BLOCKED_MESSAGE =
  'Your browser blocked the sign-in window. Allow pop-ups for this site and try again.';

const NETWORK_FAILURE_MESSAGE =
  'Could not reach Microsoft to sign in. Check your connection and try again.';

const GENERIC_SIGN_IN_FAILURE_MESSAGE =
  'Microsoft sign-in failed. Try again, and if the problem continues, check that pop-ups ' +
  'are allowed for this site.';

/** AADSTS codes that mean "an administrator has not approved this app yet". */
const CONSENT_ERROR_RE = /consent_required|AADSTS(65001|90094|900971|700016)/i;

/** MSAL `BrowserAuthError` codes/messages for a popup the browser refused to open. */
const POPUP_BLOCKED_RE = /popup_window_error|empty_window_error|popup.*blocked/i;

/** A fetch-level failure reaching Microsoft's endpoints, not an auth rejection. */
const NETWORK_FAILURE_RE = /network_error|failed to fetch|networkerror|no_network_connectivity/i;

// ---------------------------------------------------------------------------
// Lazily-constructed MSAL client, keyed on clientId + authority so a config
// change (e.g. switching accounts) gets a fresh client instead of a stale
// one built for a different app registration.
//
// The IN-FLIGHT PROMISE is cached, not just the resolved client: two
// overlapping calls to connect()/read() (a double-click, or two components
// mounting at once) must not each construct their own
// `PublicClientApplication` and race to overwrite the module-scope cache —
// that risks two competing `loginPopup()` calls and MSAL sessionStorage
// state-key collisions. Concurrent callers instead await the same promise.
// ---------------------------------------------------------------------------

let cachedClientPromise: { key: string; promise: Promise<IPublicClientApplication> } | undefined;

function authorityUrl(authority: string): string {
  return `https://login.microsoftonline.com/${authority}`;
}

async function createClient(clientId: string, authority: string): Promise<IPublicClientApplication> {
  // Dynamic, not static: keeps MSAL out of the main bundle for the visitors
  // who never touch this backend. Once loaded, the browser's module cache
  // makes a repeat `import()` of the same specifier resolve instantly.
  const { PublicClientApplication } = await import('@azure/msal-browser');
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
  return new PublicClientApplication(msalConfig);
}

async function getClient(clientId: string, authority: string): Promise<IPublicClientApplication> {
  const key = `${clientId}::${authority}`;
  if (cachedClientPromise !== undefined && cachedClientPromise.key === key) {
    return cachedClientPromise.promise;
  }
  const promise = createClient(clientId, authority).catch((error: unknown) => {
    // Construction failed — do not leave a rejected promise cached forever;
    // let the next caller retry from scratch.
    if (cachedClientPromise?.key === key) cachedClientPromise = undefined;
    throw error;
  });
  cachedClientPromise = { key, promise };
  return promise;
}

async function isConsentFailure(error: unknown): Promise<boolean> {
  // Also dynamic, for the same reason as getClient — but by the time this
  // runs, loginPopup has already failed, so `@azure/msal-browser` is
  // already loaded and this import resolves from the module cache.
  const { InteractionRequiredAuthError } = await import('@azure/msal-browser');
  if (error instanceof InteractionRequiredAuthError) return true;
  const message = error instanceof Error ? error.message : String(error);
  return CONSENT_ERROR_RE.test(message);
}

/** MSAL's `AuthError` (and subclasses) carry a machine-readable `errorCode`. */
function errorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'errorCode' in error) {
    const code = (error as { errorCode: unknown }).errorCode;
    if (typeof code === 'string') return code;
  }
  return '';
}

/**
 * Classifies a failed sign-in into an actionable, sentence-case message
 * (DESIGN.md §4). Never interpolates the raw exception's `.message` into the
 * user-facing text — that leaks library internals (MSAL error codes, popup
 * window mechanics) the user cannot act on. The original error is preserved
 * for diagnostics via `cause`, not by concatenating it into the message.
 */
async function explainSignInFailure(error: unknown): Promise<Error> {
  if (await isConsentFailure(error)) {
    return new Error(CONSENT_FAILURE_MESSAGE, { cause: error });
  }
  const message = error instanceof Error ? error.message : String(error);
  const signature = `${errorCode(error)} ${message}`;
  if (POPUP_BLOCKED_RE.test(signature)) {
    return new Error(POPUP_BLOCKED_MESSAGE, { cause: error });
  }
  if (NETWORK_FAILURE_RE.test(signature)) {
    return new Error(NETWORK_FAILURE_MESSAGE, { cause: error });
  }
  return new Error(GENERIC_SIGN_IN_FAILURE_MESSAGE, { cause: error });
}

async function acquireToken(config: BackendConfig): Promise<string> {
  const clientId = config.clientId ?? '';
  const authority = config.authority ?? DEFAULT_AUTHORITY;
  const app = await getClient(clientId, authority);
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
    throw await explainSignInFailure(error);
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
    const cached = cachedClientPromise;
    if (cached === undefined) return;
    cachedClientPromise = undefined; // a fresh sign-in may target a different account

    let app: IPublicClientApplication;
    try {
      app = await cached.promise;
    } catch {
      // Client construction never finished — nothing to log out.
      return;
    }
    await app.initialize();
    await app.logoutPopup();
  },

  async read(config: BackendConfig): Promise<Partial<SheetPayload>> {
    const token = await acquireToken(config);
    const itemId = await getWorkbookId(token, config.location);
    const entries = await Promise.all(
      TABS.map(async (tab) => [tab, await readWorksheet(token, itemId, tab)] as const),
    );
    return Object.fromEntries(entries) as Partial<SheetPayload>;
  },

  async write(config: BackendConfig, payload: Partial<SheetPayload>): Promise<void> {
    const token = await acquireToken(config);
    const itemId = await getWorkbookId(token, config.location);
    for (const tab of TABS) {
      const rows = payload[tab];
      // `writeWorksheet` clears before it writes, so a tab the caller chose
      // to omit must be skipped entirely — touching it would destroy the
      // data the omission exists to protect.
      if (rows === undefined) continue;
      await writeWorksheet(token, itemId, tab, rows);
    }
  },
};
