import { datesInRange } from './calendar';
import {
  BLOCKS_PER_DAY, OPEX_FLOOR_RATIO,
  type Blocks, type IsoDate, type Model, type OtlCode, type PersonId,
} from './types';

/**
 * Which of `dates` this person is away, and on which leave code.
 * Stat holidays override personal leave — a closed office does not
 * consume someone's vacation entitlement.
 */
export function leaveDatesFor(
  personId: PersonId, dates: IsoDate[], model: Model,
): Map<IsoDate, OtlCode> {
  const inWeek = new Set(dates);
  const out = new Map<IsoDate, OtlCode>();

  for (const range of model.leave) {
    if (range.personId !== personId) continue;
    for (const d of datesInRange(range.startDate, range.endDate)) {
      if (inWeek.has(d)) out.set(d, range.otlProjectCode);
    }
  }
  for (const holiday of model.statHolidays) {
    if (inWeek.has(holiday.date)) out.set(holiday.date, holiday.otlProjectCode);
  }
  return out;
}

export function weekCapacity(leaveDates: Map<IsoDate, OtlCode>, dates: IsoDate[]): Blocks {
  return dates.filter((d) => !leaveDates.has(d)).length * BLOCKS_PER_DAY;
}

/** Ceiling, never rounding — a minimum must never be undershot. */
export function opexFloor(capacity: Blocks): Blocks {
  return Math.ceil(capacity * OPEX_FLOOR_RATIO);
}

export function capexRoom(capacity: Blocks): Blocks {
  return capacity - opexFloor(capacity);
}
