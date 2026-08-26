import type { Model } from './types';

/** Order-insensitive: sorting means reordering a table is not a change. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).sort().join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}:${canonical(v)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** FNV-1a. Not cryptographic — this only needs to detect edits. */
export function hashModel(model: Model): string {
  const text = canonical({
    otls: model.otls, people: model.people, statHolidays: model.statHolidays,
    allocations: model.allocations, leave: model.leave, overrides: model.overrides,
  });
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
