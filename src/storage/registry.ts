/**
 * Maps each `BackendId` to its `StorageAdapter`. This is the only place in
 * the codebase allowed to know that these three backend ids exist —
 * everything above `getAdapter`/`listAdapters` deals only in the
 * `StorageAdapter` interface.
 */
import type { BackendId, StorageAdapter } from './adapter';
import { localOnlyAdapter } from './adapters/localOnly';
import { googleAdapter } from './adapters/google';
import { microsoftAdapter } from './adapters/microsoft';

const ADAPTERS: Record<BackendId, StorageAdapter> = {
  local: localOnlyAdapter,
  google: googleAdapter,
  microsoft: microsoftAdapter,
};

export function getAdapter(id: BackendId): StorageAdapter {
  // Cast to a partial index so an id that is invalid only at runtime (e.g.
  // arriving from persisted config or a type assertion) is caught here
  // rather than producing `undefined` for callers to trip over later.
  const adapter = (ADAPTERS as Record<string, StorageAdapter | undefined>)[id];
  if (adapter === undefined) {
    throw new Error(`Unknown storage backend: ${String(id)}`);
  }
  return adapter;
}

export function listAdapters(): StorageAdapter[] {
  return Object.values(ADAPTERS);
}

// ---------------------------------------------------------------------------
// Connection-form metadata. `StorageAdapter.validate()` decides whether a
// config is *complete*; this decides which fields the form shows in the
// first place. Both live behind this one file's exclusive knowledge of
// backend ids so `src/ui/` never branches on a backend name — it just reads
// `getConnectionFields(config.backend)`/`getConnectionNotice(config.backend)`
// and renders whatever comes back.
// ---------------------------------------------------------------------------

export interface ConnectionField {
  /** Which `BackendConfig` property this field edits. */
  key: 'location' | 'secret' | 'clientId' | 'authority';
  label: string;
  type: 'text' | 'password';
  /** Helper text shown between the label and the input, if any. */
  description?: string;
}

export interface ConnectionNotice {
  message: string;
  href: string;
  linkLabel: string;
}

const CONNECTION_FIELDS: Record<BackendId, ConnectionField[]> = {
  local: [],
  google: [
    { key: 'location', label: 'Script URL', type: 'text' },
    { key: 'secret', label: 'Shared secret', type: 'password' },
  ],
  microsoft: [
    { key: 'clientId', label: 'Client id', type: 'text' },
    { key: 'location', label: 'Workbook link', type: 'text' },
    {
      key: 'authority', label: 'Authority', type: 'text',
      description:
        'Valid values: common, consumers, organizations, or a tenant ID. Leave blank to use ' +
        'common. A work or school account may need its tenant ID here to sign in.',
    },
  ],
};

const CONNECTION_NOTICES: Partial<Record<BackendId, ConnectionNotice>> = {
  google: {
    message: 'Deploy the Apps Script web app from this repository before connecting.',
    href: 'apps-script/README.md',
    linkLabel: 'Apps Script setup guide',
  },
  microsoft: {
    message:
      'If this is a work or school account, an administrator may need to approve the app before you can sign in.',
    href: 'docs/microsoft-setup.md',
    linkLabel: 'Microsoft 365 setup guide',
  },
};

/** The fields a connection form should show for this backend, in order. */
export function getConnectionFields(id: BackendId): ConnectionField[] {
  return CONNECTION_FIELDS[id];
}

/** A backend-specific caveat to show inline on the connection form, if any. */
export function getConnectionNotice(id: BackendId): ConnectionNotice | undefined {
  return CONNECTION_NOTICES[id];
}
