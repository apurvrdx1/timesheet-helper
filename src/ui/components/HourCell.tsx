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
 */
import { useEffect, useRef, useState, type KeyboardEvent, type SVGProps } from 'react';
import { TableCell } from '@astryxdesign/core/Table';
import { NumberInput } from '@astryxdesign/core/NumberInput';
import { IconButton } from '@astryxdesign/core/IconButton';
import { Icon } from '@astryxdesign/core/Icon';
import { Tooltip } from '@astryxdesign/core/Tooltip';
import { Text } from '@astryxdesign/core/Text';
import { HStack } from '@astryxdesign/core/HStack';
import { formatHoursCell } from '../format';
import type { EntrySource, IsoDate, OtlCode, PersonId } from '../../domain/types';

export interface HourCellProps {
  personId: PersonId;
  date: IsoDate;
  otlProjectCode: OtlCode;
  hours: number;
  source: EntrySource;
  onOverride: (hours: number) => void;
  onRevert: () => void;
}

const LOCK_TOOLTIP = 'Manually set — recalculation will preserve this';

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

export function HourCell({ personId, date, otlProjectCode, hours, source, onOverride, onRevert }: HourCellProps) {
  const isLeave = source === 'LEAVE';
  const isOverride = source === 'OVERRIDE';
  const isZero = hours === 0;

  // The value last typed (and validated) into the field, kept in a ref
  // rather than state: NumberInput calls onChange and onEnter back-to-back
  // inside the same keydown handler on Enter, so a state read in the Enter
  // handler would still see the stale pre-keystroke render.
  const lastValidRef = useRef(hours);
  // Remounting the NumberInput (via `key`) is how its own internal
  // "pendingInput" buffer — private state this component has no other way
  // to reach — gets cleared on Escape, so the field visibly snaps back to
  // the calculated value instead of keeping the rejected keystrokes.
  const [resetKey, setResetKey] = useState(0);
  const [isFocused, setIsFocused] = useState(false);

  useEffect(() => {
    lastValidRef.current = hours;
  }, [hours, resetKey]);

  if (isLeave) {
    return (
      <TableCell className="tabular" style={{ textAlign: 'right' }}>
        <Text type="body" color={isZero ? 'disabled' : undefined}>
          {formatHoursCell(hours)}
        </Text>
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
    lastValidRef.current = hours;
    setResetKey((count) => count + 1);
    setIsFocused(false);
    onRevert();
  };

  const label = `${otlProjectCode} hours for ${personId}, ${date}`;

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
          <Tooltip content={LOCK_TOOLTIP}>
            <Icon icon={LockGlyph} label={LOCK_TOOLTIP} size="xsm" color="accent" />
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
            value={hours}
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
