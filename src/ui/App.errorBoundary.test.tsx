/**
 * Review finding F3: the ErrorBoundary's promise, tested through what it
 * actually saves.
 *
 * `App.test.tsx` proves the boundary calls whatever `onError` it is handed,
 * and that is all it proves — swapping `onError={cancelPendingPush}` for
 * `onError={() => {}}` in `App.tsx` left the whole suite green at 308/308.
 * The wiring is the entire backing for a sentence shown to the user ("Your
 * data is safe — nothing was saved over"), and the store's `write` is a
 * whole-account replace, so a push aimed at a model the renderer could not
 * make sense of does not save a bad page — it replaces the account's real
 * state with one.
 *
 * So this file runs the real `App`, the real `useStore` and the real
 * `ErrorBoundary`, and asserts on the ADAPTER: what did, and did not, leave
 * for the database.
 *
 * ## Why the failing page is a stand-in
 *
 * `SetupPage` is mocked here, and nowhere else in the suite. Every throw the
 * domain raises today is caught closer to home — `WeeksPage.scheduleSafely`
 * checks the default-OPEX precondition before `scheduleAll` can throw on it,
 * which is exactly right and is not something to undo in order to have
 * something to test with. The boundary is the backstop for the throw NOBODY
 * FORESAW, and there is no reachable one to borrow.
 *
 * What is real is everything the finding is about: App wires the boundary to
 * the store, the throw happens during the re-render the user's own edit
 * caused, and the queued push it interrupts is a genuine one made by
 * `useStore.update`. The stand-in fails the way the hazard describes — it
 * cannot render the model the pending write is carrying.
 *
 * This file must therefore keep its own `vi.mock` of the page: hoisted mocks
 * are file-wide, and `App.test.tsx` needs the real Setup page.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Session, User } from '@supabase/supabase-js';

/** The stored state the mocked adapter hands back, and what it does with a
 *  write. Hoisted so the `vi.mock` factories can close over it. */
const adapterControl = vi.hoisted(() => {
  const emptyModel = {
    otls: [], people: [], statHolidays: [], allocations: [], leave: [], overrides: [],
  };
  return {
    read: (): Promise<unknown> => Promise.resolve({ model: emptyModel, entries: [], hash: null }),
    write: vi.fn(async (_state: unknown): Promise<void> => {}),
  };
});

vi.mock('../storage/supabase', () => ({
  createSupabaseAdapter: () => ({
    read: () => adapterControl.read(),
    write: (state: unknown) => adapterControl.write(state),
  }),
}));

vi.mock('../auth/client', () => ({
  supabase: {
    from: () => {
      const settled = Promise.resolve({ data: [], error: null, count: 0 });
      const chain: Record<string, unknown> = {};
      for (const method of ['select', 'order', 'update', 'eq', 'not']) {
        chain[method] = () => chain;
      }
      chain['then'] = (onFulfilled: unknown, onRejected: unknown) =>
        settled.then(onFulfilled as never, onRejected as never);
      return chain;
    },
    auth: { signOut: vi.fn() },
  },
}));

vi.mock('../auth/useSession', () => ({ useSession: vi.fn() }));

/**
 * The stand-in Setup page.
 *
 * It offers two edits and throws on the model one of them produces, so the
 * failing render is caused by the very edit whose push is still sitting on
 * the store's debounce — the hazard the boundary's `onError` exists for,
 * exactly as `ErrorBoundary`'s own doc comment describes it.
 */
vi.mock('./pages/SetupPage', () => ({
  SetupPage: ({ model, update }: { model: Model; update: (fn: (m: Model) => Model) => void }) => {
    if (model.people.length > 0) {
      throw new Error('The Setup page could not render this model.');
    }
    return (
      <div>
        <button
          type="button"
          onClick={() => update((m) => ({
            ...m,
            people: [...m.people, { id: 'p1', name: 'Alex', role: 'MANAGER', managerId: null }],
          }))}
        >
          make an edit this page cannot render
        </button>
        <button
          type="button"
          onClick={() => update((m) => ({
            ...m,
            statHolidays: [...m.statHolidays, { date: '2026-09-07', name: 'Labour Day', otlProjectCode: 'OPEX-ADMIN' }],
          }))}
        >
          make an ordinary edit
        </button>
      </div>
    );
  },
}));

import { useSession } from '../auth/useSession';
import type { Profile, UseSessionResult } from '../auth/useSession';
import { App } from './App';
import type { Model } from '../domain/types';

const mockedUseSession = useSession as unknown as Mock<() => UseSessionResult>;

// Same jsdom shim the other App-level suites install: `window.matchMedia` is
// not implemented, and Astryx's DateInput reads it.
if (typeof window.matchMedia !== 'function') {
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

function makeSession(): Session {
  const user: User = {
    id: 'user-1',
    email: 'alex@example.com',
    app_metadata: {},
    user_metadata: {},
    aud: 'authenticated',
    created_at: '2026-01-01T00:00:00.000Z',
  };
  return {
    access_token: 'access-token',
    refresh_token: 'refresh-token',
    expires_in: 3600,
    token_type: 'bearer',
    user,
  };
}

const APPROVED: Profile = {
  id: 'user-1', email: 'alex@example.com', approved: true, isOwner: false,
};

/** Lets `useStore`'s mount read resolve — see `App.test.tsx`'s `settle`. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/**
 * Past the store's 2s push debounce, on real timers.
 *
 * Fake timers are not an option: the queued push is created by a real
 * `setTimeout` during the click, so installing fake timers afterwards would
 * not capture it and the test would pass by never letting the push fire at
 * all.
 */
async function pastThePushDebounce(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 2300));
  });
}

let consoleError: ReturnType<typeof vi.spyOn> | null = null;

beforeEach(() => {
  adapterControl.write.mockClear();
  mockedUseSession.mockReturnValue({
    session: makeSession(),
    profile: APPROVED,
    loading: false,
    databaseUnreachable: false,
    signOut: vi.fn(async () => {}),
  });
  // React logs the caught error itself; the boundary logs the detail. Neither
  // is the thing under test and both would drown the run.
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  consoleError?.mockRestore();
  document.documentElement.removeAttribute('data-astryx-theme');
  vi.clearAllMocks();
});

describe('App: a render the boundary caught really does save nothing over', () => {
  it('drops the push the failing render was heading towards', async () => {
    render(<App />);
    await settle();

    // The edit queues the store's 2s debounced push, and the re-render it
    // causes is the one the page cannot survive.
    await userEvent.click(
      screen.getByRole('button', { name: /make an edit this page cannot render/i }),
    );

    // The boundary caught it, and made its promise.
    expect(screen.getByText(/the setup page could not render this model/i)).toBeInTheDocument();
    expect(screen.getByText(/nothing was saved over/i)).toBeInTheDocument();

    await pastThePushDebounce();

    // And kept it. Not "the boundary called something" — nothing reached the
    // account, so the state the user is looking at is still the stored one.
    expect(adapterControl.write).not.toHaveBeenCalled();
  });

  it('still saves an edit no render failed on', async () => {
    // The control. Without it the assertion above is satisfiable by a flow
    // that never queued a push at all, and the wiring would go untested all
    // over again.
    render(<App />);
    await settle();

    await userEvent.click(screen.getByRole('button', { name: /make an ordinary edit/i }));
    expect(screen.queryByText(/nothing was saved over/i)).not.toBeInTheDocument();

    await pastThePushDebounce();

    expect(adapterControl.write).toHaveBeenCalledTimes(1);
    const sent = adapterControl.write.mock.calls[0]?.[0] as { model: Model };
    expect(sent.model.statHolidays).toHaveLength(1);
  });
});
