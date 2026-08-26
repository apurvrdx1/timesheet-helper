import { hoursToBlocks } from './blocks';
import { monthOf, weekDays, weeksTouchingMonth } from './calendar';
import { leaveDatesFor, opexFloor } from './capacity';
import { keyOf, parseKey } from './demand';
import { cmp } from './order';
import {
  BLOCKS_PER_DAY,
  type Blocks, type IsoDate, type IsoMonth, type Model, type OtlCode,
  type ScheduleResult, type Violation,
} from './types';

/**
 * How many blocks the user pinned away from the default OPEX code in one
 * person-week — recomputed from `model.overrides`, which is an input the
 * optimizer never writes.
 *
 * This deliberately duplicates the optimizer's clamping (same sort order,
 * same per-day capacity) rather than reading the schedule back. Reading
 * `source === 'OVERRIDE'` off the entries meant summing the whole merged
 * cell, so a regressed optimizer could breach the floor by 25 blocks while
 * the user had pinned only 5 and this check would wave it through. An
 * invariant module must not take its numbers from the component it checks,
 * even at the cost of restating a little arithmetic.
 */
function pinnedAwayFromDefault(
  personId: string,
  dates: IsoDate[],
  leaveDates: Map<IsoDate, OtlCode>,
  defaultOpex: OtlCode,
  model: Model,
): Blocks {
  const inWeek = new Set(dates);
  const dayLeft = new Map<IsoDate, Blocks>();
  for (const d of dates) dayLeft.set(d, leaveDates.has(d) ? 0 : BLOCKS_PER_DAY);

  const mine = model.overrides
    .filter((o) => o.personId === personId && inWeek.has(o.date))
    .sort((a, b) => cmp(a.date, b.date) || cmp(a.otlProjectCode, b.otlProjectCode));

  let away = 0;
  for (const o of mine) {
    const blocks = hoursToBlocks(o.hours).blocks;
    if (blocks <= 0) continue;
    const left = dayLeft.get(o.date) ?? 0;
    const placed = Math.min(blocks, left);
    if (placed <= 0) continue;
    dayLeft.set(o.date, left - placed);
    if (o.otlProjectCode !== defaultOpex) away += placed;
  }
  return away;
}

/**
 * Conservation: nothing vanishes.
 *
 * For each (month, otlProjectCode) key the budget available is
 *
 *     available = max(monthlyTotal, sum of per-person assignments)
 *
 * because every person is handed their own assignment and the cascade target
 * additionally receives `max(0, monthlyTotal - handedOut)`, so the pools sum
 * to the larger of the two. Against that,
 *
 *     accounted = blocks placed on that key + blocks reported in residuals
 *
 * Exact equality is not assertable in general, because a user override can
 * place blocks a key has no budget for: the scheduler clamps a key's balance
 * at zero (`Math.max(0, remaining - consumed)`), so the excess is placed
 * without ever being debited. That excess is bounded by what the user pinned
 * on the key, so the assertable statement is the two-sided
 *
 *     available <= accounted <= available + pinned
 *
 * which collapses to exact equality whenever the key carries no overrides —
 * the common case, and the one the property generators mostly explore.
 *
 * Scope. The default OPEX code is excluded: phase 4 tops every day up with
 * it for reasons unrelated to any budget, so its placed total is unbounded by
 * design. LEAVE-category codes and LEAVE-sourced entries are excluded for the
 * same reason — leave is capacity, not budget. Everything else is checked,
 * including keys for months outside the requested window: days in an adjacent
 * month are scheduled by `weeksTouchingMonth` and draw on their own month's
 * budget, so those keys are accounted for on exactly the same terms.
 */
function checkConservation(
  model: Model, result: ScheduleResult, defaultOpex: OtlCode | undefined,
): Violation[] {
  const problems: Violation[] = [];

  const totals = new Map<string, Blocks>();
  const handedOut = new Map<string, Blocks>();
  for (const a of model.allocations) {
    const key = keyOf(a.month, a.otlProjectCode);
    const blocks = hoursToBlocks(a.hours).blocks;
    if (a.personId === null) totals.set(key, (totals.get(key) ?? 0) + blocks);
    else handedOut.set(key, (handedOut.get(key) ?? 0) + blocks);
  }

  const available = new Map<string, Blocks>();
  for (const key of [...totals.keys(), ...handedOut.keys()]) {
    available.set(key, Math.max(totals.get(key) ?? 0, handedOut.get(key) ?? 0));
  }

  // The slack a user override is allowed to conjure past the budget.
  const pinned = new Map<string, Blocks>();
  for (const o of model.overrides) {
    const blocks = hoursToBlocks(o.hours).blocks;
    if (blocks <= 0) continue;
    const key = keyOf(monthOf(o.date), o.otlProjectCode);
    pinned.set(key, (pinned.get(key) ?? 0) + blocks);
  }

  const placed = new Map<string, Blocks>();
  for (const e of result.entries) {
    if (e.source === 'LEAVE') continue;
    const key = keyOf(monthOf(e.date), e.otlProjectCode);
    placed.set(key, (placed.get(key) ?? 0) + e.blocks);
  }

  const carried = new Map<string, Blocks>();
  for (const r of result.residuals) {
    const key = keyOf(r.month, r.otlProjectCode);
    carried.set(key, (carried.get(key) ?? 0) + r.blocks);
  }

  const categoryOf = new Map(model.otls.map((o) => [o.projectCode, o.category]));
  const keys = [...new Set([
    ...available.keys(), ...placed.keys(), ...carried.keys(),
  ])].sort(cmp);

  for (const key of keys) {
    const parsed = parseKey(key);
    if (parsed === null) continue;
    const { month, otlProjectCode } = parsed;
    if (otlProjectCode === defaultOpex) continue;
    if (categoryOf.get(otlProjectCode) === 'LEAVE') continue;

    const avail = available.get(key) ?? 0;
    const slack = pinned.get(key) ?? 0;
    const put = placed.get(key) ?? 0;
    const kept = carried.get(key) ?? 0;
    const accounted = put + kept;

    if (accounted < avail) {
      problems.push({
        personId: null, scope: month, kind: 'HOURS_NOT_CONSERVED',
        message: `${otlProjectCode} in ${month}: ${avail / 2}h available but ` +
                 `only ${put / 2}h placed and ${kept / 2}h carried. ` +
                 `${(avail - accounted) / 2}h vanished.`,
      });
    } else if (accounted > avail + slack) {
      problems.push({
        personId: null, scope: month, kind: 'HOURS_NOT_CONSERVED',
        message: `${otlProjectCode} in ${month}: ${put / 2}h placed and ` +
                 `${kept / 2}h carried against ${avail / 2}h available, which ` +
                 `${slack / 2}h of user overrides does not account for.`,
      });
    }
  }
  return problems;
}

/**
 * Checks the guarantees the optimizer claims to make. The OPEX floor is
 * checked with a precise allowance for the shortfall the user's own override
 * blocks genuinely force, rather than being skipped whenever any override
 * exists, so this only ever fires on a genuine scheduling bug.
 */
export function checkInvariants(
  model: Model, result: ScheduleResult, months: IsoMonth[],
): Violation[] {
  const problems: Violation[] = [];
  const defaultOpex = model.otls.find((o) => o.isDefaultOpex)?.projectCode;

  // Every entry is a positive integer number of blocks, and the share of it
  // the user pinned is a non-negative integer no larger than the whole.
  for (const e of result.entries) {
    if (!Number.isInteger(e.blocks) || e.blocks <= 0) {
      problems.push({
        personId: e.personId, scope: e.date, kind: 'NEGATIVE',
        message: `${e.otlProjectCode} on ${e.date} is ${e.blocks} blocks.`,
      });
    }
    if (!Number.isInteger(e.overrideBlocks) || e.overrideBlocks < 0
        || e.overrideBlocks > e.blocks) {
      problems.push({
        personId: e.personId, scope: e.date, kind: 'NEGATIVE',
        message: `${e.otlProjectCode} on ${e.date} claims ${e.overrideBlocks} ` +
                 `override blocks of ${e.blocks}.`,
      });
    }
  }

  const mondays = new Set(months.flatMap((m) => weeksTouchingMonth(m)));

  for (const person of model.people) {
    for (const monday of [...mondays].sort(cmp)) {
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

      // The OPEX floor holds, up to the shortfall the user's own override
      // blocks genuinely force. Override blocks booked away from the default
      // OPEX code are the only thing that can eat into the floor, and only
      // once they exceed the week's non-OPEX room (capacity - floor); up to
      // that point the optimizer must still find a compliant schedule.
      // Leave entries are excluded from the OPEX total because `capacity`
      // already excludes leave days — a leave code that happens to equal the
      // default OPEX code must not be allowed to pay for the floor.
      if (defaultOpex) {
        const capacity = dates.filter((d) => !leaveDates.has(d)).length * BLOCKS_PER_DAY;
        const floor = opexFloor(capacity);
        const opexBlocks = mine
          .filter((e) => e.otlProjectCode === defaultOpex && e.source !== 'LEAVE')
          .reduce((s, e) => s + e.blocks, 0);
        const overriddenAway = pinnedAwayFromDefault(
          person.id, dates, leaveDates, defaultOpex, model);
        const allowance = Math.max(0, floor - capacity + overriddenAway);
        if (capacity > 0 && opexBlocks < floor - allowance) {
          problems.push({
            personId: person.id, scope: monday, kind: 'OPEX_FLOOR_BREACHED',
            message: `Week of ${monday}: ${opexBlocks / 2}h OPEX, floor is ` +
                     `${floor / 2}h and overrides excuse only ${allowance / 2}h of it.`,
          });
        }
      }
    }
  }

  problems.push(...checkConservation(model, result, defaultOpex));
  return problems;
}
