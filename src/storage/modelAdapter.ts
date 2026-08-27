/**
 * The seam the Supabase storage layer implements.
 *
 * Deliberately a NEW file rather than an addition to `adapter.ts`. That file
 * still describes v1's three-backend world (Google Apps Script, Microsoft
 * Graph, local) and seven modules still import it; Task 9 deletes it once
 * nothing does. Until then both files export a type called `StorageAdapter`,
 * which is legal — TypeScript resolves imports by path, not by name — and
 * temporary. Nothing should import both.
 *
 * ## Why `StoredState` and not `Model`
 *
 * `Model` (`src/domain/types.ts`) is exactly six arrays: otls, people,
 * statHolidays, allocations, leave, overrides. It carries no `ScheduleEntry[]`
 * and no hash. An adapter whose `read`/`write` spoke only `Model` therefore
 * could not persist the `schedule` or `meta` tables at all — they would stay
 * permanently empty, the model hash would never be stored, and `isStale` could
 * never be cleared across a reload. That is v1's permanent-nag bug
 * (see `hasCertifiedSchedule` in `store.ts`), rebuilt from scratch.
 *
 * So the unit of storage is the whole of what has to survive a reload: the
 * model, the calculated schedule, and the hash that certifies the second
 * against the first.
 */
import type { Model, ScheduleEntry } from '../domain/types';

export interface StoredState {
  model: Model;
  entries: ScheduleEntry[];
  /**
   * The model hash the stored `entries` were calculated against, or `null`
   * when no calculation has ever been recorded.
   *
   * `null` and `''` are NOT interchangeable and must both survive the round
   * trip unchanged. `null` means "never calculated". `''` is what an edit made
   * before any recalculation leaves behind, and `hashModel` never produces one
   * — so `''` is not a certificate either, but it is a different fact from
   * `null` and the storage layer is not the place to decide they are the same.
   * See the comment on `StoreApi.hasCertifiedSchedule` (`store.ts`).
   */
  hash: string | null;
}

export interface StorageAdapter {
  /**
   * The account's entire stored state. An account that has never written
   * anything reads back as an empty `StoredState`, never as an error — see
   * `createSupabaseAdapter` for why that has to be true.
   */
  read(): Promise<StoredState>;
  /**
   * Replaces the account's entire stored state. Atomic: either all of it
   * lands or none of it does.
   */
  write(state: StoredState): Promise<void>;
}
