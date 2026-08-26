/**
 * Serialization between the domain `Model` and flat spreadsheet rows.
 *
 * This is the boundary where trusted in-app data meets an untrusted,
 * hand-editable spreadsheet (Google Sheets / Microsoft Excel both use the
 * same flat tab layout), so it is deliberately conservative: `rowsToModel`
 * NEVER throws on bad input. A malformed row (wrong column count, an
 * unparseable value, or a semantically invalid date) is reported as a
 * string in `problems` and that single row is skipped — the rest of the
 * sheet still loads.
 *
 * Pure transformation only: no React, no I/O, no knowledge of which cloud
 * backend produced the rows.
 */

import type {
  Model,
  Otl,
  OtlCategory,
  Person,
  Role,
  StatHoliday,
  Allocation,
  LeaveRange,
  Override,
  LeaveSubtype,
  ScheduleEntry,
  EntrySource,
} from '../domain/types';

export type TabName =
  | 'OTLs'
  | 'People'
  | 'StatHolidays'
  | 'Allocations'
  | 'Leave'
  | 'Overrides'
  | 'Schedule'
  | 'Meta';

export type SheetPayload = Record<TabName, string[][]>;

// ---------------------------------------------------------------------------
// Cell-level encode/decode primitives.
// ---------------------------------------------------------------------------

/** null -> '' ; boolean -> 'TRUE'/'FALSE' ; everything else -> String(value). */
function encodeCell(value: string | number | boolean | null): string {
  if (value === null) return '';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  return String(value);
}

function parseBoolean(raw: string): boolean | undefined {
  if (raw === 'TRUE') return true;
  if (raw === 'FALSE') return false;
  return undefined;
}

function parseNumber(raw: string): number | undefined {
  if (raw.trim() === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function parseNullableString(raw: string): string | null {
  return raw === '' ? null : raw;
}

function parseEnum<T extends string>(raw: string, allowed: readonly T[]): T | undefined {
  return (allowed as readonly string[]).includes(raw) ? (raw as T) : undefined;
}

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * A real calendar check, not just "no NaN in it". `Date.UTC` silently rolls
 * over out-of-range parts (e.g. month 13, day 45) into a different but
 * plausible date, so we round-trip the parsed parts back through
 * `Date.UTC` and require the year/month/day to come back unchanged.
 */
export function isValidIsoDate(raw: string): boolean {
  const match = ISO_DATE_RE.exec(raw);
  if (!match) return false;
  const [, yStr, moStr, dStr] = match;
  if (yStr === undefined || moStr === undefined || dStr === undefined) return false;
  const y = Number(yStr);
  const mo = Number(moStr);
  const d = Number(dStr);
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

const ISO_MONTH_RE = /^(\d{4})-(\d{2})$/;

export function isValidIsoMonth(raw: string): boolean {
  const match = ISO_MONTH_RE.exec(raw);
  if (!match) return false;
  const [, yStr, moStr] = match;
  if (yStr === undefined || moStr === undefined) return false;
  const mo = Number(moStr);
  return mo >= 1 && mo <= 12;
}

// ---------------------------------------------------------------------------
// Generic tab parsing scaffold. COLUMNS drives both the header row written
// by `modelToRows` and the header validated by `rowsToModel`, so the two
// cannot drift apart.
// ---------------------------------------------------------------------------

function parseTab<T>(
  payload: Partial<SheetPayload>,
  tab: TabName,
  columns: readonly string[],
  parseRow: (row: string[], rowNum: number, problems: string[]) => T | undefined,
  problems: string[],
  unreadableTabs: TabName[],
): T[] {
  const rows = payload[tab] ?? [];
  if (rows.length === 0) return [];

  const header = rows[0] ?? [];
  const headerMatches =
    header.length === columns.length && columns.every((c, i) => header[i] === c);
  if (!headerMatches) {
    problems.push(
      `${tab}: header row does not match expected columns [${columns.join(', ')}]; got [${header.join(', ')}]`,
    );
    // The whole tab is dropped, not one row: whatever the sheet holds here
    // could not be interpreted at all. Callers MUST treat such a tab as
    // "contents unknown" and never write over it — see `buildSheetPayload`'s
    // `omitTabs`.
    unreadableTabs.push(tab);
    return [];
  }

  const out: T[] = [];
  for (let i = 1; i < rows.length; i += 1) {
    const row = rows[i] ?? [];
    const item = parseRow(row, i + 1, problems);
    if (item !== undefined) out.push(item);
  }
  return out;
}

function checkRowLength(
  row: string[],
  columns: readonly string[],
  tab: TabName,
  rowNum: number,
  problems: string[],
): boolean {
  if (row.length !== columns.length) {
    problems.push(
      `${tab} row ${rowNum}: expected ${columns.length} columns, got ${row.length}`,
    );
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// OTLs
// ---------------------------------------------------------------------------

const OTL_COLUMNS = [
  'projectCode',
  'taskCode',
  'expenditureTypeCode',
  'timeReportingCode',
  'category',
  'leaveSubtype',
  'isDefaultOpex',
  'colorIndex',
  'active',
] as const satisfies readonly (keyof Otl)[];

const OTL_CATEGORIES: readonly OtlCategory[] = ['CAPEX', 'OPEX', 'LEAVE'];
const LEAVE_SUBTYPES: readonly LeaveSubtype[] = ['VACATION', 'STAT', 'PERSONAL', 'SICK'];

function otlToRow(o: Otl): string[] {
  return OTL_COLUMNS.map((col) => encodeCell(o[col]));
}

function rowToOtl(row: string[], rowNum: number, problems: string[]): Otl | undefined {
  if (!checkRowLength(row, OTL_COLUMNS, 'OTLs', rowNum, problems)) return undefined;

  const projectCode = row[0] ?? '';
  const taskCode = row[1] ?? '';
  const expenditureTypeCode = row[2] ?? '';
  const timeReportingCode = row[3] ?? '';
  const categoryRaw = row[4] ?? '';
  const leaveSubtypeRaw = row[5] ?? '';
  const isDefaultOpexRaw = row[6] ?? '';
  const colorIndexRaw = row[7] ?? '';
  const activeRaw = row[8] ?? '';

  if (projectCode === '') {
    problems.push(`OTLs row ${rowNum}: missing projectCode`);
    return undefined;
  }

  const category = parseEnum(categoryRaw, OTL_CATEGORIES);
  if (category === undefined) {
    problems.push(`OTLs row ${rowNum}: invalid category "${categoryRaw}"`);
    return undefined;
  }

  let leaveSubtype: LeaveSubtype | null = null;
  if (leaveSubtypeRaw !== '') {
    const parsed = parseEnum(leaveSubtypeRaw, LEAVE_SUBTYPES);
    if (parsed === undefined) {
      problems.push(`OTLs row ${rowNum}: invalid leaveSubtype "${leaveSubtypeRaw}"`);
      return undefined;
    }
    leaveSubtype = parsed;
  }

  const isDefaultOpex = parseBoolean(isDefaultOpexRaw);
  if (isDefaultOpex === undefined) {
    problems.push(`OTLs row ${rowNum}: invalid boolean isDefaultOpex "${isDefaultOpexRaw}"`);
    return undefined;
  }

  const colorIndex = parseNumber(colorIndexRaw);
  if (colorIndex === undefined) {
    problems.push(`OTLs row ${rowNum}: invalid number colorIndex "${colorIndexRaw}"`);
    return undefined;
  }

  const active = parseBoolean(activeRaw);
  if (active === undefined) {
    problems.push(`OTLs row ${rowNum}: invalid boolean active "${activeRaw}"`);
    return undefined;
  }

  return {
    projectCode,
    taskCode,
    expenditureTypeCode,
    timeReportingCode,
    category,
    leaveSubtype,
    isDefaultOpex,
    colorIndex,
    active,
  };
}

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

const PEOPLE_COLUMNS = ['id', 'name', 'role', 'managerId'] as const satisfies readonly (keyof Person)[];

const ROLES: readonly Role[] = ['MANAGER', 'REPORT'];

function personToRow(p: Person): string[] {
  return [p.id, p.name, p.role, encodeCell(p.managerId)];
}

function rowToPerson(row: string[], rowNum: number, problems: string[]): Person | undefined {
  if (!checkRowLength(row, PEOPLE_COLUMNS, 'People', rowNum, problems)) return undefined;

  const id = row[0] ?? '';
  const name = row[1] ?? '';
  const roleRaw = row[2] ?? '';
  const managerIdRaw = row[3] ?? '';

  if (id === '') {
    problems.push(`People row ${rowNum}: missing id`);
    return undefined;
  }

  const role = parseEnum(roleRaw, ROLES);
  if (role === undefined) {
    problems.push(`People row ${rowNum}: invalid role "${roleRaw}"`);
    return undefined;
  }

  return { id, name, role, managerId: parseNullableString(managerIdRaw) };
}

// ---------------------------------------------------------------------------
// StatHolidays
// ---------------------------------------------------------------------------

const STAT_HOLIDAY_COLUMNS = [
  'date',
  'name',
  'otlProjectCode',
] as const satisfies readonly (keyof StatHoliday)[];

function statHolidayToRow(s: StatHoliday): string[] {
  return [s.date, s.name, s.otlProjectCode];
}

function rowToStatHoliday(
  row: string[],
  rowNum: number,
  problems: string[],
): StatHoliday | undefined {
  if (!checkRowLength(row, STAT_HOLIDAY_COLUMNS, 'StatHolidays', rowNum, problems)) return undefined;

  const date = row[0] ?? '';
  const name = row[1] ?? '';
  const otlProjectCode = row[2] ?? '';

  if (!isValidIsoDate(date)) {
    problems.push(`StatHolidays row ${rowNum}: invalid date "${date}"`);
    return undefined;
  }
  if (otlProjectCode === '') {
    problems.push(`StatHolidays row ${rowNum}: missing otlProjectCode`);
    return undefined;
  }

  return { date, name, otlProjectCode };
}

// ---------------------------------------------------------------------------
// Allocations
// ---------------------------------------------------------------------------

const ALLOCATION_COLUMNS = [
  'month',
  'otlProjectCode',
  'personId',
  'hours',
] as const satisfies readonly (keyof Allocation)[];

function allocationToRow(a: Allocation): string[] {
  return [a.month, a.otlProjectCode, encodeCell(a.personId), encodeCell(a.hours)];
}

function rowToAllocation(
  row: string[],
  rowNum: number,
  problems: string[],
): Allocation | undefined {
  if (!checkRowLength(row, ALLOCATION_COLUMNS, 'Allocations', rowNum, problems)) return undefined;

  const month = row[0] ?? '';
  const otlProjectCode = row[1] ?? '';
  const personIdRaw = row[2] ?? '';
  const hoursRaw = row[3] ?? '';

  if (!isValidIsoMonth(month)) {
    problems.push(`Allocations row ${rowNum}: invalid month "${month}"`);
    return undefined;
  }
  if (otlProjectCode === '') {
    problems.push(`Allocations row ${rowNum}: missing otlProjectCode`);
    return undefined;
  }
  const hours = parseNumber(hoursRaw);
  if (hours === undefined) {
    problems.push(`Allocations row ${rowNum}: invalid number hours "${hoursRaw}"`);
    return undefined;
  }

  return { month, otlProjectCode, personId: parseNullableString(personIdRaw), hours };
}

// ---------------------------------------------------------------------------
// Leave
// ---------------------------------------------------------------------------

const LEAVE_COLUMNS = [
  'personId',
  'startDate',
  'endDate',
  'otlProjectCode',
] as const satisfies readonly (keyof LeaveRange)[];

function leaveToRow(l: LeaveRange): string[] {
  return [l.personId, l.startDate, l.endDate, l.otlProjectCode];
}

function rowToLeave(row: string[], rowNum: number, problems: string[]): LeaveRange | undefined {
  if (!checkRowLength(row, LEAVE_COLUMNS, 'Leave', rowNum, problems)) return undefined;

  const personId = row[0] ?? '';
  const startDate = row[1] ?? '';
  const endDate = row[2] ?? '';
  const otlProjectCode = row[3] ?? '';

  if (personId === '') {
    problems.push(`Leave row ${rowNum}: missing personId`);
    return undefined;
  }
  if (!isValidIsoDate(startDate)) {
    problems.push(`Leave row ${rowNum}: invalid startDate "${startDate}"`);
    return undefined;
  }
  if (!isValidIsoDate(endDate)) {
    problems.push(`Leave row ${rowNum}: invalid endDate "${endDate}"`);
    return undefined;
  }
  if (otlProjectCode === '') {
    problems.push(`Leave row ${rowNum}: missing otlProjectCode`);
    return undefined;
  }

  return { personId, startDate, endDate, otlProjectCode };
}

// ---------------------------------------------------------------------------
// Overrides
// ---------------------------------------------------------------------------

const OVERRIDE_COLUMNS = [
  'personId',
  'date',
  'otlProjectCode',
  'hours',
] as const satisfies readonly (keyof Override)[];

function overrideToRow(o: Override): string[] {
  return [o.personId, o.date, o.otlProjectCode, encodeCell(o.hours)];
}

function rowToOverride(row: string[], rowNum: number, problems: string[]): Override | undefined {
  if (!checkRowLength(row, OVERRIDE_COLUMNS, 'Overrides', rowNum, problems)) return undefined;

  const personId = row[0] ?? '';
  const date = row[1] ?? '';
  const otlProjectCode = row[2] ?? '';
  const hoursRaw = row[3] ?? '';

  if (personId === '') {
    problems.push(`Overrides row ${rowNum}: missing personId`);
    return undefined;
  }
  if (!isValidIsoDate(date)) {
    problems.push(`Overrides row ${rowNum}: invalid date "${date}"`);
    return undefined;
  }
  if (otlProjectCode === '') {
    problems.push(`Overrides row ${rowNum}: missing otlProjectCode`);
    return undefined;
  }
  const hours = parseNumber(hoursRaw);
  if (hours === undefined) {
    problems.push(`Overrides row ${rowNum}: invalid number hours "${hoursRaw}"`);
    return undefined;
  }

  return { personId, date, otlProjectCode, hours };
}

// ---------------------------------------------------------------------------
// Schedule — the optimizer's output, not part of `Model`. Serialized
// separately from `modelToRows`/`rowsToModel` because a `ScheduleEntry[]`
// comes from `scheduleAll`, not from the domain model itself.
//
// `overrideBlocks` MUST round-trip as its own column, distinct from
// `blocks` and `source`: `source` says whether the UI should lock a cell,
// `overrideBlocks` says how many of its blocks the user actually pinned.
// A pinned cell can have `source: 'OVERRIDE'` with `overrideBlocks` less
// than `blocks` (the optimizer topped the rest up to fill the day) — losing
// that distinction on save/reload is exactly the bug this column exists to
// prevent.
// ---------------------------------------------------------------------------

const SCHEDULE_COLUMNS = [
  'personId',
  'date',
  'otlProjectCode',
  'blocks',
  'source',
  'overrideBlocks',
] as const satisfies readonly (keyof ScheduleEntry)[];

const ENTRY_SOURCES: readonly EntrySource[] = ['CALC', 'OVERRIDE', 'LEAVE'];

function scheduleEntryToRow(e: ScheduleEntry): string[] {
  return SCHEDULE_COLUMNS.map((col) => encodeCell(e[col]));
}

function rowToScheduleEntry(
  row: string[],
  rowNum: number,
  problems: string[],
): ScheduleEntry | undefined {
  if (!checkRowLength(row, SCHEDULE_COLUMNS, 'Schedule', rowNum, problems)) return undefined;

  const personId = row[0] ?? '';
  const date = row[1] ?? '';
  const otlProjectCode = row[2] ?? '';
  const blocksRaw = row[3] ?? '';
  const sourceRaw = row[4] ?? '';
  const overrideBlocksRaw = row[5] ?? '';

  if (personId === '') {
    problems.push(`Schedule row ${rowNum}: missing personId`);
    return undefined;
  }
  if (!isValidIsoDate(date)) {
    problems.push(`Schedule row ${rowNum}: invalid date "${date}"`);
    return undefined;
  }
  if (otlProjectCode === '') {
    problems.push(`Schedule row ${rowNum}: missing otlProjectCode`);
    return undefined;
  }

  const blocks = parseNumber(blocksRaw);
  if (blocks === undefined) {
    problems.push(`Schedule row ${rowNum}: invalid number blocks "${blocksRaw}"`);
    return undefined;
  }

  const source = parseEnum(sourceRaw, ENTRY_SOURCES);
  if (source === undefined) {
    problems.push(`Schedule row ${rowNum}: invalid source "${sourceRaw}"`);
    return undefined;
  }

  const overrideBlocks = parseNumber(overrideBlocksRaw);
  if (overrideBlocks === undefined) {
    problems.push(`Schedule row ${rowNum}: invalid number overrideBlocks "${overrideBlocksRaw}"`);
    return undefined;
  }

  return { personId, date, otlProjectCode, blocks, source, overrideBlocks };
}

/** Converts `scheduleAll`'s entries to the `Schedule` tab's rows. */
export function scheduleEntriesToRows(entries: ScheduleEntry[]): string[][] {
  return [[...SCHEDULE_COLUMNS], ...entries.map(scheduleEntryToRow)];
}

/**
 * Converts the `Schedule` tab's rows back to `ScheduleEntry[]`. Same
 * never-throw contract as `rowsToModel`: a malformed row is reported and
 * skipped, not fatal to the rest of the sheet.
 */
export function rowsToScheduleEntries(
  payload: Partial<SheetPayload>,
): { entries: ScheduleEntry[]; problems: string[]; unreadableTabs: TabName[] } {
  const problems: string[] = [];
  const unreadableTabs: TabName[] = [];
  const entries = parseTab(
    payload,
    'Schedule',
    SCHEDULE_COLUMNS,
    rowToScheduleEntry,
    problems,
    unreadableTabs,
  );
  return { entries, problems, unreadableTabs };
}

// ---------------------------------------------------------------------------
// Meta — a flat key/value tab. Currently carries just the model hash the
// Schedule tab was last calculated against, so a backend read can tell
// whether the stored schedule is stale without recomputing it first.
// ---------------------------------------------------------------------------

const META_COLUMNS = ['key', 'value'] as const;
const MODEL_HASH_KEY = 'modelHash';

/** Converts the current model hash to the `Meta` tab's rows. */
export function metaToRows(hash: string): string[][] {
  return [[...META_COLUMNS], [MODEL_HASH_KEY, hash]];
}

/**
 * Reads the model hash back out of the `Meta` tab. `hash` is `null` when the
 * tab is missing or carries no `modelHash` row — never thrown.
 */
export function rowsToMeta(
  payload: Partial<SheetPayload>,
): { hash: string | null; problems: string[]; unreadableTabs: TabName[] } {
  const problems: string[] = [];
  const unreadableTabs: TabName[] = [];
  const rows = payload.Meta ?? [];
  if (rows.length === 0) return { hash: null, problems, unreadableTabs };

  const header = rows[0] ?? [];
  const headerMatches =
    header.length === META_COLUMNS.length && META_COLUMNS.every((c, i) => header[i] === c);
  if (!headerMatches) {
    problems.push(
      `Meta: header row does not match expected columns [${META_COLUMNS.join(', ')}]; got [${header.join(', ')}]`,
    );
    return { hash: null, problems, unreadableTabs: ['Meta'] };
  }

  for (let i = 1; i < rows.length; i += 1) {
    const row = rows[i] ?? [];
    if (row.length !== META_COLUMNS.length) {
      problems.push(`Meta row ${i + 1}: expected ${META_COLUMNS.length} columns, got ${row.length}`);
      continue;
    }
    if (row[0] === MODEL_HASH_KEY) {
      return { hash: row[1] ?? '', problems, unreadableTabs };
    }
  }

  return { hash: null, problems, unreadableTabs };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Converts the domain `Model` to sheet rows. `Schedule` and `Meta` come back
 * empty here — populate them with `scheduleEntriesToRows`/`metaToRows` (or
 * use `buildSheetPayload`) once a `ScheduleResult` and hash exist.
 */
export function modelToRows(model: Model): SheetPayload {
  return {
    OTLs: [[...OTL_COLUMNS], ...model.otls.map(otlToRow)],
    People: [[...PEOPLE_COLUMNS], ...model.people.map(personToRow)],
    StatHolidays: [[...STAT_HOLIDAY_COLUMNS], ...model.statHolidays.map(statHolidayToRow)],
    Allocations: [[...ALLOCATION_COLUMNS], ...model.allocations.map(allocationToRow)],
    Leave: [[...LEAVE_COLUMNS], ...model.leave.map(leaveToRow)],
    Overrides: [[...OVERRIDE_COLUMNS], ...model.overrides.map(overrideToRow)],
    Schedule: [],
    Meta: [],
  };
}

/**
 * Converts sheet rows back to a domain `Model`. Never throws: a malformed
 * row (wrong column count, an unparseable value, a header that does not
 * match, or a date/month that fails the calendar check) is reported as a
 * string in `problems` and skipped, so one bad row never costs the rest of
 * the sheet. Missing tabs yield empty arrays.
 */
export function rowsToModel(
  payload: Partial<SheetPayload>,
): { model: Model; problems: string[]; unreadableTabs: TabName[] } {
  const problems: string[] = [];
  const unreadableTabs: TabName[] = [];

  const otls = parseTab(payload, 'OTLs', OTL_COLUMNS, rowToOtl, problems, unreadableTabs);
  const people = parseTab(payload, 'People', PEOPLE_COLUMNS, rowToPerson, problems, unreadableTabs);
  const statHolidays = parseTab(
    payload,
    'StatHolidays',
    STAT_HOLIDAY_COLUMNS,
    rowToStatHoliday,
    problems,
    unreadableTabs,
  );
  const allocations = parseTab(
    payload,
    'Allocations',
    ALLOCATION_COLUMNS,
    rowToAllocation,
    problems,
    unreadableTabs,
  );
  const leave = parseTab(payload, 'Leave', LEAVE_COLUMNS, rowToLeave, problems, unreadableTabs);
  const overrides = parseTab(
    payload,
    'Overrides',
    OVERRIDE_COLUMNS,
    rowToOverride,
    problems,
    unreadableTabs,
  );

  return {
    model: { otls, people, statHolidays, allocations, leave, overrides },
    problems,
    unreadableTabs,
  };
}

/**
 * Composes the `SheetPayload` a write to a backend should send: the six
 * model tabs plus the current `Schedule` (from the latest `scheduleAll`) and
 * `Meta` (the hash it was calculated against).
 *
 * `omitTabs` names tabs the caller must NOT overwrite — a tab whose header
 * did not parse on the last read (`rowsToModel().unreadableTabs`), or one
 * the caller has no trustworthy content for. An omitted key is absent from
 * the returned payload, and every adapter leaves an absent tab exactly as
 * it is. Preserving data the app cannot read is strictly better than
 * replacing it with nothing.
 */
export function buildSheetPayload(
  model: Model,
  entries: ScheduleEntry[],
  hash: string,
  omitTabs: readonly TabName[] = [],
): Partial<SheetPayload> {
  const full: SheetPayload = {
    ...modelToRows(model),
    Schedule: scheduleEntriesToRows(entries),
    Meta: metaToRows(hash),
  };
  if (omitTabs.length === 0) return full;

  const omitted = new Set<TabName>(omitTabs);
  const kept = (Object.keys(full) as TabName[]).filter((tab) => !omitted.has(tab));
  return Object.fromEntries(kept.map((tab) => [tab, full[tab]])) as Partial<SheetPayload>;
}
