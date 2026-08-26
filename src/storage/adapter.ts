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
  /**
   * Writes the tabs the payload carries. A tab the payload OMITS must be
   * left exactly as it is on the backend — never cleared, never emptied.
   * That is how the app protects a tab it could not read (a hand-edited
   * header) from being replaced with nothing.
   */
  write(config: BackendConfig, payload: Partial<SheetPayload>): Promise<void>;
  disconnect(): Promise<void>;
}
