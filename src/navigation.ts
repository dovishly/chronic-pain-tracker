// The app's tabs, and what one tab can ask App to open on another.
import type { TrackerType } from './lib/model';

export type View = 'today' | 'checkin' | 'settings';

export const VIEW_TITLES: Record<View, string> = {
  today: 'Today',
  checkin: 'Check in',
  settings: 'Settings',
};

/** A tracker to add, asked for from a section's "+ Add" on Today or Check in: its kind and heading. */
export interface NewTrackerRequest {
  type: TrackerType;
  group: string;
}
