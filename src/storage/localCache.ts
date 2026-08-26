/**
 * The browser-local cache: the last-known model, the hash it was calculated
 * against, and the backend config the app is pointed at.
 *
 * The secret and clientId live here — and never in the bundle. GitHub Pages
 * serves this app's JavaScript publicly, so any credential in source would
 * be public too; the user enters it once and it is cached only in their own
 * browser's `localStorage`.
 *
 * Every read is wrapped in try/catch and returns `null` on any failure
 * (private browsing, blocked site data, corrupt JSON, a throwing accessor)
 * rather than throwing — this cache is a fallback, and a fallback that can
 * itself crash the app defeats its own purpose. Writes degrade the same way:
 * a failed `saveCache` is silently a no-op rather than an unhandled
 * exception, matching `localOnlyAdapter`'s defensive style.
 */
import type { Model } from '../domain/types';
import type { BackendConfig } from './adapter';

const KEY = 'timesheet-helper:v1';

interface CacheEntry {
  model: Model;
  hash: string;
  config: BackendConfig;
}

function isCacheEntry(value: unknown): value is CacheEntry {
  return (
    typeof value === 'object' &&
    value !== null &&
    'model' in value &&
    'hash' in value &&
    'config' in value
  );
}

export function loadCache(): CacheEntry | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    return isCacheEntry(parsed) ? parsed : null;
  } catch {
    return null; // private browsing, blocked site data, corrupt JSON, throwing accessor
  }
}

export function saveCache(model: Model, hash: string, config: BackendConfig): void {
  try {
    const entry: CacheEntry = { model, hash, config };
    localStorage.setItem(KEY, JSON.stringify(entry));
  } catch {
    // Degrade silently: the cache is a convenience, not the system of
    // record, and a quota/availability failure here must never crash the
    // app or interrupt whatever the user was doing.
  }
}
