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
