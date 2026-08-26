/**
 * The application shell: theme root, page header, primary navigation, the
 * recalculation banner, and the per-tab content area. Each tab renders its
 * real page — SetupPage, AllocationsPage, WeeksPage — wired to `useStore()`.
 */
import { Component, useCallback, useState } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { Theme } from '@astryxdesign/core/theme';
import { neutralTheme } from '@astryxdesign/theme-neutral/built';
import { Section } from '@astryxdesign/core/Section';
import { Layout, LayoutContent, LayoutHeader } from '@astryxdesign/core/Layout';
import { HStack } from '@astryxdesign/core/HStack';
import { Heading } from '@astryxdesign/core/Heading';
import { Button } from '@astryxdesign/core/Button';
import { Banner } from '@astryxdesign/core/Banner';
import { TabList, Tab } from '@astryxdesign/core/TabList';
import { StaleBanner } from './components/StaleBanner';
import { ConnectionSettings } from './components/ConnectionSettings';
import { SetupPage } from './pages/SetupPage';
import { AllocationsPage } from './pages/AllocationsPage';
import { WeeksPage } from './pages/WeeksPage';
import { useStore } from '../storage/store';
import type { IsoMonth, Model } from '../domain/types';

type TabValue = 'setup' | 'allocations' | 'weeks';

function isTabValue(value: string): value is TabValue {
  return value === 'setup' || value === 'allocations' || value === 'weeks';
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
 * never a stack trace, and keeps the header, tabs and connection settings
 * alive around it so the user can go and fix the cause.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { message: null };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { message: error instanceof Error ? error.message : String(error) };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    // Before anything else: make "nothing was saved over" true. A push may
    // already be sitting on the store's 2s debounce, aimed at the very
    // model the failing render could not make sense of.
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

export function App() {
  const {
    model, isStale, status, notice, dataNotice,
    update, cancelPendingPush, recalculate, config, connect,
  } = useStore();
  const [activeTab, setActiveTab] = useState<TabValue>('setup');
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  // ConnectionSettings is a controlled form: it reports edits via `onChange`
  // and only asks the store to actually connect (write to the backend) once
  // the user presses Connect (`onConnect`). This local draft holds the
  // in-progress edit, seeded from the store's committed config each time the
  // dialog opens, so cancelling never touches the real connection.
  const [draftConfig, setDraftConfig] = useState(config);
  // Held here, not per-page, so switching tabs (Allocations ↔ Weeks) keeps
  // the manager's place instead of resetting to the current month.
  const [month, setMonth] = useState<IsoMonth>(() => currentMonth());

  const openConnectionSettings = (): void => {
    setDraftConfig(config);
    setIsSettingsOpen(true);
  };

  // AllocationsPage/WeeksPage take `update` as "apply this whole next
  // model" — the store's `update` takes an updater function instead, so
  // this adapts one shape to the other in exactly one place.
  const applyModel = useCallback((next: Model) => update(() => next), [update]);

  return (
    <Theme theme={neutralTheme}>
      <Section variant="section" maxWidth={1440} padding={8}>
        <Layout
          header={
            <LayoutHeader hasDivider role="banner">
              <HStack hAlign="between" vAlign="center">
                <Heading level={1}>Timesheet helper</Heading>
                <Button
                  label="Connection settings"
                  variant="secondary"
                  onClick={openConnectionSettings}
                />
              </HStack>
            </LayoutHeader>
          }
          content={
            <LayoutContent>
              {/* One banner at a time (DESIGN.md §3) — merged, never stacked.
                  A data-integrity problem outranks everything else: it means
                  the spreadsheet holds data the app cannot see, and only the
                  user can fix it. So it takes the title, the other live
                  messages fall in behind it as the description, and the
                  Recalculate action stays attached when the schedule is stale
                  too. Suppressing it behind the stale banner (which is up on
                  exactly this load, because Meta's hash was written against
                  the intact model) is how the user used to never hear about
                  it at all. */}
              {dataNotice !== null ? (
                <Banner
                  status="error"
                  title={dataNotice}
                  description={[isStale ? STALE_REASON : null, notice]
                    .filter((message): message is string => message !== null && message !== '')
                    .join(' ')}
                  collapsible={false}
                  endContent={
                    isStale ? (
                      <Button label="Recalculate" variant="primary" onClick={recalculate} />
                    ) : undefined
                  }
                />
              ) : (
                <>
                  <StaleBanner
                    isStale={isStale}
                    reason={STALE_REASON}
                    onRecalculate={recalculate}
                  />
                  {!isStale && notice && (
                    <Banner
                      status={status === 'error' || status === 'offline' ? 'error' : 'info'}
                      title={notice}
                      collapsible={false}
                    />
                  )}
                </>
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
              </ErrorBoundary>
            </LayoutContent>
          }
        />
      </Section>
      <ConnectionSettings
        config={draftConfig}
        onChange={setDraftConfig}
        onConnect={() => {
          void connect(draftConfig);
          setIsSettingsOpen(false);
        }}
        isOpen={isSettingsOpen}
        onOpenChange={setIsSettingsOpen}
      />
    </Theme>
  );
}
