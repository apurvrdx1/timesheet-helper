/**
 * One person's week, serialised for export (spec §9). Two formats, because
 * the two destinations want different things:
 *
 * - `toHtmlTable` for the clipboard, so the week arrives in email or Slack as
 *   a real table with the four OTL identifier columns intact — the daily
 *   path, where someone reads it and types the figures into the corporate
 *   system.
 * - `toCsv` for a downloaded file opened in a spreadsheet.
 *
 * **The zero rule differs between them, deliberately.** In the HTML table a
 * zero is an em-dash, matching `formatHoursCell` and therefore the
 * `PersonWeekView` it was copied from. In the CSV a zero is an EMPTY cell:
 * an em-dash in a CSV is *text* to a spreadsheet, not a number, so a single
 * one silently breaks every formula in its column.
 *
 * `formatHoursCell` is imported rather than re-implemented so the pasted
 * table and the screen can never drift apart. That is the one place this
 * storage module reaches into `ui/` — the formatting rule genuinely lives
 * there (DESIGN.md §2.2) and duplicating it is the worse trade.
 */
import { formatHoursCell } from './format';

/** One OTL across one Monday–Friday week. Every numeric field is hours. */
export interface ExportRow {
  projectCode: string;
  taskCode: string;
  expenditureTypeCode: string;
  timeReportingCode: string;
  mon: number;
  tue: number;
  wed: number;
  thu: number;
  fri: number;
  total: number;
}

const HEADERS = [
  'Project', 'Task', 'Expenditure type', 'Time reporting code',
  'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Total',
] as const;

function identifiers(row: ExportRow): string[] {
  return [row.projectCode, row.taskCode, row.expenditureTypeCode, row.timeReportingCode];
}

function hours(row: ExportRow): number[] {
  return [row.mon, row.tue, row.wed, row.thu, row.fri, row.total];
}

/**
 * RFC 4180 §2: a field is quoted when it contains the delimiter, a double
 * quote, CR or LF, and an embedded double quote is doubled. Without this an
 * OTL code containing a comma shifts every column to its right — a failure
 * that is invisible, because the file still opens cleanly.
 */
function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Zero is an empty cell here; see the module comment. */
function csvHours(value: number): string {
  return value === 0 ? '' : value.toFixed(1);
}

export function toCsv(rows: ExportRow[]): string {
  const body = rows.map((row) => [
    ...identifiers(row).map(csvField),
    ...hours(row).map(csvHours),
  ].join(','));
  return [HEADERS.join(','), ...body].join('\r\n');
}

/** Text placed in an HTML clipboard flavour is markup; an unescaped `<` or
 * `&` in an OTL code would break the table rather than appear in it. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function toHtmlTable(rows: ExportRow[]): string {
  const head = HEADERS.map((header) => `<th>${escapeHtml(header)}</th>`).join('');
  const body = rows.map((row) => {
    const cells = [
      ...identifiers(row).map((value) => escapeHtml(value)),
      // Zero is an em-dash here — the opposite of the CSV rule, on purpose.
      ...hours(row).map(formatHoursCell),
    ];
    return `<tr>${cells.map((cell) => `<td>${cell}</td>`).join('')}</tr>`;
  }).join('');
  return `<table border="1" cellspacing="0" cellpadding="4">`
    + `<thead><tr>${head}</tr></thead>`
    + `<tbody>${body}</tbody>`
    + `</table>`;
}
