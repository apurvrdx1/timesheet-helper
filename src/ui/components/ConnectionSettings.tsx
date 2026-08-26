/**
 * The backend connection form. Every field on screen — which ones appear,
 * their labels, their input type, whether Connect is blocked — comes from
 * the storage layer (`registry.ts`'s `getConnectionFields`/
 * `getConnectionNotice` and the active adapter's own `validate()`), never
 * from a hardcoded `if (backend === 'google')` here. If a backend name ever
 * needs to appear in this file, that is a sign the abstraction leaked and
 * the fix belongs in `src/storage/`, not here.
 */
import { useMemo, useState } from 'react';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { Layout, LayoutContent, LayoutFooter } from '@astryxdesign/core/Layout';
import { FormLayout } from '@astryxdesign/core/FormLayout';
import { Selector } from '@astryxdesign/core/Selector';
import { TextInput } from '@astryxdesign/core/TextInput';
import { Button } from '@astryxdesign/core/Button';
import { Banner } from '@astryxdesign/core/Banner';
import { Link } from '@astryxdesign/core/Link';
import {
  getAdapter,
  listAdapters,
  getConnectionFields,
  getConnectionNotice,
  type ConnectionField,
} from '../../storage/registry';
import type { BackendConfig, BackendId } from '../../storage/adapter';

export interface ConnectionSettingsProps {
  config: BackendConfig;
  onChange: (config: BackendConfig) => void;
  onConnect: () => void;
  /** @default true — this component owns whether it's shown at all. */
  isOpen?: boolean;
  onOpenChange?: (isOpen: boolean) => void;
}

function isBackendId(value: string): value is BackendId {
  return listAdapters().some((adapter) => adapter.id === value);
}

export function ConnectionSettings({
  config,
  onChange,
  onConnect,
  isOpen = true,
  onOpenChange,
}: ConnectionSettingsProps) {
  const [problems, setProblems] = useState<string[]>([]);

  const backendOptions = useMemo(
    () => listAdapters().map((adapter) => ({ value: adapter.id, label: adapter.label })),
    [],
  );
  const fields = getConnectionFields(config.backend);
  const notice = getConnectionNotice(config.backend);

  const handleOpenChange = (open: boolean): void => {
    onOpenChange?.(open);
  };

  const handleBackendChange = (value: string): void => {
    // Switching backends must not lose the in-memory config for the one
    // being left — only `backend` itself changes here.
    if (isBackendId(value)) {
      onChange({ ...config, backend: value });
      setProblems([]);
    }
  };

  const handleFieldChange = (key: ConnectionField['key'], value: string): void => {
    onChange({ ...config, [key]: value });
  };

  const handleConnect = (): void => {
    const found = getAdapter(config.backend).validate(config);
    setProblems(found);
    if (found.length === 0) {
      onConnect();
    }
  };

  return (
    <Dialog isOpen={isOpen} onOpenChange={handleOpenChange} purpose="form" width={480}>
      <Layout
        header={<DialogHeader title="Connection settings" onOpenChange={handleOpenChange} />}
        content={
          <LayoutContent>
            <FormLayout>
              <Selector
                label="Backend"
                options={backendOptions}
                value={config.backend}
                onChange={handleBackendChange}
                isDefaultOpen
              />
              {notice && (
                <Banner
                  status="info"
                  title={notice.message}
                  collapsible={false}
                  endContent={<Link href={notice.href}>{notice.linkLabel}</Link>}
                />
              )}
              {fields.map((field) => (
                <TextInput
                  key={field.key}
                  type={field.type}
                  label={field.label}
                  description={field.description}
                  value={config[field.key] ?? ''}
                  onChange={(value) => handleFieldChange(field.key, value)}
                />
              ))}
              {problems.length > 0 && (
                <Banner status="error" title="Can't connect yet" collapsible={false}>
                  <ul>
                    {problems.map((problem) => (
                      <li key={problem}>{problem}</li>
                    ))}
                  </ul>
                </Banner>
              )}
            </FormLayout>
          </LayoutContent>
        }
        footer={
          <LayoutFooter hasDivider>
            <Button label="Connect" variant="primary" onClick={handleConnect} />
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}
