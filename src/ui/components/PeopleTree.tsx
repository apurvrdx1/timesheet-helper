/**
 * The manager-and-reports tree. Exactly one manager per instance: "Add
 * manager" appears only while none exists, and once one does, "Add report"
 * takes its place — a report can only ever be created underneath the
 * manager, there is no standalone "add report" path. Deleting a person with
 * hours booked against them is confirmed with an `AlertDialog` first.
 */
import { useState } from 'react';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { Layout, LayoutContent, LayoutFooter } from '@astryxdesign/core/Layout';
import { FormLayout } from '@astryxdesign/core/FormLayout';
import { TextInput } from '@astryxdesign/core/TextInput';
import { Button } from '@astryxdesign/core/Button';
import { IconButton } from '@astryxdesign/core/IconButton';
import { Icon } from '@astryxdesign/core/Icon';
import { List, ListItem } from '@astryxdesign/core/List';
import { AlertDialog } from '@astryxdesign/core/AlertDialog';
import { Heading } from '@astryxdesign/core/Heading';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import type { Person } from '../../domain/types';

export interface PeopleTreeProps {
  people: Person[];
  /** Whether hours are booked against this person (allocations, leave, or overrides). */
  hasHours: (personId: string) => boolean;
  onAdd: (person: Person) => void;
  onDelete: (personId: string) => void;
}

function newId(): string {
  return `p-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
}

export function PeopleTree({ people, hasHours, onAdd, onDelete }: PeopleTreeProps) {
  const manager = people.find((person) => person.role === 'MANAGER') ?? null;
  const reports = people.filter((person) => person.role === 'REPORT');

  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [dialogRole, setDialogRole] = useState<'MANAGER' | 'REPORT'>('MANAGER');
  const [name, setName] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<Person | null>(null);

  const openAddManager = (): void => {
    setDialogRole('MANAGER');
    setName('');
    setIsDialogOpen(true);
  };

  const openAddReport = (): void => {
    setDialogRole('REPORT');
    setName('');
    setIsDialogOpen(true);
  };

  const handleSave = (): void => {
    const trimmed = name.trim();
    if (trimmed.length === 0) return;
    onAdd({
      id: newId(),
      name: trimmed,
      role: dialogRole,
      managerId: dialogRole === 'REPORT' ? (manager?.id ?? null) : null,
    });
    setIsDialogOpen(false);
  };

  const requestDelete = (person: Person): void => {
    if (hasHours(person.id)) {
      setDeleteTarget(person);
    } else {
      onDelete(person.id);
    }
  };

  return (
    <VStack gap={4}>
      <Heading level={2}>Manager</Heading>
      {manager ? (
        <List>
          <ListItem
            label={manager.name}
            endContent={
              <IconButton
                label={`Delete ${manager.name}`}
                tooltip="Delete"
                icon={<Icon icon="close" />}
                variant="ghost"
                onClick={() => requestDelete(manager)}
              />
            }
          />
        </List>
      ) : (
        <Text color="secondary">Add a manager to start building the team.</Text>
      )}
      {manager === null && <Button label="Add manager" variant="secondary" onClick={openAddManager} />}

      <Heading level={2}>Reports</Heading>
      {reports.length > 0 ? (
        <List>
          {reports.map((report) => (
            <ListItem
              key={report.id}
              label={report.name}
              endContent={
                <IconButton
                  label={`Delete ${report.name}`}
                  tooltip="Delete"
                  icon={<Icon icon="close" />}
                  variant="ghost"
                  onClick={() => requestDelete(report)}
                />
              }
            />
          ))}
        </List>
      ) : (
        <Text color="secondary">
          {manager ? 'Add a report to start allocating their hours.' : 'Add a manager first.'}
        </Text>
      )}
      {manager !== null && <Button label="Add report" variant="secondary" onClick={openAddReport} />}

      <Dialog isOpen={isDialogOpen} onOpenChange={setIsDialogOpen} purpose="form" width={400}>
        <Layout
          header={
            <DialogHeader
              title={dialogRole === 'MANAGER' ? 'Add manager' : 'Add report'}
              onOpenChange={setIsDialogOpen}
            />
          }
          content={
            <LayoutContent>
              <FormLayout>
                <TextInput label="Name" value={name} onChange={setName} />
              </FormLayout>
            </LayoutContent>
          }
          footer={
            <LayoutFooter hasDivider>
              <Button label="Save" variant="primary" onClick={handleSave} />
            </LayoutFooter>
          }
        />
      </Dialog>

      <AlertDialog
        isOpen={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title={deleteTarget ? `Delete ${deleteTarget.name}` : ''}
        description={
          deleteTarget
            ? `${deleteTarget.name} has hours booked against them. Deleting them removes those hours from the schedule.`
            : ''
        }
        actionLabel="Delete"
        onAction={() => {
          if (deleteTarget) onDelete(deleteTarget.id);
          setDeleteTarget(null);
        }}
      />
    </VStack>
  );
}
