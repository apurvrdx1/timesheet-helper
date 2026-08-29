/**
 * The export control that sits beside `PersonWeekView` (spec §9): one
 * `DropdownMenu` — DESIGN.md §3 "Selector for a bounded set, DropdownMenu
 * for actions", secondary variant, since Export is explicitly listed there
 * as a secondary button — offering the two ways a week leaves the app.
 *
 * "Copy as table" writes BOTH `text/html` and `text/plain` to the clipboard,
 * so the week arrives in email or Slack as a real table with the four OTL
 * identifier columns intact and still degrades to something readable
 * wherever HTML flavours are dropped. "Download CSV" saves
 * `<person>-<monday>.csv` for a spreadsheet.
 *
 * It takes exactly the props `PersonWeekView` takes, so the caller feeds
 * both from one expression and the two can never disagree about which week
 * is on screen.
 */
import { useState } from 'react';
import { HStack } from '@astryxdesign/core/HStack';
import { Text } from '@astryxdesign/core/Text';
import { DropdownMenu } from '@astryxdesign/core/DropdownMenu';
import { blocksToHours } from '../../domain/blocks';
import { weekDays } from '../../domain/calendar';
import { toCsv, toHtmlTable, type ExportRow } from '../csv';
import type { IsoDate, Otl, ScheduleEntry } from '../../domain/types';

export interface ExportMenuProps {
  personName: string;
  /** The Monday that starts the week being exported. */
  monday: IsoDate;
  /** This person's schedule entries — already filtered by the caller. */
  entries: ScheduleEntry[];
  otls: Otl[];
}

/** Placeholder for an identifier whose OTL is no longer in setup — the same
 * em-dash `PersonWeekView` shows, so the export matches what was on screen.
 * It only ever lands in a text column, never a numeric one. */
const UNKNOWN = '—';

/**
 * The rows for one person-week, in the same order `PersonWeekView` lists
 * them (project code, ascending). An entry whose OTL is missing from `otls`
 * still exports its hours — only the identifier columns fall back.
 */
export function exportRows(entries: ScheduleEntry[], otls: Otl[], monday: IsoDate): ExportRow[] {
  const dates = weekDays(monday);
  const inWeek = entries.filter((entry) => dates.includes(entry.date));
  const codes = [...new Set(inWeek.map((entry) => entry.otlProjectCode))].sort();
  return codes.map((code) => {
    const otl = otls.find((candidate) => candidate.projectCode === code);
    const hoursOn = (date: IsoDate): number => inWeek
      .filter((entry) => entry.date === date && entry.otlProjectCode === code)
      .reduce((sum, entry) => sum + blocksToHours(entry.blocks), 0);
    const [mon = 0, tue = 0, wed = 0, thu = 0, fri = 0] = dates.map(hoursOn);
    return {
      projectCode: code,
      taskCode: otl ? otl.taskCode : UNKNOWN,
      expenditureTypeCode: otl ? otl.expenditureTypeCode : UNKNOWN,
      timeReportingCode: otl ? otl.timeReportingCode : UNKNOWN,
      mon, tue, wed, thu, fri,
      total: mon + tue + wed + thu + fri,
    };
  });
}

/** A filename, not a display name: whitespace and anything a filesystem or a
 * `Content-Disposition` header would argue about becomes a hyphen. */
function fileNameFor(personName: string, monday: IsoDate): string {
  const person = personName.trim().replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `${person || 'person'}-${monday}.csv`;
}

async function writeToClipboard(html: string, text: string): Promise<void> {
  // `ClipboardItem` is absent in older Safari and in jsdom. Falling back to
  // writeText keeps the action working — the paste is plain, not broken.
  if (typeof ClipboardItem === 'undefined') {
    await navigator.clipboard.writeText(text);
    return;
  }
  await navigator.clipboard.write([
    new ClipboardItem({
      'text/html': new Blob([html], { type: 'text/html' }),
      'text/plain': new Blob([text], { type: 'text/plain' }),
    }),
  ]);
}

/**
 * Two details here are load-bearing in Firefox and are the usual reason a
 * download "does nothing": the anchor must be IN the document when it is
 * clicked (a synthetic click on a detached node is ignored), and the object
 * URL must not be revoked in the same tick — the download reads it
 * asynchronously, so revoking immediately can cancel it. Deferring the
 * revoke by a tick still frees the blob; leaving it un-revoked would leak
 * the whole file until the tab closes.
 */
function downloadCsv(csv: string, fileName: string): void {
  // A BOM-free UTF-8 file; `text/csv` is what a spreadsheet expects.
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function ExportMenu({ personName, monday, entries, otls }: ExportMenuProps) {
  const [status, setStatus] = useState<string | null>(null);

  const rows = exportRows(entries, otls, monday);

  const copyAsTable = () => {
    setStatus(null);
    void writeToClipboard(toHtmlTable(rows), toCsv(rows))
      .then(() => setStatus('Copied — paste it into your email or timesheet.'))
      .catch((error: unknown) => setStatus(
        // DESIGN.md §4: say what happened and what to do next, and never
        // swallow the reason — a clipboard refusal is usually a permission.
        `Could not copy: ${error instanceof Error ? error.message : String(error)}. `
        + 'Download the CSV instead.',
      ));
  };

  const download = () => {
    setStatus(null);
    try {
      downloadCsv(toCsv(rows), fileNameFor(personName, monday));
    } catch (error: unknown) {
      setStatus(`Could not download: ${error instanceof Error ? error.message : String(error)}.`);
    }
  };

  return (
    <HStack gap={3} vAlign="center">
      {status !== null && (
        <Text type="supporting" color="secondary" aria-live="polite">{status}</Text>
      )}
      <DropdownMenu
        button={{ label: 'Export', variant: 'secondary' }}
        items={[
          { id: 'copy', label: 'Copy as table', onClick: copyAsTable },
          { id: 'csv', label: 'Download CSV', onClick: download },
        ]}
      />
    </HStack>
  );
}
