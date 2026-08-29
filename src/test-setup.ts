import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup, configure } from '@testing-library/react';

// Why 5000 and not the 1000ms default.
//
// Astryx announces field errors through a screen-reader live region
// (`useAnnounce`), which is a singleton <div aria-live> appended straight to
// document.body — outside React, so `cleanup()` below cannot touch it — and
// whose text is auto-cleared 2000ms later (`CLEAR_DELAY_MS` in
// @astryxdesign/core/dist/hooks/useAnnounce.js).
//
// An error message therefore exists TWICE for two seconds: once in the field's
// own status node, once in the live region. `screen.findByText(...)` queries
// document.body, so it sees both and throws "Found multiple elements".
//
// Whether it does is a race with no stable winner. If the assertion's first
// poll lands before the announce effect has flushed to the DOM it sees one
// node and passes; if the announce gets there first it sees two. On an idle
// machine the assertion usually wins; under CPU contention the announce does,
// which is why the suite went red on a loaded laptop and green on the same
// commit a minute later, with a different set of files failing each time.
//
// `findBy*` retries on any thrown error, so the duplicate would resolve itself
// the moment the live region self-clears — except that the default budget of
// 1000ms expires first and can never reach the 2000ms clear. Raising the
// budget past that point makes the race unloseable rather than merely
// unlikely: worst case the assertion waits out the announcement and then
// passes.
//
// The cost is that an assertion for something genuinely absent now takes 5s to
// fail instead of 1s. That is the right way round for a deploy gate — a slow
// honest failure beats a fast dishonest one — but it does mean a broken suite
// reports more slowly than it used to.
configure({ asyncUtilTimeout: 5000 });

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
