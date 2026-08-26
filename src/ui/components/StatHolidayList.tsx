/**
 * The dated stat-holiday list. Each entry names a date, a label, and the
 * LEAVE/STAT OTL it books hours against — the `Selector` here is
 * deliberately restricted to OTLs with `category: 'LEAVE'` and
 * `leaveSubtype: 'STAT'`, since a stat holiday cannot point at anything
 * else.
 */
import { useState } from 'react';
import { DateInput } from '@astryxdesign/core/DateInput';
import { TextInput } from '@astryxdesign/core/TextInput';
import { Selector } from '@astryxdesign/core/Selector';
import { Button } from '@astryxdesign/core/Button';
import { IconButton } from '@astryxdesign/core/IconButton';
import { Icon } from '@astryxdesign/core/Icon';
import { List, ListItem } from '@astryxdesign/core/List';
import { HStack } from '@astryxdesign/core/HStack';
import { Text } from '@astryxdesign/core/Text';
// `DateInput` speaks a template-literal `ISODateString`, stricter than the
// domain's plain `IsoDate = string`. Holding the draft in that stricter type
// lets it flow into `StatHoliday.date` (a `string`) with no cast needed, and
// keeps DateInput's own value/onChange contract exact.
import type { ISODateString } from '@astryxdesign/core/utils';
import type { IsoDate, Otl, StatHoliday } from '../../domain/types';

export interface StatHolidayListProps {
  statHolidays: StatHoliday[];
  otls: Otl[];
  onAdd: (statHoliday: StatHoliday) => void;
  onDelete: (date: IsoDate, otlProjectCode: string) => void;
}

export function StatHolidayList({ statHolidays, otls, onAdd, onDelete }: StatHolidayListProps) {
  const leaveOtls = otls.filter((otl) => otl.category === 'LEAVE' && otl.leaveSubtype === 'STAT');

  const [date, setDate] = useState<ISODateString | undefined>(undefined);
  const [name, setName] = useState('');
  const [otlProjectCode, setOtlProjectCode] = useState<string | undefined>(undefined);

  const canAdd = date !== undefined && name.trim().length > 0 && otlProjectCode !== undefined;

  const handleAdd = (): void => {
    if (!canAdd || date === undefined || otlProjectCode === undefined) return;
    onAdd({ date, name: name.trim(), otlProjectCode });
    setDate(undefined);
    setName('');
    setOtlProjectCode(undefined);
  };

  return (
    <>
      <HStack gap={4} vAlign="end">
        <DateInput label="Date" value={date} onChange={setDate} />
        <TextInput label="Name" value={name} onChange={setName} />
        <Selector
          label="OTL"
          options={leaveOtls.map((otl) => ({ value: otl.projectCode, label: otl.projectCode }))}
          value={otlProjectCode}
          placeholder="Choose a stat OTL"
          onChange={setOtlProjectCode}
          disabledMessage={leaveOtls.length === 0 ? 'Add a leave/stat OTL first.' : undefined}
          isDisabled={leaveOtls.length === 0}
        />
        <Button label="Add stat holiday" variant="secondary" onClick={handleAdd} isDisabled={!canAdd} />
      </HStack>
      {statHolidays.length > 0 ? (
        <List>
          {statHolidays.map((holiday) => (
            <ListItem
              key={`${holiday.date}-${holiday.otlProjectCode}`}
              label={`${holiday.date} — ${holiday.name}`}
              description={holiday.otlProjectCode}
              endContent={
                <IconButton
                  label={`Delete ${holiday.name}`}
                  tooltip="Delete"
                  icon={<Icon icon="close" />}
                  variant="ghost"
                  onClick={() => onDelete(holiday.date, holiday.otlProjectCode)}
                />
              }
            />
          ))}
        </List>
      ) : (
        <Text color="secondary">Add your first stat holiday to track it against a leave OTL.</Text>
      )}
    </>
  );
}
