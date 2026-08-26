/**
 * Presentation-only formatting for the hour grid. Per DESIGN.md §2.2, hours
 * always show exactly one decimal place, and a zero renders as an em-dash
 * (in `--color-text-disabled`, applied by the caller) rather than `0.0` — a
 * grid full of zeroes is unreadable noise.
 */
export function formatHoursCell(hours: number): string {
  return hours === 0 ? '—' : hours.toFixed(1);
}
