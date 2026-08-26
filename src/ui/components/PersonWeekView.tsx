/**
 * The per-person weekly read-off view (task 20). Its entire job is to be
 * read from while the user types the same figures into their real
 * corporate timesheet system — a standalone, read-only `Card` (DESIGN.md
 * §3 Table, §6: never a card inside a card, and this component IS the
 * outer card) showing one person's Monday–Friday week: the four sticky
 * OTL identifier columns, daily hours, a per-row weekly total, and a
 * footer row with daily and grand totals.
 *
 * Deliberately prop-driven and standalone (task 20's constraint): it does
 * not import from `src/domain` beyond types/helpers, does not touch
 * storage, and does not filter `entries` by person — the caller is
 * expected to hand it exactly the entries for the one person and week
 * being displayed, the same contract `WeekTable` uses for its per-person
 * grouping.
 */
import { Card } from '@astryxdesign/core/Card';
import { VStack } from '@astryxdesign/core/VStack';
import { HStack } from '@astryxdesign/core/HStack';
import { Heading } from '@astryxdesign/core/Heading';
import { Text } from '@astryxdesign/core/Text';
import { Code } from '@astryxdesign/core/Code';
import {
  Table, TableHeader, TableBody, TableRow, TableCell, TableHeaderCell,
} from '@astryxdesign/core/Table';
import { blocksToHours } from '../../domain/blocks';
import { formatWeekRange, formatDayHeader, weekDays } from '../../domain/calendar';
import { formatHoursCell } from '../format';
import type { IsoDate, Otl, ScheduleEntry } from '../../domain/types';

export interface PersonWeekViewProps {
  personName: string;
  /** The Monday that starts the week being read off. */
  monday: IsoDate;
  /** This person's schedule entries for the week — already filtered by the caller. */
  entries: ScheduleEntry[];
  otls: Otl[];
}

/** Print isolation: hides everything else on the page and lets only this
 * card through, so the app chrome (nav, other cards, the page header)
 * never lands on paper — DESIGN.md's "must print on one page" is a
 * requirement on the printed page's content, not just this element's own
 * layout, and there is no other file this standalone component is allowed
 * to touch to arrange that at the page level. Scoped to a data attribute
 * rather than a class to avoid colliding with any host-page class name.
 * `break-inside: avoid` (with the `page-break-inside` fallback for older
 * print engines) keeps the whole card — and each table row — from
 * splitting across a page boundary. */
const PRINT_STYLES = `
@media print {
  body * { visibility: hidden; }
  [data-person-week-view], [data-person-week-view] * { visibility: visible; }
  [data-person-week-view] {
    position: absolute;
    inset: 0;
    width: 100%;
  }
  [data-person-week-view] .pwv-card {
    box-shadow: none;
    break-inside: avoid;
    page-break-inside: avoid;
  }
  [data-person-week-view] tr {
    break-inside: avoid;
    page-break-inside: avoid;
  }
}
`;

interface DayCell {
  date: IsoDate;
  hours: number;
}

function dayCellsFor(entries: ScheduleEntry[], code: string, dates: IsoDate[]): DayCell[] {
  return dates.map((date) => {
    const entry = entries.find((candidate) => candidate.date === date && candidate.otlProjectCode === code);
    return { date, hours: entry ? blocksToHours(entry.blocks) : 0 };
  });
}

export function PersonWeekView({ personName, monday, entries, otls }: PersonWeekViewProps) {
  const dates = weekDays(monday);
  // AN ENTRY WHOSE OTL IS MISSING FROM `otls` MUST STILL RENDER: hours are
  // never gated on a successful lookup, only the OTL code itself decides
  // which rows exist.
  const codes = [...new Set(entries.map((entry) => entry.otlProjectCode))].sort();
  const weekTotal = entries
    .filter((entry) => dates.includes(entry.date))
    .reduce((sum, entry) => sum + blocksToHours(entry.blocks), 0);

  return (
    <div data-person-week-view="true">
      <style>{PRINT_STYLES}</style>
      <Card className="pwv-card" variant="default" padding={4} elevation="low">
        <VStack gap={4}>
          <HStack justify="between" align="center">
            <Heading level={4}>{personName}</Heading>
            <Text type="label" color="secondary">{formatWeekRange(monday)}</Text>
          </HStack>

          <div style={{ overflowX: 'auto' }}>
            <Table aria-label={`${personName} week`} density="balanced" dividers="rows">
              <TableHeader>
                <TableRow isHeaderRow>
                  <TableHeaderCell scope="col">Project</TableHeaderCell>
                  <TableHeaderCell scope="col">Task</TableHeaderCell>
                  <TableHeaderCell scope="col">Expenditure type</TableHeaderCell>
                  <TableHeaderCell scope="col">Time reporting code</TableHeaderCell>
                  {dates.map((date) => (
                    <TableHeaderCell key={date} scope="col" style={{ textAlign: 'right' }}>
                      {formatDayHeader(date)}
                    </TableHeaderCell>
                  ))}
                  <TableHeaderCell scope="col" style={{ textAlign: 'right' }}>Total</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {codes.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={4}>
                      <Text type="body" color="secondary">No hours scheduled this week.</Text>
                    </TableCell>
                    <TableCell colSpan={dates.length + 1} />
                  </TableRow>
                )}
                {codes.map((code) => {
                  // Hours render regardless of whether the OTL is known —
                  // only the identifier columns fall back to an em-dash.
                  const otl = otls.find((candidate) => candidate.projectCode === code);
                  const cells = dayCellsFor(entries, code, dates);
                  const rowTotal = cells.reduce((sum, cell) => sum + cell.hours, 0);
                  return (
                    <TableRow key={code}>
                      <TableCell><Code>{code}</Code></TableCell>
                      <TableCell><Code color={otl ? 'primary' : 'secondary'}>{otl ? otl.taskCode : '—'}</Code></TableCell>
                      <TableCell><Code color={otl ? 'primary' : 'secondary'}>{otl ? otl.expenditureTypeCode : '—'}</Code></TableCell>
                      <TableCell><Code color={otl ? 'primary' : 'secondary'}>{otl ? otl.timeReportingCode : '—'}</Code></TableCell>
                      {cells.map((cell) => (
                        <TableCell key={cell.date} className="tabular" style={{ textAlign: 'right' }}>
                          <Text type="body" color={cell.hours === 0 ? 'disabled' : 'primary'}>
                            {formatHoursCell(cell.hours)}
                          </Text>
                        </TableCell>
                      ))}
                      <TableCell className="tabular" style={{ textAlign: 'right' }}>
                        <Text type="label">{formatHoursCell(rowTotal)}</Text>
                      </TableCell>
                    </TableRow>
                  );
                })}
                {codes.length > 0 && (
                  <TableRow style={{ borderTop: '2px solid var(--color-border-emphasized)' }}>
                    <TableCell colSpan={4}><Text type="label">Total</Text></TableCell>
                    {dates.map((date) => {
                      const dayTotal = entries
                        .filter((entry) => entry.date === date)
                        .reduce((sum, entry) => sum + blocksToHours(entry.blocks), 0);
                      return (
                        <TableCell key={date} className="tabular" style={{ textAlign: 'right' }}>
                          <Text type="label" color={dayTotal === 0 ? 'disabled' : 'primary'}>
                            {formatHoursCell(dayTotal)}
                          </Text>
                        </TableCell>
                      );
                    })}
                    <TableCell className="tabular" style={{ textAlign: 'right' }}>
                      <Text type="label">{formatHoursCell(weekTotal)}</Text>
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </VStack>
      </Card>
    </div>
  );
}
