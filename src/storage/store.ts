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
  /**
   * True when the model expects a schedule but has no allocated month to
   * build one over — people plus leave or an override, and nothing allocated
   * yet, which is a natural first step.
   *
   * `recalculate` schedules over `monthsOf(model)`, derived from ALLOCATIONS
   * ONLY, so such a model can only ever place nothing. Reported as staleness
   * that was a permanent nag: the banner said the schedule was out of date,
   * the one primary action attached to it failed every time it was pressed,
   * and no `Meta` was ever written, so a reload reproduced it exactly. It is
   * an EMPTY STATE, not a failed action — the UI names the missing
   * allocation instead of offering an action that cannot succeed.
   */
  needsAllocation: boolean;
  /**
   * True when a schedule HAS been calculated and certified — a model hash was
   * recorded, and the backend's `Schedule`/`Meta` tabs hold what it certifies.
   *
   * This is what separates the two states `needsAllocation` used to conflate.
   * A model that was NEVER scheduled and has nothing allocated is an empty
   * state, and saying "out of date" about it is a nag. A model that WAS
   * scheduled and then had its allocations removed is something else
   * entirely: the stored schedule no longer matches the model, the screen
   * recomputes from the current model, and the two disagree. Suppressing the
   * banner there is silent staleness.
   *
   * `''` is not a certificate: `update` writes `hashRef.current ?? ''` to the
   * cache, so an edit made before any recalculation leaves an empty string
   * behind. `hashModel` never produces one.
   */
  hasCertifiedSchedule: boolean;
  update: (fn: (model: Model) => Model) => void;
  /**
   * Drops a push that `update` has queued on the debounce timer but not yet
   * sent. The one caller is the render error boundary: it tells the user
   * "nothing was saved over", and that sentence is only true if the write
   * the failing render was heading towards never leaves.
   */
  cancelPendingPush: () => void;
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

/** Every tab a push can carry. Used as "protect all of it" for a target the
 *  app could not read — see `connect`. */
const ALL_TABS: readonly TabName[] = [
  'OTLs', 'People', 'StatHolidays', 'Allocations', 'Leave', 'Overrides', 'Schedule', 'Meta',
];

/** Every month the model allocates into, deduplicated and sorted. */
export function monthsOf(model: Model): IsoMonth[] {
  return [...new Set(model.allocations.map((a) => a.month))].sort();
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * What a read of one target says about it: which tabs could not be parsed,
 * and the detail behind that.
 */
interface ReadVerdict {
  unreadableTabs: readonly TabName[];
  problems: readonly string[];
}

/** A verdict about the target, or the reason there is none. */
type ReadOutcome =
  | { readonly kind: 'verdict'; readonly verdict: ReadVerdict }
  | { readonly kind: 'unread'; readonly error: string };

/**
 * Re-derives the unreadable-tab verdict by READING the target being moved to.
 *
 * `unreadableTabs` is evidence about one specific stored copy of the data,
 * produced by reading it. It says nothing about a different copy, and
 * carrying it across meant the intuitive escape hatch from a broken header
 * ("connect somewhere clean") silently did not work. But the previous
 * attempt at retiring it compared `backend` + `location` and treated a
 * difference as proof of a different target — and `location` IS NOT TARGET
 * IDENTITY. Every adapter maps it many-to-one:
 *
 * - the local adapter ignores it entirely; there is one fixed key, so every
 *   local location string names the same store;
 * - a Microsoft share link for one workbook differs textually run to run
 *   (the `?e=` token, `:x:/g/` vs `Doc.aspx?sourcedoc=`) while Graph
 *   resolves them all to the same driveItem;
 * - a NEW Apps Script deployment mints a new /exec URL for the SAME bound
 *   spreadsheet.
 *
 * The comparison was wrong in the unsafe direction: a false "different
 * target" dropped the protection, and `connect` then blind-wrote the app's
 * own copy of the tab it could not parse — EMPTY, precisely because it could
 * not be parsed — over the user's rows, which both cloud writers clear before
 * writing. A read is what produced the verdict, so a read is what retires it.
 *
 * The payload is used for NOTHING but this verdict. `connect` writes and
 * never reads the model; replacing the in-memory model here would clobber
 * exactly the unsaved local edits that "write, never read" exists to keep.
 *
 * A `kind: 'unread'` outcome means the target could not be read at all —
 * which is not evidence that it is clean, and callers must not treat it as
 * such. It carries the reason: a consent prompt, a blocked popup or a
 * wrong sharing link used to vanish into a blanket `catch { return null }`
 * while the app went on telling the user to fix a header in the spreadsheet
 * they had just left. The trade is safe; the silence was not.
 */
async function readVerdict(config: BackendConfig): Promise<ReadOutcome> {
  try {
    const payload = await getAdapter(config.backend).read(config);
    const model_ = rowsToModel(payload);
    const schedule_ = rowsToScheduleEntries(payload);
    const meta_ = rowsToMeta(payload);
    return {
      kind: 'verdict',
      verdict: {
        unreadableTabs: [
          ...model_.unreadableTabs,
          ...schedule_.unreadableTabs,
          ...meta_.unreadableTabs,
        ],
        problems: [...model_.problems, ...schedule_.problems, ...meta_.problems],
      },
    };
  } catch (error) {
    return { kind: 'unread', error: messageOf(error) };
  }
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
 * True when the model implies a schedule but there is no allocated month to
 * build one over. `monthsOf` is derived from ALLOCATIONS ONLY, so this is the
 * CAUSE behind "the recalculation placed nothing" for a model that plainly
 * has a schedule — and the only one that names an action the user can take.
 */
function hasNoAllocatedMonths(model: Model): boolean {
  return impliesSchedule(model) && monthsOf(model).length === 0;
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

/**
 * True when the in-memory model holds NOTHING for `tab`.
 *
 * This is the discriminator `connect` was missing. `readVerdict` answers
 * "is the target parseable?"; the question that must be answered before a
 * push overwrites a tab is "does the target hold rows the model does not?".
 * The two coincide only while parseability is unchanged since the read that
 * populated the model, and they diverge in exactly one direction —
 * unparseable becoming parseable — which is precisely the direction where
 * `parseTab` dropped the tab, so the in-memory copy is EMPTY and the
 * target's copy is FULL.
 */
function isEmptyInMemory(
  tab: TabName,
  model: Model,
  entries: ScheduleResult['entries'],
  hash: string | null,
): boolean {
  switch (tab) {
    case 'OTLs': return model.otls.length === 0;
    case 'People': return model.people.length === 0;
    case 'StatHolidays': return model.statHolidays.length === 0;
    case 'Allocations': return model.allocations.length === 0;
    case 'Leave': return model.leave.length === 0;
    case 'Overrides': return model.overrides.length === 0;
    case 'Schedule': return entries.length === 0;
    case 'Meta': return hash === null || hash === '';
  }
}

/**
 * The tabs a standing verdict protects that the fresh read now parses
 * cleanly, but which the model is STILL empty for — because this session
 * never loaded them.
 *
 * Retiring their protection is what let `connect` write a lone header row
 * over rows the user had just repaired the header on: the app tells them
 * "restore the header row, then reload this page", and pressing Connect
 * instead produced a clean verdict against an empty model. Keeping them
 * protected is strictly more conservative than writing them, and it matches
 * the advice the app already gives.
 */
function stillEmptyTabs(
  standing: readonly TabName[],
  verdict: ReadVerdict,
  model: Model,
  entries: ScheduleResult['entries'],
  hash: string | null,
): TabName[] {
  return standing.filter(
    (tab) => !verdict.unreadableTabs.includes(tab) && isEmptyInMemory(tab, model, entries, hash),
  );
}

/**
 * The notice for a tab that now reads correctly but which this session never
 * loaded. Repeating "the header row does not match" would be false — the
 * user has already fixed that. The honest statement is that the app is
 * holding nothing for the tab, is still not writing over it, and a reload is
 * what picks it up.
 */
function recoveredNoticeFor(tabs: readonly TabName[]): string | null {
  if (tabs.length === 0) return null;
  const isPlural = tabs.length > 1;
  const subject = `${listTabs(tabs)} ${isPlural ? 'tabs' : 'tab'}`;
  const pronoun = isPlural ? 'them' : 'it';
  return (
    `The ${subject} now ${isPlural ? 'read' : 'reads'} correctly, but this session never loaded ` +
    `${isPlural ? 'their' : 'its'} contents, so the app is still holding nothing for ${pronoun} — ` +
    `and is still not writing over ${pronoun}. Reload this page to load ${pronoun}.`
  );
}

/** What to say when a target could not be read and so was not written to. */
function unreadTargetNotice(error: string): string {
  return (
    `Connected, but the target could not be read (${error}), so nothing was written to it — ` +
    'every tab is left exactly as it is. Reload this page once the target is reachable.'
  );
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
   * Replaces the "these tabs did not parse" verdict with one freshly read
   * off the target the store is landing on. The ref is written directly as
   * well as the state: a push already queued on the debounce timer reads
   * `unreadableTabsRef.current`, and it must not use a verdict about a
   * backend the store has just left.
   *
   * Rows that merely failed to parse are deliberately NOT reported here.
   * `connect` immediately writes the in-memory model over every tab it is
   * not protecting, so a malformed row in a readable tab is about to be
   * replaced; only a tab that could not be read at all still has something
   * to say.
   */
  const adoptVerdict = useCallback(
    (verdict: ReadVerdict, stillEmpty: readonly TabName[]): void => {
      const kept = [...new Set([...verdict.unreadableTabs, ...stillEmpty])];
      unreadableTabsRef.current = kept;
      setUnreadableTabs(kept);
      const messages = [
        verdict.unreadableTabs.length > 0
          ? dataNoticeFor(verdict.unreadableTabs, verdict.problems)
          : null,
        recoveredNoticeFor(stillEmpty),
      ].filter((text): text is string => text !== null);
      setDataNotice(messages.length === 0 ? null : messages.join(' '));
    },
    [],
  );

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
    // Schedule tab nobody wrote.
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
    try {
      const adapter = getAdapter(newConfig.backend);
      await adapter.connect(newConfig);

      // Which tabs this push must leave alone is decided by what the target
      // being connected to ACTUALLY holds, never by whether its config
      // strings look different from the last one's. The read runs after
      // `adapter.connect` because that is where interactive sign-in happens,
      // and its payload is used for nothing but the verdict.
      //
      // A read that fails says nothing about the target — least of all that
      // it is clean.
      const outcome = await readVerdict(newConfig);

      // Switching backends must not lose data: write the in-memory model to
      // the newly selected backend rather than reading it and possibly
      // clobbering unsaved local changes.
      const currentModel = modelRef.current;
      const hash = hashRef.current ?? hashModel(currentModel);
      const entries = resultRef.current.entries;

      // A clean verdict is NOT permission to write a tab this session never
      // loaded. `parseTab` drops an unreadable tab whole, so the model holds
      // nothing for it while the target holds everything — and the app's own
      // remediation ("restore the header row, then reload this page")
      // reaches exactly that state when the user presses Connect instead of
      // reloading. Such a tab keeps its protection until a read populates
      // the model with it.
      const stillEmpty =
        outcome.kind === 'verdict'
          ? stillEmptyTabs(
              unreadableTabsRef.current, outcome.verdict, currentModel, entries, hashRef.current,
            )
          : [];

      // A target we could not read is the one we know least about, so
      // protect ALL of it. Falling back to the standing verdict looks
      // equivalent but is not: on a FIRST connect there is no standing
      // verdict, so `?? unreadableTabsRef.current` degraded to `?? []` and
      // every tab was blind-written to a target the app could not read one
      // row of. At worst nothing is written, which is recoverable.
      const protectedTabs: readonly TabName[] =
        outcome.kind === 'verdict' ? [...outcome.verdict.unreadableTabs, ...stillEmpty] : ALL_TABS;

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
      if (outcome.kind === 'verdict') adoptVerdict(outcome.verdict, stillEmpty);
      setStatus('idle');
      // A failed read used to disappear into a blanket catch. Consent
      // required, a blocked popup and a wrong sharing link all land here,
      // and the user needs to know that nothing was written — otherwise the
      // app looks connected and saved when it is neither.
      setNotice(outcome.kind === 'unread' ? unreadTargetNotice(outcome.error) : null);
    } catch (error) {
      setStatus('error');
      setNotice(`Could not connect: ${messageOf(error)}.`);
    }
  }, [adoptVerdict]);

  const disconnect = useCallback(async (): Promise<void> => {
    const adapter = getAdapter(configRef.current.backend);
    try {
      await adapter.disconnect();
    } catch (error) {
      setNotice(`The backend did not disconnect cleanly: ${messageOf(error)}.`);
    } finally {
      const fallback: BackendConfig = { backend: 'local', location: '' };
      setConfig(fallback);
      saveCache(modelRef.current, hashRef.current ?? '', fallback);
      // Same rule as `connect`, for the same reason: only a read of the copy
      // being landed on can retire a verdict gathered from the copy being
      // left. Comparing configs got this wrong in both directions — the
      // fallback's location is hardcoded `''`, so ANY non-empty location
      // (including one the backend switcher carried over from a previous
      // backend) read as "a different store" and dropped the protection,
      // while the local-only adapter has exactly one store regardless.
      const outcome = await readVerdict(fallback);
      if (outcome.kind === 'verdict') {
        // Same rule as `connect`: a tab this session never loaded is empty
        // in memory, so a clean read of the store being landed on must not
        // free the next debounced push to write that emptiness over it.
        adoptVerdict(
          outcome.verdict,
          stillEmptyTabs(
            unreadableTabsRef.current, outcome.verdict, modelRef.current,
            resultRef.current.entries, hashRef.current,
          ),
        );
      }
      setStatus('idle');
    }
  }, [adoptVerdict]);

  return {
    model,
    result,
    config,
    isStale: hashModel(model) !== lastCalculatedHash,
    needsAllocation: hasNoAllocatedMonths(model),
    hasCertifiedSchedule:
      (lastCalculatedHash !== null && lastCalculatedHash !== '') || result.entries.length > 0,
    status,
    notice,
    dataNotice,
    unreadableTabs,
    update,
    cancelPendingPush,
    recalculate,
    connect,
    disconnect,
  };
}
