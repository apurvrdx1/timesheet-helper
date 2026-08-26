/**
 * Google Sheets backend: talks to a Google Apps Script web app that the
 * user deploys against their own Sheet (see apps-script/Code.gs).
 *
 * Two wire-protocol details matter and are exercised by tests:
 *
 * 1. Writes POST as `text/plain`, never `application/json`. Apps Script web
 *    apps do not answer CORS preflight OPTIONS requests, and
 *    `application/json` is not a "simple" content type, so the browser
 *    would send a preflight the script can never satisfy. `text/plain` is
 *    a simple content type, so no preflight happens.
 * 2. The secret travels as a query parameter on GET (`doGet` in Code.gs
 *    reads `e.parameter.secret`) and inside the JSON body on POST (`doPost`
 *    reads `JSON.parse(e.postData.contents).secret`) — never in the URL for
 *    a write, so it doesn't end up in server access logs.
 */
import type { BackendConfig, StorageAdapter } from '../adapter';
import type { SheetPayload } from '../serialize';

const EXEC_URL_RE = /^https:\/\/script\.google\.com\/macros\/s\/.+\/exec$/;

interface ScriptResponse {
  ok: boolean;
  error?: string;
  payload?: Partial<SheetPayload>;
}

function isScriptResponse(value: unknown): value is ScriptResponse {
  return typeof value === 'object' && value !== null && 'ok' in value;
}

/**
 * Runs `fetch` and turns a rejected fetch (the browser could not even reach
 * the endpoint — almost always a wrong URL or a deployment whose access is
 * not "Anyone") into an actionable message instead of the opaque
 * `TypeError: Failed to fetch`.
 */
async function fetchOrExplain(input: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch {
    throw new Error(
      'Could not reach the Apps Script endpoint. Check the URL and that the deployment is set to "Anyone".',
    );
  }
}

async function parseScriptResponse(response: Response): Promise<ScriptResponse> {
  const body: unknown = await response.json();
  if (!isScriptResponse(body)) {
    throw new Error('The Apps Script endpoint returned an unexpected response.');
  }
  return body;
}

export const googleAdapter: StorageAdapter = {
  id: 'google',
  label: 'Google Sheets',

  validate(config: BackendConfig): string[] {
    const problems: string[] = [];
    if (!config.location) {
      problems.push('Enter the Apps Script web app URL.');
    } else if (!EXEC_URL_RE.test(config.location)) {
      problems.push(
        'The URL must be an Apps Script web app URL ending in /exec (from Deploy → Manage deployments).',
      );
    }
    if (!config.secret) {
      problems.push('Enter the shared secret configured in the Apps Script.');
    }
    return problems;
  },

  async connect(): Promise<void> {
    // No interactive session for this backend.
  },

  async disconnect(): Promise<void> {
    // No interactive session for this backend.
  },

  async read(config: BackendConfig): Promise<Partial<SheetPayload>> {
    const url = `${config.location}?secret=${encodeURIComponent(config.secret ?? '')}`;
    const response = await fetchOrExplain(url);
    const body = await parseScriptResponse(response);
    if (!body.ok) {
      throw new Error(body.error ?? 'The Apps Script endpoint reported an error.');
    }
    return body.payload ?? {};
  },

  async write(config: BackendConfig, payload: SheetPayload): Promise<void> {
    const response = await fetchOrExplain(config.location, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ secret: config.secret, payload }),
    });
    const body = await parseScriptResponse(response);
    if (!body.ok) {
      throw new Error(body.error ?? 'The Apps Script endpoint reported an error.');
    }
  },
};
