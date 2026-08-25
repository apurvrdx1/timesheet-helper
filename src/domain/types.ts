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
  source: EntrySource;
}

export interface Residual {
  personId: PersonId | null;
  otlProjectCode: OtlCode;
  month: IsoMonth;
  blocks: Blocks;
  reason: ResidualReason;
}

export interface Violation {
  personId: PersonId;
  scope: IsoDate | IsoMonth;
  kind: 'DAY_NOT_FULL' | 'OPEX_FLOOR_BREACHED' | 'OVER_CAPACITY' | 'NEGATIVE';
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
