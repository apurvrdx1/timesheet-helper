import { HOURS_PER_BLOCK, type Blocks } from './types';

/**
 * Converts hours to whole half-hour blocks, flooring, and reports what
 * could not be represented. Rounds to 4dp first so float drift
 * (2.5 * 3 === 7.500000000000001) never manufactures a residual.
 */
export function hoursToBlocks(hours: number): { blocks: Blocks; residualHours: number } {
  if (!Number.isFinite(hours) || hours <= 0) return { blocks: 0, residualHours: 0 };
  const exact = Math.round(hours / HOURS_PER_BLOCK * 1e4) / 1e4;
  const blocks = Math.floor(exact);
  const residualHours = Math.round((hours - blocks * HOURS_PER_BLOCK) * 1e4) / 1e4;
  return { blocks, residualHours };
}

export function blocksToHours(blocks: Blocks): number {
  return blocks * HOURS_PER_BLOCK;
}

export function formatHours(hours: number): string {
  return hours.toFixed(1);
}
