/**
 * The application shell: theme root, page header, primary navigation, the
 * recalculation banner, and the per-tab content area. Task 16 wires the
 * shell and nav only — each tab's real content (the OTL/person setup
 * table, the allocation grid, the week accordions) belongs to later tasks
 * and is stood in for here with a DESIGN.md-compliant empty state that
 * names the next action rather than the absence of data.
 */
import { useState } from 'react';
import { Theme } from '@astryxdesign/core/theme';
import { neutralTheme } from '@astryxdesign/theme-neutral/built';
import { Section } from '@astryxdesign/core/Section';
import { Layout, LayoutContent, LayoutHeader } from '@astryxdesign/core/Layout';
import { HStack } from '@astryxdesign/core/HStack';
import { Heading } from '@astryxdesign/core/Heading';
import { Button } from '@astryxdesign/core/Button';
import { Banner } from '@astryxdesign/core/Banner';
import { TabList, Tab } from '@astryxdesign/core/TabList';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { StaleBanner } from './components/StaleBanner';
import { ConnectionSettings } from './components/ConnectionSettings';
import { useStore } from '../storage/store';

type TabValue = 'setup' | 'allocations' | 'weeks';

function isTabValue(value: string): value is TabValue {
  return value === 'setup' || value === 'allocations' || value === 'weeks';
}

const TABS: ReadonlyArray<{ value: TabValue; label: string; emptyTitle: string }> = [
  { value: 'setup', label: 'Setup', emptyTitle: 'Add your first OTL to start allocating hours.' },
  {
    value: 'allocations',
    label: 'Allocations',
    emptyTitle: 'Add an OTL and a report to start allocating hours.',
  },
  {
    value: 'weeks',
    label: 'Weeks',
    emptyTitle: 'Weeks appear here once hours are allocated and recalculated.',
  },
];

/** Names what went stale. The store tracks staleness as a boolean (a model
 * hash mismatch) rather than a specific field diff, so the reason is
 * necessarily general — still a statement of fact, never "Oops". */
const STALE_REASON = 'The schedule changed since the last recalculation — results are out of date.';

export function App() {
  const { model, isStale, status, notice, recalculate, config, connect } = useStore();
  const [activeTab, setActiveTab] = useState<TabValue>('setup');
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  // ConnectionSettings is a controlled form: it reports edits via `onChange`
  // and only asks the store to actually connect (write to the backend) once
  // the user presses Connect (`onConnect`). This local draft holds the
  // in-progress edit, seeded from the store's committed config each time the
  // dialog opens, so cancelling never touches the real connection.
  const [draftConfig, setDraftConfig] = useState(config);

  const activeEmptyTitle = TABS.find((tab) => tab.value === activeTab)?.emptyTitle ?? '';

  const openConnectionSettings = (): void => {
    setDraftConfig(config);
    setIsSettingsOpen(true);
  };

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
              <EmptyState title={activeEmptyTitle} description={`${model.otls.length} OTL(s) configured.`} />
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
