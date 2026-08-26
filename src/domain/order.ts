/**
 * Deterministic string ordering.
 *
 * `String.prototype.localeCompare` consults ICU and the ambient locale, so the
 * same two strings can order differently on two machines (and Node builds
 * without full-icu disagree with browsers). The domain promises byte-identical
 * output for identical input, so every comparator here uses plain code-unit
 * comparison instead.
 */
export function cmp(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
