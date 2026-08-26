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

function monthsOf(model: Model): IsoMonth[] {
  return [...new Set(model.allocations.map((a) => a.month))].sort();
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const pushToAdapter = useCallback(
    async (pushModel: Model, entries: ScheduleResult['entries'], hash: string | null) => {
      setStatus('syncing');
      try {
        const adapter = getAdapter(configRef.current.backend);
        await adapter.write(configRef.current, buildSheetPayload(pushModel, entries, hash ?? ''));
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

        const { model: readModel, problems: modelProblems } = rowsToModel(payload);
        const { entries, problems: scheduleProblems } = rowsToScheduleEntries(payload);
        const { hash: metaHash } = rowsToMeta(payload);

        setModel(readModel);
        setResult({ entries, residuals: [], violations: [] });
        setLastCalculatedHash(metaHash);
        saveCache(readModel, metaHash ?? hashModel(readModel), startingConfig);
        setStatus('idle');

        const problemCount = modelProblems.length + scheduleProblems.length;
        setNotice(
          problemCount > 0
            ? `Loaded with ${problemCount} problem(s) in the backend's data — see the console for detail.`
            : null,
        );
        if (problemCount > 0) {
          // eslint-disable-next-line no-console
          console.warn('Problems loading from backend:', [...modelProblems, ...scheduleProblems]);
        }
      } catch (error) {
        if (cancelled) return;
        const cached = loadCache();
        if (cached) {
          setModel(cached.model);
          setLastCalculatedHash(cached.hash);
          setConfig(cached.config);
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
    const newResult = scheduleAll(currentModel, monthsOf(currentModel));
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

      // Switching backends must not lose data: write the in-memory model to
      // the newly selected backend rather than reading it and possibly
      // clobbering unsaved local changes.
      const currentModel = modelRef.current;
      const hash = hashRef.current ?? hashModel(currentModel);
      await adapter.write(
        newConfig,
        buildSheetPayload(currentModel, resultRef.current.entries, hash),
      );

      setConfig(newConfig);
      saveCache(currentModel, hash, newConfig);
      setStatus('idle');
      setNotice(null);
    } catch (error) {
      setStatus('error');
      setNotice(`Could not connect: ${messageOf(error)}.`);
    }
  }, []);

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
      setStatus('idle');
    }
  }, []);

  return {
    model,
    result,
    config,
    isStale: hashModel(model) !== lastCalculatedHash,
    status,
    notice,
    update,
    recalculate,
    connect,
    disconnect,
  };
}
