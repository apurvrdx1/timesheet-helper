/**
 * One audience's table for one week: four sticky-left OTL identifier
 * columns, Mon–Fri hour cells, and a totals row per person (DESIGN.md §3
 * Table). `WeeksPage` renders one `WeekTable` for the manager and a second
 * for the reports — the same component either way, since the only real
 * difference is which people it's given.
 *
 * Sticky-left positioning has no Astryx prop in the children-mode Table API
 * (`useTableStickyColumns` is a data-driven-mode plugin only), so the four
 * identifier columns get `position: sticky` by hand here — the one other
 * hand-rolled layout bit in this file, called out per DESIGN.md §5 rule 1.
 */
import { Fragment, type CSSProperties, type SVGProps } from 'react';
import {
  Table, TableHeader, TableBody, TableRow, TableCell, TableHeaderCell,
} from '@astryxdesign/core/Table';
import { Text } from '@astryxdesign/core/Text';
import { Code } from '@astryxdesign/core/Code';
import { HStack } from '@astryxdesign/core/HStack';
import { IconButton } from '@astryxdesign/core/IconButton';
import { Icon } from '@astryxdesign/core/Icon';
import { HourCell } from './HourCell';
import { blocksToHours } from '../../domain/blocks';
import { formatDayHeader } from '../../domain/calendar';
import { formatHoursCell } from '../format';
import type {
  IsoDate, LeaveSubtype, Otl, OtlCode, Person, PersonId, ScheduleEntry,
} from '../../domain/types';

export interface WeekTableProps {
  /** Accessible name for the table (matched by tests via /manager/i, /reports/i). */
  title: string;
  people: Person[];
  dates: IsoDate[];
  /** Every schedule entry for the week, across all people — filtered internally per person. */
  entries: ScheduleEntry[];
  otls: Otl[];
  onOverride: (personId: PersonId, date: IsoDate, otlProjectCode: OtlCode, hours: number) => void;
  onRevert: (personId: PersonId, date: IsoDate, otlProjectCode: OtlCode) => void;
  /** Opens the read-only PersonWeekView for this person and week (task 21). */
  onViewPerson: (personId: PersonId) => void;
}

/** No "view"/"eye" name exists in the Astryx icon registry — the same
 * situation HourCell's lock glyph documents — so a minimal eye glyph is
 * supplied directly rather than repurposing an unrelated registry icon. */
function ViewGlyph(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" {...props}>
      <path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5Z" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

/** DESIGN.md §2.1's named ramp (blue, orange, purple, green, pink, cyan, red,
 * teal, brown, indigo) has no "brown"/"indigo" token in the neutral theme —
 * only these ten hues exist as real `--color-border-*` custom properties.
 * Gray and yellow stand in for the two missing names rather than inventing
 * a hex value, which DESIGN.md §5 rule 2 forbids. */
const CAPEX_BORDER_VARS = [
  '--color-border-blue', '--color-border-orange', '--color-border-purple', '--color-border-green',
  '--color-border-pink', '--color-border-cyan', '--color-border-red', '--color-border-teal',
  '--color-border-gray', '--color-border-yellow',
] as const;

function capexBorderVar(colorIndex: number): string {
  const index = ((colorIndex % CAPEX_BORDER_VARS.length) + CAPEX_BORDER_VARS.length) % CAPEX_BORDER_VARS.length;
  return CAPEX_BORDER_VARS[index] ?? CAPEX_BORDER_VARS[0];
}

const LEAVE_SUBTYPE_LABELS: Record<LeaveSubtype, string> = {
  VACATION: 'Vacation', STAT: 'Stat', PERSONAL: 'Personal', SICK: 'Sick',
};

const EMPHASIZED = { borderTop: '2px solid var(--color-border-emphasized)' } as const;

const STICKY_COLUMN_WIDTHS = [0, 96, 96, 128] as const;

function stickyStyle(columnIndex: number): CSSProperties {
  let left = 0;
  for (let i = 0; i < columnIndex; i++) left += STICKY_COLUMN_WIDTHS[i] ?? 0;
  return {
    position: 'sticky',
    left,
    zIndex: 1,
    backgroundColor: 'var(--color-background-card)',
    minWidth: STICKY_COLUMN_WIDTHS[columnIndex] ?? 96,
  };
}

function otlLookup(otls: Otl[], code: OtlCode): Otl | undefined {
  return otls.find((otl) => otl.projectCode === code);
}

export function WeekTable({
  title, people, dates, entries, otls, onOverride, onRevert, onViewPerson,
}: WeekTableProps) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <Table aria-label={title} density="balanced" dividers="rows">
        <TableHeader>
          <TableRow isHeaderRow>
            <TableHeaderCell scope="col" style={stickyStyle(0)}>Project</TableHeaderCell>
            <TableHeaderCell scope="col" style={stickyStyle(1)}>Task</TableHeaderCell>
            <TableHeaderCell scope="col" style={stickyStyle(2)}>Expenditure type</TableHeaderCell>
            <TableHeaderCell scope="col" style={stickyStyle(3)}>Time reporting code</TableHeaderCell>
            {dates.map((date) => (
              <TableHeaderCell key={date} scope="col" style={{ textAlign: 'right' }}>
                {formatDayHeader(date)}
              </TableHeaderCell>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {people.map((person, personIndex) => {
            const personEntries = entries.filter((entry) => entry.personId === person.id);
            const codes = [...new Set(personEntries.map((entry) => entry.otlProjectCode))].sort();
            const isNewPersonBlock = personIndex > 0;

            return (
              <Fragment key={person.id}>
                {codes.length === 0 && (
                  <TableRow style={isNewPersonBlock ? EMPHASIZED : undefined}>
                    <TableCell colSpan={4} style={stickyStyle(0)}>
                      <HStack gap={2} vAlign="center">
                        <Text type="label">{person.name}</Text>
                        <IconButton
                          label={`View ${person.name}'s week`}
                          tooltip={`View ${person.name}'s week`}
                          icon={<Icon icon={ViewGlyph} />}
                          variant="ghost"
                          size="sm"
                          onClick={() => onViewPerson(person.id)}
                        />
                      </HStack>
                    </TableCell>
                    <TableCell colSpan={dates.length}>
                      <Text type="supporting" color="disabled">No hours scheduled this week.</Text>
                    </TableCell>
                  </TableRow>
                )}
                {codes.map((code, codeIndex) => {
                  const otl = otlLookup(otls, code);
                  const rowStyle = codeIndex === 0 && isNewPersonBlock ? EMPHASIZED : undefined;
                  const isCapex = otl?.category === 'CAPEX';
                  const leaveLabel = otl?.leaveSubtype ? LEAVE_SUBTYPE_LABELS[otl.leaveSubtype] : null;
                  return (
                    <TableRow key={code} style={rowStyle}>
                      <TableCell
                        style={{
                          ...stickyStyle(0),
                          ...(isCapex
                            ? { borderLeft: `3px solid var(${capexBorderVar(otl?.colorIndex ?? 0)})` }
                            : {}),
                        }}
                      >
                        <Code>{code}</Code>
                      </TableCell>
                      <TableCell style={stickyStyle(1)}><Code>{otl?.taskCode ?? ''}</Code></TableCell>
                      <TableCell style={stickyStyle(2)}><Code>{otl?.expenditureTypeCode ?? ''}</Code></TableCell>
                      <TableCell style={stickyStyle(3)}><Code>{otl?.timeReportingCode ?? ''}</Code></TableCell>
                      {dates.map((date) => {
                        const entry = personEntries.find(
                          (candidate) => candidate.date === date && candidate.otlProjectCode === code,
                        );
                        const hours = entry ? blocksToHours(entry.blocks) : 0;
                        const source = entry?.source ?? 'CALC';
                        return (
                          <HourCell
                            key={date}
                            personId={person.id}
                            date={date}
                            otlProjectCode={code}
                            hours={hours}
                            source={source}
                            leaveSubtype={leaveLabel}
                            onOverride={(newHours) => onOverride(person.id, date, code, newHours)}
                            onRevert={() => onRevert(person.id, date, code)}
                          />
                        );
                      })}
                    </TableRow>
                  );
                })}
                {codes.length > 0 && (
                  <TableRow>
                    <TableCell colSpan={4} style={stickyStyle(0)}>
                      <HStack gap={2} vAlign="center">
                        <Text type="label">{`${person.name} total`}</Text>
                        <IconButton
                          label={`View ${person.name}'s week`}
                          tooltip={`View ${person.name}'s week`}
                          icon={<Icon icon={ViewGlyph} />}
                          variant="ghost"
                          size="sm"
                          onClick={() => onViewPerson(person.id)}
                        />
                      </HStack>
                    </TableCell>
                    {dates.map((date) => {
                      const total = personEntries
                        .filter((entry) => entry.date === date)
                        .reduce((sum, entry) => sum + blocksToHours(entry.blocks), 0);
                      return (
                        <TableCell
                          key={date}
                          aria-label="day total"
                          className="tabular"
                          style={{ textAlign: 'right' }}
                        >
                          <Text type="label">{formatHoursCell(total)}</Text>
                        </TableCell>
                      );
                    })}
                  </TableRow>
                )}
              </Fragment>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
