import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from './App';

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
