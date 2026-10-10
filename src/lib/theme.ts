// Light or dark: the one picked in Settings → Appearance, or else the device's. styles.css draws dark from
// <html data-theme="dark">. A script in index.html sets it before the first paint (reading the same setting); this
// keeps it right when the pick or the device's mode changes.
import { createStore, prefs } from './util';

export type ThemeChoice = 'device' | 'light' | 'dark';

/** The browser bar's color in each theme: the page background, --bg in styles.css. */
const BAR_COLORS = { light: '#E8ECE6', dark: '#1B1C1E' };

const deviceIsDark = matchMedia('(prefers-color-scheme: dark)');
const stored = prefs.get<string>('theme');

export const themeStore = createStore<ThemeChoice>(stored === 'light' || stored === 'dark' ? stored : 'device');

function apply(): void {
  const choice = themeStore.get();
  const theme = choice === 'device' ? (deviceIsDark.matches ? 'dark' : 'light') : choice;
  document.documentElement.dataset.theme = theme;
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) meta.setAttribute('content', BAR_COLORS[theme]);
}

/** Saved on this device only. 'device' saves nothing: it follows the device's light or dark mode. */
export function setTheme(choice: ThemeChoice): void {
  prefs.set('theme', choice === 'device' ? null : choice);
  themeStore.set(choice);
  apply();
}

deviceIsDark.addEventListener('change', apply);
apply();
