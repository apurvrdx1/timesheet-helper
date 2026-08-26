import { describe, it, expect } from 'vitest';
import { cmp } from './order';

describe('cmp', () => {
  it('orders by code unit, not by locale', () => {
    expect(cmp('a', 'b')).toBe(-1);
    expect(cmp('b', 'a')).toBe(1);
    expect(cmp('a', 'a')).toBe(0);
  });

  it('sorts an array into plain ascending code-unit order', () => {
    const codes = ['P-10', 'P-2', 'OPEX', 'p-1', 'Ä'];
    expect([...codes].sort(cmp)).toEqual([...codes].sort());
  });

  it('does not fold case the way a locale collator would', () => {
    // localeCompare('a', 'B') is -1 under most locales; code-unit order is +1.
    expect(cmp('a', 'B')).toBe(1);
  });
});
