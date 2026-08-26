/**
 * The app's single state store: the in-memory `Model`, the last calculated
 * `ScheduleResult`, and the sync machinery that keeps both mirrored to the
 * local cache and the active backend.
 *
 * Never branches on a backend name — every backend-specific operation goes
 * through `getAdapter(config.backend)`, exactly like `ConnectionSettings`.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { BackendConfig } from './adapter';
import { getAdapter } from './registry';
import { loadCache, saveCache } from './localCache';
import { rowsToModel, rowsToScheduleEntries, rowsToMeta, buildSheetPayload } from './serialize';
import type { TabName } from './serialize';
import { hashModel } from '../domain/hash';
import { scheduleAll } from '../domain/schedule';
import type { Model, ScheduleResult, IsoMonth } from '../domain/types';

export type StoreStatus = 'idle' | 'syncing' | 'offline' | 'error';

export interface StoreApi {
  model: Model;
  result: ScheduleResult;
  config: BackendConfig;
  isStale: boolean;
  status: StoreStatus;
  /**
   * A human-readable, non-blocking notice about the last sync attempt (a
   * fallback-to-cache, a failed push, …). `null` when there is nothing to
   * say. Never a substitute for `status` — always paired with it.
   */
  notice: string | null;
  /**
   * A data-integrity notice about the last read: a tab whose header the app
   * could not make sense of, or rows it had to skip. Separate from `notice`
   * because it outranks a connectivity message and must never be suppressed
   * behind one — the user's spreadsheet holds data the app cannot see, and
   * only the user can fix that. `null` when the last read was clean.
   */
  dataNotice: string | null;
  /**
   * The tabs that failed to parse on the last read. Every push omits them,
   * so unreadable data stays exactly where it is instead of being replaced
   * with nothing.
   */
  unreadableTabs: readonly TabName[];
  update: (fn: (model: Model) => Model) => void;
  recalculate: () => void;
  connect: (config: BackendConfig) => Promise<void>;
  disconnect: () => Promise<void>;
}

const EMPTY_MODEL: Model = {
  otls: [], people: [], statHolidays: [], allocations: [], leave: [], overrides: [],
};

const EMPTY_RESULT: ScheduleResult = { entries: [], residuals: [], violations: [] };

/** First-run default: the app must be usable with no configuration at all. */
const DEFAULT_CONFIG: BackendConfig = { backend: 'local', location: '' };

const PUSH_DEBOUNCE_MS = 2000;

/** Every month the model allocates into, deduplicated and sorted. */
export function monthsOf(model: Model): IsoMonth[] {
  return [...new Set(model.allocations.map((a) => a.month))].sort();
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Whether two configs point at the SAME stored copy of the data — the same
 * backend and the same location within it.
 *
 * `unreadableTabs` is evidence about one specific spreadsheet, gathered by
 * reading it. It says nothing about a different one, which has not been read
 * at all. Carrying the verdict across meant the intuitive escape hatch from a
 * broken header ("connect somewhere clean") silently did not work: the new
 * sheet received seven of eight tabs for the rest of the session, and the
 * banner told the user to fix a header in a spreadsheet they had just left.
 *
 * Reconnecting to the SAME target is the one case where the evidence still
 * holds. `connect` writes, it never re-reads, so clearing the verdict there
 * would push the app's own (empty, because the tab did not load) rows over
 * the very data the protection exists for.
 */
function isSameBackendTarget(a: BackendConfig, b: BackendConfig): boolean {
  return a.backend === b.backend && a.location === b.location;
}

/**
 * True when the model plainly implies the schedule has content — there are
 * people, and something to place against their days. An empty
 * `ScheduleResult` for such a model means "nothing has been calculated
 * yet", never "the schedule is genuinely empty", so the `Schedule` tab must
 * not be overwritten with it.
 */
function impliesSchedule(model: Model): boolean {
  return (
    model.people.length > 0 &&
    (model.allocations.length > 0 || model.leave.length > 0 || model.overrides.length > 0)
  );
}

/**
 * The tabs a push must leave alone: every tab that failed to parse on the
 * last read, plus `Schedule` when there is no computed result to write for
 * a model that clearly has one. Both cloud writers clear a tab before
 * writing it, so "write nothing there" is the only way to keep the user's
 * data.
 *
 * `Meta` is bound to `Schedule` and always travels with it. Meta carries
 * exactly one thing: the hash of the model the Schedule tab was calculated
 * against. It is a CERTIFICATE FOR the Schedule tab, and publishing the
 * certificate without the thing it certifies is how a sheet ends up
 * declaring a schedule current that was never written — after which no
 * future load ever prompts a recalculation, because the hash says there is
 * nothing to do.
 */
function tabsToProtect(
  model: Model,
  entries: ScheduleResult['entries'],
  unreadableTabs: readonly TabName[],
): TabName[] {
  const omitted = new Set<TabName>(unreadableTabs);
  if (entries.length === 0 && impliesSchedule(model)) omitted.add('Schedule');
  if (omitted.has('Schedule')) omitted.add('Meta');
  return [...omitted];
}

/** `scheduleAll`, but a model the scheduler rejects yields no result rather
 * than an exception — the caller is restoring state, not asking a question,
 * and `tabsToProtect` keeps an empty result from reaching the sheet. */
function scheduleOrEmpty(model: Model): ScheduleResult {
  try {
    return scheduleAll(model, monthsOf(model));
  } catch {
    return EMPTY_RESULT;
  }
}

function listTabs(tabs: readonly TabName[]): string {
  if (tabs.length <= 1) return tabs.join('');
  return `${tabs.slice(0, -1).join(', ')} and ${tabs[tabs.length - 1] ?? ''}`;
}

/**
 * The expected-vs-got detail behind an unreadable tab, lifted out of
 * `problems`.
 *
 * "The header row does not match the columns the app expects" is
 * unactionable on its own — for the whole family of near-miss headers it is
 * said about a header that looks byte-perfect on screen. The discriminating
 * fact (which column is wrong, or that there is a stray extra one) is
 * already computed in `parseTab`; it just never left the console.
 */
function headerDetailFor(
  unreadableTabs: readonly TabName[],
  problems: readonly string[],
): string {
  const details = problems.filter((problem) =>
    unreadableTabs.some((tab) => problem.startsWith(`${tab}: header row`)),
  );
  return details.length === 0 ? '' : `${details.join(' ')}. `;
}

/**
 * Names the constraint and the next action (DESIGN.md §4): which tab the
 * app could not read, exactly how its header differs from the expected one,
 * and BOTH consequences — the app will not write over it, and the user's own
 * edits to it are not reaching the backend either.
 *
 * Saying only "the app will not write over it" reads as pure protection and
 * hides the second half: while the tab is frozen, every edit the user makes
 * to it is being kept locally and nowhere else.
 */
function dataNoticeFor(
  unreadableTabs: readonly TabName[],
  problems: readonly string[],
): string | null {
  if (unreadableTabs.length > 0) {
    const isPlural = unreadableTabs.length > 1;
    const subject = `${listTabs(unreadableTabs)} ${isPlural ? 'tabs' : 'tab'}`;
    const pronoun = isPlural ? 'them' : 'it';
    const changes = isPlural ? 'those tabs' : 'that tab';
    return (
      `The ${subject} could not be read: the header row does not match the columns the app expects. ` +
      `${headerDetailFor(unreadableTabs, problems)}` +
      `Nothing from ${pronoun} was loaded, and the app will not write over ${pronoun} — ` +
      `which also means your changes to ${changes} are NOT being saved to the backend until the header is fixed. ` +
      `Restore the header row in your spreadsheet, then reload this page.`
    );
  }
  if (problems.length > 0) {
    return `Loaded with ${problems.length} problem(s) in the backend's data — see the console for detail.`;
  }
  return null;
}

export function useStore(): StoreApi {
  const initialCache = useRef(loadCache()).current;

  const [model, setModel] = useState<Model>(initialCache?.model ?? EMPTY_MODEL);
  const [result, setResult] = useState<ScheduleResult>(EMPTY_RESULT);
  const [config, setConfig] = useState<BackendConfig>(initialCache?.config ?? DEFAULT_CONFIG);
  const [lastCalculatedHash, setLastCalculatedHash] = useState<string | null>(
    initialCache?.hash ?? null,
  );
  const [status, setStatus] = useState<StoreStatus>('idle');
  const [notice, setNotice] = useState<string | null>(null);
  const [dataNotice, setDataNotice] = useState<string | null>(null);
  const [unreadableTabs, setUnreadableTabs] = useState<readonly TabName[]>([]);

  // Mirrors kept current every render so callbacks (debounced timers, async
  // continuations) that must not close over a stale value can read the
  // latest state without becoming a dependency that re-runs mount effects
  // or invalidates the debounce timer.
  const modelRef = useRef(model);
  modelRef.current = model;
  const resultRef = useRef(result);
  resultRef.current = result;
  const configRef = useRef(config);
  configRef.current = config;
  const hashRef = useRef(lastCalculatedHash);
  hashRef.current = lastCalculatedHash;
  const unreadableTabsRef = useRef(unreadableTabs);
  unreadableTabsRef.current = unreadableTabs;

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * Drops the "these tabs did not parse" verdict and the notice built from
   * it. The ref is written directly as well as the state: a push already
   * queued on the debounce timer reads `unreadableTabsRef.current`, and it
   * must not use a verdict about a backend the store has just left.
   */
  const forgetUnreadableTabs = useCallback((): void => {
    unreadableTabsRef.current = [];
    setUnreadableTabs([]);
    setDataNotice(null);
  }, []);

  const pushToAdapter = useCallback(
    async (pushModel: Model, entries: ScheduleResult['entries'], hash: string | null) => {
      setStatus('syncing');
      const omitTabs = tabsToProtect(pushModel, entries, unreadableTabsRef.current);
      try {
        const adapter = getAdapter(configRef.current.backend);
        await adapter.write(
          configRef.current,
          buildSheetPayload(pushModel, entries, hash ?? '', omitTabs),
        );
        setStatus('idle');
        setNotice(null);
      } catch (error) {
        setStatus('error');
        setNotice(`Could not save to the backend: ${messageOf(error)}. Your changes are kept locally.`);
      }
    },
    [],
  );

  // Mount: read through the configured adapter; fall back to the cache on
  // failure with a non-blocking notice. Never a crash, never a blocking
  // modal — the app stays usable with whatever data is on hand.
  useEffect(() => {
    let cancelled = false;

    async function loadInitial(): Promise<void> {
      setStatus('syncing');
      const startingConfig = configRef.current;
      try {
        const adapter = getAdapter(startingConfig.backend);
        const payload = await adapter.read(startingConfig);
        if (cancelled) return;

        const model_ = rowsToModel(payload);
        const schedule_ = rowsToScheduleEntries(payload);
        const meta_ = rowsToMeta(payload);
        const readModel = model_.model;
        const metaHash = meta_.hash;
        const problems = [...model_.problems, ...schedule_.problems, ...meta_.problems];
        const unreadable = [
          ...model_.unreadableTabs,
          ...schedule_.unreadableTabs,
          ...meta_.unreadableTabs,
        ];

        setModel(readModel);
        setResult({ entries: schedule_.entries, residuals: [], violations: [] });
        setLastCalculatedHash(metaHash);
        setUnreadableTabs(unreadable);

        // A read that lost data must not overwrite the copy that still has
        // it. The cache is the only place a tab the backend could not be
        // parsed out of might survive, so it wins over what just came back.
        if (problems.length === 0 || loadCache() === null) {
          saveCache(readModel, metaHash ?? hashModel(readModel), startingConfig);
        }
        setStatus('idle');

        setNotice(null);
        setDataNotice(dataNoticeFor(unreadable, problems));
        if (problems.length > 0) {
          // eslint-disable-next-line no-console
          console.warn('Problems loading from backend:', problems);
        }
      } catch (error) {
        if (cancelled) return;
        const cached = loadCache();
        if (cached) {
          setModel(cached.model);
          setLastCalculatedHash(cached.hash);
          setConfig(cached.config);
          // Restoring the model without its schedule would leave `result`
          // empty, and the next edit would push that emptiness over the
          // Schedule tab. Recompute it from the very model being restored.
          setResult(scheduleOrEmpty(cached.model));
          setNotice(
            `Could not reach the backend (${messageOf(error)}). Showing your last saved copy.`,
          );
        } else {
          setNotice(`Could not reach the backend (${messageOf(error)}), and no local copy was found.`);
        }
        setStatus('offline');
      }
    }

    void loadInitial();
    return () => {
      cancelled = true;
    };
    // Mount-only: this reads whatever config/cache were present at first
    // render. `connect`/`disconnect` own every later config change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(
    () => () => {
      if (debounceRef.current !== null) clearTimeout(debounceRef.current);
    },
    [],
  );

  const update = useCallback(
    (fn: (model: Model) => Model) => {
      setModel((previous) => {
        const next = fn(previous);
        saveCache(next, hashRef.current ?? '', configRef.current);

        if (debounceRef.current !== null) clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(() => {
          debounceRef.current = null;
          void pushToAdapter(next, resultRef.current.entries, hashRef.current);
        }, PUSH_DEBOUNCE_MS);

        return next;
      });
    },
    [pushToAdapter],
  );

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

    // A recalculation that placed nothing for a model that plainly has a
    // schedule did not succeed — it ran over an empty window of months and
    // computed over zero weeks. Recording its hash would clear the stale
    // banner and certify a Schedule tab nobody wrote. Report it the same
    // non-blocking way a scheduling failure is reported, and leave the
    // model exactly as it was: still stale, still recoverable.
    if (newResult.entries.length === 0 && impliesSchedule(currentModel)) {
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
    saveCache(currentModel, hash, configRef.current);

    // Recalculation is an explicit, infrequent user action — push it right
    // away rather than folding it into the 2s debounce meant for typing.
    if (debounceRef.current !== null) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    void pushToAdapter(currentModel, newResult.entries, hash);
  }, [pushToAdapter]);

  const connect = useCallback(async (newConfig: BackendConfig): Promise<void> => {
    setStatus('syncing');
    // A verdict gathered by reading the OLD spreadsheet must not be applied
    // to a different one. Moving to a new target starts with no evidence
    // against it, so every tab is pushed; reconnecting to the same target
    // keeps the protection, because `connect` writes without re-reading.
    const isSameTarget = isSameBackendTarget(configRef.current, newConfig);
    const protectedTabs = isSameTarget ? unreadableTabsRef.current : [];
    try {
      const adapter = getAdapter(newConfig.backend);
      await adapter.connect(newConfig);

      // Switching backends must not lose data: write the in-memory model to
      // the newly selected backend rather than reading it and possibly
      // clobbering unsaved local changes.
      const currentModel = modelRef.current;
      const hash = hashRef.current ?? hashModel(currentModel);
      const entries = resultRef.current.entries;
      await adapter.write(
        newConfig,
        buildSheetPayload(
          currentModel,
          entries,
          hash,
          tabsToProtect(currentModel, entries, protectedTabs),
        ),
      );

      setConfig(newConfig);
      saveCache(currentModel, hash, newConfig);
      if (!isSameTarget) forgetUnreadableTabs();
      setStatus('idle');
      setNotice(null);
    } catch (error) {
      setStatus('error');
      setNotice(`Could not connect: ${messageOf(error)}.`);
    }
  }, [forgetUnreadableTabs]);

  const disconnect = useCallback(async (): Promise<void> => {
    const adapter = getAdapter(configRef.current.backend);
    try {
      await adapter.disconnect();
    } catch (error) {
      setNotice(`The backend did not disconnect cleanly: ${messageOf(error)}.`);
    } finally {
      const fallback: BackendConfig = { backend: 'local', location: '' };
      const isSameTarget = isSameBackendTarget(configRef.current, fallback);
      setConfig(fallback);
      saveCache(modelRef.current, hashRef.current ?? '', fallback);
      // Same rule as `connect`: the local-only store is a different copy of
      // the data from the cloud sheet just left, and it has not been read.
      if (!isSameTarget) forgetUnreadableTabs();
      setStatus('idle');
    }
  }, [forgetUnreadableTabs]);

  return {
    model,
    result,
    config,
    isStale: hashModel(model) !== lastCalculatedHash,
    status,
    notice,
    dataNotice,
    unreadableTabs,
    update,
    recalculate,
    connect,
    disconnect,
  };
}
