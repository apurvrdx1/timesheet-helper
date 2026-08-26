/**
 * Thin Microsoft Graph Excel client. No MSAL here — callers pass an
 * already-acquired bearer token; this module only knows how to turn a
 * sharing link into a drive item id and read/write a worksheet's used range.
 */
const GRAPH = 'https://graph.microsoft.com/v1.0';

/** Graph addresses a shared file by a base64url token of its sharing URL. */
export function encodeShareUrl(url: string): string {
  const b64 = btoa(url);
  return 'u!' + b64.replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function call(
  token: string, path: string, init: RequestInit = {},
): Promise<Response> {
  return fetch(`${GRAPH}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
}

export async function resolveWorkbookId(token: string, shareUrl: string): Promise<string> {
  const res = await call(token, `/shares/${encodeShareUrl(shareUrl)}/driveItem`);
  if (!res.ok) {
    throw new Error(
      'Could not find that workbook. Check the sharing link, and that the ' +
      'signed-in account has access to it.');
  }
  const body: unknown = await res.json();
  if (typeof body !== 'object' || body === null || !('id' in body)) {
    throw new Error('The Graph API returned an unexpected response for that workbook.');
  }
  return String((body as { id: unknown }).id);
}

/** Used-range values as display text. An absent worksheet reads as empty. */
export async function readWorksheet(
  token: string, itemId: string, name: string,
): Promise<string[][]> {
  const sheet = encodeURIComponent(name);
  const res = await call(token,
    `/me/drive/items/${itemId}/workbook/worksheets('${sheet}')/usedRange(valuesOnly=true)`);
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`Could not read the "${name}" sheet.`);
  const body: unknown = await res.json();
  if (typeof body !== 'object' || body === null) return [];
  const record = body as { text?: string[][]; values?: string[][] };
  return record.text ?? record.values ?? [];
}

function columnName(n: number): string {
  let out = '';
  let remaining = n;
  while (remaining > 0) {
    const rem = (remaining - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    remaining = Math.floor((remaining - 1) / 26);
  }
  return out;
}

/**
 * `usedRange`'s `address` comes back sheet-qualified (e.g. `Sheet1!A1:F27`),
 * but `range(address='...')` wants a bare address. Strip everything up to
 * and including the last `!`; if there is none, the value was already bare.
 */
function stripSheetPrefix(address: string): string {
  const bang = address.lastIndexOf('!');
  return bang === -1 ? address : address.slice(bang + 1);
}

export async function writeWorksheet(
  token: string, itemId: string, name: string, rows: string[][],
): Promise<void> {
  const sheet = encodeURIComponent(name);
  const base = `/me/drive/items/${itemId}/workbook/worksheets('${sheet}')`;

  // usedRange is the only way to learn what to clear: there is no
  // `usedRange/clear` endpoint (usedRange is a read-only function and
  // cannot be chained with `/clear` — the only documented clear paths take
  // an explicit `range(address='...')`). A 404 here means the worksheet
  // genuinely does not exist yet, so create it and skip the clear.
  const usedRange = await call(token, `${base}/usedRange(valuesOnly=true)`);
  if (usedRange.status === 404) {
    const created = await call(token, `/me/drive/items/${itemId}/workbook/worksheets`, {
      method: 'POST', body: JSON.stringify({ name }),
    });
    if (!created.ok) throw new Error(`Could not create the "${name}" sheet.`);
  } else if (usedRange.ok) {
    const body: unknown = await usedRange.json();
    const rawAddress =
      typeof body === 'object' && body !== null && 'address' in body
        ? (body as { address: unknown }).address
        : undefined;
    if (typeof rawAddress !== 'string') {
      throw new Error(`The Graph API returned an unexpected response for the "${name}" sheet.`);
    }
    const address = stripSheetPrefix(rawAddress);
    const clear = await call(token, `${base}/range(address='${address}')/clear`, {
      method: 'POST', body: JSON.stringify({ applyTo: 'contents' }),
    });
    if (!clear.ok) throw new Error(`Could not clear the "${name}" sheet before writing.`);
  } else {
    throw new Error(`Could not write the "${name}" sheet.`);
  }

  if (rows.length === 0) return;

  const firstRow = rows[0] ?? [];
  const address = `A1:${columnName(firstRow.length)}${rows.length}`;
  const res = await call(token, `${base}/range(address='${address}')`, {
    method: 'PATCH', body: JSON.stringify({ values: rows }),
  });
  if (!res.ok) throw new Error(`Could not write the "${name}" sheet.`);
}
