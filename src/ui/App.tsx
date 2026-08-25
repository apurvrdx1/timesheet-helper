import { Theme } from '@astryxdesign/core/theme';
import { neutralTheme } from '@astryxdesign/theme-neutral/built';

export function App() {
  return (
    <Theme theme={neutralTheme}>
      <main><h1>Timesheet Helper</h1></main>
    </Theme>
  );
}
