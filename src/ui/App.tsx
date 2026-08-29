/**
 * The application shell: theme root, the auth gate, page header, primary
 * navigation, the recalculation banner, and the per-tab content area. Each tab
 * renders its real page — SetupPage, AllocationsPage, WeeksPage, AdminPage —
 * wired to `useStore()`.
 *
 * `AuthGate` sits INSIDE `Theme` and OUTSIDE everything else, for two
 * reasons. The signed-out screens (`SignInPage`, `PendingApproval`) render
 * Astryx components and need the theme scope on `document.documentElement`
 * just as much as the planner does. And `useStore()` reads the whole account
 * on mount, so it must not run for a visitor who has no session or no
 * approval — hence the planner is a separate component that only mounts once
 * the gate has let someone through.
 */
import { Component, useCallback, useState } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { Theme } from '@astryxdesign/core/theme';
import { neutralTheme } from '@astryxdesign/theme-neutral/built';
import { Section } from '@astryxdesign/core/Section';
import { Layout, LayoutContent, LayoutHeader } from '@astryxdesign/core/Layout';
import { HStack } from '@astryxdesign/core/HStack';
import { VStack } from '@astryxdesign/core/VStack';
import { Spinner } from '@astryxdesign/core/Spinner';
import { Heading } from '@astryxdesign/core/Heading';
import { Text } from '@astryxdesign/core/Text';
import { Button } from '@astryxdesign/core/Button';
import { Banner } from '@astryxdesign/core/Banner';
import { Badge } from '@astryxdesign/core/Badge';
import { TabList, Tab } from '@astryxdesign/core/TabList';
import { StaleBanner } from './components/StaleBanner';
import { SetupPage } from './pages/SetupPage';
import { AllocationsPage } from './pages/AllocationsPage';
import { WeeksPage } from './pages/WeeksPage';
import { AdminPage } from './pages/AdminPage';
import { AuthGate } from '../auth/AuthGate';
import { useSession } from '../auth/useSession';
import { usePendingCount } from '../auth/usePendingCount';
import { useStore } from '../storage/store';
import type { StoreStatus } from '../storage/store';
import type { IsoMonth, Model } from '../domain/types';

type TabValue = 'setup' | 'allocations' | 'weeks' | 'admin';

function isTabValue(value: string): value is TabValue {
  return value === 'setup' || value === 'allocations' || value === 'weeks' || value === 'admin';
}

const TABS: ReadonlyArray<{ value: TabValue; label: string }> = [
  { value: 'setup', label: 'Setup' },
  { value: 'allocations', label: 'Allocations' },
  { value: 'weeks', label: 'Weeks' },
];

/** Today's month, in the UI layer only — src/domain/ forbids `new Date()`
 * for determinism, but the app still needs a real, current default when it
 * first opens. Local time is fine here: this only ever seeds the initial
 * `Selector` value, which the user can change immediately. */
function currentMonth(): IsoMonth {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

/** Names what went stale. The store tracks staleness as a boolean (a model
 * hash mismatch) rather than a specific field diff, so the reason is
 * necessarily general — still a statement of fact, never "Oops". */
const STALE_REASON = 'The schedule changed since the last recalculation — results are out of date.';

/** Names what went stale when recalculation cannot clear it.
 *
 * A model that was never scheduled and has nothing allocated is an empty
 * state, and `needsAllocation` rightly keeps the nag off it. A model that WAS
 * scheduled and then had its allocations removed is a different thing: the
 * account still holds the schedule rows, the stored hash still certifies them,
 * and the Weeks page recomputes from the current model — so the stored data
 * and the screen disagree. Suppressing both the banner and the action there
 * was silent staleness. The banner stays; the action, which still cannot
 * succeed, does not. */
const UNCLEARABLE_STALE_REASON =
  'The stored schedule no longer matches the model, and it cannot be rebuilt: the model has ' +
  'no allocated months to place hours into. Add an allocation on the Allocations tab for the ' +
  'month you are planning, then recalculate.';

/** What to do about a domain constraint the renderer could not satisfy.
 * The thrown message names the constraint (DESIGN.md §4 "Errors"); this
 * names the move that clears it.
 *
 * "Nothing was saved over" is a promise, so the boundary keeps it: catching
 * cancels the pending debounced push (`onError`) rather than letting the
 * write the failing render was heading towards land two seconds later.
 *
 * The move itself depends on where the user already is. Sending someone
 * standing on Setup to "the Setup tab" is a dead end — that is the tab that
 * just failed to render. */
const RECOVERY_HINT_ELSEWHERE =
  'Your data is safe — nothing was saved over. Fix the cause on the Setup tab, then press Try again.';

const RECOVERY_HINT_HERE =
  'Your data is safe — nothing was saved over. Fix the cause in the data on this page, then press Try again.';

/**
 * Which message leads the one banner, and how loudly it speaks.
 *
 * DESIGN.md §3 allows exactly one banner, and two things can want it at once:
 * the store's notice about the last load or save, and the stale message about
 * the schedule. They merge rather than stacking, and the severity comes from
 * WHAT WENT WRONG rather than from which slot the message landed in:
 *
 * - A failed save, a failed load and a refused one (`status` `'error'` or
 *   `'forbidden'`) are errors: the user's data is not where they think it is.
 *   These used to be demoted to description text under an informational
 *   notice, losing their error styling entirely.
 * - Anything the store says while it is otherwise healthy is informational.
 *
 * The stale message always trails, never leads: it is a statement about the
 * schedule and it carries its own action (the Recalculate button), so putting
 * it in front of "your changes are not being saved" would bury the one thing
 * the user has to act on.
 */
export interface NoticeBannerPlan {
  status: 'error' | 'info';
  title: string;
  description: string;
}

interface NoticeBannerInput {
  notice: string | null;
  status: StoreStatus;
  /** The stale message, when the schedule is out of date. */
  staleReason: string | null;
}

export function planNoticeBanner({
  notice, status, staleReason,
}: NoticeBannerInput): NoticeBannerPlan | null {
  if (notice === null || notice === '') return null;
  const isFailure = status === 'error' || status === 'forbidden';
  return {
    status: isFailure ? 'error' : 'info',
    title: notice,
    description: staleReason ?? '',
  };
}

interface ErrorBoundaryProps {
  children: ReactNode;
  /**
   * True when the failing page IS the one the recovery hint would otherwise
   * point at, so the hint must not send the user to where they already are.
   */
  isRecoveryPage?: boolean;
  /** Called once when a render error is caught, before anything is shown. */
  onError?: () => void;
}

interface ErrorBoundaryState {
  message: string | null;
}

/**
 * The app's last line of defence. `src/domain/` throws deliberately on a
 * model it cannot make sense of (no OTL flagged as the default OPEX code
 * being the reachable case), and every one of those throws is reachable
 * from a render path. Without a boundary, React unmounts the whole tree and
 * the user gets a blank page with no way back — for a data problem the
 * model itself tolerates.
 *
 * Renders the constraint the domain named plus the action that clears it,
 * never a stack trace, and keeps the header and tabs alive around it so the
 * user can go and fix the cause.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { message: null };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { message: error instanceof Error ? error.message : String(error) };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    // Before anything else: make "nothing was saved over" true. A push may
    // already be sitting on the store's 2s debounce, aimed at the very
    // model the failing render could not make sense of — and the store's
    // write replaces the WHOLE account, so letting it leave is not a partial
    // save, it is the account's real state replaced by a broken one.
    this.props.onError?.();
    // The screen gets the constraint; the console gets the detail needed to
    // debug it. Same split the store uses for load problems.
    // eslint-disable-next-line no-console
    console.error('A render failed:', error, info.componentStack);
  }

  private readonly retry = (): void => {
    this.setState({ message: null });
  };

  override render(): ReactNode {
    const { message } = this.state;
    if (message === null) return this.props.children;

    return (
      <Banner
        status="error"
        title={`This view could not be built: ${message}`}
        description={this.props.isRecoveryPage === true ? RECOVERY_HINT_HERE : RECOVERY_HINT_ELSEWHERE}
        collapsible={false}
        endContent={<Button label="Try again" variant="primary" onClick={this.retry} />}
      />
    );
  }
}

/**
 * Everything behind the gate. Mounted only for a signed-in, approved account,
 * which is what makes `useStore()`'s mount read legitimate.
 */
export function Planner() {
  const {
    model, isStale, needsAllocation, hasCertifiedSchedule, status, notice, isSafeToWrite,
    update, cancelPendingPush, recalculate,
  } = useStore();
  // A second `useSession()` — `AuthGate` has its own, and AdminPage already
  // does the same. The alternative is threading the session through the gate
  // as a render prop, which would make every consumer of `AuthGate` carry it.
  const { profile, signOut } = useSession();
  const isOwner = profile?.isOwner === true;

  const [activeTab, setActiveTab] = useState<TabValue>('setup');
  // Held here, not per-page, so switching tabs (Allocations ↔ Weeks) keeps
  // the manager's place instead of resetting to the current month.
  const [month, setMonth] = useState<IsoMonth>(() => currentMonth());

  // A16: the badge that replaced the spec's owner-notification email. Keyed
  // on the active tab so that leaving the Admin page after approving someone
  // re-counts, rather than leaving a stale number on the tab.
  const pendingCount = usePendingCount(isOwner, activeTab);

  // AllocationsPage/WeeksPage take `update` as "apply this whole next
  // model" — the store's `update` takes an updater function instead, so
  // this adapts one shape to the other in exactly one place.
  const applyModel = useCallback((next: Model) => update(() => next), [update]);

  /**
   * The mount read is still in flight and nothing has ever loaded.
   *
   * `isSafeToWrite` turns true only when a read resolves and never turns
   * false again, so this is the initial load and nothing else: a later save
   * is `'syncing'` too, and a load that FAILED lands on `'error'` or
   * `'forbidden'` with a banner that says so.
   */
  const isLoadingAccount = status === 'syncing' && !isSafeToWrite;

  if (isLoadingAccount) {
    // DESIGN.md §4 "Loading": no spinner for this app's own local, millisecond
    // computation, but the account read is a real Supabase round trip and
    // there is nothing drawn yet to put a Banner over — the same case
    // `AuthGate` already uses a `Spinner` for.
    //
    // Not merely cosmetic. Every control on the pages below calls the store's
    // `update`, and an edit made in this window descends from the app's own
    // empty placeholder, not from the account (store.ts, the load epoch). The
    // store refuses to write such an edit, and the read replaces it on screen
    // the moment it lands — so offering a fully interactive, apparently-EMPTY
    // planner here is inviting work that is guaranteed to be thrown away.
    return (
      <Section variant="section" maxWidth={1440} padding={8}>
        <VStack align="center" justify="center" gap={4}>
          <Spinner aria-label="Loading your data" size="lg" />
        </VStack>
      </Section>
    );
  }

  // A model with no allocated month has nothing for `recalculate` to place,
  // so Recalculate is not offered for it — a primary action that can only
  // fail is worse than no action. The missing allocation is an empty state,
  // named where it can be acted on (AllocationsPage), not a stale schedule.
  const canRecalculate = isStale && !needsAllocation;

  // Hiding the action is right; hiding the FACT is not, once a schedule has
  // actually been certified. Then the stored schedule and the model really
  // have diverged, and only the banner can say so.
  const staleReason = canRecalculate
    ? STALE_REASON
    : isStale && needsAllocation && hasCertifiedSchedule
      ? UNCLEARABLE_STALE_REASON
      : null;

  const bannerPlan = planNoticeBanner({ notice, status, staleReason });

  return (
    <Section variant="section" maxWidth={1440} padding={8}>
      <Layout
        header={
          <LayoutHeader hasDivider role="banner">
            <HStack hAlign="between" vAlign="center">
              <Heading level={1}>Timesheet helper</Heading>
              <HStack gap={3} vAlign="center">
                {profile !== null && <Text type="supporting">{profile.email}</Text>}
                <Button label="Sign out" variant="secondary" clickAction={() => signOut()} />
              </HStack>
            </HStack>
          </LayoutHeader>
        }
        content={
          <LayoutContent>
            {/* One banner at a time (DESIGN.md §3) — merged, never stacked.
                `planNoticeBanner` decides how loudly the banner speaks; the
                Recalculate action stays attached whenever the schedule is
                stale, so a load or save message never costs the user the
                primary action. With no message live at all, the stale banner
                stands on its own. */}
            {bannerPlan !== null ? (
              <Banner
                status={bannerPlan.status}
                title={bannerPlan.title}
                description={bannerPlan.description}
                collapsible={false}
                endContent={
                  canRecalculate ? (
                    <Button label="Recalculate" variant="primary" onClick={recalculate} />
                  ) : undefined
                }
              />
            ) : (
              <StaleBanner
                isStale={staleReason !== null}
                reason={staleReason ?? STALE_REASON}
                onRecalculate={canRecalculate ? recalculate : undefined}
              />
            )}
            <TabList
              value={activeTab}
              onChange={(value) => {
                if (isTabValue(value)) setActiveTab(value);
              }}
            >
              {TABS.map((tab) => (
                <Tab key={tab.value} value={tab.value} label={tab.label} />
              ))}
              {/* Owner-only. The database agrees independently — every row
                  AdminPage reads and writes is behind `profiles_owner_reads_all`
                  and `profiles_owner_updates` — so hiding the tab is the UI
                  matching the schema, not the only guard. */}
              {isOwner && (
                <Tab
                  value="admin"
                  label="Admin"
                  endContent={
                    pendingCount !== null && pendingCount > 0 ? (
                      <Badge variant="warning" label={`${pendingCount} waiting`} />
                    ) : undefined
                  }
                />
              )}
            </TabList>
            {/* Keyed by tab so moving to another tab clears a caught error
                and remounts that page: the way out of a domain constraint
                is almost always Setup, and the boundary must not stand
                between the user and it. */}
            <ErrorBoundary
              key={activeTab}
              isRecoveryPage={activeTab === 'setup'}
              onError={cancelPendingPush}
            >
              {activeTab === 'setup' && <SetupPage model={model} update={update} />}
              {activeTab === 'allocations' && (
                <AllocationsPage model={model} month={month} update={applyModel} onMonthChange={setMonth} />
              )}
              {activeTab === 'weeks' && (
                <WeeksPage model={model} month={month} update={applyModel} onMonthChange={setMonth} />
              )}
              {activeTab === 'admin' && isOwner && <AdminPage />}
            </ErrorBoundary>
          </LayoutContent>
        }
      />
    </Section>
  );
}

export function App() {
  return (
    <Theme theme={neutralTheme}>
      <AuthGate>
        <Planner />
      </AuthGate>
    </Theme>
  );
}
