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

export function AllocationsPage({ model, month, update, onMonthChange }: AllocationsPageProps) {
  return (
    <Stack gap={6}>
      <Heading level={2}>Allocations</Heading>
      <Selector
        label="Month"
        options={monthOptions(month)}
        value={month}
        onChange={onMonthChange}
      />
      <AllocationGrid model={model} month={month} update={update} />
    </Stack>
  );
}
