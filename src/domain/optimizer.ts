import { hoursToBlocks } from './blocks';
import { monthOf } from './calendar';
import { opexFloor } from './capacity';
import type { DemandItem } from './demand';
import { keyOf } from './demand';
import {
  BLOCKS_PER_DAY,
  type Blocks, type IsoDate, type Override, type OtlCode,
  type PersonId, type ScheduleEntry, type Violation,
} from './types';

export interface WeekInput {
  personId: PersonId;
  dates: IsoDate[];
  leaveDates: Map<IsoDate, OtlCode>;
  overrides: Override[];
  demand: DemandItem[];
  defaultOpexCode: OtlCode;
  capexCodes: Set<OtlCode>;
}

export interface WeekOutput {
  entries: ScheduleEntry[];
  consumed: Map<string, Blocks>;
  violations: Violation[];
}

export function scheduleWeek(input: WeekInput): WeekOutput {
  const { personId, dates, leaveDates, overrides, demand,
          defaultOpexCode, capexCodes } = input;

  const entries: ScheduleEntry[] = [];
  const consumed = new Map<string, Blocks>();
  const violations: Violation[] = [];
  const dayRemaining = new Map<IsoDate, Blocks>();

  // 1. Leave takes whole days and removes them from capacity entirely.
  for (const date of dates) {
    const leaveCode = leaveDates.get(date);
    if (leaveCode) {
      entries.push({
        personId, date, otlProjectCode: leaveCode,
        blocks: BLOCKS_PER_DAY, source: 'LEAVE',
      });
      dayRemaining.set(date, 0);
    } else {
      dayRemaining.set(date, BLOCKS_PER_DAY);
    }
  }

  const capacity = dates.filter((d) => !leaveDates.has(d)).length * BLOCKS_PER_DAY;
  const floor = opexFloor(capacity);

  // 2. Overrides are inputs, not outputs. They win, even over the floor.
  let overriddenCapex = 0;
  const sortedOverrides = [...overrides].sort((a, b) =>
    a.date.localeCompare(b.date) || a.otlProjectCode.localeCompare(b.otlProjectCode));

  for (const o of sortedOverrides) {
    if (leaveDates.has(o.date)) continue;       // a leave day cannot hold anything else
    const blocks = hoursToBlocks(o.hours).blocks;
    if (blocks <= 0) continue;

    const left = dayRemaining.get(o.date) ?? 0;
    if (blocks > left) {
      violations.push({
        personId, scope: o.date, kind: 'OVER_CAPACITY',
        message: `Overrides on ${o.date} exceed 7.5h.`,
      });
    }
    const placed = Math.min(blocks, left);
    if (placed <= 0) continue;

    entries.push({
      personId, date: o.date, otlProjectCode: o.otlProjectCode,
      blocks: placed, source: 'OVERRIDE',
    });
    dayRemaining.set(o.date, left - placed);

    if (capexCodes.has(o.otlProjectCode)) {
      overriddenCapex += placed;
      const key = keyOf(monthOf(o.date), o.otlProjectCode);
      consumed.set(key, (consumed.get(key) ?? 0) + placed);
    }
  }

  // 3. Fill CAPEX up to the room the floor leaves, minus what overrides already took.
  let capexBudget = Math.max(0, capacity - floor - overriddenCapex);

  for (const item of demand) {
    if (capexBudget <= 0) break;
    let want = Math.min(item.blocks, capexBudget);

    for (const date of dates) {
      if (want <= 0) break;
      if (monthOf(date) !== item.month) continue;   // a day only spends its own month
      const left = dayRemaining.get(date) ?? 0;
      if (left <= 0) continue;

      const place = Math.min(left, want);           // greedy: fills the day, stays chunky
      entries.push({
        personId, date, otlProjectCode: item.otlProjectCode,
        blocks: place, source: 'CALC',
      });
      dayRemaining.set(date, left - place);
      want -= place;
      capexBudget -= place;

      const key = keyOf(item.month, item.otlProjectCode);
      consumed.set(key, (consumed.get(key) ?? 0) + place);
    }
  }

  // 4. Everything still open becomes default OPEX.
  for (const date of dates) {
    const left = dayRemaining.get(date) ?? 0;
    if (left > 0) {
      entries.push({
        personId, date, otlProjectCode: defaultOpexCode,
        blocks: left, source: 'CALC',
      });
      dayRemaining.set(date, 0);
    }
  }

  // 5. The floor holds by construction unless overrides broke it. Say so.
  const opexPlaced = entries
    .filter((e) => e.otlProjectCode === defaultOpexCode)
    .reduce((s, e) => s + e.blocks, 0);
  const firstDate = dates[0];
  if (capacity > 0 && opexPlaced < floor && firstDate !== undefined) {
    violations.push({
      personId, scope: firstDate, kind: 'OPEX_FLOOR_BREACHED',
      message: `Overrides leave ${opexPlaced / 2}h on the default OPEX code; ` +
               `the week needs ${floor / 2}h.`,
    });
  }

  entries.sort((a, b) =>
    a.date.localeCompare(b.date) || a.otlProjectCode.localeCompare(b.otlProjectCode));
  return { entries, consumed, violations };
}
