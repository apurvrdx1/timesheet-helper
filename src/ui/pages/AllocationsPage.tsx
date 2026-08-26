/**
 * The Allocations page: pick a month, then a grid of people × active CAPEX
 * OTLs. This is where the manager spends most of their time, so the
 * emphasis is data-entry quality — see AllocationGrid for the grid itself.
 *
 * Prop-driven: it owns no store access. Wiring into App.tsx belongs to a
 * later task.
 */
import { Stack } from '@astryxdesign/core/Stack';
import { Selector } from '@astryxdesign/core/Selector';
import { Heading } from '@astryxdesign/core/Heading';
import { VStack } from '@astryxdesign/core/VStack';
import { Text } from '@astryxdesign/core/Text';
import { AllocationGrid } from '../components/AllocationGrid';
import type { Model, IsoMonth } from '../../domain/types';

export interface AllocationsPageProps {
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

/**
 * A generous, static window of months around the currently selected one.
 * The model carries no "known months" list to build options from, so this
 * offers a fixed ±18-month range rather than inventing one from allocation
 * data that may not exist yet.
 */
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

/**
 * The empty state for a model with people but nothing allocated in any month
 * (DESIGN.md §4 "Empty states": the title is the next action).
 *
 * This is where the schedule's empty window is acted on. `recalculate`
 * schedules over allocated months only, so until one month has hours there is
 * nothing for it to place — which the app used to report as a permanently
 * stale schedule with a Recalculate button that failed every time it was
 * pressed. The state is named here, next to the grid that clears it, and the
 * banner stays quiet.
 *
 * The grid is still rendered underneath: it is the thing the user has to type
 * into, so an empty state that replaced it would take away the way out.
 */
function AllocationsEmptyState() {
  return (
    <VStack gap={2}>
      <Text type="label">Allocate hours to a month to see them scheduled.</Text>
      <Text type="supporting" color="secondary">
        No hours are allocated in any month yet. Enter hours in the grid below for the
        month you are planning — the schedule is built from allocated months only, so
        nothing is placed until at least one month has hours.
      </Text>
    </VStack>
  );
}

export function AllocationsPage({ model, month, update, onMonthChange }: AllocationsPageProps) {
  const hasNothingAllocated = model.people.length > 0 && model.allocations.length === 0;

  return (
    <Stack gap={6}>
      <Heading level={2}>Allocations</Heading>
      <Selector
        label="Month"
        options={monthOptions(month)}
        value={month}
        onChange={onMonthChange}
      />
      {hasNothingAllocated && <AllocationsEmptyState />}
      <AllocationGrid model={model} month={month} update={update} />
    </Stack>
  );
}
