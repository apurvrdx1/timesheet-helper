import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// `@testing-library/react`'s automatic per-test cleanup relies on detecting
// a global `afterEach` — this project doesn't set `test.globals` in
// vitest.config.ts, so without this, DOM from one test (e.g. an open
// Dialog) leaks into the next, both duplicating elements and re-triggering
// the showModal() polyfill below on an already-open <dialog>.
afterEach(() => {
  cleanup();
});

// jsdom does not implement <dialog>'s showModal()/close(), and several
// Astryx components (LeaveDialog's Dialog, AdminPage's AlertDialog) render a
// real <dialog> element — without this polyfill every test that renders one
// fails with "dialog.showModal is not a function" before any assertion runs.
if (typeof HTMLDialogElement !== 'undefined' && !HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement): void {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement): void {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
}
