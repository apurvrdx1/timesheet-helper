import type { IsoDate, IsoMonth } from './types';

const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'] as const;

/** All arithmetic is UTC so a local timezone can never shift a day into another week. */
function toUtc(date: IsoDate): Date {
  const parts = date.split('-');
  const y = parseInt(parts[0] ?? '', 10);
  const m = parseInt(parts[1] ?? '', 10);
  const d = parseInt(parts[2] ?? '', 10);
  if (!parts[0] || !parts[1] || !parts[2] || Number.isNaN(y) || Number.isNaN(m) || Number.isNaN(d)) {
    throw new Error(`Invalid IsoDate format: ${date}`);
  }
  return new Date(Date.UTC(y, m - 1, d));
}

function toIso(d: Date): IsoDate {
  return d.toISOString().slice(0, 10) as IsoDate;
}

export function addDays(date: IsoDate, n: number): IsoDate {
  const d = toUtc(date);
  d.setUTCDate(d.getUTCDate() + n);
  return toIso(d);
}

/** 1 = Monday … 7 = Sunday */
function isoDayOfWeek(date: IsoDate): number {
  const dow = toUtc(date).getUTCDay();
  return dow === 0 ? 7 : dow;
}

export function isWeekend(date: IsoDate): boolean {
  return isoDayOfWeek(date) > 5;
}

export function mondayOf(date: IsoDate): IsoDate {
  return addDays(date, -(isoDayOfWeek(date) - 1));
}

export function weekDays(monday: IsoDate): IsoDate[] {
  return [0, 1, 2, 3, 4].map((i) => addDays(monday, i));
}

export function monthOf(date: IsoDate): IsoMonth {
  return date.slice(0, 7) as IsoMonth;
}

/** Every Monday whose Mon–Fri span contains at least one day of `month`. */
export function weeksTouchingMonth(month: IsoMonth): IsoDate[] {
  const parts = month.split('-');
  const y = parseInt(parts[0] ?? '', 10);
  const m = parseInt(parts[1] ?? '', 10);
  if (!parts[0] || !parts[1] || Number.isNaN(y) || Number.isNaN(m)) {
    throw new Error(`Invalid IsoMonth format: ${month}`);
  }
  const first = toIso(new Date(Date.UTC(y, m - 1, 1)));
  const last = toIso(new Date(Date.UTC(y, m, 0)));
  const weeks: IsoDate[] = [];
  for (let monday = mondayOf(first); monday <= mondayOf(last); monday = addDays(monday, 7)) {
    if (weekDays(monday).some((d) => monthOf(d) === month)) weeks.push(monday);
  }
  return weeks;
}

/** Weekdays from start to end inclusive. Empty if end precedes start. */
export function datesInRange(start: IsoDate, end: IsoDate): IsoDate[] {
  if (end < start) return [];
  const out: IsoDate[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) {
    if (!isWeekend(d)) out.push(d);
  }
  return out;
}

export function formatDayHeader(date: IsoDate): string {
  const names = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
  const d = toUtc(date);
  const dayOfWeekIndex = isoDayOfWeek(date) - 1;
  if (dayOfWeekIndex < 0 || dayOfWeekIndex >= names.length) {
    throw new Error(`Invalid day of week index: ${dayOfWeekIndex}`);
  }
  const dayName = names[dayOfWeekIndex];
  const monthIndex = d.getUTCMonth();
  if (monthIndex < 0 || monthIndex >= MONTH_NAMES.length) {
    throw new Error(`Invalid month index: ${monthIndex}`);
  }
  const monthName = MONTH_NAMES[monthIndex];
  return `${dayName} ${d.getUTCDate()} ${monthName}`;
}

export function formatWeekRange(monday: IsoDate): string {
  const friday = addDays(monday, 4);
  const a = toUtc(monday);
  const b = toUtc(friday);
  const year = b.getUTCFullYear();
  const aMonthIndex = a.getUTCMonth();
  const bMonthIndex = b.getUTCMonth();
  if (aMonthIndex < 0 || aMonthIndex >= MONTH_NAMES.length || bMonthIndex < 0 || bMonthIndex >= MONTH_NAMES.length) {
    throw new Error(`Invalid month index`);
  }
  const aMonthName = MONTH_NAMES[aMonthIndex];
  const bMonthName = MONTH_NAMES[bMonthIndex];
  if (a.getUTCMonth() === b.getUTCMonth()) {
    return `${a.getUTCDate()} – ${b.getUTCDate()} ${bMonthName} ${year}`;
  }
  return `${a.getUTCDate()} ${aMonthName} – ` +
         `${b.getUTCDate()} ${bMonthName} ${year}`;
}
