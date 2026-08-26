/**
 * The editable hour cell (DESIGN.md §3: composed `TableCell` + `NumberInput`).
 *
 * The NumberInput is mounted unconditionally — never swapped in only after a
 * click — because Tab navigation across a person's week (DESIGN.md §5 rule
 * 11) needs every day's input to already be a real, focusable element; a
 * cell that only grows an `<input>` on click can never receive focus via Tab.
 *
 * To get "looks like plain text at rest, becomes an input on focus" without
 * a bespoke stylesheet, the NumberInput sits absolutely UNDER a plain text
 * span: the span carries the visible figure ("2.5", "—") that a sighted user
 * reads at rest, and the input sits beneath it at opacity 0 — still
 * clickable and keyboard-focusable — becoming visible (its own border, its
 * own value) once actually focused, at which point the span fades so the
 * two don't double-print the same number. This absolute positioning is the
 * one hand-rolled layout in this file (DESIGN.md §5 rule 1 asks for a
 * comment whenever custom CSS is used instead of an Astryx primitive) —
 * there is no Astryx "click-anywhere-to-edit" cell primitive to compose
 * instead.
 *
 * Two different numbers live in a locked cell and the split matters: `hours`
 * is the cell's whole figure — the one the user copies into the real
 * timesheet, and the one the totals row sums — while `overrideHours` is the
 * part they actually pinned. They differ whenever the optimizer had to top a
 * pinned default-OPEX cell up to a full 7.5h day. At rest the cell shows the
 * total, because reading a week off is what the grid is for; the field edits
 * and commits the pin, because that is what the user owns; and the padlock
 * names the pin so the total is never mistaken for something the user typed.
 */
import { useEffect, useRef, useState, type KeyboardEvent, type SVGProps } from 'react';
import { TableCell } from '@astryxdesign/core/Table';
import { NumberInput } from '@astryxdesign/core/NumberInput';
import { IconButton } from '@astryxdesign/core/IconButton';
import { Icon } from '@astryxdesign/core/Icon';
import { Tooltip } from '@astryxdesign/core/Tooltip';
import { Text } from '@astryxdesign/core/Text';
import { HStack } from '@astryxdesign/core/HStack';
import { Badge } from '@astryxdesign/core/Badge';
import { formatHoursCell } from '../format';
import type { EntrySource, IsoDate, OtlCode, PersonId } from '../../domain/types';

export interface HourCellProps {
  personId: PersonId;
  date: IsoDate;
  otlProjectCode: OtlCode;
  /** The cell's whole figure: what the user copies into the real timesheet. */
  hours: number;
  source: EntrySource;
  /**
   * How many of `hours` the user actually pinned, mirroring the domain's
   * `ScheduleEntry.overrideBlocks`. The two differ in exactly one place: a
   * pin on the default OPEX code, which phase 4 of the optimizer may still
   * top up so the day reaches 7.5h. `source` says "lock this cell"; only
   * this says "the user typed this much", so this — never `hours` — is what
   * the field edits and what Enter commits on a locked cell.
   *
   * Omitted means "the whole cell is the pin", which is what every caller
   * predating the split assumed and what every non-default-OPEX pin is.
   */
  overrideHours?: number;
  onOverride: (hours: number) => void;
  onRevert: () => void;
  /**
   * The leave subtype label (e.g. "Vacation"), when this cell's hours are a
   * leave booking. Optional and additive to the verbatim task-19 test
   * fixture, which never passes it: DESIGN.md §2.1 asks for a
   * warning-muted day column plus a subtype Badge on a leave day, and
   * `source === 'LEAVE'` alone doesn't carry which subtype.
   */
  leaveSubtype?: string | null;
}

const LOCK_TOOLTIP = 'Manually set — recalculation will preserve this';

/**
 * The same promise, but for a cell the optimizer topped up: it names the
 * figure the user actually pinned, so the padlock can never be read as a
 * claim over the whole cell. DESIGN.md §4 asks warnings and explanations to
 * state the quantity and where it went, and §3 keeps the "recalculation will
 * preserve this" wording the lock has always carried.
 */
function lockTooltipFor(pinned: number, total: number): string {
  if (pinned >= total) return LOCK_TOOLTIP;
  return `${pinned.toFixed(1)}h manually set — recalculation will preserve this. ` +
         `The optimizer added ${(total - pinned).toFixed(1)}h to fill the day.`;
}

/** No "lock" name exists in the Astryx icon registry (DESIGN.md §3 asks for
 * one); `Icon` accepts a custom SVG component in place of a registry name,
 * so a minimal padlock glyph is supplied directly rather than repurposing an
 * unrelated registry icon. */
function LockGlyph(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" {...props}>
      <rect x="3" y="7" width="10" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" stroke="currentColor" strokeWidth="1.5" fill="none" />
    </svg>
  );
}

export function HourCell({
  personId, date, otlProjectCode, hours, source, overrideHours, onOverride, onRevert,
  leaveSubtype,
}: HourCellProps) {
  const isLeave = source === 'LEAVE';
  const isOverride = source === 'OVERRIDE';
  const isZero = hours === 0;
  // What the field edits and commits. On a locked cell that is the pin, which
  // is not always the whole cell; everywhere else the calculated figure is
  // itself the starting point for an edit.
  const editedHours = isOverride ? (overrideHours ?? hours) : hours;

  // The value last typed (and validated) into the field, kept in a ref
  // rather than state: NumberInput calls onChange and onEnter back-to-back
  // inside the same keydown handler on Enter, so a state read in the Enter
  // handler would still see the stale pre-keystroke render.
  const lastValidRef = useRef(editedHours);
  // Remounting the NumberInput (via `key`) is how its own internal
  // "pendingInput" buffer — private state this component has no other way
  // to reach — gets cleared on Escape, so the field visibly snaps back to
  // the calculated value instead of keeping the rejected keystrokes.
  const [resetKey, setResetKey] = useState(0);
  const [isFocused, setIsFocused] = useState(false);

  useEffect(() => {
    lastValidRef.current = editedHours;
  }, [editedHours, resetKey]);

  if (isLeave) {
    return (
      <TableCell
        className="tabular"
        style={{ textAlign: 'right', backgroundColor: 'var(--color-warning-muted)' }}
      >
        <HStack gap={1} vAlign="center" hAlign="end">
          {leaveSubtype && <Badge variant="warning" label={leaveSubtype} />}
          <Text type="body" color={isZero ? 'disabled' : undefined}>
            {formatHoursCell(hours)}
          </Text>
        </HStack>
      </TableCell>
    );
  }

  const handleChange = (value: number): void => {
    lastValidRef.current = value;
  };

  const handleEnter = (): void => {
    onOverride(lastValidRef.current);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    lastValidRef.current = editedHours;
    setResetKey((count) => count + 1);
    setIsFocused(false);
    onRevert();
  };

  const label = `${otlProjectCode} hours for ${personId}, ${date}`;
  const lockTooltip = lockTooltipFor(editedHours, hours);

  return (
    <TableCell
      className="tabular"
      style={{
        textAlign: 'right',
        borderLeft: isOverride ? '3px solid var(--color-accent)' : undefined,
      }}
    >
      <HStack gap={1} vAlign="center" hAlign="end">
        {isOverride && (
          <Tooltip content={lockTooltip}>
            <Icon icon={LockGlyph} label={lockTooltip} size="xsm" color="accent" />
          </Tooltip>
        )}
        <span style={{ position: 'relative', display: 'inline-block', minWidth: '2.5rem' }}>
          <span
            aria-hidden="true"
            style={{
              display: 'block',
              textAlign: 'right',
              opacity: isFocused ? 0 : 1,
              color: isZero ? 'var(--color-text-disabled)' : 'var(--color-text-primary)',
            }}
          >
            {formatHoursCell(hours)}
          </span>
          <NumberInput
            key={resetKey}
            label={label}
            isLabelHidden
            value={editedHours}
            onChange={handleChange}
            onEnter={handleEnter}
            onKeyDown={handleKeyDown}
            onFocus={() => setIsFocused(true)}
            onBlur={() => setIsFocused(false)}
            step={0.5}
            min={0}
            formatValue={formatHoursCell}
            style={{
              position: 'absolute',
              inset: 0,
              opacity: isFocused ? 1 : 0,
            }}
          />
        </span>
        {isOverride && (
          <IconButton
            label="Revert to calculated value"
            tooltip="Revert to calculated value"
            icon={<Icon icon="chevronsLeft" />}
            variant="ghost"
            size="sm"
            onClick={onRevert}
          />
        )}
      </HStack>
    </TableCell>
  );
}
