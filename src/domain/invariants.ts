import { weekDays, weeksTouchingMonth } from './calendar';
import { leaveDatesFor, opexFloor } from './capacity';
import {
  BLOCKS_PER_DAY,
  type IsoMonth, type Model, type ScheduleResult, type Violation,
} from './types';

/**
 * Checks the guarantees the optimizer claims to make. Violations caused
 * by user overrides are reported by the optimizer itself and excluded
 * here, so this only ever fires on a genuine scheduling bug.
 */
export function checkInvariants(
  model: Model, result: ScheduleResult, months: IsoMonth[],
): Violation[] {
  const problems: Violation[] = [];
  const defaultOpex = model.otls.find((o) => o.isDefaultOpex)?.projectCode;
  const hasOverrides = model.overrides.length > 0;

  // Every entry is a positive integer number of blocks.
  for (const e of result.entries) {
    if (!Number.isInteger(e.blocks) || e.blocks <= 0) {
      problems.push({
        personId: e.personId, scope: e.date, kind: 'NEGATIVE',
        message: `${e.otlProjectCode} on ${e.date} is ${e.blocks} blocks.`,
      });
    }
  }

  const mondays = new Set(months.flatMap((m) => weeksTouchingMonth(m)));

  for (const person of model.people) {
    for (const monday of [...mondays].sort()) {
      const dates = weekDays(monday);
      const leaveDates = leaveDatesFor(person.id, dates, model);
      const mine = result.entries.filter(
        (e) => e.personId === person.id && dates.includes(e.date));

      // Each working day totals exactly 7.5h.
      for (const date of dates) {
        const total = mine.filter((e) => e.date === date)
          .reduce((s, e) => s + e.blocks, 0);
        if (total !== BLOCKS_PER_DAY) {
          problems.push({
            personId: person.id, scope: date, kind: 'DAY_NOT_FULL',
            message: `${date} totals ${total / 2}h, expected 7.5h.`,
          });
        }
      }

      // A leave day holds exactly one entry.
      for (const [date] of leaveDates) {
        const onDay = mine.filter((e) => e.date === date);
        const only = onDay.length === 1 ? onDay[0] : undefined;
        if (!only || only.source !== 'LEAVE') {
          problems.push({
            personId: person.id, scope: date, kind: 'DAY_NOT_FULL',
            message: `${date} is leave but holds ${onDay.length} entries.`,
          });
        }
      }

      // The OPEX floor holds, unless the user's own overrides broke it.
      if (!hasOverrides && defaultOpex) {
        const capacity = dates.filter((d) => !leaveDates.has(d)).length * BLOCKS_PER_DAY;
        const opexBlocks = mine.filter((e) => e.otlProjectCode === defaultOpex)
          .reduce((s, e) => s + e.blocks, 0);
        if (capacity > 0 && opexBlocks < opexFloor(capacity)) {
          problems.push({
            personId: person.id, scope: monday, kind: 'OPEX_FLOOR_BREACHED',
            message: `Week of ${monday}: ${opexBlocks / 2}h OPEX, ` +
                     `floor is ${opexFloor(capacity) / 2}h.`,
          });
        }
      }
    }
  }
  return problems;
}
