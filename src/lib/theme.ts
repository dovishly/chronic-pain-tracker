// Light or dark: the one picked in Settings → Appearance, or else the phone's. styles.css draws dark from
// <html data-theme="dark">. A script in index.html sets it before the first paint (reading the same setting); this
// keeps it right when the pick or the phone's mode changes.
import { createStore, prefs } from './util';

export type ThemeChoice = 'phone' | 'light' | 'dark';

/** The browser bar's color in each theme: the page background, --bg in styles.css. */
const BAR_COLORS = { light: '#E8ECE6', dark: '#1B1C1E' };

const phoneIsDark = matchMedia('(prefers-color-scheme: dark)');
const stored = prefs.get<string>('theme');

export const themeStore = createStore<ThemeChoice>(stored === 'light' || stored === 'dark' ? stored : 'phone');

function apply(): void {
  const choice = themeStore.get();
  const theme = choice === 'phone' ? (phoneIsDark.matches ? 'dark' : 'light') : choice;
  document.documentElement.dataset.theme = theme;
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) meta.setAttribute('content', BAR_COLORS[theme]);
}

/** Saved on this phone only. 'phone' saves nothing: it follows the phone's light or dark mode. */
export function setTheme(choice: ThemeChoice): void {
  prefs.set('theme', choice === 'phone' ? null : choice);
  themeStore.set(choice);
  apply();
}

phoneIsDark.addEventListener('change', apply);
apply();
