/**
 * The "add leave" form: a whole date range, for one person, on one LEAVE
 * OTL (its subtype — Vacation/Stat/Personal/Sick — is a property of the
 * OTL itself, per src/domain/types.ts, so picking the OTL IS picking the
 * subtype). Submitting only reports the range upward via `onSubmit`; it
 * does not touch the model itself — WeeksPage owns turning a `LeaveRange`
 * into the day-by-day zeroing described in DESIGN.md (leave claims the
 * whole day, so every other code on that day is cleared by the schedule
 * recompute, not by this dialog).
 */
import { useState } from 'react';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { Layout, LayoutContent, LayoutFooter } from '@astryxdesign/core/Layout';
import { FormLayout } from '@astryxdesign/core/FormLayout';
import { Selector } from '@astryxdesign/core/Selector';
import { DateRangeInput, type DateRange } from '@astryxdesign/core/DateRangeInput';
import { Button } from '@astryxdesign/core/Button';
import type { LeaveRange, Otl, OtlCode, Person, PersonId } from '../../domain/types';

export interface LeaveDialogProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  people: Person[];
  /** OTLs whose category is 'LEAVE' — one option per leave subtype. */
  leaveOtls: Otl[];
  onSubmit: (leave: LeaveRange) => void;
}

export function LeaveDialog({ isOpen, onOpenChange, people, leaveOtls, onSubmit }: LeaveDialogProps) {
  const [personId, setPersonId] = useState<PersonId | null>(null);
  const [range, setRange] = useState<DateRange | null>(null);
  const [otlProjectCode, setOtlProjectCode] = useState<OtlCode | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const reset = (): void => {
    setPersonId(null);
    setRange(null);
    setOtlProjectCode(null);
    setProblem(null);
  };

  const close = (): void => {
    reset();
    onOpenChange(false);
  };

  const handleSubmit = (): void => {
    if (!personId || !range || !otlProjectCode) {
      setProblem('Choose a person, a date range, and a leave type.');
      return;
    }
    onSubmit({
      personId, startDate: range.start, endDate: range.end, otlProjectCode,
    });
    close();
  };

  return (
    <Dialog isOpen={isOpen} onOpenChange={(open) => (open ? onOpenChange(true) : close())} purpose="form" width={480}>
      <Layout
        header={<DialogHeader title="Add leave" onOpenChange={(open) => (open ? onOpenChange(true) : close())} />}
        content={
          <LayoutContent>
            <FormLayout>
              <Selector
                label="Person"
                options={people.map((person) => ({ value: person.id, label: person.name }))}
                value={personId ?? undefined}
                placeholder="Choose a person"
                onChange={(value) => setPersonId(value)}
              />
              <DateRangeInput
                label="Date range"
                value={range}
                onChange={setRange}
              />
              <Selector
                label="Leave type"
                options={leaveOtls.map((otl) => ({ value: otl.projectCode, label: otl.leaveSubtype ?? otl.projectCode }))}
                value={otlProjectCode ?? undefined}
                placeholder="Choose a leave type"
                onChange={(value) => setOtlProjectCode(value)}
                status={problem ? { type: 'error', message: problem } : undefined}
              />
            </FormLayout>
          </LayoutContent>
        }
        footer={
          <LayoutFooter hasDivider>
            <Button label="Add leave" variant="primary" onClick={handleSubmit} />
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}
