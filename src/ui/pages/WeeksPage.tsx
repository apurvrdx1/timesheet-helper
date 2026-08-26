/**
 * The Weeks page: the optimized weekly timesheet the user actually submits.
 * Prop-driven, like SetupPage/AllocationsPage — it owns no store access;
 * wiring into App.tsx belongs to a later task.
 *
 * Scheduling runs on every render from `model` and `month` (scheduleAll is
 * pure and local-only per DESIGN.md §4 "Loading" — no spinner, no caching
 * needed for a computation that finishes in milliseconds).
 *
 * Two things the month picker must not do, both of which it once did:
 * it must not narrow the schedule to the month on screen (spec §3.4: there
 * is one continuous schedule and the picker is a window onto it, so a week
 * reads the same from either month it touches), and it must not let a model
 * the scheduler cannot yet make sense of throw out of a render.
 */
import { useState } from 'react';
import { Stack } from '@astryxdesign/core/Stack';
import { VStack } from '@astryxdesign/core/VStack';
import { HStack } from '@astryxdesign/core/HStack';
import { Heading } from '@astryxdesign/core/Heading';
import { Selector } from '@astryxdesign/core/Selector';
import { Button } from '@astryxdesign/core/Button';
import { Badge } from '@astryxdesign/core/Badge';
import { Text } from '@astryxdesign/core/Text';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { Layout, LayoutContent } from '@astryxdesign/core/Layout';
import { WeekAccordion } from '../components/WeekAccordion';
import { LeaveDialog } from '../components/LeaveDialog';
import { PersonWeekView } from '../components/PersonWeekView';
import { weeksTouchingMonth, weekDays } from '../../domain/calendar';
import { scheduleAll } from '../../domain/schedule';
import { blocksToHours } from '../../domain/blocks';
import type {
  IsoDate, IsoMonth, LeaveRange, Model, OtlCode, PersonId, Residual, ScheduleEntry,
  ScheduleResult,
} from '../../domain/types';

export interface WeeksPageProps {
  model: Model;
  month: IsoMonth;
  update: (model: Model) => void;
  onMonthChange: (month: IsoMonth) => void;
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

function monthLabel(month: IsoMonth): string {
  const [yearText, monthText] = month.split('-');
  const monthIndex = Number(monthText) - 1;
  const name = MONTH_NAMES[monthIndex];
  return name ? `${name} ${yearText}` : month;
}

/** A generous, static window of months around the currently selected one —
 * same reasoning as AllocationsPage: the model carries no "known months"
 * list to derive options from. */
function monthOptions(month: IsoMonth): { value: string; label: string }[] {
  const [yearText, monthText] = month.split('-');
  const year = Number(yearText);
  const monthIndex = Number(monthText) - 1;
  const options: { value: string; label: string }[] = [];
  for (let offset = -18; offset <= 18; offset++) {
    const total = year * 12 + monthIndex + offset;
    const optionYear = Math.floor(total / 12);
    const optionMonthIndex = ((total % 12) + 12) % 12;
    const value = `${optionYear}-${String(optionMonthIndex + 1).padStart(2, '0')}`;
    options.push({ value, label: monthLabel(value) });
  }
  return options;
}

const EMPTY_RESULT: ScheduleResult = { entries: [], residuals: [], violations: [] };

/**
 * The months the schedule must span. Every month the model allocates into —
 * the same set `store.recalculate` schedules over (see `monthsOf` in
 * store.ts, which this deliberately matches rather than narrows) — plus the
 * month being looked at, so opening a month the model has no allocations for
 * still renders its weeks.
 *
 * Passing just `[month]` is what broke spec §3.4: with only one month in the
 * window, pacing sees a runway of only the days that month contributes to
 * the weeks on screen, so a straddling week is filled from a budget that
 * looks nearly exhausted and the same week reads differently depending on
 * which side it is opened from. Everything the truncated window failed to
 * place then re-surfaced as an UNABSORBED residual for a month that had a
 * whole run of days left.
 */
function scheduleMonths(model: Model, month: IsoMonth): IsoMonth[] {
  return [...new Set([...model.allocations.map((allocation) => allocation.month), month])].sort();
}

interface ScheduleProblem {
  /** The next action, per DESIGN.md §4 "Empty states". */
  title: string;
  detail: string;
}

/**
 * `scheduleAll` throws on a model it cannot make sense of — the reachable
 * case being a person to schedule with no OTL flagged as the default OPEX
 * code, which Setup allows (add a manager before flagging a code) and
 * deleting that OTL re-creates. The precondition is checked here rather than
 * only caught, so the page can name the missing setting instead of quoting a
 * domain exception; the catch stays as a backstop, because a render is the
 * one place a throw costs the user the whole app.
 */
function scheduleSafely(model: Model, month: IsoMonth): {
  result: ScheduleResult; problem: ScheduleProblem | null;
} {
  if (model.people.length > 0 && !model.otls.some((otl) => otl.isDefaultOpex)) {
    return {
      result: EMPTY_RESULT,
      problem: {
        title: 'Flag an OPEX code as default to see a schedule.',
        detail: 'Every day is filled to 7.5h with the default OPEX code, so no week ' +
                'can be scheduled until one of the OPEX codes on Setup is flagged as ' +
                'the default.',
      },
    };
  }
  try {
    return { result: scheduleAll(model, scheduleMonths(model, month)), problem: null };
  } catch (error) {
    return {
      result: EMPTY_RESULT,
      problem: {
        title: 'The schedule could not be built.',
        detail: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

function upsertOverride(
  model: Model, personId: PersonId, date: IsoDate, otlProjectCode: OtlCode, hours: number,
): Model {
  const rest = model.overrides.filter(
    (o) => !(o.personId === personId && o.date === date && o.otlProjectCode === otlProjectCode),
  );
  return { ...model, overrides: [...rest, { personId, date, otlProjectCode, hours }] };
}

function removeOverride(
  model: Model, personId: PersonId, date: IsoDate, otlProjectCode: OtlCode,
): Model {
  return {
    ...model,
    overrides: model.overrides.filter(
      (o) => !(o.personId === personId && o.date === date && o.otlProjectCode === otlProjectCode),
    ),
  };
}

function clearOverridesForWeek(model: Model, weekDates: IsoDate[]): Model {
  const dateSet = new Set(weekDates);
  return { ...model, overrides: model.overrides.filter((o) => !dateSet.has(o.date)) };
}

function addLeave(model: Model, leave: LeaveRange): Model {
  return { ...model, leave: [...model.leave, leave] };
}

function residualKey(residual: Residual): string {
  return `${residual.personId ?? 'TEAM'}|${residual.otlProjectCode}|${residual.month}|${residual.reason}`;
}

function residualHours(residual: Residual): number {
  return residual.blocks > 0 ? blocksToHours(residual.blocks) : (residual.subBlockHours ?? 0);
}

/** The one person's entries for the one week being read off (task 21) —
 * the same "already filtered by the caller" contract PersonWeekView and
 * WeekTable both rely on. */
function entriesForPersonWeek(entries: ScheduleEntry[], personId: PersonId, monday: IsoDate): ScheduleEntry[] {
  const dates = new Set(weekDays(monday));
  return entries.filter((entry) => entry.personId === personId && dates.has(entry.date));
}

interface Viewing {
  personId: PersonId;
  monday: IsoDate;
}

export function WeeksPage({ model, month, update, onMonthChange }: WeeksPageProps) {
  const [isLeaveDialogOpen, setIsLeaveDialogOpen] = useState(false);
  const [viewing, setViewing] = useState<Viewing | null>(null);

  const weeks = weeksTouchingMonth(month);
  const { result: scheduleResult, problem } = scheduleSafely(model, month);
  const leaveOtls = model.otls.filter((otl) => otl.category === 'LEAVE');
  const viewingPersonName = viewing
    ? (model.people.find((person) => person.id === viewing.personId)?.name ?? '')
    : '';

  return (
    <Stack gap={6}>
      <Heading level={2}>Weeks</Heading>
      <HStack hAlign="between" vAlign="center">
        <Selector
          label="Month"
          options={monthOptions(month)}
          value={month}
          onChange={onMonthChange}
        />
        <Button label="Add leave" variant="secondary" onClick={() => setIsLeaveDialogOpen(true)}>
          Add leave
        </Button>
      </HStack>

      {scheduleResult.residuals.length > 0 && (
        <VStack gap={2}>
          <Text type="label">Unplaced hours</Text>
          {scheduleResult.residuals.map((residual) => (
            <HStack key={residualKey(residual)} gap={2} vAlign="center">
              <Badge variant="warning" label="carried forward" />
              <Text type="supporting" color="secondary">
                {`${residualHours(residual).toFixed(1)}h of ${residual.otlProjectCode} in ${residual.month} could not be placed.`}
              </Text>
            </HStack>
          ))}
        </VStack>
      )}

      {problem !== null ? (
        <VStack gap={2}>
          <Text type="label">{problem.title}</Text>
          <Text type="supporting" color="secondary">{problem.detail}</Text>
        </VStack>
      ) : (
        <WeekAccordion
          weeks={weeks}
          model={model}
          scheduleResult={scheduleResult}
          onOverride={(personId, date, otlProjectCode, hours) =>
            update(upsertOverride(model, personId, date, otlProjectCode, hours))
          }
          onRevert={(personId, date, otlProjectCode) =>
            update(removeOverride(model, personId, date, otlProjectCode))
          }
          onClearOverrides={(weekDates) => update(clearOverridesForWeek(model, weekDates))}
          onViewPerson={(personId, monday) => setViewing({ personId, monday })}
        />
      )}

      <LeaveDialog
        isOpen={isLeaveDialogOpen}
        onOpenChange={setIsLeaveDialogOpen}
        people={model.people}
        leaveOtls={leaveOtls}
        onSubmit={(leave) => update(addLeave(model, leave))}
      />

      {/* A sibling of WeekAccordion, not a replacement for it: opening this
          dialog never unmounts the accordion, so its open/closed weeks (and
          their localStorage-backed state) are untouched — the user's place
          in the accordion survives opening and closing the read-off view. */}
      <Dialog
        isOpen={viewing !== null}
        onOpenChange={(open) => {
          if (!open) setViewing(null);
        }}
        purpose="info"
        width={960}
      >
        <Layout
          header={
            <DialogHeader
              title={viewing ? `${viewingPersonName}'s week` : ''}
              onOpenChange={(open) => {
                if (!open) setViewing(null);
              }}
            />
          }
          content={
            <LayoutContent>
              {viewing && (
                <PersonWeekView
                  personName={viewingPersonName}
                  monday={viewing.monday}
                  entries={entriesForPersonWeek(scheduleResult.entries, viewing.personId, viewing.monday)}
                  otls={model.otls}
                />
              )}
            </LayoutContent>
          }
        />
      </Dialog>
    </Stack>
  );
}
