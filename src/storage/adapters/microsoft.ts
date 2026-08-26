/**
 * Placeholder stub. Replaced wholesale by Task 14 (Microsoft 365 Excel
 * backend). Conforms to the `StorageAdapter` shape so the registry can list
 * all three backends before the real implementation lands. No MSAL, no
 * Graph calls here — see Task 14.
 */
import type { StorageAdapter } from '../adapter';

export const microsoftAdapter: StorageAdapter = {
  id: 'microsoft',
  label: 'Microsoft 365 Excel',
  validate: () => ['Microsoft 365 Excel support is not implemented yet.'],
  connect: async () => {},
  disconnect: async () => {},

  async read() {
    throw new Error('Not implemented yet');
  },

  async write() {
    throw new Error('Not implemented yet');
  },
};
