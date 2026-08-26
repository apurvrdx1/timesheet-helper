/**
 * The Weeks page: the optimized weekly timesheet the user actually submits.
 * Prop-driven, like SetupPage/AllocationsPage — it owns no store access;
 * wiring into App.tsx belongs to a later task.
 *
 * Scheduling runs on every render from `model` and `month` (scheduleAll is
 * pure and local-only per DESIGN.md §4 "Loading" — no spinner, no caching
 * needed for a computation that finishes in milliseconds).
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
import { WeekAccordion } from '../components/WeekAccordion';
import { LeaveDialog } from '../components/LeaveDialog';
import { weeksTouchingMonth } from '../../domain/calendar';
import { scheduleAll } from '../../domain/schedule';
import { blocksToHours } from '../../domain/blocks';
import type {
  IsoDate, IsoMonth, LeaveRange, Model, OtlCode, PersonId, Residual,
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

export function WeeksPage({ model, month, update, onMonthChange }: WeeksPageProps) {
  const [isLeaveDialogOpen, setIsLeaveDialogOpen] = useState(false);

  const weeks = weeksTouchingMonth(month);
  const scheduleResult = scheduleAll(model, [month]);
  const leaveOtls = model.otls.filter((otl) => otl.category === 'LEAVE');

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
      />

      <LeaveDialog
        isOpen={isLeaveDialogOpen}
        onOpenChange={setIsLeaveDialogOpen}
        people={model.people}
        leaveOtls={leaveOtls}
        onSubmit={(leave) => update(addLeave(model, leave))}
      />
    </Stack>
  );
}
