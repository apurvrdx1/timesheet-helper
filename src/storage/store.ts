/**
 * The app's single state store: the in-memory `Model`, the last calculated
 * `ScheduleResult`, and the sync that keeps both in the signed-in account's
 * Supabase rows.
 *
 * There is exactly one backend now, reached through `StorageAdapter`
 * (`./modelAdapter`). Nothing here names a table, a column or a policy — the
 * adapter owns all of that, and row-level security owns which account's rows
 * a query can even see.
 *
 * ## The one rule this file exists to keep
 *
 * **NEVER WRITE A STATE THAT DID NOT COME FROM A SUCCESSFUL, COMPLETE,
 * AUTHORISED READ.**
 *
 * `StorageAdapter.write` is an unconditional whole-account replace: it hands
 * `replace_state` everything the account owns, in one transaction, and what it
 * sends becomes the account's entire stored state. So a write of a state the
 * app made up — an empty model shown while a read was failing, say — is not a
 * partial save, it is a delete of everything the account had.
 *
 * The adapter cannot enforce that from where it sits; it is handed a state and
 * has no way to know where the caller got it. So the store carries the
 * provenance itself, as a LOAD EPOCH: `loadEpochRef` starts at `0`, meaning
 * no read has resolved for this mount, and is incremented by exactly one
 * thing — a `read()` that resolved with the whole account's state in hand.
 *
 * A boolean was not enough, and the way it failed is the reason this is a
 * counter. `update` captures its model in a 2s debounce closure; the flag was
 * consulted when the TIMER FIRED. Type into the planner while the mount read
 * is still in flight and the closure holds the app's own empty placeholder
 * plus one keystroke — then the read resolves, the flag flips true, the timer
 * fires, the guard says yes, and the whole account is replaced by that
 * placeholder. A flag proves that A READ SUCCEEDED. It cannot prove that the
 * state being written DESCENDS FROM that read, and only the second claim is
 * safe.
 *
 * The epoch proves descent. Every push carries the epoch that was current
 * when it was SCHEDULED, and `pushToAdapter` refuses unless that stamp still
 * matches `loadEpochRef.current` when it runs. `0` never matches (nothing has
 * been read), and a stamp from before a read no longer matches after it, so a
 * state that predates the read it would be written under cannot be sent.
 *
 * This replaces v1's `unreadableTabs`, which protected individual tabs the app
 * could not parse. There are no tabs and no partial writes any more, so the
 * protection is all-or-nothing and lives in one flag.
 *
 * ## What the epoch does NOT protect: two tabs (review finding F4)
 *
 * The epoch is per-mount. It proves a write descends from the read THIS tab
 * did; it knows nothing about any other tab. So: open the account twice, let
 * both reads resolve, edit in tab A, then edit in tab B. Both writes are
 * legitimately authorised, and the second one wins.
 *
 * That is ordinary last-writer-wins, except for one thing that makes it
 * materially worse here, and which is why it is written down rather than left
 * to be discovered: because `write` is a WHOLE-ACCOUNT REPLACE, the losing
 * tab does not lose the field it was editing. It loses everything it never
 * knew about — every change the other tab made since they diverged, across
 * all eight tables. A conflict on one cell reverts the whole account to a
 * different tab's picture of it.
 *
 * RULING (controller, v2): ACCEPTED AS DEBT FOR THIS RELEASE, not overlooked.
 * The product is one admin maintaining their own team's data, so two tabs
 * editing one account concurrently is a real but secondary flow, and closing
 * it properly is not a small change: it needs the base hash sent with the
 * write, a comparison inside `replace_state`, a new migration, and a conflict
 * UX for the tab that loses. Shipping that hastily at this stage would add
 * risk to the exact write path this release spent its whole review budget
 * making safe.
 *
 * THE FIX, WHEN IT IS DONE: `meta.model_hash` already records what the
 * account looked like when this tab read it. Send it as a base hash, have
 * `replace_state` raise when it no longer matches what is stored, and surface
 * that to the user as "this account changed in another tab — reload" rather
 * than silently overwriting. Optimistic concurrency, one extra column in one
 * comparison.
 *
 * ## Approval comes from `profiles`, never from an empty read
 *
 * A revoked account's selects all succeed and all return nothing — RLS hides
 * rows, it does not raise. That is byte-identical to a brand-new approved
 * account, which is why the adapter asks `is_approved()` and throws
 * `StorageError` with code `42501` rather than handing back an empty state.
 * This file branches on `error.code === INSUFFICIENT_PRIVILEGE` and never on
 * the message: the code is the contract, the English is not.
 *
 * An empty account (`status: 'idle'`, empty model, safe to write) and a
 * forbidden one (`status: 'forbidden'`, NOT safe to write) are therefore
 * different states here, and the app shows different things for them.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../auth/client';
import { createSupabaseAdapter } from './supabase';
import { INSUFFICIENT_PRIVILEGE, StorageError } from './modelAdapter';
import type { StorageAdapter } from './modelAdapter';
import { hashModel } from '../domain/hash';
import { scheduleAll } from '../domain/schedule';
import type { Model, ScheduleResult, IsoMonth } from '../domain/types';

/**
 * `'forbidden'` is deliberately separate from `'error'`. "Your account is not
 * approved" is a state someone can act on (ask the owner); "the database is
 * unreachable" is not, and collapsing the two would tell one of those users
 * the wrong thing.
 */
export type StoreStatus = 'idle' | 'syncing' | 'error' | 'forbidden';

export interface StoreApi {
  model: Model;
  result: ScheduleResult;
  isStale: boolean;
  /**
   * True when the model expects a schedule but has no allocated month to
   * build one over — people plus leave or an override, and nothing allocated
   * yet, which is a natural first step.
   *
   * `recalculate` schedules over `monthsOf(model)`, derived from ALLOCATIONS
   * ONLY, so such a model can only ever place nothing. Reported as staleness
   * that was a permanent nag: the banner said the schedule was out of date,
   * the one primary action attached to it failed every time it was pressed,
   * and no hash was ever recorded, so a reload reproduced it exactly. It is
   * an EMPTY STATE, not a failed action — the UI names the missing
   * allocation instead of offering an action that cannot succeed.
   */
  needsAllocation: boolean;
  /**
   * True when a schedule HAS been calculated and certified — a model hash was
   * recorded, and the stored schedule rows hold what it certifies.
   *
   * This is what separates the two states `needsAllocation` used to conflate.
   * A model that was NEVER scheduled and has nothing allocated is an empty
   * state, and saying "out of date" about it is a nag. A model that WAS
   * scheduled and then had its allocations removed is something else
   * entirely: the stored schedule no longer matches the model, the screen
   * recomputes from the current model, and the two disagree. Suppressing the
   * banner there is silent staleness.
   *
   * `''` is not a certificate. `StoredState.hash` keeps `''` and `null`
   * distinct on purpose, and `hashModel` never produces an empty string.
   */
  hasCertifiedSchedule: boolean;
  status: StoreStatus;
  /**
   * A human-readable, non-blocking notice about the last load or save.
   * `null` when there is nothing to say. Never a substitute for `status` —
   * always paired with it.
   */
  notice: string | null;
  /**
   * Whether the state on screen came from a resolved, authorised `read()` and
   * may therefore be written back over the whole account.
   *
   * Added by this task, and not part of v1's surface: `write` replaces
   * everything, so the app needs to be able to say "your edits are being kept
   * here and nowhere else" rather than silently dropping every push. False
   * until the mount read resolves, and false forever after a load that
   * failed — nothing but a load can make it true.
   */
  isSafeToWrite: boolean;
  update: (fn: (model: Model) => Model) => void;
  /**
   * Drops a push that `update` has queued on the debounce timer but not yet
   * sent. The one caller is the render error boundary: it tells the user
   * "nothing was saved over", and that sentence is only true if the write
   * the failing render was heading towards never leaves.
   */
  cancelPendingPush: () => void;
  recalculate: () => void;
}

const EMPTY_MODEL: Model = {
  otls: [], people: [], statHolidays: [], allocations: [], leave: [], overrides: [],
};

const EMPTY_RESULT: ScheduleResult = { entries: [], residuals: [], violations: [] };

const PUSH_DEBOUNCE_MS = 2000;

/**
 * What the app says when the account is not approved.
 *
 * Both halves matter. "Could not load" alone would leave someone typing into
 * a grid whose contents are going nowhere; "nothing will be saved" alone
 * would read as a bug rather than as a pending approval.
 */
const NOT_APPROVED_NOTICE =
  'This account is not approved yet, so your data could not be loaded and nothing you change ' +
  'here will be saved. Ask the owner to approve it, then reload this page.';

/** What the app says when access was withdrawn while the user was working. */
const REVOKED_NOTICE =
  'Your access was withdrawn, so your last change was not saved. Your changes are kept in this ' +
  'tab only — ask the owner to approve the account again and they will be saved on the next change.';

/**
 * What the app says when it could not reach the database at all.
 *
 * The likeliest cause by far is a PAUSED PROJECT: this runs on a free Supabase
 * project, which is paused after about a week idle.
 * `.github/workflows/keepwarm.yml` exists to prevent that, but a cron job is a
 * thing that can fail — a rotated secret, Actions disabled on the repository,
 * a run that simply did not happen — and when it does, this is the screen
 * every user meets. The fallback for a failed cron must not mystify.
 *
 * Two things it deliberately does NOT do. It does not blame the user's
 * connection alone, because a paused project looks exactly the same from here.
 * And it does not imply the answer is instant: waking a paused project takes
 * about a minute, and postgrest-js has already spent up to 7 seconds retrying
 * (1s/2s/4s) before this text is even rendered. "Try again" with no sense of
 * the wait is a sentence the user experiences as a hang.
 */
const UNREACHABLE_LOAD_NOTICE =
  'Could not reach the database. It has most likely gone to sleep — that happens when the ' +
  'project sits unused, and waking it takes about a minute, so this will not clear straight ' +
  'away. Wait a minute, then reload this page; if it still fails, check your connection. ' +
  'Nothing you change here will be saved until it loads.';

/**
 * The same failure met on the way out rather than on the way in.
 *
 * A separate sentence because the advice differs: the data DID load, the state
 * on screen is real, and there is nothing to reload — the next edit retries on
 * its own. Telling this user to reload would throw away work for nothing.
 */
const UNREACHABLE_SAVE_NOTICE =
  'Could not reach the database, so your last change was not saved. It has most likely gone to ' +
  'sleep — waking it takes about a minute, so retrying immediately will probably fail too. Your ' +
  'changes are kept in this tab, and the next change you make will try again.';

/**
 * What the app says about a push it refused to send.
 *
 * The reason is the whole point: not "saving failed" (which invites a retry)
 * but "saving would replace your stored data with what this session happens to
 * be holding", which is why the only way out is a load.
 */
const UNSAFE_PUSH_NOTICE =
  'Your changes are not being saved: this session never loaded your stored data, and saving now ' +
  'would replace it with what is on screen. Reload this page to load it.';

/**
 * What the app says about a push whose state predates the load.
 *
 * A separate sentence from `UNSAFE_PUSH_NOTICE` on purpose: the data DID
 * load, so "reload this page" would be wrong advice, and the edit is gone
 * from the screen as well as from the database — the loaded state replaced
 * it. The only true thing to say is that it was not saved and why.
 */
const SUPERSEDED_PUSH_NOTICE =
  'Your stored data finished loading while you were editing, and replaced what was on screen, so ' +
  'that change was not saved. Make it again on the loaded data.';

/** Every month the model allocates into, deduplicated and sorted. */
export function monthsOf(model: Model): IsoMonth[] {
  return [...new Set(model.allocations.map((a) => a.month))].sort();
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * True when the failure is the database refusing this account, rather than
 * the database being broken.
 *
 * Branches on the SQLSTATE, never on the message. `42501` is the only signal
 * that separates "not approved" from "something went wrong", and matching on
 * `new row violates row-level security policy for table "otls"` would break
 * the day Postgres rewords it.
 */
function isNotApproved(error: unknown): boolean {
  return error instanceof StorageError && error.code === INSUFFICIENT_PRIVILEGE;
}

/**
 * The statuses that mean "nothing in Postgres ran", as opposed to "Postgres
 * ran something and it went wrong".
 *
 * * `0` — the fetch never landed: DNS did not resolve, the connection was
 *   refused, or the client is offline. A paused Supabase project's host stops
 *   resolving, so this is the likelier of the two shapes for one.
 * * `503` — something in front of the database answered for it.
 * * `520` — Cloudflare's version of the same.
 *
 * `503` and `520` are exactly `postgrest-js`'s own `RETRYABLE_STATUS_CODES`,
 * which is not a coincidence: it retries them because they are the transient,
 * nothing-ran failures. It retries GET/HEAD/OPTIONS only, three times, with
 * 1s/2s/4s backoff — so a failing read can take about 7 seconds to arrive here
 * while a failing `rpc` (a POST, and both `write` and the approval check are
 * POSTs) arrives on the first attempt. Either way the notice must not sound
 * instant.
 */
const UNREACHABLE_STATUSES: readonly number[] = [0, 503, 520];

/**
 * True when the failure is the database not being there, rather than the
 * database refusing or failing.
 *
 * Branches on the STATUS, never on the message — the same rule `isNotApproved`
 * follows and for the same reason, with one extra pressure behind it here:
 * these failures have no useful `code` to branch on either. A fetch that never
 * landed reports `code: ''`, and a 503 whose body is not PostgREST JSON
 * reports no code at all, so the status is the only signal there is. `null`
 * status (the adapter raised it itself — a short or torn read) is not in the
 * list and must not be: that read reached the database perfectly well.
 */
function isUnreachable(error: unknown): boolean {
  return (
    error instanceof StorageError &&
    error.status !== null &&
    UNREACHABLE_STATUSES.includes(error.status)
  );
}

/**
 * True when the model plainly implies the schedule has content — there are
 * people, and something to place against their days.
 */
function impliesSchedule(model: Model): boolean {
  return (
    model.people.length > 0 &&
    (model.allocations.length > 0 || model.leave.length > 0 || model.overrides.length > 0)
  );
}

/**
 * True when the model implies a schedule but there is no allocated month to
 * build one over. `monthsOf` is derived from ALLOCATIONS ONLY, so this is the
 * CAUSE behind "the recalculation placed nothing" for a model that plainly
 * has a schedule — and the only one that names an action the user can take.
 */
function hasNoAllocatedMonths(model: Model): boolean {
  return impliesSchedule(model) && monthsOf(model).length === 0;
}

/**
 * @param adapter The storage backend. Bound once, at mount. Defaults to the
 * Supabase adapter over the signed-in client; tests pass a fake so they need
 * neither a network nor a project.
 */
export function useStore(adapter?: StorageAdapter): StoreApi {
  // Lazy, and read from a ref rather than rebuilt each render, so the mount
  // effect and every queued push all speak to the same object.
  const adapterRef = useRef<StorageAdapter | null>(null);
  if (adapterRef.current === null) {
    adapterRef.current = adapter ?? createSupabaseAdapter(supabase);
  }

  /**
   * The state on screen.
   *
   * ## Who is allowed to change it (review finding F9)
   *
   * AFTER `loadInitial` HAS RESOLVED, `model` IS MUTATED BY EXACTLY TWO
   * THINGS: `loadInitial` ITSELF, ONCE, AND `update`.
   *
   * That is not a description, it is a precondition, and something else in
   * this file already depends on it. When a write comes back `42501` the
   * store deliberately leaves the load epoch alone and leaves
   * `isSafeToWrite` true, so that re-approval saves the user's edits instead
   * of stranding them (see the catch in `pushToAdapter`). That is only sound
   * because the state still on screen is provably "what the read returned,
   * plus this user's own edits on top" — which is exactly what the two
   * mutators above guarantee and nothing else does.
   *
   * So a THIRD mutator does not merely add a code path. It silently
   * invalidates that exception, because the model would then be able to hold
   * something that no longer descends from the read the pending write was
   * authorised by. A background refresh, a realtime subscription writing
   * server rows into state, an "undo" restoring a snapshot from before the
   * load, a second `read()` on reconnect — each is a reasonable feature and
   * each breaks it.
   *
   * If one is ever added, the load epoch is the thing to reason about, not
   * this comment: anything that replaces `model` with state the user did not
   * type must advance `loadEpochRef` the way `loadInitial` does, so pushes
   * scheduled against the old state are refused rather than sent.
   */
  const [model, setModel] = useState<Model>(EMPTY_MODEL);
  const [result, setResult] = useState<ScheduleResult>(EMPTY_RESULT);
  const [lastCalculatedHash, setLastCalculatedHash] = useState<string | null>(null);
  const [status, setStatus] = useState<StoreStatus>('syncing');
  const [notice, setNotice] = useState<string | null>(null);
  const [isSafeToWrite, setIsSafeToWrite] = useState(false);

  // Mirrors kept current every render so callbacks (debounced timers, async
  // continuations) that must not close over a stale value can read the
  // latest state without becoming a dependency that re-runs mount effects
  // or invalidates the debounce timer.
  const modelRef = useRef(model);
  modelRef.current = model;
  const resultRef = useRef(result);
  resultRef.current = result;
  const hashRef = useRef(lastCalculatedHash);
  hashRef.current = lastCalculatedHash;

  /**
   * The provenance stamp, in the form the debounce timer can read.
   *
   * `0` means no read has resolved for this mount; each resolved read gets
   * the next number. A ref rather than state because a push already sitting
   * on the 2s timer fires from a closure and must compare against the CURRENT
   * epoch, and because the value it captured has to be the one that was
   * current at SCHEDULE time — a re-render must not be able to move it.
   */
  const loadEpochRef = useRef(0);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * @param epoch The load epoch that was current when this push was
   * SCHEDULED. The push is sent only if it still is — see the file header.
   */
  const pushToAdapter = useCallback(
    async (
      epoch: number,
      pushModel: Model,
      entries: ScheduleResult['entries'],
      hash: string | null,
    ) => {
      // The guard. `write` replaces the whole account, so a state that did not
      // descend from a resolved read is not a save — it is a deletion of
      // whatever the account really holds.
      if (epoch !== loadEpochRef.current || epoch === 0) {
        // Two different failures, and telling them apart is the whole point.
        // Nothing has ever loaded: the state on screen is the app's own
        // placeholder, and only a load can fix it. Or a load has since landed
        // and replaced this state: the data is there, this particular edit is
        // not, and asking for a reload would be wrong.
        setNotice(loadEpochRef.current === 0 ? UNSAFE_PUSH_NOTICE : SUPERSEDED_PUSH_NOTICE);
        return;
      }

      setStatus('syncing');
      try {
        await adapterRef.current?.write({ model: pushModel, entries, hash });
        setStatus('idle');
        setNotice(null);
      } catch (error) {
        if (isNotApproved(error)) {
          // Access was withdrawn mid-session.
          //
          // The load epoch deliberately does NOT move here. The rule is about
          // the PROVENANCE of the state, and this state still descends from a
          // resolved, authorised read plus the user's own edits on top. If the
          // owner re-approves, the next push is the right thing to send —
          // advancing it would instead strand every edit made since.
          //
          // "Plus the user's own edits on top" is the load-bearing half, and
          // it is a claim about who may write to `model` — see the invariant
          // on its declaration above (F9). Add a third mutator without
          // advancing the epoch and this exception stops being safe, with
          // nothing here to notice.
          setStatus('forbidden');
          setNotice(REVOKED_NOTICE);
          return;
        }
        // A NEW branch, deliberately below the 42501 one and deliberately
        // changing nothing above it: the load epoch is not touched and
        // `isSafeToWrite` stays as it was, exactly as on the generic error
        // path below. The state on screen still descends from the read, so
        // the next edit is still the right thing to send.
        if (isUnreachable(error)) {
          setStatus('error');
          setNotice(UNREACHABLE_SAVE_NOTICE);
          return;
        }
        setStatus('error');
        setNotice(
          `Could not save to Supabase: ${messageOf(error)}. Your changes are kept in this tab only.`,
        );
      }
    },
    [],
  );

  // Mount: read the account's whole state. This is the ONLY thing that can
  // make the store safe to write.
  useEffect(() => {
    let cancelled = false;

    async function loadInitial(): Promise<void> {
      setStatus('syncing');
      try {
        const state = await adapterRef.current?.read();
        if (cancelled || state === undefined) return;

        setModel(state.model);
        // The stored schedule, not an empty result. Restoring the model
        // without it would leave `result` empty and let the next push replace
        // the account's schedule rows with nothing.
        setResult({ entries: state.entries, residuals: [], violations: [] });
        setLastCalculatedHash(state.hash);

        // Advanced here and nowhere else. Every push scheduled before this
        // line captured an earlier epoch and can no longer be sent — which is
        // exactly right: the state it carries has just been replaced above.
        loadEpochRef.current += 1;
        setIsSafeToWrite(true);

        setStatus('idle');
        setNotice(null);
      } catch (error) {
        if (cancelled) return;
        // Left false. There is no cache to fall back to and no partial state
        // worth keeping: whatever is on screen is the app's own empty
        // placeholder, and writing it would empty the account.
        if (isNotApproved(error)) {
          setStatus('forbidden');
          setNotice(NOT_APPROVED_NOTICE);
          return;
        }
        // Below the approval check on purpose: an RLS refusal arrives as a
        // 403, which is not in `UNREACHABLE_STATUSES`, but "not approved" is
        // the more specific and more actionable fact either way and must win.
        if (isUnreachable(error)) {
          setStatus('error');
          setNotice(UNREACHABLE_LOAD_NOTICE);
          return;
        }
        setStatus('error');
        setNotice(
          `Could not load your data (${messageOf(error)}). Nothing you change here will be ` +
          'saved until it loads — reload this page to try again.',
        );
      }
    }

    void loadInitial();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(
    () => () => {
      if (debounceRef.current !== null) clearTimeout(debounceRef.current);
    },
    [],
  );

  const update = useCallback(
    (fn: (model: Model) => Model) => {
      // Read before `setModel`, so it is the epoch at the moment of the EDIT
      // and not whatever the updater happens to run under. (React may call
      // the updater twice, or later; neither must change the stamp.)
      const epoch = loadEpochRef.current;

      setModel((previous) => {
        const next = fn(previous);

        if (debounceRef.current !== null) clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(() => {
          debounceRef.current = null;
          void pushToAdapter(epoch, next, resultRef.current.entries, hashRef.current);
        }, PUSH_DEBOUNCE_MS);

        return next;
      });
    },
    [pushToAdapter],
  );

  const cancelPendingPush = useCallback((): void => {
    if (debounceRef.current === null) return;
    clearTimeout(debounceRef.current);
    debounceRef.current = null;
  }, []);

  const recalculate = useCallback(() => {
    const currentModel = modelRef.current;
    // `scheduleAll` throws on a model the scheduler can't yet make sense of
    // (no OTL flagged as the default OPEX code is the reachable case: a
    // manager exists but Setup hasn't gotten an OTL yet). Recalculation is
    // the app's one primary action (DESIGN.md §5 rule 7) and reachable the
    // moment any tab renders — an uncaught throw here would take the whole
    // app down for a data problem the model itself already tolerates.
    // Never a crash: report it the same non-blocking way a failed sync does
    // and leave the model exactly as it was, still stale, still recoverable.
    let newResult: ScheduleResult;
    try {
      newResult = scheduleAll(currentModel, monthsOf(currentModel));
    } catch (error) {
      setNotice(`Could not recalculate: ${messageOf(error)}.`);
      return;
    }

    // Gate on the CAUSE, not on the symptom. "It placed nothing" was the
    // symptom; the cause is an empty window of months, and the message names
    // exactly that, so it must only be said when that is what is missing.
    // Recording the hash here would clear the stale banner and certify a
    // schedule nobody wrote.
    //
    // The UI does not offer Recalculate in this state at all — see
    // `needsAllocation`, which reports it as the empty state it is rather
    // than as staleness with a primary action that can only fail. This
    // remains the guard behind that.
    if (hasNoAllocatedMonths(currentModel)) {
      setNotice(
        'Could not recalculate: nothing could be scheduled, because the model has no ' +
        'allocated months to place hours into. Add an allocation on the Allocations tab ' +
        'for the month you are planning, then recalculate.',
      );
      return;
    }

    const hash = hashModel(currentModel);

    setResult(newResult);
    setLastCalculatedHash(hash);

    // Recalculation is an explicit, infrequent user action — push it right
    // away rather than folding it into the 2s debounce meant for typing.
    if (debounceRef.current !== null) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    // Sent immediately, so the epoch it captures is the one it runs under.
    void pushToAdapter(loadEpochRef.current, currentModel, newResult.entries, hash);
  }, [pushToAdapter]);

  return {
    model,
    result,
    isStale: hashModel(model) !== lastCalculatedHash,
    needsAllocation: hasNoAllocatedMonths(model),
    hasCertifiedSchedule:
      (lastCalculatedHash !== null && lastCalculatedHash !== '') || result.entries.length > 0,
    status,
    notice,
    isSafeToWrite,
    update,
    cancelPendingPush,
    recalculate,
  };
}
