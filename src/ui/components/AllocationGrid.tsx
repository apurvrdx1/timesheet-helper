/**
 * The monthly allocation grid: people as rows, active CAPEX OTLs as columns,
 * hours typed into a `NumberInput` per cell.
 *
 * A "Team total" row carries the whole-team monthly budget per OTL — those
 * are the allocation rows with `personId === null` (src/domain/types.ts),
 * which is how the model distinguishes a team budget from a per-person
 * assignment. A per-column footer reports how much of that budget has not
 * been handed out; a trailing per-row "Capacity" column compares each
 * person's committed CAPEX for the month against what they have available.
 *
 * Hours are never rounded. A non-multiple of 0.5 is accepted and stored as
 * typed; on blur the cell's residual (the part past the last half-hour) is
 * named in Supporting text so it never reads as a generic warning banner.
 */
import { useState, type CSSProperties } from 'react';
import {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableRow,
  TableCell,
  TableHeaderCell,
} from '@astryxdesign/core/Table';
import { NumberInput } from '@astryxdesign/core/NumberInput';
import { Text } from '@astryxdesign/core/Text';
import { weeksTouchingMonth, weekDays, monthOf } from '../../domain/calendar';
import { leaveDatesFor, weekCapacity, capexRoom } from '../../domain/capacity';
import { HOURS_PER_BLOCK } from '../../domain/types';
import type { Model, IsoMonth, IsoDate, PersonId } from '../../domain/types';
import { formatHoursCell } from '../format';

export interface AllocationGridProps {
  model: Model;
  month: IsoMonth;
  update: (model: Model) => void;
}

// Tolerance for float noise when comparing hours against the half-hour grid.
const EPSILON = 1e-6;

function cellKey(personId: PersonId | null, otlProjectCode: string): string {
  return `${personId ?? 'TEAM'}|${otlProjectCode}`;
}

/** The part of `hours` past the last whole half-hour block, rounded to avoid float noise. */
function fractionalResidual(hours: number): number {
  const blocks = Math.floor(hours / HOURS_PER_BLOCK + EPSILON);
  const residual = hours - blocks * HOURS_PER_BLOCK;
  return Math.round(residual * 1000) / 1000;
}

/**
 * Every weekday of `month`, via the exported calendar helpers rather than
 * hand-rolled date math: every Monday touching the month, filtered to the
 * weekdays that actually land inside it. `weekDays` already excludes
 * weekends, so no separate weekend filter is needed.
 */
function workingDatesInMonth(month: IsoMonth): IsoDate[] {
  const dates: IsoDate[] = [];
  for (const monday of weeksTouchingMonth(month)) {
    for (const day of weekDays(monday)) {
      if (monthOf(day) === month) dates.push(day);
    }
  }
  return dates;
}

function getHours(
  model: Model, month: IsoMonth, personId: PersonId | null, otlProjectCode: string,
): number {
  const found = model.allocations.find(
    (a) => a.month === month && a.otlProjectCode === otlProjectCode && a.personId === personId,
  );
  return found?.hours ?? 0;
}

/** Immutable upsert: replace the one allocation row for this key, if any. */
function upsertAllocation(
  model: Model, month: IsoMonth, otlProjectCode: string, personId: PersonId | null, hours: number,
): Model {
  const rest = model.allocations.filter(
    (a) => !(a.month === month && a.otlProjectCode === otlProjectCode && a.personId === personId),
  );
  return { ...model, allocations: [...rest, { month, otlProjectCode, personId, hours }] };
}

export function AllocationGrid({ model, month, update }: AllocationGridProps) {
  // `update` may be a caller-owned mock that never re-renders this component
  // with the new model (as in tests), so the input's own value and the
  // blur-time residual both need a local, optimistic source of truth layered
  // over the model rather than reading the model back after every keystroke.
  const [localHours, setLocalHours] = useState<Record<string, number>>({});
  const [residuals, setResiduals] = useState<Record<string, number>>({});

  const capexOtls = model.otls.filter((otl) => otl.category === 'CAPEX' && otl.active);
  const monthDates = workingDatesInMonth(month);

  const cellValue = (personId: PersonId | null, otlProjectCode: string): number => {
    const key = cellKey(personId, otlProjectCode);
    return key in localHours ? (localHours[key] as number) : getHours(model, month, personId, otlProjectCode);
  };

  const handleChange = (personId: PersonId | null, otlProjectCode: string, hours: number): void => {
    setLocalHours((prev) => ({ ...prev, [cellKey(personId, otlProjectCode)]: hours }));
    update(upsertAllocation(model, month, otlProjectCode, personId, hours));
  };

  // Never block typing: the residual is only surfaced on blur, once the
  // user has committed a value, not on every keystroke.
  const handleBlur = (personId: PersonId | null, otlProjectCode: string): void => {
    const key = cellKey(personId, otlProjectCode);
    const residual = fractionalResidual(cellValue(personId, otlProjectCode));
    setResiduals((prev) => {
      if (residual > EPSILON) {
        return { ...prev, [key]: residual };
      }
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const capacityHoursFor = (personId: PersonId): number => {
    const leaveDates = leaveDatesFor(personId, monthDates, model);
    const capacityBlocks = weekCapacity(leaveDates, monthDates);
    return capexRoom(capacityBlocks) * HOURS_PER_BLOCK;
  };

  const committedHoursFor = (personId: PersonId): number =>
    capexOtls.reduce((sum, otl) => sum + getHours(model, month, personId, otl.projectCode), 0);

  const unassignedFor = (otlProjectCode: string): number => {
    const total = getHours(model, month, null, otlProjectCode);
    const handedOut = model.people.reduce(
      (sum, person) => sum + getHours(model, month, person.id, otlProjectCode),
      0,
    );
    return total - handedOut;
  };

  function renderCell(personId: PersonId | null, personLabel: string, otlProjectCode: string) {
    const key = cellKey(personId, otlProjectCode);
    const residual = residuals[key];
    const isZero = cellValue(personId, otlProjectCode) === 0;
    return (
      <TableCell key={otlProjectCode} style={{ textAlign: 'right' }} className="tabular">
        <NumberInput
          label={`${personLabel} ${otlProjectCode}`}
          isLabelHidden
          value={cellValue(personId, otlProjectCode)}
          onChange={(hours) => handleChange(personId, otlProjectCode, hours)}
          onBlur={() => handleBlur(personId, otlProjectCode)}
          formatValue={formatHoursCell}
          step={0.5}
          min={0}
          // DESIGN.md §2.2/§6: a zeroed cell renders as an em-dash in the
          // disabled color, never black "0.0" text. NumberInput has no
          // `color`/zero-state prop of its own — its input text is styled
          // via `color: var(--color-text-primary)` (NumberInput.tsx), so
          // re-scoping that one custom property on the wrapper is the
          // smallest change that reaches it, rather than reimplementing the
          // component's text rendering to add a prop it doesn't expose.
          style={isZero ? ({ '--color-text-primary': 'var(--color-text-disabled)' } as CSSProperties) : undefined}
        />
        {residual != null && (
          // Supporting-scale helper text naming the exact residual — not the
          // NumberInput's built-in `status` banner, which would read as a
          // generic warning rather than this specific figure.
          <Text type="supporting" style={{ color: 'var(--color-warning)' }}>
            {`${residual.toFixed(1)}h will carry forward`}
          </Text>
        )}
      </TableCell>
    );
  }

  return (
    <Table density="balanced" dividers="rows">
      <TableHeader>
        <TableRow isHeaderRow>
          <TableHeaderCell scope="col">Person</TableHeaderCell>
          {capexOtls.map((otl) => (
            <TableHeaderCell key={otl.projectCode} scope="col" style={{ textAlign: 'right' }}>
              <Text type="code">{otl.projectCode}</Text>
            </TableHeaderCell>
          ))}
          <TableHeaderCell scope="col" style={{ textAlign: 'right' }}>
            Capacity
          </TableHeaderCell>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow>
          <TableCell>
            <Text type="label">Team total</Text>
          </TableCell>
          {capexOtls.map((otl) => renderCell(null, 'Team total', otl.projectCode))}
          <TableCell />
        </TableRow>
        {model.people.map((person) => {
          const committed = committedHoursFor(person.id);
          const capacity = capacityHoursFor(person.id);
          const isOverCapacity = committed > capacity;
          return (
            <TableRow key={person.id}>
              <TableCell>
                <Text type="label">{person.name}</Text>
              </TableCell>
              {capexOtls.map((otl) => renderCell(person.id, person.name, otl.projectCode))}
              <TableCell style={{ textAlign: 'right' }} className="tabular">
                <Text
                  type="label"
                  style={isOverCapacity ? { color: 'var(--color-error)' } : undefined}
                >
                  {isOverCapacity
                    ? `${committed.toFixed(1)}h of ${capacity.toFixed(1)}h — over capacity`
                    : `${committed.toFixed(1)}h of ${capacity.toFixed(1)}h`}
                </Text>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
      <TableFooter>
        <TableRow>
          <TableCell>
            <Text type="label">Unassigned</Text>
          </TableCell>
          {capexOtls.map((otl) => {
            const unassigned = unassignedFor(otl.projectCode);
            return (
              <TableCell key={otl.projectCode} style={{ textAlign: 'right' }} className="tabular">
                {unassigned > EPSILON ? (
                  <Text type="label" style={{ color: 'var(--color-warning)' }}>
                    {`${unassigned.toFixed(1)}h unassigned`}
                  </Text>
                ) : (
                  <Text type="label" color="disabled">
                    —
                  </Text>
                )}
              </TableCell>
            );
          })}
          <TableCell />
        </TableRow>
      </TableFooter>
    </Table>
  );
}
