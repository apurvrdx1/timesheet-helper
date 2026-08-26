/**
 * The application shell: theme root, page header, primary navigation, the
 * recalculation banner, and the per-tab content area. Each tab renders its
 * real page — SetupPage, AllocationsPage, WeeksPage — wired to `useStore()`.
 */
import { useCallback, useState } from 'react';
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

export function App() {
  const { model, isStale, status, notice, update, recalculate, config, connect } = useStore();
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
              <StaleBanner
                isStale={isStale}
                reason={STALE_REASON}
                onRecalculate={recalculate}
              />
              {/* One banner at a time (DESIGN.md §3): a connectivity notice only
                  shows once the stale banner — the higher-priority, more actionable
                  message — isn't already occupying the slot. */}
              {!isStale && notice && (
                <Banner
                  status={status === 'error' || status === 'offline' ? 'error' : 'info'}
                  title={notice}
                  collapsible={false}
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
              </TabList>
              {activeTab === 'setup' && <SetupPage model={model} update={update} />}
              {activeTab === 'allocations' && (
                <AllocationsPage model={model} month={month} update={applyModel} onMonthChange={setMonth} />
              )}
              {activeTab === 'weeks' && (
                <WeeksPage model={model} month={month} update={applyModel} onMonthChange={setMonth} />
              )}
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
