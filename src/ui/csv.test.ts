import { describe, it, expect } from 'vitest';
import { toCsv, toHtmlTable, type ExportRow } from './csv';

const row = (over: Partial<ExportRow> = {}): ExportRow => ({
  projectCode: 'OPEX-ADMIN',
  taskCode: 'T0',
  expenditureTypeCode: 'E0',
  timeReportingCode: 'R0',
  mon: 7.5, tue: 7.5, wed: 7.5, thu: 7.5, fri: 7.5, total: 37.5,
  ...over,
});

const lines = (csv: string): string[] => csv.split('\r\n');

describe('toCsv', () => {
  it('heads the four identifier columns, Mon–Fri and a total', () => {
    const [header] = lines(toCsv([row()]));
    expect(header).toBe('Project,Task,Expenditure type,Time reporting code,Mon,Tue,Wed,Thu,Fri,Total');
  });

  it('writes one row per OTL, one decimal place throughout', () => {
    const csv = lines(toCsv([row({ mon: 4, total: 34 })]));
    expect(csv[1]).toBe('OPEX-ADMIN,T0,E0,R0,4.0,7.5,7.5,7.5,7.5,34.0');
  });

  it('separates rows with CRLF and does not end on a blank line', () => {
    const csv = toCsv([row(), row({ projectCode: 'CAPEX-1' })]);
    expect(csv.endsWith('\r\n')).toBe(false);
    expect(lines(csv)).toHaveLength(3);
  });

  it('is a header on its own when there is nothing to export', () => {
    expect(lines(toCsv([]))).toHaveLength(1);
  });

  // The failure this guards is silent: an unquoted comma shifts every column
  // to its right, so Friday's hours land under "Total" and the file still
  // opens cleanly.
  it('quotes a field containing a comma so the following columns do not shift', () => {
    const csv = lines(toCsv([row({ projectCode: 'OPEX,ADMIN' })]));
    expect(csv[1]).toBe('"OPEX,ADMIN",T0,E0,R0,7.5,7.5,7.5,7.5,7.5,37.5');
    expect(csv[1]?.split(',')).toHaveLength(11); // proof the naive split IS fooled…
    expect(csv[0]?.split(',')).toHaveLength(10); // …while the header is not.
  });

  it('doubles a double quote and wraps the field, per RFC 4180', () => {
    const csv = lines(toCsv([row({ taskCode: 'T"0' })]));
    expect(csv[1]).toBe('OPEX-ADMIN,"T""0",E0,R0,7.5,7.5,7.5,7.5,7.5,37.5');
  });

  it('quotes a field containing a newline', () => {
    const csv = toCsv([row({ expenditureTypeCode: 'E0\nE1' })]);
    expect(csv).toContain('"E0\nE1"');
  });

  // A6/A13: an em-dash in a CSV is TEXT to a spreadsheet, which breaks every
  // formula in the column. Zero is an empty cell here and an em-dash only in
  // the HTML table.
  it('leaves a zero cell empty rather than writing 0.0 or an em-dash', () => {
    const csv = lines(toCsv([row({ mon: 0, total: 30 })]));
    expect(csv[1]).toBe('OPEX-ADMIN,T0,E0,R0,,7.5,7.5,7.5,7.5,30.0');
    expect(csv[1]).not.toContain('—');
    expect(csv[1]?.split(',')[4]).toBe('');
  });

  it('exports a leave day as its own row alongside the working codes', () => {
    const csv = lines(toCsv([
      row({ mon: 0, total: 30 }),
      row({ projectCode: 'LEAVE-VAC', taskCode: 'TL', expenditureTypeCode: 'EL',
        timeReportingCode: 'RL', mon: 7.5, tue: 0, wed: 0, thu: 0, fri: 0, total: 7.5 }),
    ]));
    expect(csv[2]).toBe('LEAVE-VAC,TL,EL,RL,7.5,,,,,7.5');
  });
});

describe('toHtmlTable', () => {
  it('is a real table, not a wall of text', () => {
    const html = toHtmlTable([row()]);
    expect(html.startsWith('<table')).toBe(true);
    expect(html).toContain('<thead>');
    expect(html).toContain('<tbody>');
    expect(html).toContain('<th>Time reporting code</th>');
    expect(html.trimEnd().endsWith('</table>')).toBe(true);
  });

  it('renders one decimal place', () => {
    expect(toHtmlTable([row({ mon: 4 })])).toContain('<td>4.0</td>');
  });

  // The other half of the split rule: here a zero IS an em-dash, matching
  // formatHoursCell and therefore PersonWeekView on screen.
  it('renders a zero as an em-dash, matching the view it is copied from', () => {
    const html = toHtmlTable([row({ mon: 0 })]);
    expect(html).toContain('<td>—</td>');
    expect(html).not.toContain('<td>0.0</td>');
  });

  it('escapes markup in an identifier so a stray angle bracket cannot break the table', () => {
    const html = toHtmlTable([row({ projectCode: 'A&B<script>"x"' })]);
    expect(html).toContain('A&amp;B&lt;script&gt;&quot;x&quot;');
    expect(html).not.toContain('<script>');
  });

  it('emits a header-only table when there is nothing to export', () => {
    const html = toHtmlTable([]);
    expect(html).toContain('<tbody></tbody>');
  });

  it('includes a leave row', () => {
    const html = toHtmlTable([row({ projectCode: 'LEAVE-VAC', tue: 0, wed: 0, thu: 0, fri: 0, total: 7.5 })]);
    expect(html).toContain('<td>LEAVE-VAC</td>');
    expect(html).toContain('<td>7.5</td>');
  });
});
