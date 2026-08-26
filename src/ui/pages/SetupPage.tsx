/**
 * The Setup page: cost-centre codes (OTLs), the manager-and-reports team,
 * and the dated stat-holiday list. Everything else in the app depends on
 * this data being right, so every mutation here goes through `update`,
 * which always builds a new `Model` rather than mutating the one it was
 * given (see each `with*` helper below).
 */
import { VStack } from '@astryxdesign/core/VStack';
import { Section } from '@astryxdesign/core/Section';
import { Heading } from '@astryxdesign/core/Heading';
import { OtlTable } from '../components/OtlTable';
import { PeopleTree } from '../components/PeopleTree';
import { StatHolidayList } from '../components/StatHolidayList';
import type { IsoDate, Model, Otl, Person, StatHoliday } from '../../domain/types';

export interface SetupPageProps {
  model: Model;
  update: (fn: (model: Model) => Model) => void;
}

/** Whether any hours are booked against an OTL: an allocation with nonzero
 * hours, an override with nonzero hours, or a leave range naming it. */
function otlHasHours(model: Model, projectCode: string): boolean {
  return (
    model.allocations.some((a) => a.otlProjectCode === projectCode && a.hours > 0) ||
    model.overrides.some((o) => o.otlProjectCode === projectCode && o.hours > 0) ||
    model.leave.some((l) => l.otlProjectCode === projectCode)
  );
}

/** Whether any hours are booked against a person: an allocation or override
 * naming them with nonzero hours, or a leave range naming them. */
function personHasHours(model: Model, personId: string): boolean {
  return (
    model.allocations.some((a) => a.personId === personId && a.hours > 0) ||
    model.overrides.some((o) => o.personId === personId && o.hours > 0) ||
    model.leave.some((l) => l.personId === personId)
  );
}

export function SetupPage({ model, update }: SetupPageProps) {
  const addOtl = (otl: Otl): void => {
    update((current) => ({ ...current, otls: [...current.otls, otl] }));
  };

  const updateOtl = (otl: Otl): void => {
    update((current) => ({
      ...current,
      otls: current.otls.map((existing) => (existing.projectCode === otl.projectCode ? otl : existing)),
    }));
  };

  const deleteOtl = (projectCode: string): void => {
    update((current) => ({
      ...current,
      otls: current.otls.filter((existing) => existing.projectCode !== projectCode),
    }));
  };

  const addPerson = (person: Person): void => {
    update((current) => ({ ...current, people: [...current.people, person] }));
  };

  const deletePerson = (personId: string): void => {
    update((current) => ({
      ...current,
      // Deleting a manager takes their reports with them: a report cannot
      // exist without the manager it was created under.
      people: current.people.filter(
        (person) => person.id !== personId && person.managerId !== personId,
      ),
    }));
  };

  const addStatHoliday = (statHoliday: StatHoliday): void => {
    update((current) => ({ ...current, statHolidays: [...current.statHolidays, statHoliday] }));
  };

  const deleteStatHoliday = (date: IsoDate, otlProjectCode: string): void => {
    update((current) => ({
      ...current,
      statHolidays: current.statHolidays.filter(
        (holiday) => !(holiday.date === date && holiday.otlProjectCode === otlProjectCode),
      ),
    }));
  };

  return (
    <VStack gap={8}>
      <Section variant="section">
        <VStack gap={4}>
          <Heading level={2}>Cost-centre codes</Heading>
          <OtlTable
            otls={model.otls}
            hasHours={(projectCode) => otlHasHours(model, projectCode)}
            onAdd={addOtl}
            onUpdate={updateOtl}
            onDelete={deleteOtl}
          />
        </VStack>
      </Section>

      <Section variant="section">
        <VStack gap={4}>
          <Heading level={2}>Team</Heading>
          <PeopleTree
            people={model.people}
            hasHours={(personId) => personHasHours(model, personId)}
            onAdd={addPerson}
            onDelete={deletePerson}
          />
        </VStack>
      </Section>

      <Section variant="section">
        <VStack gap={4}>
          <Heading level={2}>Stat holidays</Heading>
          <StatHolidayList
            statHolidays={model.statHolidays}
            otls={model.otls}
            onAdd={addStatHoliday}
            onDelete={deleteStatHoliday}
          />
        </VStack>
      </Section>
    </VStack>
  );
}
