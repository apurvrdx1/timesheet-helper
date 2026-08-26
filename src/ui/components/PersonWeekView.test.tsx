import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PersonWeekView } from './PersonWeekView';
import type { ScheduleEntry } from '../../domain/types';

const entries: ScheduleEntry[] = [
  { personId: 'p1', date: '2026-09-07', otlProjectCode: 'P-1001', blocks: 15, source: 'CALC', overrideBlocks: 0 },
  { personId: 'p1', date: '2026-09-08', otlProjectCode: 'OPEX-ADMIN', blocks: 15, source: 'CALC', overrideBlocks: 0 },
];

describe('PersonWeekView', () => {
  it('names the person and the week', () => {
    render(<PersonWeekView personName="Alex" monday="2026-09-07" entries={entries} otls={[]} />);
    expect(screen.getByText('Alex')).toBeInTheDocument();
    expect(screen.getByText(/7 – 11 Sep 2026/)).toBeInTheDocument();
  });

  it('shows the four OTL identifier fields for each row', () => {
    render(<PersonWeekView personName="Alex" monday="2026-09-07" entries={entries} otls={[{
      projectCode: 'P-1001', taskCode: 'T1', expenditureTypeCode: 'E1',
      timeReportingCode: 'R1', category: 'CAPEX', leaveSubtype: null,
      isDefaultOpex: false, colorIndex: 1, active: true,
    }]} />);
    expect(screen.getByText('T1')).toBeInTheDocument();
    expect(screen.getByText('E1')).toBeInTheDocument();
    expect(screen.getByText('R1')).toBeInTheDocument();
  });

  it('shows a weekly total', () => {
    render(<PersonWeekView personName="Alex" monday="2026-09-07" entries={entries} otls={[]} />);
    expect(screen.getByText('15.0')).toBeInTheDocument();
  });
});
