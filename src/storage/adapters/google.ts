/**
 * Placeholder stub. Replaced wholesale by Task 13 (Google Sheets backend).
 * Conforms to the `StorageAdapter` shape so the registry can list all three
 * backends before the real implementation lands. No fetch calls, no real
 * Google logic here — see Task 13.
 */
import type { StorageAdapter } from '../adapter';

export const googleAdapter: StorageAdapter = {
  id: 'google',
  label: 'Google Sheets',
  validate: () => ['Google Sheets support is not implemented yet.'],
  connect: async () => {},
  disconnect: async () => {},

  async read() {
    throw new Error('Not implemented yet');
  },

  async write() {
    throw new Error('Not implemented yet');
  },
};
