import { blocksToHours, hoursToBlocks } from './blocks';
import { monthOf } from './calendar';
import { opexFloor } from './capacity';
import type { DemandItem } from './demand';
import { keyOf } from './demand';
import { cmp } from './order';
import {
  BLOCKS_PER_DAY,
  type Blocks, type EntrySource, type IsoDate, type Override, type OtlCode,
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

/**
 * Which source label survives when two bookings merge into one cell. A cell
 * the user touched must keep reading as user-set, because the UI locks on
 * that flag.
 */
const SOURCE_RANK: Record<EntrySource, number> = { CALC: 0, LEAVE: 1, OVERRIDE: 2 };

export function scheduleWeek(input: WeekInput): WeekOutput {
  const { personId, dates, leaveDates, overrides, demand,
          defaultOpexCode, capexCodes } = input;

  const consumed = new Map<string, Blocks>();
  const violations: Violation[] = [];
  const dayRemaining = new Map<IsoDate, Blocks>();

  // At most one row per (personId, date, otlProjectCode): the grid and the
  // export both read this array directly, so duplicates are settled here.
  // Dates are fixed-width and contain no '|', so the cell key is unambiguous.
  const cells = new Map<string, ScheduleEntry>();
  const place = (
    date: IsoDate, otlProjectCode: OtlCode, blocks: Blocks, source: EntrySource,
  ): void => {
    if (blocks <= 0) return;
    const cellKey = `${date}|${otlProjectCode}`;
    const existing = cells.get(cellKey);
    if (existing === undefined) {
      cells.set(cellKey, { personId, date, otlProjectCode, blocks, source });
      return;
    }
    cells.set(cellKey, {
      ...existing,
      blocks: existing.blocks + blocks,
      source: SOURCE_RANK[source] > SOURCE_RANK[existing.source] ? source : existing.source,
    });
  };

  // 1. Leave takes whole days and removes them from capacity entirely.
  for (const date of dates) {
    const leaveCode = leaveDates.get(date);
    if (leaveCode) {
      place(date, leaveCode, BLOCKS_PER_DAY, 'LEAVE');
      dayRemaining.set(date, 0);
    } else {
      dayRemaining.set(date, BLOCKS_PER_DAY);
    }
  }

  const capacity = dates.filter((d) => !leaveDates.has(d)).length * BLOCKS_PER_DAY;
  const floor = opexFloor(capacity);

  // 2. Overrides are inputs, not outputs. They win, even over the floor.
  //    Every block they book away from the default OPEX code is charged
  //    against the CAPEX ceiling in phase 3, whichever code it landed on.
  let overriddenCapex = 0;
  let overriddenOther = 0;
  const sortedOverrides = [...overrides].sort((a, b) =>
    cmp(a.date, b.date) || cmp(a.otlProjectCode, b.otlProjectCode));

  for (const o of sortedOverrides) {
    if (leaveDates.has(o.date)) {
      // A leave day cannot hold anything else. Nothing vanishes silently:
      // the override is reported rather than dropped on the floor.
      violations.push({
        personId, scope: o.date, kind: 'OVERRIDE_ON_LEAVE_DAY',
        message: `${o.date} is a leave day, so the ${o.hours}h override on ` +
                 `${o.otlProjectCode} could not be placed.`,
      });
      continue;
    }

    const { blocks, residualHours } = hoursToBlocks(o.hours);
    if (residualHours > 0) {
      violations.push({
        personId, scope: o.date, kind: 'OVERRIDE_RESIDUAL_DROPPED',
        message: `The ${o.hours}h override on ${o.otlProjectCode} on ${o.date} ` +
                 `booked ${blocksToHours(blocks)}h; ${residualHours}h does not ` +
                 `fit a half-hour block and was dropped.`,
      });
    }
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

    place(o.date, o.otlProjectCode, placed, 'OVERRIDE');
    dayRemaining.set(o.date, left - placed);

    if (capexCodes.has(o.otlProjectCode)) {
      overriddenCapex += placed;
      const key = keyOf(monthOf(o.date), o.otlProjectCode);
      consumed.set(key, (consumed.get(key) ?? 0) + placed);
    } else if (o.otlProjectCode !== defaultOpexCode) {
      // A secondary OPEX code, a training code, anything unclassified: it is
      // not CAPEX, but it eats floor room just the same and must be charged.
      overriddenOther += placed;
    }
  }

  // 3. Fill CAPEX up to the room the floor leaves, minus every override block
  //    already booked somewhere other than the default OPEX code.
  let capexBudget = Math.max(0, capacity - floor - overriddenCapex - overriddenOther);

  for (const item of demand) {
    if (capexBudget <= 0) break;
    let want = Math.min(item.blocks, capexBudget);

    for (const date of dates) {
      if (want <= 0) break;
      if (monthOf(date) !== item.month) continue;   // a day only spends its own month
      const left = dayRemaining.get(date) ?? 0;
      if (left <= 0) continue;

      const take = Math.min(left, want);            // greedy: fills the day, stays chunky
      place(date, item.otlProjectCode, take, 'CALC');
      dayRemaining.set(date, left - take);
      want -= take;
      capexBudget -= take;

      const key = keyOf(item.month, item.otlProjectCode);
      consumed.set(key, (consumed.get(key) ?? 0) + take);
    }
  }

  // 4. Everything still open becomes default OPEX.
  for (const date of dates) {
    const left = dayRemaining.get(date) ?? 0;
    if (left > 0) {
      place(date, defaultOpexCode, left, 'CALC');
      dayRemaining.set(date, 0);
    }
  }

  // 5. With every override block charged against the ceiling, the floor now
  //    holds by construction. Writing C for capacity, F for the floor, O for
  //    the override blocks actually placed (split into O_def on the default
  //    OPEX code, O_capex and O_other elsewhere) and P for the CAPEX phase 3
  //    placed, phase 4 books C - O - P onto the default code, so
  //      opexPlaced = O_def + (C - O - P)  and  P <= C - F - O_capex - O_other
  //      => opexPlaced >= O_def + C - O - C + F + O_capex + O_other = F.
  //    The only remaining way to land under the floor is for the user's own
  //    overrides to book more than C - F blocks away from the default code,
  //    which clamps that budget at zero. That is a genuine user conflict.
  //    Leave entries are excluded: `capacity` already excludes leave days, so
  //    a leave code that happens to equal the default OPEX code must not be
  //    allowed to pay for the floor.
  const entries = [...cells.values()];
  const opexPlaced = entries
    .filter((e) => e.otlProjectCode === defaultOpexCode && e.source !== 'LEAVE')
    .reduce((s, e) => s + e.blocks, 0);
  const firstDate = dates[0];
  if (capacity > 0 && opexPlaced < floor && firstDate !== undefined) {
    violations.push({
      personId, scope: firstDate, kind: 'OPEX_FLOOR_BREACHED',
      message: `Overrides book more than the week's non-OPEX room, leaving ` +
               `${blocksToHours(opexPlaced)}h on the default OPEX code; ` +
               `the week needs ${blocksToHours(floor)}h.`,
    });
  }

  // (date, otlProjectCode) is unique per person after the merge in `place`,
  // so this comparator is a total order and needs no further tiebreaker.
  entries.sort((a, b) =>
    cmp(a.date, b.date) || cmp(a.otlProjectCode, b.otlProjectCode));
  return { entries, consumed, violations };
}
