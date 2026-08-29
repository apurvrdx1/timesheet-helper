import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ExportMenu, exportRows } from './ExportMenu';
import type { Otl, ScheduleEntry } from '../../domain/types';

const opex: Otl = {
  projectCode: 'OPEX-ADMIN', taskCode: 'T0', expenditureTypeCode: 'E0',
  timeReportingCode: 'R0', category: 'OPEX', leaveSubtype: null,
  isDefaultOpex: true, colorIndex: 0, active: true,
};
const leave: Otl = {
  projectCode: 'LEAVE-VAC', taskCode: 'TL', expenditureTypeCode: 'EL',
  timeReportingCode: 'RL', category: 'LEAVE', leaveSubtype: 'VACATION',
  isDefaultOpex: false, colorIndex: 1, active: true,
};

const MONDAY = '2026-09-07';
const entry = (date: string, code: string, blocks: number): ScheduleEntry => ({
  personId: 'p1', date, otlProjectCode: code, blocks, source: 'CALC', overrideBlocks: 0,
});

// Mon–Thu on the OPEX code, Friday off on leave.
const entries: ScheduleEntry[] = [
  entry('2026-09-07', 'OPEX-ADMIN', 15),
  entry('2026-09-08', 'OPEX-ADMIN', 15),
  entry('2026-09-09', 'OPEX-ADMIN', 15),
  entry('2026-09-10', 'OPEX-ADMIN', 15),
  entry('2026-09-11', 'LEAVE-VAC', 15),
];

// jsdom implements NEITHER of these. Without the stubs the component throws
// on click and the test fails somewhere far from the cause.
let written: unknown[] = [];
const clipboardWrite = vi.fn(async (items: unknown[]) => { written = items; });
const clipboardWriteText = vi.fn(async () => undefined);

class FakeClipboardItem {
  readonly flavours: Record<string, Blob>;
  constructor(flavours: Record<string, Blob>) {
    this.flavours = flavours;
  }
}

let clicked: HTMLAnchorElement | null = null;
let wasAttachedWhenClicked = false;

beforeEach(() => {
  written = [];
  clicked = null;
  wasAttachedWhenClicked = false;
  clipboardWrite.mockClear();
  clipboardWriteText.mockClear();
  vi.stubGlobal('ClipboardItem', FakeClipboardItem);
  Object.defineProperty(globalThis.navigator, 'clipboard', {
    value: { write: clipboardWrite, writeText: clipboardWriteText },
    configurable: true, writable: true,
  });
  URL.createObjectURL = vi.fn(() => 'blob:stub');
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function mocked(
    this: HTMLAnchorElement,
  ) {
    clicked = this;
    wasAttachedWhenClicked = document.body.contains(this);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderMenu(over: Partial<Parameters<typeof ExportMenu>[0]> = {}) {
  return render(
    <ExportMenu personName="Alex Kim" monday={MONDAY} entries={entries} otls={[opex, leave]} {...over} />,
  );
}

async function openAnd(label: RegExp) {
  await userEvent.click(screen.getByRole('button', { name: /export/i }));
  await userEvent.click(screen.getByRole('menuitem', { name: label }));
}

describe('exportRows', () => {
  it('is one row per OTL, with Mon–Fri and a weekly total', () => {
    const rows = exportRows(entries, [opex, leave], MONDAY);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      projectCode: 'LEAVE-VAC', taskCode: 'TL', expenditureTypeCode: 'EL', timeReportingCode: 'RL',
      mon: 0, tue: 0, wed: 0, thu: 0, fri: 7.5, total: 7.5,
    });
    expect(rows[1]).toEqual({
      projectCode: 'OPEX-ADMIN', taskCode: 'T0', expenditureTypeCode: 'E0', timeReportingCode: 'R0',
      mon: 7.5, tue: 7.5, wed: 7.5, thu: 7.5, fri: 0, total: 30,
    });
  });

  it('ignores entries outside the week being exported', () => {
    const rows = exportRows([...entries, entry('2026-09-14', 'OPEX-ADMIN', 15)], [opex, leave], MONDAY);
    expect(rows[1]?.total).toBe(30);
  });

  // Same rule PersonWeekView follows: hours are never gated on a successful
  // OTL lookup — only the identifier columns fall back.
  it('still exports hours for an OTL that has been deleted from setup', () => {
    const rows = exportRows(entries, [leave], MONDAY);
    const orphan = rows.find((row) => row.projectCode === 'OPEX-ADMIN');
    expect(orphan?.total).toBe(30);
    expect(orphan?.taskCode).toBe('—');
  });
});

describe('ExportMenu', () => {
  it('offers copy and download behind one Export control', async () => {
    renderMenu();
    await userEvent.click(screen.getByRole('button', { name: /export/i }));
    expect(screen.getByRole('menuitem', { name: /copy as table/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /download csv/i })).toBeInTheDocument();
  });

  it('puts both an HTML and a plain-text flavour on the clipboard', async () => {
    renderMenu();
    await openAnd(/copy as table/i);
    expect(clipboardWrite).toHaveBeenCalledTimes(1);
    const [item] = written as FakeClipboardItem[];
    expect(Object.keys(item?.flavours ?? {}).sort()).toEqual(['text/html', 'text/plain']);
    const html = await item?.flavours['text/html']?.text();
    expect(html).toContain('<table');
    expect(html).toContain('LEAVE-VAC');
    const text = await item?.flavours['text/plain']?.text();
    expect(text).toContain('Time reporting code');
    expect(text).not.toContain('<table');
  });

  it('falls back to plain text where ClipboardItem is unsupported', async () => {
    vi.stubGlobal('ClipboardItem', undefined);
    renderMenu();
    await openAnd(/copy as table/i);
    expect(clipboardWrite).not.toHaveBeenCalled();
    expect(clipboardWriteText).toHaveBeenCalledTimes(1);
  });

  it('says so when the copy lands, rather than looking like nothing happened', async () => {
    renderMenu();
    await openAnd(/copy as table/i);
    expect(await screen.findByText(/copied/i)).toBeInTheDocument();
  });

  it('names what went wrong when the clipboard refuses', async () => {
    clipboardWrite.mockRejectedValueOnce(new Error('denied'));
    renderMenu();
    await openAnd(/copy as table/i);
    expect(await screen.findByText(/denied|could not/i)).toBeInTheDocument();
  });

  it('downloads a CSV named for the person and the week', async () => {
    renderMenu();
    await openAnd(/download csv/i);
    expect(clicked).not.toBeNull();
    expect(clicked?.download).toBe('Alex-Kim-2026-09-07.csv');
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    // Firefox ignores a synthetic click on a detached anchor, and cancels the
    // download if the object URL is revoked in the same tick.
    expect(wasAttachedWhenClicked).toBe(true);
    expect(document.body.contains(clicked)).toBe(false);
    await vi.waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:stub'));
  });

  it('exports nothing but a header for a week with no hours', async () => {
    renderMenu({ entries: [] });
    await openAnd(/copy as table/i);
    const [item] = written as FakeClipboardItem[];
    const text = await item?.flavours['text/plain']?.text();
    expect(text?.split('\r\n')).toHaveLength(1);
  });
});
