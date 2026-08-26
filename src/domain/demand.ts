import { hoursToBlocks } from './blocks';
import { cmp } from './order';
import type { Blocks, IsoDate, IsoMonth, Model, OtlCode, PersonId } from './types';

export interface DemandItem {
  otlProjectCode: OtlCode;
  month: IsoMonth;
  blocks: Blocks;
}

export function keyOf(month: IsoMonth, otl: OtlCode): string {
  return `${month}|${otl}`;
}

/**
 * The exact inverse of `keyOf`, kept beside it so encoder and decoder cannot
 * drift. Parses on the first delimiter only: OTL codes are free text and may
 * themselves contain '|'. The month is always fixed-width 'YYYY-MM'.
 *
 * Returns null only when the string carries no '|' at all, which is the one
 * shape `keyOf` can never produce. It does not otherwise validate: a key whose
 * prefix is not a well-formed 'YYYY-MM' is still split and returned.
 */
export function parseKey(key: string): { month: IsoMonth; otlProjectCode: OtlCode } | null {
  const sep = key.indexOf('|');
  if (sep === -1) return null;
  return {
    month: key.slice(0, sep) as IsoMonth,
    otlProjectCode: key.slice(sep + 1) as OtlCode,
  };
}

/** Per-person CAPEX assignments as blocks. Rows with a null personId are OTL totals. */
export function assignmentBlocks(personId: PersonId, model: Model): Map<string, Blocks> {
  const out = new Map<string, Blocks>();
  for (const a of model.allocations) {
    if (a.personId !== personId) continue;
    const key = keyOf(a.month, a.otlProjectCode);
    out.set(key, (out.get(key) ?? 0) + hoursToBlocks(a.hours).blocks);
  }
  return out;
}

/**
 * The slice of each remaining allocation this week should absorb, so a
 * month's budget is spread rather than front-loaded. Rounds up so the
 * balance always lands before the month runs out of days.
 */
export function pacedDemand(
  remaining: Map<string, Blocks>,
  _weekDates: IsoDate[],
  remainingWorkdaysByMonth: Map<IsoMonth, number>,
  weekWorkdaysByMonth: Map<IsoMonth, number>,
): DemandItem[] {
  const items: DemandItem[] = [];

  for (const [key, blocks] of remaining) {
    if (blocks <= 0) continue;

    const parsed = parseKey(key);
    if (parsed === null) continue;
    const { month, otlProjectCode } = parsed;

    const weekDays = weekWorkdaysByMonth.get(month) ?? 0;
    if (weekDays === 0) continue;

    const monthDays = remainingWorkdaysByMonth.get(month) ?? 0;
    const share = monthDays <= weekDays
      ? blocks
      : Math.min(blocks, Math.ceil(blocks * (weekDays / monthDays)));

    items.push({ otlProjectCode, month, blocks: share });
  }

  // Stable: biggest first, then alphabetical. Never rely on Map iteration order.
  items.sort((a, b) =>
    b.blocks - a.blocks ||
    cmp(a.otlProjectCode, b.otlProjectCode) ||
    cmp(a.month, b.month));
  return items;
}
