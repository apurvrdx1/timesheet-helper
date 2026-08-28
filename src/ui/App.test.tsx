import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Session, User } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Mocks
//
// `App` now renders behind `AuthGate` and its store reads through Supabase,
// so three modules have to be stood in for. `client.ts` throws at module
// scope when the env vars are absent (A8's rule: every test whose import
// graph reaches it must mock it), `useSession` decides what the gate does,
// and `createSupabaseAdapter` is the store's one door to the network.
// ---------------------------------------------------------------------------

/**
 * The stored state the mocked adapter hands back, and what it does with a
 * write. Hoisted so the `vi.mock` factories below — which run before this
 * file's own top-level statements — can close over it, and mutable so each
 * test can set the account's contents before rendering.
 */
const adapterControl = vi.hoisted(() => {
  const emptyModel = {
    otls: [], people: [], statHolidays: [], allocations: [], leave: [], overrides: [],
  };
  return {
    read: (): Promise<unknown> => Promise.resolve({ model: emptyModel, entries: [], hash: null }),
    write: (_state: unknown): Promise<void> => Promise.resolve(),
    reset(): void {
      this.read = () => Promise.resolve({ model: emptyModel, entries: [], hash: null });
      this.write = () => Promise.resolve();
    },
  };
});

/** What the mocked `profiles` queries resolve to: rows for `AdminPage`'s
 *  listing, and a count for `usePendingCount`'s head query. */
const profilesControl = vi.hoisted(() => ({
  rows: [] as unknown[],
  count: 0,
}));

vi.mock('../storage/supabase', () => ({
  createSupabaseAdapter: () => ({
    read: () => adapterControl.read(),
    write: (state: unknown) => adapterControl.write(state),
  }),
}));

vi.mock('../auth/client', () => {
  // Every PostgREST builder method returns the same thenable, so a caller can
  // chain in any order and `await` at any point — which is what `AdminPage`
  // (`select().order().order()`, `update().eq()`) and `usePendingCount`
  // (`select().eq().not()`) between them require.
  interface Result {
    data: unknown;
    error: null;
    count: number;
  }
  interface Chain extends PromiseLike<Result> {
    select: () => Chain;
    order: () => Chain;
    update: () => Chain;
    eq: () => Chain;
    not: () => Chain;
  }
  const makeChain = (): Chain => {
    const settled = Promise.resolve({
      data: profilesControl.rows,
      error: null,
      count: profilesControl.count,
    });
    const chain: Chain = {
      select: () => chain,
      order: () => chain,
      update: () => chain,
      eq: () => chain,
      not: () => chain,
      then: (onFulfilled, onRejected) => settled.then(onFulfilled, onRejected),
    };
    return chain;
  };
  return { supabase: { from: () => makeChain(), auth: { signOut: vi.fn() } } };
});

vi.mock('../auth/useSession', () => ({ useSession: vi.fn() }));

import { useSession } from '../auth/useSession';
import type { Profile, UseSessionResult } from '../auth/useSession';
import { App, ErrorBoundary, planNoticeBanner } from './App';
import type { Model, ScheduleEntry } from '../domain/types';

const mockedUseSession = useSession as unknown as Mock<() => UseSessionResult>;

// jsdom (this project's `src/test-setup.ts`, which this file must not edit
// per the storage-isolation constraint other page tests document) does not
// implement `window.matchMedia`, which Astryx's DateInput reads for
// coarse-pointer detection. Setup is App's default tab, and SetupPage's
// stat-holiday section renders a DateInput, so every test in this file needs
// the same shim SetupPage.test.tsx installs — without it, rendering the real
// App (rather than a placeholder) fails before any assertion runs.
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

const EMPTY_MODEL: Model = {
  otls: [], people: [], statHolidays: [], allocations: [], leave: [], overrides: [],
};

/** A model that plainly implies a schedule but allocates nothing. */
const NOTHING_ALLOCATED: Model = {
  ...EMPTY_MODEL,
  otls: [{
    projectCode: 'OPEX-ADMIN', taskCode: 'T0', expenditureTypeCode: 'E0',
    timeReportingCode: 'R0', category: 'OPEX', leaveSubtype: null,
    isDefaultOpex: true, colorIndex: 1, active: true,
  }],
  people: [{ id: 'p1', name: 'Alex', role: 'MANAGER', managerId: null }],
  overrides: [{ personId: 'p1', date: '2026-09-07', otlProjectCode: 'OPEX-ADMIN', hours: 7.5 }],
};

const A_SCHEDULE_ENTRY: ScheduleEntry = {
  personId: 'p1', date: '2026-09-07', otlProjectCode: 'OPEX-ADMIN',
  blocks: 2, source: 'OVERRIDE', overrideBlocks: 2,
};

function storedState(model: Model, entries: ScheduleEntry[] = [], hash: string | null = null) {
  return { model, entries, hash };
}

function makeUser(id: string, email: string): User {
  return {
    id,
    email,
    app_metadata: {},
    user_metadata: {},
    aud: 'authenticated',
    created_at: '2026-01-01T00:00:00.000Z',
  };
}

function makeSession(id: string, email: string): Session {
  return {
    access_token: 'access-token',
    refresh_token: 'refresh-token',
    expires_in: 3600,
    token_type: 'bearer',
    user: makeUser(id, email),
  };
}

function makeProfile(overrides: Partial<Profile> = {}): Profile {
  return { id: 'user-1', email: 'alex@example.com', approved: true, isOwner: false, ...overrides };
}

const signOut = vi.fn(async () => {});

/** Signs in an approved, non-owner account — the default for these tests. */
function signedIn(profile: Partial<Profile> = {}): void {
  const full = makeProfile(profile);
  mockedUseSession.mockReturnValue({
    session: makeSession(full.id, full.email),
    profile: full,
    loading: false,
    signOut,
  });
}

// The Astryx neutral theme's CSS (theme-neutral/theme.css) is written as
// `@scope ([data-astryx-theme="neutral"]) to ([data-astryx-theme])` — most of
// its rules only apply inside that scope. `<Theme theme={neutralTheme}>` is
// the package's real (if inconsistently documented) integration: as the root
// Theme in the tree, it syncs `data-astryx-theme="neutral"` onto
// `document.documentElement`. Without that attribute present, the theme's
// CSS silently never applies, even though every import resolves and the
// build succeeds. This test guards against a future refactor dropping the
// wrapper.
afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute('data-astryx-theme');
  document.documentElement.removeAttribute('data-theme');
  vi.clearAllMocks();
});

beforeEach(() => {
  adapterControl.reset();
  profilesControl.rows = [];
  profilesControl.count = 0;
  signedIn();
});

/**
 * `useStore()`'s mount effect reads the account's state — a real async chain
 * of microtasks (`await adapter.read()`, then several `setState` calls) with
 * no observable UI signal on an empty account (no banner, no spinner —
 * DESIGN.md §4 "Loading" bans one for local computation). store.test.ts gets
 * the same ordering guarantee via `waitFor(() => status === 'idle')`, which
 * isn't available from outside the hook; flushing a macrotask (after every
 * already-queued microtask has run) is the App-level equivalent.
 */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

// The Astryx TabList speaks the WAI-ARIA tabs pattern (role="tab" on each
// item) only when the caller passes `role="tablist"`; App.tsx's TabList
// doesn't (that's this app's existing, un-modified nav-strip usage — outside
// this task's scope), so each tab is a plain named button instead.
async function openTab(name: RegExp): Promise<void> {
  await userEvent.click(screen.getByRole('button', { name }));
}

describe('App', () => {
  it('applies the Astryx neutral theme scope to the document root', () => {
    render(<App />);
    expect(document.documentElement.getAttribute('data-astryx-theme')).toBe('neutral');
  });

  it("renders each tab's real page, not a placeholder, when selected", async () => {
    render(<App />);
    await settle();

    // Setup is the default tab — SetupPage's own section headings and "Add
    // OTL" action, never the old EmptyState placeholder.
    expect(screen.getByRole('heading', { name: /cost-centre codes/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add otl/i })).toBeInTheDocument();

    await openTab(/allocations/i);
    expect(screen.getByRole('heading', { name: /^allocations$/i })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: /month/i })).toBeInTheDocument();

    await openTab(/weeks/i);
    expect(screen.getByRole('heading', { name: /^weeks$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add leave/i })).toBeInTheDocument();
  });

  it('keeps the selected month when switching tabs', async () => {
    render(<App />);
    await settle();

    await openTab(/allocations/i);
    const initialLabel = screen.getByRole('combobox', { name: /month/i }).textContent;

    await userEvent.click(screen.getByRole('combobox', { name: /month/i }));
    const options = await screen.findAllByRole('option');
    const target = options.find((option) => option.textContent !== initialLabel);
    if (!target) throw new Error('expected at least one other month option');
    const targetLabel = target.textContent;
    await userEvent.click(target);

    expect(screen.getByRole('combobox', { name: /month/i }).textContent).toBe(targetLabel);

    // Round-trip through Setup (which has no month of its own) and land on
    // Weeks — App, not either page, owns the month, so it must survive both.
    await openTab(/setup/i);
    await openTab(/weeks/i);
    expect(screen.getByRole('combobox', { name: /month/i }).textContent).toBe(targetLabel);

    await openTab(/allocations/i);
    expect(screen.getByRole('combobox', { name: /month/i }).textContent).toBe(targetLabel);
  });

  it('reaches the store when the Recalculate CTA is pressed, clearing the stale banner', async () => {
    render(<App />);
    await settle();

    // A brand-new model has never been calculated, so the banner is up
    // (`useStore().isStale` is true before anything has been calculated —
    // see store.test.ts) from the very first render, with no action needed
    // to make it stale first.
    const recalculate = screen.getByRole('button', { name: /recalculate/i });
    await userEvent.click(recalculate);

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /recalculate/i })).not.toBeInTheDocument();
    });
  });

  it("opens a person's read-off week view and closes it without losing the accordion selection", async () => {
    render(<App />);
    await settle();

    // scheduleAll (which WeeksPage runs on every render) requires exactly
    // one OTL flagged as the default OPEX code, so an OTL comes first.
    await userEvent.click(screen.getByRole('button', { name: /add otl/i }));
    const addOtlDialog = screen.getByRole('dialog');
    await userEvent.type(within(addOtlDialog).getByLabelText(/project code/i), 'OPEX-ADMIN');
    await userEvent.type(within(addOtlDialog).getByLabelText(/task code/i), 'T0');
    await userEvent.type(within(addOtlDialog).getByLabelText(/expenditure type/i), 'E0');
    await userEvent.type(within(addOtlDialog).getByLabelText(/time reporting/i), 'R0');
    await userEvent.click(within(addOtlDialog).getByLabelText(/category/i));
    await userEvent.click(await screen.findByRole('option', { name: /^opex$/i }));
    await userEvent.click(within(addOtlDialog).getByRole('button', { name: /^save$/i }));
    await userEvent.click(screen.getByRole('radio', { name: /default opex for opex-admin/i }));

    // Give Weeks a person to show — the manager is the shortest path since
    // "Add manager" needs no prior selection, unlike "Add report". Scoped to
    // the open "Add manager" dialog: StatHolidayList elsewhere on the Setup
    // page has its own field labelled "Name", so an unscoped query is
    // ambiguous.
    await userEvent.click(screen.getByRole('button', { name: /add manager/i }));
    const addPersonDialog = screen.getByRole('dialog');
    await userEvent.type(within(addPersonDialog).getByLabelText(/^name$/i), 'Alex');
    await userEvent.click(within(addPersonDialog).getByRole('button', { name: /^save$/i }));

    await openTab(/weeks/i);

    // Open the first week so its per-person "View" control exists in the tree.
    const [firstWeekTrigger] = screen.getAllByRole('button', { expanded: false });
    if (!firstWeekTrigger) throw new Error('expected at least one week accordion trigger');
    await userEvent.click(firstWeekTrigger);

    expect(screen.getByRole('table', { name: /manager/i })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /view alex's week/i }));

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Alex')).toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole('button', { name: /close/i }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    // The week is still expanded — opening/closing the read-off view didn't
    // reset the accordion.
    expect(screen.getByRole('table', { name: /manager/i })).toBeInTheDocument();
  });
});

describe('App: the account is still loading', () => {
  it('shows a loading state instead of an editable, apparently-empty planner', async () => {
    // The mount read, held in flight for the whole test — the window in which
    // the account's real contents are not on screen yet.
    adapterControl.read = () => new Promise(() => {});

    render(<App />);
    await settle();

    // Nothing to type into. Every Setup control calls the store's `update`,
    // and an edit made in this window descends from the app's own empty
    // placeholder rather than from the account (see store.test.ts, F1) — so
    // the invitation to type must not be on screen at all.
    expect(screen.queryByRole('button', { name: /add otl/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /cost-centre codes/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /allocations/i })).not.toBeInTheDocument();
    // And the wait is named. DESIGN.md §4: a genuine network round trip with
    // nothing yet drawn is the one case the Spinner is for, as in `AuthGate`.
    expect(screen.getByRole('status', { name: /loading/i })).toBeInTheDocument();
  });

  it('shows the planner once the read resolves', async () => {
    render(<App />);
    await settle();

    expect(screen.queryByRole('status', { name: /loading/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add otl/i })).toBeInTheDocument();
  });
});

describe('App: the account it is signed in as', () => {
  it('shows the signed-in address and a way out, in place of the old connection settings', async () => {
    render(<App />);
    await settle();

    expect(screen.getByText('alex@example.com')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /connection settings/i })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /sign out/i }));
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it('renders nothing of the planner until the gate lets someone through', () => {
    mockedUseSession.mockReturnValue({ session: null, profile: null, loading: false, signOut });
    render(<App />);

    expect(screen.getByRole('heading', { name: /sign in/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^setup$/i })).not.toBeInTheDocument();
  });

  it('does not read the account for a session the gate turned away', async () => {
    // The read is the thing that makes the store safe to write, and an
    // unapproved account's read is a 42501 the store would have to explain.
    // Not mounting the planner at all is why it never has to.
    const read = vi.fn(adapterControl.read);
    adapterControl.read = read;
    mockedUseSession.mockReturnValue({
      session: makeSession('user-1', 'alex@example.com'),
      profile: makeProfile({ approved: false }),
      loading: false,
      signOut,
    });

    render(<App />);
    await settle();

    expect(screen.getByRole('heading', { name: /waiting for approval/i })).toBeInTheDocument();
    expect(read).not.toHaveBeenCalled();
  });
});

describe('App: the Admin tab is the owner’s alone', () => {
  it('is absent for an approved admin who does not own the account', async () => {
    render(<App />);
    await settle();

    expect(screen.queryByRole('button', { name: /^admin$/i })).not.toBeInTheDocument();
  });

  it('is offered to the owner and opens the accounts page', async () => {
    signedIn({ isOwner: true });
    render(<App />);
    await settle();

    await openTab(/admin/i);
    expect(screen.getByRole('heading', { name: /accounts/i })).toBeInTheDocument();
  });

  // A16: the spec's owner-notification email was dropped, and this is what
  // replaced it. Without a count on the tab, approving depends on the owner
  // spontaneously opening a page they have no reason to open.
  it('carries the number of accounts waiting, so the owner does not have to look', async () => {
    signedIn({ isOwner: true });
    profilesControl.count = 2;

    render(<App />);
    await settle();

    expect(screen.getByText('2 waiting')).toBeInTheDocument();
  });

  it('shows no badge when nobody is waiting', async () => {
    signedIn({ isOwner: true });
    profilesControl.count = 0;

    render(<App />);
    await settle();

    expect(screen.queryByText(/waiting/i)).not.toBeInTheDocument();
  });
});

describe('App: a load the store refused is never silent', () => {
  it('reports an unapproved account as an error, naming the approval', async () => {
    // Reachable when approval is withdrawn between the gate's profile read
    // and the store's: the gate lets the session through, the store's read
    // comes back 42501.
    const { StorageError, INSUFFICIENT_PRIVILEGE } = await import('../storage/modelAdapter');
    adapterControl.read = () =>
      Promise.reject(new StorageError('not approved', { code: INSUFFICIENT_PRIVILEGE }));

    render(<App />);
    await settle();

    expect(screen.getByText(/not approved yet/i)).toBeInTheDocument();
    expect(screen.getByText(/ask the owner to approve it/i)).toBeInTheDocument();
  });

  it('says plainly that nothing will be saved when the load failed outright', async () => {
    adapterControl.read = () => Promise.reject(new Error('the server is unreachable'));

    render(<App />);
    await settle();

    expect(screen.getByText(/could not load your data/i)).toBeInTheDocument();
  });
});

function Boom(): never {
  throw new Error('No OTL is flagged as the default OPEX code.');
}

describe('ErrorBoundary', () => {
  it('turns a domain throw into a readable, actionable message instead of a blank page', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );

    // The constraint the domain named, and the move that clears it — not a
    // stack trace (DESIGN.md §4).
    expect(screen.getByText(/no otl is flagged as the default opex code/i)).toBeInTheDocument();
    expect(screen.getByText(/setup tab/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
    expect(screen.queryByText(/\bat Boom\b/)).not.toBeInTheDocument();

    consoleError.mockRestore();
  });

  it('renders its children untouched when nothing throws', () => {
    render(
      <ErrorBoundary>
        <p>the real page</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText('the real page')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// N5 regression: RECOVERY_HINT promises "Your data is safe — nothing was
// saved over", but the boundary did not cancel the store's pending 2s
// debounce, so the write the failing render was heading towards still
// landed. And it sent the user to "the Setup tab" even when Setup was the
// tab that had just failed.
//
// The promise matters more now, not less: the store's write replaces the
// WHOLE account in one transaction, so a push aimed at a model the renderer
// could not make sense of is not a bad save, it is the account's real state
// gone.
// ---------------------------------------------------------------------------

describe('ErrorBoundary: the promise it makes is backed by what it does', () => {
  it('cancels the pending push so nothing is saved over', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onError = vi.fn();

    render(
      <ErrorBoundary onError={onError}>
        <Boom />
      </ErrorBoundary>,
    );

    expect(onError).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/nothing was saved over/i)).toBeInTheDocument();
    consoleError.mockRestore();
  });

  it('does not send the user to the Setup tab when Setup is the tab that failed', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <ErrorBoundary isRecoveryPage>
        <Boom />
      </ErrorBoundary>,
    );

    expect(screen.queryByText(/setup tab/i)).not.toBeInTheDocument();
    expect(screen.getByText(/on this page/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
    consoleError.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// N6 regression: severity was decided by which slot a message landed in, not
// by what the message said, so a real "could not save" failure could be
// demoted to description text and lose its error styling entirely.
// ---------------------------------------------------------------------------

describe('planNoticeBanner: severity follows what went wrong', () => {
  it('has nothing to say when nothing is live', () => {
    expect(planNoticeBanner({ notice: null, status: 'idle', staleReason: null })).toBeNull();
  });

  it('keeps a failed save at error severity', () => {
    const plan = planNoticeBanner({
      notice: 'Could not save to Supabase: offline.', status: 'error', staleReason: null,
    });
    expect(plan?.status).toBe('error');
  });

  it('treats a refused account as an error, not as a passing remark', () => {
    const plan = planNoticeBanner({
      notice: 'This account is not approved yet.', status: 'forbidden', staleReason: null,
    });
    expect(plan?.status).toBe('error');
  });

  it('stays informational while the store is healthy', () => {
    const plan = planNoticeBanner({
      notice: 'Could not recalculate: nothing to place.', status: 'idle', staleReason: null,
    });
    expect(plan?.status).toBe('info');
  });

  it('does not swallow a live notice behind the stale message', () => {
    const plan = planNoticeBanner({
      notice: 'Could not save to Supabase: offline.',
      status: 'error',
      staleReason: 'The schedule changed since the last recalculation.',
    });
    // The notice leads and keeps its severity; the stale message trails.
    expect(plan?.title).toMatch(/could not save/i);
    expect(plan?.description).toMatch(/schedule changed/i);
  });
});

// ---------------------------------------------------------------------------
// N3 regression: a model with people and an override but nothing allocated
// can only ever schedule nothing, so the stale banner nagged permanently and
// its one action failed on every press. That is an EMPTY STATE, named where
// it can be acted on, not staleness.
// ---------------------------------------------------------------------------

describe('App: no allocated month is an empty state, not a permanent nag', () => {
  it('offers no stale banner and no Recalculate action when there is no month to schedule over', async () => {
    adapterControl.read = () => Promise.resolve(storedState(NOTHING_ALLOCATED));

    render(<App />);
    await settle();

    expect(screen.queryByText(/out of date/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /recalculate/i })).not.toBeInTheDocument();
  });

  it('names the missing allocation on the Allocations tab instead', async () => {
    adapterControl.read = () => Promise.resolve(storedState(NOTHING_ALLOCATED));

    render(<App />);
    await settle();
    await openTab(/allocations/i);

    expect(screen.getByText(/allocate hours to a month to see them scheduled/i)).toBeInTheDocument();
  });

  it('still offers Recalculate once a month has an allocation', async () => {
    adapterControl.read = () => Promise.resolve(storedState({
      ...NOTHING_ALLOCATED,
      allocations: [{ month: '2026-09', otlProjectCode: 'OPEX-ADMIN', personId: 'p1', hours: 40 }],
    }));

    render(<App />);
    await settle();

    expect(screen.getByRole('button', { name: /recalculate/i })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// N4 regression: `needsAllocation` is the right empty state for a model that
// was NEVER scheduled. For one that WAS scheduled and then had its
// allocations removed it over-suppressed BOTH the banner and the action —
// while the account still held the schedule rows and the stored hash still
// certified the old model, and WeeksPage recomputed from the current one.
// The screen and the stored data disagreed, with nothing saying so. Silent
// staleness is this project's named recurring failure mode.
// ---------------------------------------------------------------------------

describe('App: a certified schedule that lost its allocations still says so', () => {
  /** The same model, but a schedule WAS calculated for it once: a hash is
   *  stored, and the schedule rows it certifies came back with it. Then the
   *  allocations went away. */
  const certifiedThenUnallocated = () =>
    Promise.resolve(storedState(
      NOTHING_ALLOCATED, [A_SCHEDULE_ENTRY], 'the-hash-it-was-scheduled-against',
    ));

  it('keeps a banner up naming the missing allocation, without offering Recalculate', async () => {
    adapterControl.read = certifiedThenUnallocated;

    render(<App />);
    await settle();

    expect(screen.getByText(/stored schedule no longer matches/i)).toBeInTheDocument();
    // The action still cannot succeed, so it is still not offered.
    expect(screen.queryByRole('button', { name: /recalculate/i })).not.toBeInTheDocument();
  });

  it('names the allocation that is missing, so the banner is actionable', async () => {
    adapterControl.read = certifiedThenUnallocated;

    render(<App />);
    await settle();

    expect(screen.getByText(/no allocated months/i)).toBeInTheDocument();
  });
});
