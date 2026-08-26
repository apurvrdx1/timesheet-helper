import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App, ErrorBoundary, planNoticeBanner } from './App';

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
});

beforeEach(() => {
  localStorage.clear();
});

/**
 * `useStore()`'s mount effect reads through the configured adapter — a real
 * async chain of microtasks (`await adapter.read(...)`, then several
 * `setState` calls) with no observable UI signal on an empty cache (no
 * banner, no spinner — DESIGN.md §4 "Loading" bans one for local
 * computation). store.test.ts gets the same ordering guarantee via
 * `waitFor(() => status === 'idle')`, which isn't available from outside the
 * hook; flushing a macrotask (after every already-queued microtask has run)
 * is the App-level equivalent. Without this, a test that both changes store
 * state and asserts on it immediately after mount races the mount effect's
 * own `setLastCalculatedHash` / `setModel` calls.
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

/** The local adapter's own storage key — the backend App reads through on
 * mount, not the client-side cache. */
const LOCAL_ADAPTER_KEY = 'timesheet-helper:payload:v1';

describe('App: a data-integrity problem is never suppressed', () => {
  it('shows the unreadable tab and the Recalculate action in one banner', async () => {
    // One capital R in the People header: the whole tab drops, and the Meta
    // hash was written against the intact model, so the schedule reads as
    // stale on exactly this load. The user used to see the stale banner and
    // nothing at all about the tab that had just vanished.
    localStorage.setItem(LOCAL_ADAPTER_KEY, JSON.stringify({
      People: [['id', 'name', 'Role', 'managerId'], ['p1', 'Alex', 'MANAGER', '']],
    }));

    render(<App />);
    await settle();

    expect(screen.getByText(/People tab could not be read/i)).toBeInTheDocument();
    expect(screen.getByText(/will not write over it/i)).toBeInTheDocument();
    // Merged, not stacked (DESIGN.md §3): the stale message and its action
    // ride along in the same banner.
    expect(screen.getByText(/out of date/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /recalculate/i })).toBeInTheDocument();
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
// by what the message said. A single skipped malformed row rendered as a
// persistent red error banner, and a real "could not save to the backend"
// failure was demoted to description text under it, losing its error
// styling entirely.
// ---------------------------------------------------------------------------

describe('planNoticeBanner: severity follows the message, not the slot', () => {
  const clean = {
    dataNotice: null,
    hasUnreadableTab: false,
    notice: null,
    status: 'idle' as const,
    staleReason: null,
  };

  it('has nothing to say when nothing is live', () => {
    expect(planNoticeBanner(clean)).toBeNull();
  });

  it('treats a skipped row as informational, not an error', () => {
    const plan = planNoticeBanner({
      ...clean,
      dataNotice: "Loaded with 1 problem(s) in the backend's data — see the console for detail.",
    });
    expect(plan?.status).toBe('info');
    expect(plan?.title).toMatch(/1 problem/);
  });

  it('treats a tab that could not be read at all as an error', () => {
    const plan = planNoticeBanner({
      ...clean,
      dataNotice: 'The People tab could not be read: …',
      hasUnreadableTab: true,
    });
    expect(plan?.status).toBe('error');
  });

  it('keeps a save failure at error severity and in the lead, even beside a skipped row', () => {
    const plan = planNoticeBanner({
      ...clean,
      dataNotice: "Loaded with 1 problem(s) in the backend's data — see the console for detail.",
      notice: 'Could not save to the backend: quota exceeded. Your changes are kept locally.',
      status: 'error',
    });
    expect(plan?.status).toBe('error');
    expect(plan?.title).toMatch(/could not save to the backend/i);
    expect(plan?.description).toMatch(/1 problem/);
  });

  it('leaves an unreadable tab in the lead when both are errors', () => {
    const plan = planNoticeBanner({
      ...clean,
      dataNotice: 'The People tab could not be read: …',
      hasUnreadableTab: true,
      notice: 'Could not save to the backend: quota exceeded. Your changes are kept locally.',
      status: 'error',
    });
    expect(plan?.status).toBe('error');
    expect(plan?.title).toMatch(/People tab could not be read/);
    expect(plan?.description).toMatch(/could not save to the backend/i);
  });

  it('does not swallow a sync notice behind the stale message', () => {
    const plan = planNoticeBanner({
      ...clean,
      notice: 'Could not reach the backend (network down). Showing your last saved copy.',
      status: 'offline',
      staleReason: 'The schedule changed since the last recalculation — results are out of date.',
    });
    expect(plan?.status).toBe('error');
    expect(plan?.title).toMatch(/could not reach the backend/i);
    expect(plan?.description).toMatch(/out of date/);
  });
});

describe('App: a skipped row is an informational notice, not a red error', () => {
  it('renders the row-level data notice without error styling', async () => {
    // The tab's header is fine; one row carries an unparseable role, so it
    // is skipped and reported. Nothing is being withheld from the backend.
    localStorage.setItem(LOCAL_ADAPTER_KEY, JSON.stringify({
      People: [
        ['id', 'name', 'role', 'managerId'],
        ['p1', 'Alex', 'BOSS', ''],
        ['p2', 'Sam', 'REPORT', ''],
      ],
    }));
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    render(<App />);
    await settle();

    const notice = screen.getByText(/1 problem\(s\) in the backend's data/i);
    expect(notice).toBeInTheDocument();
    // Astryx's Banner gives an error status the assertive `role="alert"` and
    // an informational one the polite `role="status"`, so the ARIA role of
    // the banner this message sits in IS its severity.
    expect(notice.closest('[role="alert"]')).toBeNull();
    expect(notice.closest('[role="status"]')).not.toBeNull();

    consoleWarn.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// N3 regression: a model with people and an override but nothing allocated
// has no month for `recalculate` to schedule over, so the recalculation
// placed nothing every time and never recorded a hash. The banner stayed up
// for the whole session, its one primary action failed on every press, and
// nothing was written to make it stop — while the Weeks page rendered a full
// schedule on screen. An empty scheduling window is an empty state.
// ---------------------------------------------------------------------------

/** People and an override, and not one allocated month. */
const NOTHING_ALLOCATED = {
  OTLs: [
    ['projectCode', 'taskCode', 'expenditureTypeCode', 'timeReportingCode', 'category', 'leaveSubtype', 'isDefaultOpex', 'colorIndex', 'active'],
    ['OPEX-ADMIN', 'T0', 'E0', 'R0', 'OPEX', '', 'TRUE', '1', 'TRUE'],
  ],
  People: [['id', 'name', 'role', 'managerId'], ['p1', 'Alex', 'MANAGER', '']],
  Overrides: [['personId', 'date', 'otlProjectCode', 'hours'], ['p1', '2026-09-07', 'OPEX-ADMIN', '7.5']],
};

describe('App: no allocated month is an empty state, not a permanent nag', () => {
  it('offers no stale banner and no Recalculate action when there is no month to schedule over', async () => {
    localStorage.setItem(LOCAL_ADAPTER_KEY, JSON.stringify(NOTHING_ALLOCATED));

    render(<App />);
    await settle();

    expect(screen.queryByText(/out of date/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /recalculate/i })).not.toBeInTheDocument();
  });

  it('names the missing allocation on the Allocations tab instead', async () => {
    localStorage.setItem(LOCAL_ADAPTER_KEY, JSON.stringify(NOTHING_ALLOCATED));

    render(<App />);
    await settle();
    await openTab(/allocations/i);

    expect(screen.getByText(/allocate hours to a month to see them scheduled/i)).toBeInTheDocument();
  });

  it('still offers Recalculate once a month has an allocation', async () => {
    localStorage.setItem(LOCAL_ADAPTER_KEY, JSON.stringify({
      ...NOTHING_ALLOCATED,
      Allocations: [
        ['month', 'otlProjectCode', 'personId', 'hours'],
        ['2026-09', 'OPEX-ADMIN', 'p1', '40'],
      ],
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
// while the backend still held the schedule rows and `Meta` still certified
// the old hash, and WeeksPage recomputed from the current model. The screen
// and the sheet disagreed, with nothing saying so. Silent staleness is this
// project's named recurring failure mode.
// ---------------------------------------------------------------------------

/** The same model, but a schedule WAS calculated for it once: `Meta`
 *  certifies a hash, and the `Schedule` tab holds the rows it certifies.
 *  Then the allocations went away. */
const CERTIFIED_THEN_UNALLOCATED = {
  ...NOTHING_ALLOCATED,
  Schedule: [
    ['personId', 'date', 'otlProjectCode', 'blocks', 'source', 'overrideBlocks'],
    ['p1', '2026-09-07', 'OPEX-ADMIN', '2', 'OVERRIDE', '2'],
  ],
  Meta: [['key', 'value'], ['modelHash', 'the-hash-it-was-scheduled-against']],
};

describe('App: a certified schedule that lost its allocations still says so', () => {
  it('keeps a banner up naming the missing allocation, without offering Recalculate', async () => {
    localStorage.setItem(LOCAL_ADAPTER_KEY, JSON.stringify(CERTIFIED_THEN_UNALLOCATED));

    render(<App />);
    await settle();

    expect(screen.getByText(/stored schedule no longer matches/i)).toBeInTheDocument();
    // The action still cannot succeed, so it is still not offered.
    expect(screen.queryByRole('button', { name: /recalculate/i })).not.toBeInTheDocument();
  });

  it('names the allocation that is missing, so the banner is actionable', async () => {
    localStorage.setItem(LOCAL_ADAPTER_KEY, JSON.stringify(CERTIFIED_THEN_UNALLOCATED));

    render(<App />);
    await settle();

    expect(screen.getByText(/no allocated months/i)).toBeInTheDocument();
  });
});
