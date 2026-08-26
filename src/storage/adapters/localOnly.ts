import type { StorageAdapter } from '../adapter';
import type { SheetPayload } from '../serialize';

const KEY = 'timesheet-helper:payload:v1';

/**
 * The always-available fallback. No account, no network, this browser only.
 *
 * `read()` must never throw: it is the guaranteed fallback when both cloud
 * backends are unavailable, so any failure to access `localStorage` (private
 * browsing, blocked site data, corrupt JSON, a throwing accessor) degrades
 * to an empty payload instead of propagating.
 */
function readStored(): Partial<SheetPayload> {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Partial<SheetPayload>) : {};
  } catch {
    return {}; // private browsing, blocked site data, corrupt JSON, throwing accessor
  }
}

export const localOnlyAdapter: StorageAdapter = {
  id: 'local',
  label: 'This browser only',
  validate: () => [],
  connect: async () => {},
  disconnect: async () => {},

  async read(): Promise<Partial<SheetPayload>> {
    return readStored();
  },

  /**
   * Merges over what is already stored rather than replacing it: a tab the
   * caller omitted (because it could not be read, or because there is no
   * trustworthy content for it) must survive the write untouched, exactly
   * as it does on the two cloud backends.
   */
  async write(_config, payload): Promise<void> {
    try {
      localStorage.setItem(KEY, JSON.stringify({ ...readStored(), ...payload }));
    } catch {
      throw new Error('This browser refused to save. Export a backup instead.');
    }
  },
};
