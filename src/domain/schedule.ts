import { blocksToHours, hoursToBlocks } from './blocks';
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

  const entries: ScheduleEntry[] = [];
  const violations: Violation[] = [];
  const residuals: Residual[] = [];

  // Violations about the model rather than about a day need some scope; the
  // first requested month is the most useful thing to point the UI at.
  const modelScope: IsoMonth | IsoDate = months[0] ?? weeks[0] ?? '';

  // Allocation rows are inputs at a system boundary. A value that is not a
  // multiple of 0.5 cannot be represented as blocks, and truncating it in
  // silence is the same defect class already fixed for overrides. The
  // Violation flags that the input was off the half-hour grid; the Residual
  // is where the leftover fraction actually goes — flagging alone does not
  // carry it forward, and the two serve different purposes for the UI.
  for (const a of model.allocations) {
    const { blocks, residualHours } = hoursToBlocks(a.hours);
    if (residualHours <= 0) continue;
    const which = a.personId === null
      ? 'monthly total' : `allocation for ${a.personId}`;
    violations.push({
      personId: a.personId, scope: a.month, kind: 'ALLOCATION_RESIDUAL_DROPPED',
      message: `The ${a.hours}h ${which} on ${a.otlProjectCode} in ${a.month} ` +
               `does not fit a half-hour block: ${blocksToHours(blocks)}h was ` +
               `booked and ${residualHours}h is carried forward as a residual.`,
    });
    // The fraction is smaller than the scheduling grain itself, so it can
    // never become a block — not placed, not carried as blocks. `blocks`
    // stays 0 by construction; `subBlockHours` is the only honest place to
    // put it. Nothing here disturbs the block-denominated conservation
    // ledger in invariants.ts, since `available` there was already
    // floor-based and never counted this fraction to begin with.
    residuals.push({
      personId: a.personId, otlProjectCode: a.otlProjectCode, month: a.month,
      blocks: 0, reason: 'SUB_BLOCK_REMAINDER', subBlockHours: residualHours,
    });
  }

  // Sorted by id, never by array order: the cascade target must not change
  // just because the people rows arrived in a different sequence.
  const people = [...model.people].sort((a, b) => cmp(a.id, b.id));
  const managers = people.filter((p) => p.role === 'MANAGER');
  const cascadeTarget = managers[0];

  // The product rule is one manager per instance. A second one is a
  // configuration error — but silently dropping a human being out of the
  // timesheet is far worse than a warning, so every extra manager is
  // scheduled like anybody else and the surplus is reported instead.
  for (const extra of managers.slice(1)) {
    violations.push({
      personId: extra.id, scope: modelScope, kind: 'MULTIPLE_MANAGERS',
      message: `The model has ${managers.length} people with the MANAGER role, ` +
               `but exactly one is expected. ${cascadeTarget?.id ?? ''} is the ` +
               `cascade target; ${extra.id} is scheduled with their own ` +
               `assignments and floor only.`,
    });
  }

  // 1. Everyone who is not the cascade target — reports, surplus managers, and
  //    anyone carrying a role this code does not recognise. Filtering on role
  //    would drop the rest of them from the schedule entirely.
  const others = people.filter((p) => p !== cascadeTarget);

  const unabsorbed = new Map<string, Blocks>();
  for (const person of others) {
    const remaining = assignmentBlocks(person.id, model);
    const result = schedulePerson(person.id, weeks, remaining, model);
    entries.push(...result.entries);
    violations.push(...result.violations);

    for (const [key, blocks] of remaining) {
      if (blocks > 0) unabsorbed.set(key, (unabsorbed.get(key) ?? 0) + blocks);
    }
  }

  // 2. Unassigned budget: an OTL's monthly total minus what was handed out.
  //
  // An allocation row can name a personId that is not in model.people — a
  // deleted report, a typo, a hand-edited sheet. `assignmentBlocks` only ever
  // matches a row against a real person's id, so such a row is never claimed
  // by anyone's schedule. Counting it in `handedOutLegit` (the portion that
  // actually reaches a person) would make it disappear: it would shrink the
  // computed gap without any person ever being scheduled for it. It still
  // counts in `handedOutAll`, exactly as invariants.ts's own independent
  // `available` calculation does, so `available` here and there stay in
  // lockstep and the gap this block computes is `available - handedOutLegit`
  // — never smaller than what invariants.ts expects to see accounted for.
  const personIds = new Set(model.people.map((p) => p.id));
  const totals = new Map<string, Blocks>();
  const handedOutAll = new Map<string, Blocks>();
  const handedOutLegit = new Map<string, Blocks>();
  for (const a of model.allocations) {
    const key = keyOf(a.month, a.otlProjectCode);
    const blocks = hoursToBlocks(a.hours).blocks;
    if (a.personId === null) {
      totals.set(key, (totals.get(key) ?? 0) + blocks);
      continue;
    }
    handedOutAll.set(key, (handedOutAll.get(key) ?? 0) + blocks);
    if (personIds.has(a.personId)) {
      handedOutLegit.set(key, (handedOutLegit.get(key) ?? 0) + blocks);
    } else {
      violations.push({
        personId: a.personId, scope: a.month, kind: 'ALLOCATION_UNKNOWN_PERSON',
        message: `The allocation for ${a.personId} on ${a.otlProjectCode} in ` +
                 `${a.month} names a person who is not in the people list; ` +
                 `treated as unassigned budget rather than reaching nobody.`,
      });
    }
  }
  const unassigned = new Map<string, Blocks>();
  for (const key of new Set([...totals.keys(), ...handedOutAll.keys()])) {
    const available = Math.max(totals.get(key) ?? 0, handedOutAll.get(key) ?? 0);
    const gap = available - (handedOutLegit.get(key) ?? 0);
    if (gap > 0) unassigned.set(key, gap);
  }

  const carried = new Map<string, Blocks>();
  for (const pool of [unabsorbed, unassigned]) {
    for (const [key, blocks] of pool) {
      carried.set(key, (carried.get(key) ?? 0) + blocks);
    }
  }

  // 3. The cascade target takes their own assignments, then the leftovers.
  //    With no manager in the model there is nobody to absorb them, so the
  //    pools pass straight through to step 4 untouched.
  let leftover = carried;
  if (cascadeTarget) {
    const remaining = assignmentBlocks(cascadeTarget.id, model);
    for (const [key, blocks] of carried) {
      remaining.set(key, (remaining.get(key) ?? 0) + blocks);
    }
    const result = schedulePerson(cascadeTarget.id, weeks, remaining, model);
    entries.push(...result.entries);
    violations.push(...result.violations);
    leftover = remaining;
  }

  // 4. Whatever nobody could take carries forward. This runs unconditionally.
  //    The headline invariant is that every hour is placed, carried forward,
  //    or explicitly reported; a model with no manager is not an exemption
  //    from it, and gating this block on a manager existing meant both pools
  //    were computed and then thrown away without a trace.
  for (const [key, blocks] of leftover) {
    if (blocks <= 0) continue;
    const parsed = parseKey(key);
    if (parsed === null) continue;
    const { month, otlProjectCode } = parsed;
    residuals.push({
      personId: null, otlProjectCode, month, blocks,
      reason: unassigned.has(key) ? 'UNASSIGNED' : 'UNABSORBED',
    });
  }

  entries.sort((a, b) =>
    cmp(a.personId, b.personId) ||
    cmp(a.date, b.date) ||
    cmp(a.otlProjectCode, b.otlProjectCode));
  // personId and reason are needed as tiebreakers now that a single
  // (month, otlProjectCode) key can carry more than one residual — e.g. an
  // allocation's SUB_BLOCK_REMAINDER alongside an UNASSIGNED/UNABSORBED
  // carry-forward for the same key.
  residuals.sort((a, b) =>
    cmp(a.month, b.month) ||
    cmp(a.otlProjectCode, b.otlProjectCode) ||
    cmp(a.personId ?? '', b.personId ?? '') ||
    cmp(a.reason, b.reason));
  // Violations are output too, and output has to be deterministic. Message is
  // the last tiebreaker, so the order only ever ties for identical rows.
  violations.sort((a, b) =>
    cmp(a.personId ?? '', b.personId ?? '') ||
    cmp(a.scope, b.scope) ||
    cmp(a.kind, b.kind) ||
    cmp(a.message, b.message));

  return { entries, residuals, violations };
}
