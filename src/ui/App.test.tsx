import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { App } from './App';

// The Astryx neutral theme's CSS (theme-neutral/theme.css) is written as
// `@scope ([data-astryx-theme="neutral"]) to ([data-astryx-theme])` — most of
// its rules only apply inside that scope. `<Theme theme={neutralTheme}>` is
// the package's real (if inconsistently documented) integration: as the root
// Theme in the tree, it syncs `data-astryx-theme="neutral"` onto
// `document.documentElement`. Without that attribute present, the theme's
// CSS silently never applies, even though every import resolves and the
// build succeeds. This test guards against a future refactor dropping the
// wrapper.
afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute('data-astryx-theme');
  document.documentElement.removeAttribute('data-theme');
});

describe('App', () => {
  it('applies the Astryx neutral theme scope to the document root', () => {
    render(<App />);
    expect(document.documentElement.getAttribute('data-astryx-theme')).toBe('neutral');
  });
});
