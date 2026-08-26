/**
 * The seam every storage backend implements. Nothing above this file may
 * ever branch on which backend is active — the UI's connection form is
 * generated from `StorageAdapter.validate()`, never from an
 * `if (backend === 'google')` ladder.
 */
import type { SheetPayload } from './serialize';

export type BackendId = 'google' | 'microsoft' | 'local';

export interface BackendConfig {
  backend: BackendId;
  /** Google: the Apps Script /exec URL. Microsoft: the workbook share link. */
  location: string;
  /** Google: shared secret. Microsoft: unused (auth is interactive). */
  secret?: string;
  /** Microsoft only: Entra app (client) id. */
  clientId?: string;
  /** Microsoft only: 'common' | 'consumers' | 'organizations' | a tenant id. */
  authority?: string;
}

export interface StorageAdapter {
  readonly id: BackendId;
  readonly label: string;
  /** Human-readable check that config is complete. Empty array = ready. */
  validate(config: BackendConfig): string[];
  /** Interactive sign-in where the backend needs it. No-op otherwise. */
  connect(config: BackendConfig): Promise<void>;
  read(config: BackendConfig): Promise<Partial<SheetPayload>>;
  write(config: BackendConfig, payload: SheetPayload): Promise<void>;
  disconnect(): Promise<void>;
}
