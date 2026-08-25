import { describe, it, expect } from 'vitest';
import { hoursToBlocks, blocksToHours, formatHours } from './blocks';

describe('hoursToBlocks', () => {
  it('converts clean halves exactly with no residual', () => {
    expect(hoursToBlocks(7.5)).toEqual({ blocks: 15, residualHours: 0 });
    expect(hoursToBlocks(0)).toEqual({ blocks: 0, residualHours: 0 });
    expect(hoursToBlocks(100)).toEqual({ blocks: 200, residualHours: 0 });
  });

  it('floors a non-multiple and reports the residual', () => {
    expect(hoursToBlocks(96.3)).toEqual({ blocks: 192, residualHours: 0.3 });
    expect(hoursToBlocks(0.4)).toEqual({ blocks: 0, residualHours: 0.4 });
  });

  it('never returns a negative block count', () => {
    expect(hoursToBlocks(-5)).toEqual({ blocks: 0, residualHours: 0 });
  });

  it('is immune to float representation error', () => {
    // 0.1 + 0.2 style drift must not create a phantom residual
    expect(hoursToBlocks(37.5)).toEqual({ blocks: 75, residualHours: 0 });
    expect(hoursToBlocks(2.5 * 3)).toEqual({ blocks: 15, residualHours: 0 });
  });
});

describe('blocksToHours', () => {
  it('round-trips', () => {
    expect(blocksToHours(15)).toBe(7.5);
    expect(blocksToHours(0)).toBe(0);
  });
});

describe('formatHours', () => {
  it('always shows exactly one decimal place', () => {
    expect(formatHours(7.5)).toBe('7.5');
    expect(formatHours(2)).toBe('2.0');
    expect(formatHours(15)).toBe('15.0');
  });
});
