export const BLOCKS_PER_DAY = 15;      // 7.5h in half-hour blocks
export const BLOCKS_PER_WEEK = 75;     // 37.5h
export const HOURS_PER_BLOCK = 0.5;
export const OPEX_FLOOR_RATIO = 0.4;

export type Blocks = number;    // always a non-negative integer
export type IsoDate = string;   // 'YYYY-MM-DD'
export type IsoMonth = string;  // 'YYYY-MM'
export type OtlCode = string;   // project code — primary key
export type PersonId = string;

export type OtlCategory = 'CAPEX' | 'OPEX' | 'LEAVE';
export type LeaveSubtype = 'VACATION' | 'STAT' | 'PERSONAL' | 'SICK';
export type Role = 'MANAGER' | 'REPORT';
export type EntrySource = 'CALC' | 'OVERRIDE' | 'LEAVE';
export type ResidualReason = 'UNABSORBED' | 'UNASSIGNED';

export interface Otl {
  projectCode: OtlCode;
  taskCode: string;
  expenditureTypeCode: string;
  timeReportingCode: string;
  category: OtlCategory;
  leaveSubtype: LeaveSubtype | null;
  isDefaultOpex: boolean;
  colorIndex: number;
  active: boolean;
}

export interface Person {
  id: PersonId;
  name: string;
  role: Role;
  managerId: PersonId | null;
}

export interface StatHoliday { date: IsoDate; name: string; otlProjectCode: OtlCode; }

/** personId === null means this row is the OTL's monthly total. */
export interface Allocation {
  month: IsoMonth;
  otlProjectCode: OtlCode;
  personId: PersonId | null;
  hours: number;
}

export interface LeaveRange {
  personId: PersonId;
  startDate: IsoDate;
  endDate: IsoDate;
  otlProjectCode: OtlCode;
}

export interface Override {
  personId: PersonId;
  date: IsoDate;
  otlProjectCode: OtlCode;
  hours: number;
}

export interface ScheduleEntry {
  personId: PersonId;
  date: IsoDate;
  otlProjectCode: OtlCode;
  blocks: Blocks;
  /**
   * What the UI should do with the cell. `OVERRIDE` means "lock this"; it
   * does NOT mean every block in the cell came from the user. Use
   * `overrideBlocks` for that question.
   */
  source: EntrySource;
  /**
   * How many of `blocks` the user pinned by hand, 0 when none. Never greater
   * than `blocks`. This is the only field that means "user input"; `source`
   * survives a merge and so speaks for the whole cell, which is why the two
   * had to be split. After a pinned cell became untouchable in phase 3 the
   * two can differ in exactly one place: the default OPEX code, which phase 4
   * may still have to top up so the day can reach 7.5h.
   */
  overrideBlocks: Blocks;
}

export interface Residual {
  personId: PersonId | null;
  otlProjectCode: OtlCode;
  month: IsoMonth;
  blocks: Blocks;
  reason: ResidualReason;
}

export interface Violation {
  /** null for a violation about the model itself rather than about a person. */
  personId: PersonId | null;
  scope: IsoDate | IsoMonth;
  kind:
    | 'DAY_NOT_FULL'
    | 'OPEX_FLOOR_BREACHED'
    | 'OVER_CAPACITY'
    | 'NEGATIVE'
    /** An override landed on a day that leave had already claimed in full. */
    | 'OVERRIDE_ON_LEAVE_DAY'
    /** An override's hours did not divide into whole half-hour blocks. */
    | 'OVERRIDE_RESIDUAL_DROPPED'
    /** An allocation row's hours did not divide into whole half-hour blocks. */
    | 'ALLOCATION_RESIDUAL_DROPPED'
    /** The model has more than one MANAGER; only the first is a cascade target. */
    | 'MULTIPLE_MANAGERS'
    /** Placed + carried does not reconcile against the budget for a key. */
    | 'HOURS_NOT_CONSERVED';
  message: string;
}

export interface Model {
  otls: Otl[];
  people: Person[];
  statHolidays: StatHoliday[];
  allocations: Allocation[];
  leave: LeaveRange[];
  overrides: Override[];
}

export interface ScheduleResult {
  entries: ScheduleEntry[];
  residuals: Residual[];
  violations: Violation[];
}
