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

/**
 * The error every failure path of the Supabase adapter throws.
 *
 * It carries the PostgREST/Postgres error `code` through instead of flattening
 * the failure to a message string. That matters for exactly one reason: `42501`
 * ("new row violates row-level security policy" / a `using` refusal) is the only
 * signal that separates "this account is not approved" from "the database is
 * broken", and the caller must never have to decide that by matching on English
 * prose. See `code` below for the codes that mean something here.
 */
export class StorageError extends Error {
  /**
   * The SQLSTATE or PostgREST code, when the failure came from the server.
   * `null` when the adapter itself raised (a short read, a missing count).
   *
   * The two that callers act on:
   *
   * * `42501` — insufficient privilege. Either RLS refused a write, or the
   *   adapter refused to hand back a state it was not authorised to read.
   *   This is "you are not approved", and it is the app's cue to show the
   *   pending/revoked screen — never a generic error banner.
   * * `PGRST103` — a requested range is not satisfiable. Only reachable if the
   *   pagination below asks for rows past the end, which would be a bug here.
   */
  readonly code: string | null;
  readonly details: string | null;
  readonly hint: string | null;

  constructor(
    message: string,
    source: { readonly code?: string | null; readonly details?: string | null; readonly hint?: string | null } = {},
  ) {
    super(message);
    this.name = 'StorageError';
    this.code = source.code ?? null;
    this.details = source.details ?? null;
    this.hint = source.hint ?? null;
  }
}

/**
 * The SQLSTATE the app must treat as "not approved", not as "broken".
 *
 * Postgres raises it for a `with check` refusal on an insert. A `using`
 * refusal on a select is silent — it returns no rows — so the adapter raises
 * this code itself when the account is not approved, rather than letting a
 * denied read masquerade as an empty account. See `createSupabaseAdapter`.
 */
export const INSUFFICIENT_PRIVILEGE = '42501';
