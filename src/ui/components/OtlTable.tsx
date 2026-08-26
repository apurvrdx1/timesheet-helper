/**
 * The OTL (cost-centre code) table. An OTL is identified by its project code
 * (the primary key) plus three companion codes; it also carries a category
 * (CAPEX / OPEX / LEAVE), an optional leave subtype, the single default-OPEX
 * flag, and a `colorIndex` that is assigned once on creation and never
 * touched again (DESIGN.md §2.1 — a code keeps its color for its whole
 * life). Add/edit happens in a `Dialog`; deleting a row with hours booked
 * against it is confirmed with an `AlertDialog` first.
 */
import { useState } from 'react';
import { Table, TableHeader, TableBody, TableRow, TableCell, TableHeaderCell } from '@astryxdesign/core/Table';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { Layout, LayoutContent, LayoutFooter } from '@astryxdesign/core/Layout';
import { FormLayout } from '@astryxdesign/core/FormLayout';
import { TextInput } from '@astryxdesign/core/TextInput';
import { Selector } from '@astryxdesign/core/Selector';
import { Button } from '@astryxdesign/core/Button';
import { IconButton } from '@astryxdesign/core/IconButton';
import { Icon } from '@astryxdesign/core/Icon';
import { Badge } from '@astryxdesign/core/Badge';
import { AlertDialog } from '@astryxdesign/core/AlertDialog';
import { Text } from '@astryxdesign/core/Text';
import { Code } from '@astryxdesign/core/Code';
import type { LeaveSubtype, Otl, OtlCategory } from '../../domain/types';

export interface OtlTableProps {
  otls: Otl[];
  /** Whether hours are booked against this project code (allocations, leave, or overrides). */
  hasHours: (projectCode: string) => boolean;
  onAdd: (otl: Otl) => void;
  onUpdate: (otl: Otl) => void;
  onDelete: (projectCode: string) => void;
}

// `Selector`'s `options` prop wants a mutable array, so these stay plain
// arrays rather than `ReadonlyArray` even though neither is ever mutated.
const CATEGORY_OPTIONS: Array<{ value: OtlCategory; label: string }> = [
  { value: 'CAPEX', label: 'CAPEX' },
  { value: 'OPEX', label: 'OPEX' },
  { value: 'LEAVE', label: 'LEAVE' },
];

const SUBTYPE_OPTIONS: Array<{ value: LeaveSubtype; label: string }> = [
  { value: 'VACATION', label: 'Vacation' },
  { value: 'STAT', label: 'Stat' },
  { value: 'PERSONAL', label: 'Personal' },
  { value: 'SICK', label: 'Sick' },
];

interface Draft {
  projectCode: string;
  taskCode: string;
  expenditureTypeCode: string;
  timeReportingCode: string;
  category: OtlCategory;
  leaveSubtype: LeaveSubtype | null;
}

function emptyDraft(): Draft {
  return {
    projectCode: '',
    taskCode: '',
    expenditureTypeCode: '',
    timeReportingCode: '',
    category: 'CAPEX',
    leaveSubtype: null,
  };
}

function draftFromOtl(otl: Otl): Draft {
  return {
    projectCode: otl.projectCode,
    taskCode: otl.taskCode,
    expenditureTypeCode: otl.expenditureTypeCode,
    timeReportingCode: otl.timeReportingCode,
    category: otl.category,
    leaveSubtype: otl.leaveSubtype,
  };
}

/** Assigned once, on creation, from the count of CAPEX OTLs that already
 * exist — never recomputed for an existing OTL (DESIGN.md §2.1). */
function nextColorIndex(existing: Otl[]): number {
  const capexCount = existing.filter((otl) => otl.category === 'CAPEX').length;
  return capexCount % 10;
}

export function OtlTable({ otls, hasHours, onAdd, onUpdate, onDelete }: OtlTableProps) {
  const [editingCode, setEditingCode] = useState<string | null>(null);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(emptyDraft());
  const [projectCodeProblem, setProjectCodeProblem] = useState<string | null>(null);
  const [subtypeProblem, setSubtypeProblem] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  const isEditing = editingCode !== null;

  const openAdd = (): void => {
    setEditingCode(null);
    setDraft(emptyDraft());
    setProjectCodeProblem(null);
    setSubtypeProblem(null);
    setIsDialogOpen(true);
  };

  const openEdit = (otl: Otl): void => {
    setEditingCode(otl.projectCode);
    setDraft(draftFromOtl(otl));
    setProjectCodeProblem(null);
    setSubtypeProblem(null);
    setIsDialogOpen(true);
  };

  const validateProjectCode = (value: string): string | null => {
    const trimmed = value.trim();
    if (trimmed.length === 0) return null;
    const duplicate = otls.some(
      (otl) => otl.projectCode === trimmed && otl.projectCode !== editingCode,
    );
    return duplicate ? `Project code ${trimmed} already exists.` : null;
  };

  const handleProjectCodeChange = (value: string): void => {
    setDraft((previous) => ({ ...previous, projectCode: value }));
    setProjectCodeProblem(validateProjectCode(value));
  };

  const handleCategoryChange = (value: string): void => {
    const category = value as OtlCategory;
    setDraft((previous) => ({
      ...previous,
      category,
      leaveSubtype: category === 'LEAVE' ? previous.leaveSubtype : null,
    }));
    if (category !== 'LEAVE') setSubtypeProblem(null);
  };

  const handleSave = (): void => {
    const codeProblem = validateProjectCode(draft.projectCode);
    setProjectCodeProblem(codeProblem);
    if (codeProblem) return;

    if (draft.category === 'LEAVE' && draft.leaveSubtype === null) {
      setSubtypeProblem('A leave OTL needs a subtype.');
      return;
    }

    if (isEditing) {
      const original = otls.find((otl) => otl.projectCode === editingCode);
      if (!original) return;
      onUpdate({
        ...original,
        projectCode: draft.projectCode,
        taskCode: draft.taskCode,
        expenditureTypeCode: draft.expenditureTypeCode,
        timeReportingCode: draft.timeReportingCode,
        category: draft.category,
        leaveSubtype: draft.category === 'LEAVE' ? draft.leaveSubtype : null,
      });
    } else {
      onAdd({
        projectCode: draft.projectCode,
        taskCode: draft.taskCode,
        expenditureTypeCode: draft.expenditureTypeCode,
        timeReportingCode: draft.timeReportingCode,
        category: draft.category,
        leaveSubtype: draft.category === 'LEAVE' ? draft.leaveSubtype : null,
        isDefaultOpex: false,
        colorIndex: nextColorIndex(otls),
        active: true,
      });
    }
    setIsDialogOpen(false);
  };

  const handleDefaultOpexChange = (projectCode: string): void => {
    for (const otl of otls) {
      if (otl.category !== 'OPEX') continue;
      const shouldBeDefault = otl.projectCode === projectCode;
      if (otl.isDefaultOpex !== shouldBeDefault) {
        onUpdate({ ...otl, isDefaultOpex: shouldBeDefault });
      }
    }
  };

  const requestDelete = (projectCode: string): void => {
    if (hasHours(projectCode)) {
      setDeleteTarget(projectCode);
    } else {
      onDelete(projectCode);
    }
  };

  return (
    <>
      <Button label="Add OTL" variant="secondary" onClick={openAdd} />
      <Table<Record<string, unknown>>>
        <TableHeader>
          <TableRow>
            <TableHeaderCell scope="col">Project code</TableHeaderCell>
            <TableHeaderCell scope="col">Task code</TableHeaderCell>
            <TableHeaderCell scope="col">Expenditure type code</TableHeaderCell>
            <TableHeaderCell scope="col">Time reporting code</TableHeaderCell>
            <TableHeaderCell scope="col">Category</TableHeaderCell>
            <TableHeaderCell scope="col">Leave subtype</TableHeaderCell>
            <TableHeaderCell scope="col">Default OPEX</TableHeaderCell>
            <TableHeaderCell scope="col">Actions</TableHeaderCell>
          </TableRow>
        </TableHeader>
        <TableBody>
          {otls.map((otl) => (
            <TableRow key={otl.projectCode}>
              <TableCell>
                <Code>{otl.projectCode}</Code>
              </TableCell>
              <TableCell>
                <Code>{otl.taskCode}</Code>
              </TableCell>
              <TableCell>
                <Code>{otl.expenditureTypeCode}</Code>
              </TableCell>
              <TableCell>
                <Code>{otl.timeReportingCode}</Code>
              </TableCell>
              <TableCell>
                <Badge label={otl.category} />
              </TableCell>
              <TableCell>
                {otl.leaveSubtype ? <Badge label={otl.leaveSubtype} /> : <Text color="disabled">—</Text>}
              </TableCell>
              <TableCell>
                {otl.category === 'OPEX' && (
                  // Astryx's RadioList owns a single wrapping `role="radiogroup"`
                  // div around all its items — it cannot straddle separate
                  // `<td>`s in different table rows without invalid/mismatched
                  // markup. A native radio input sharing one `name` is the
                  // minimal, accessible substitute for this one cross-row case;
                  // `accent-color` (below) is the only non-token styling in this
                  // file, added purely so it reads as an Astryx accent control.
                  <input
                    type="radio"
                    name="default-opex"
                    aria-label={`Default OPEX for ${otl.projectCode}`}
                    checked={otl.isDefaultOpex}
                    onChange={() => handleDefaultOpexChange(otl.projectCode)}
                    style={{ accentColor: 'var(--color-accent)' }}
                  />
                )}
              </TableCell>
              <TableCell>
                <Button label={`Edit ${otl.projectCode}`} variant="secondary" onClick={() => openEdit(otl)}>
                  Edit
                </Button>
                <IconButton
                  label={`Delete ${otl.projectCode}`}
                  tooltip="Delete"
                  icon={<Icon icon="close" />}
                  variant="ghost"
                  onClick={() => requestDelete(otl.projectCode)}
                />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <Dialog isOpen={isDialogOpen} onOpenChange={setIsDialogOpen} purpose="form" width={480}>
        <Layout
          header={
            <DialogHeader
              title={isEditing ? 'Edit OTL' : 'Add OTL'}
              onOpenChange={setIsDialogOpen}
            />
          }
          content={
            <LayoutContent>
              <FormLayout>
                <TextInput
                  label="Project code"
                  value={draft.projectCode}
                  onChange={handleProjectCodeChange}
                  status={projectCodeProblem ? { type: 'error', message: projectCodeProblem } : undefined}
                />
                <TextInput
                  label="Task code"
                  value={draft.taskCode}
                  onChange={(value) => setDraft((previous) => ({ ...previous, taskCode: value }))}
                />
                <TextInput
                  label="Expenditure type code"
                  value={draft.expenditureTypeCode}
                  onChange={(value) =>
                    setDraft((previous) => ({ ...previous, expenditureTypeCode: value }))
                  }
                />
                <TextInput
                  label="Time reporting code"
                  value={draft.timeReportingCode}
                  onChange={(value) =>
                    setDraft((previous) => ({ ...previous, timeReportingCode: value }))
                  }
                />
                <Selector
                  label="Category"
                  options={CATEGORY_OPTIONS}
                  value={draft.category}
                  onChange={handleCategoryChange}
                />
                {draft.category === 'LEAVE' && (
                  <Selector
                    label="Leave subtype"
                    options={SUBTYPE_OPTIONS}
                    value={draft.leaveSubtype ?? undefined}
                    placeholder="Choose a subtype"
                    onChange={(value) => {
                      setDraft((previous) => ({ ...previous, leaveSubtype: value as LeaveSubtype }));
                      setSubtypeProblem(null);
                    }}
                    status={subtypeProblem ? { type: 'error', message: subtypeProblem } : undefined}
                  />
                )}
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
        title={deleteTarget ? `Delete ${deleteTarget}` : ''}
        description={
          deleteTarget
            ? `${deleteTarget} has hours booked against it. Deleting it removes those hours from the schedule.`
            : ''
        }
        actionLabel="Delete"
        onAction={() => {
          if (deleteTarget) onDelete(deleteTarget);
          setDeleteTarget(null);
        }}
      />
    </>
  );
}
