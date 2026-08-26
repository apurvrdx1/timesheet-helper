import { hoursToBlocks } from './blocks';
import { monthOf, weekDays, weeksTouchingMonth } from './calendar';
import { leaveDatesFor } from './capacity';
import { assignmentBlocks, keyOf, pacedDemand, parseKey, type DemandItem } from './demand';
import { cmp } from './order';
import { scheduleWeek } from './optimizer';
import type {
  Blocks, IsoDate, IsoMonth, Model, PersonId, Residual, ScheduleEntry,
  ScheduleResult, Violation,
} from './types';

/** Every Monday touching any requested month, ascending, deduplicated. */
function allWeeks(months: IsoMonth[]): IsoDate[] {
  const set = new Set<IsoDate>();
  for (const m of months) for (const w of weeksTouchingMonth(m)) set.add(w);
  return [...set].sort();
}

function workdayCountsByMonth(dates: IsoDate[]): Map<IsoMonth, number> {
  const out = new Map<IsoMonth, number>();
  for (const d of dates) out.set(monthOf(d), (out.get(monthOf(d)) ?? 0) + 1);
  return out;
}

/** Schedules one person across the weeks, returning entries and what was left over. */
function schedulePerson(
  personId: PersonId,
  weeks: IsoDate[],
  remaining: Map<string, Blocks>,
  model: Model,
): { entries: ScheduleEntry[]; violations: Violation[] } {
  const defaultOpex = model.otls.find((o) => o.isDefaultOpex);
  if (!defaultOpex) throw new Error('No OTL is flagged as the default OPEX code.');
  const capexCodes = new Set(
    model.otls.filter((o) => o.category === 'CAPEX').map((o) => o.projectCode));

  const entries: ScheduleEntry[] = [];
  const violations: Violation[] = [];

  // Remaining workdays per month, so pacing knows how much runway is left.
  const runway = workdayCountsByMonth(weeks.flatMap(weekDays));

  for (const monday of weeks) {
    const dates = weekDays(monday);
    const leaveDates = leaveDatesFor(personId, dates, model);
    const workDates = dates.filter((d) => !leaveDates.has(d));
    // This week's actual capacity, so pacing asks for a slice this person can
    // really absorb: leave days are excluded.
    const weekCounts = workdayCountsByMonth(workDates);
    // How much runway this week burns, which is every workday of the month it
    // contains — leave days included. A leave day is spent whether or not it
    // could hold CAPEX, and a runway that ignores them stays permanently
    // inflated, so `monthDays > weekDays` never stops holding and pacing never
    // takes the whole remaining balance in the month's final week.
    const runwayCounts = workdayCountsByMonth(dates);

    const demand: DemandItem[] = pacedDemand(remaining, dates, runway, weekCounts);

    const out = scheduleWeek({
      personId, dates, leaveDates,
      overrides: model.overrides.filter(
        (o) => o.personId === personId && dates.includes(o.date)),
      demand, defaultOpexCode: defaultOpex.projectCode, capexCodes,
    });

    entries.push(...out.entries);
    violations.push(...out.violations);

    for (const [key, blocks] of out.consumed) {
      remaining.set(key, Math.max(0, (remaining.get(key) ?? 0) - blocks));
    }
    for (const [month, count] of runwayCounts) {
      runway.set(month, Math.max(0, (runway.get(month) ?? 0) - count));
    }
  }

  return { entries, violations };
}

export function scheduleAll(model: Model, months: IsoMonth[]): ScheduleResult {
  const weeks = allWeeks(months);
  const manager = model.people.find((p) => p.role === 'MANAGER');
  const reports = model.people
    .filter((p) => p.role === 'REPORT')
    .sort((a, b) => cmp(a.id, b.id));   // stable ordering

  const entries: ScheduleEntry[] = [];
  const violations: Violation[] = [];
  const residuals: Residual[] = [];

  // 1. Reports first — they have first claim on their own assignments.
  const unabsorbed = new Map<string, Blocks>();
  for (const person of reports) {
    const remaining = assignmentBlocks(person.id, model);
    const result = schedulePerson(person.id, weeks, remaining, model);
    entries.push(...result.entries);
    violations.push(...result.violations);

    for (const [key, blocks] of remaining) {
      if (blocks > 0) unabsorbed.set(key, (unabsorbed.get(key) ?? 0) + blocks);
    }
  }

  // 2. Unassigned budget: an OTL's monthly total minus what was handed out.
  const totals = new Map<string, Blocks>();
  const handedOut = new Map<string, Blocks>();
  for (const a of model.allocations) {
    const key = keyOf(a.month, a.otlProjectCode);
    const blocks = hoursToBlocks(a.hours).blocks;
    if (a.personId === null) totals.set(key, (totals.get(key) ?? 0) + blocks);
    else handedOut.set(key, (handedOut.get(key) ?? 0) + blocks);
  }
  const unassigned = new Map<string, Blocks>();
  for (const [key, total] of totals) {
    const gap = total - (handedOut.get(key) ?? 0);
    if (gap > 0) unassigned.set(key, gap);
  }

  // 3. The manager takes their own assignments, then the leftovers.
  if (manager) {
    const remaining = assignmentBlocks(manager.id, model);
    for (const source of [unabsorbed, unassigned]) {
      for (const [key, blocks] of source) {
        remaining.set(key, (remaining.get(key) ?? 0) + blocks);
      }
    }
    const result = schedulePerson(manager.id, weeks, remaining, model);
    entries.push(...result.entries);
    violations.push(...result.violations);

    // 4. Whatever the manager could not take carries forward.
    for (const [key, blocks] of remaining) {
      if (blocks <= 0) continue;
      const parsed = parseKey(key);
      if (parsed === null) continue;
      const { month, otlProjectCode } = parsed;
      residuals.push({
        personId: null, otlProjectCode, month, blocks,
        reason: unassigned.has(key) ? 'UNASSIGNED' : 'UNABSORBED',
      });
    }
  }

  entries.sort((a, b) =>
    cmp(a.personId, b.personId) ||
    cmp(a.date, b.date) ||
    cmp(a.otlProjectCode, b.otlProjectCode));
  residuals.sort((a, b) =>
    cmp(a.month, b.month) || cmp(a.otlProjectCode, b.otlProjectCode));

  return { entries, residuals, violations };
}
