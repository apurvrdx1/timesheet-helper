/**
 * The Mon–Fri week accordion (DESIGN.md §3 Collapsible). One panel per
 * Monday from `weeksTouchingMonth`; each panel's header — always visible,
 * collapsed or not, since it is the Collapsible `trigger` — carries the
 * week's date range, its capacity, and a status dot, so a manager scanning
 * five collapsed weeks can already see which ones need attention.
 *
 * Open/closed state is a plain `string[]` of Monday keys, mirrored to
 * localStorage on every change; every access is wrapped in try/catch since
 * localStorage can throw (private browsing, quota, disabled storage) and a
 * persistence failure must never take the accordion down with it.
 */
import { useEffect, useState } from 'react';
import { CollapsibleGroup, Collapsible } from '@astryxdesign/core/Collapsible';
import { VStack } from '@astryxdesign/core/VStack';
import { HStack } from '@astryxdesign/core/HStack';
import { Text } from '@astryxdesign/core/Text';
import { StatusDot, type StatusDotVariant } from '@astryxdesign/core/StatusDot';
import { Button } from '@astryxdesign/core/Button';
import { AlertDialog } from '@astryxdesign/core/AlertDialog';
import { WeekTable } from './WeekTable';
import { formatWeekRange, weekDays, monthOf } from '../../domain/calendar';
import { BLOCKS_PER_DAY, HOURS_PER_BLOCK } from '../../domain/types';
import type {
  IsoDate, IsoMonth, Model, OtlCode, PersonId, ScheduleResult,
} from '../../domain/types';

export interface WeekAccordionProps {
  weeks: IsoDate[];
  model: Model;
  scheduleResult: ScheduleResult;
  onOverride: (personId: PersonId, date: IsoDate, otlProjectCode: OtlCode, hours: number) => void;
  onRevert: (personId: PersonId, date: IsoDate, otlProjectCode: OtlCode) => void;
  onClearOverrides: (weekDates: IsoDate[]) => void;
}

const STORAGE_KEY = 'timesheet-helper.weeksAccordion.open';

function loadOpenWeeks(): string[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [];
  } catch {
    return [];
  }
}

function saveOpenWeeks(weeks: string[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(weeks));
  } catch {
    // Storage can be unavailable (private browsing, quota, disabled) — the
    // accordion still works for this session, it just won't remember state.
  }
}

function weekStatus(weekDates: IsoDate[], scheduleResult: ScheduleResult): StatusDotVariant {
  const months = new Set<IsoMonth>(weekDates.map(monthOf));
  const hasViolation = scheduleResult.violations.some(
    (violation) => weekDates.includes(violation.scope) || months.has(violation.scope),
  );
  if (hasViolation) return 'error';
  const hasResidual = scheduleResult.residuals.some((residual) => months.has(residual.month));
  if (hasResidual) return 'warning';
  return 'success';
}

// "carried forward" (DESIGN.md §3 Badge) is deliberately not a substring of
// any of these: the page-level residuals summary renders that exact phrase
// as a Badge, and this word sits right beside it whenever a week with a
// residual is expanded — sharing the phrase would make the two
// indistinguishable to a query (and to a screen reader skimming for it).
const STATUS_WORD: Record<StatusDotVariant, string> = {
  success: 'Balances', warning: 'Has unplaced hours', error: 'Needs attention',
  accent: '', neutral: '',
};

function weekCapacityHours(weekDates: IsoDate[], model: Model): number {
  const statHolidayDates = new Set(
    model.statHolidays.filter((holiday) => weekDates.includes(holiday.date)).map((holiday) => holiday.date),
  );
  const workingDays = weekDates.length - statHolidayDates.size;
  return workingDays * BLOCKS_PER_DAY * HOURS_PER_BLOCK;
}

export function WeekAccordion({
  weeks, model, scheduleResult, onOverride, onRevert, onClearOverrides,
}: WeekAccordionProps) {
  const [openWeeks, setOpenWeeks] = useState<string[]>(() => loadOpenWeeks());
  const [clearTarget, setClearTarget] = useState<IsoDate | null>(null);

  useEffect(() => {
    saveOpenWeeks(openWeeks);
  }, [openWeeks]);

  const handleOpenChange = (value: string | string[]): void => {
    setOpenWeeks(Array.isArray(value) ? value : [value]);
  };

  const managers = model.people.filter((person) => person.role === 'MANAGER');
  const reports = model.people.filter((person) => person.role === 'REPORT');

  return (
    <>
      <CollapsibleGroup type="multiple" value={openWeeks} onChange={handleOpenChange} hasDividers>
        {weeks.map((monday) => {
          const dates = weekDays(monday);
          const status = weekStatus(dates, scheduleResult);
          const capacityHours = weekCapacityHours(dates, model);
          const hasOverrides = model.overrides.some((override) => dates.includes(override.date));
          // Astryx's Collapsible hides a closed panel's content with a CSS
          // class rather than omitting it from the DOM (see its source) —
          // correct for a real stylesheet, but this project's test
          // environment never loads one, so an un-gated body would stay
          // fully queryable while "collapsed" and every week's tables would
          // collide on the same accessible names. Mounting the body only
          // for weeks this component itself has recorded as open sidesteps
          // that gap and, as a side effect, keeps ninety percent of the
          // page's DOM out of the tree until a week is actually opened.
          const isOpen = openWeeks.includes(monday);

          return (
            <Collapsible
              key={monday}
              value={monday}
              trigger={
                <HStack gap={3} vAlign="center">
                  <Text type="body" weight="semibold">{formatWeekRange(monday)}</Text>
                  <Text type="supporting" color="secondary">
                    {`${capacityHours.toFixed(1)}h capacity`}
                  </Text>
                  <StatusDot
                    variant={status}
                    label={`week status: ${STATUS_WORD[status]}`}
                    tooltip={STATUS_WORD[status]}
                  />
                  <Text type="supporting" color="secondary">{STATUS_WORD[status]}</Text>
                </HStack>
              }
            >
              {isOpen && (
                <VStack gap={4}>
                  {hasOverrides && (
                    <HStack hAlign="end">
                      <Button
                        label={`Clear overrides for the week of ${formatWeekRange(monday)}`}
                        variant="secondary"
                        onClick={() => setClearTarget(monday)}
                      >
                        Clear overrides
                      </Button>
                    </HStack>
                  )}
                  <WeekTable
                    title="Manager"
                    people={managers}
                    dates={dates}
                    entries={scheduleResult.entries}
                    otls={model.otls}
                    onOverride={onOverride}
                    onRevert={onRevert}
                  />
                  <WeekTable
                    title="Reports"
                    people={reports}
                    dates={dates}
                    entries={scheduleResult.entries}
                    otls={model.otls}
                    onOverride={onOverride}
                    onRevert={onRevert}
                  />
                </VStack>
              )}
            </Collapsible>
          );
        })}
      </CollapsibleGroup>

      <AlertDialog
        isOpen={clearTarget !== null}
        onOpenChange={(open) => {
          if (!open) setClearTarget(null);
        }}
        title={clearTarget ? `Clear overrides for the week of ${formatWeekRange(clearTarget)}` : ''}
        description="Every hand-set hour in this week reverts to what the optimizer would calculate. This cannot be undone."
        actionLabel="Clear overrides"
        onAction={() => {
          if (clearTarget) onClearOverrides(weekDays(clearTarget));
          setClearTarget(null);
        }}
      />
    </>
  );
}
