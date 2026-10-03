export type View = 'today' | 'checkin' | 'settings';

export const VIEW_TITLES: Record<View, string> = {
  today: 'Today',
  checkin: 'Check in',
  settings: 'Settings',
};

export function TabBar({ current, onSelect }: { current: View; onSelect: (view: View) => void }) {
  return (
    <nav className="tabs" aria-label="Sections">
      <div className="in">
        {(Object.keys(VIEW_TITLES) as View[]).map(view => (
          <button
            key={view}
            type="button"
            data-view={view}
            aria-current={view === current ? 'page' : 'false'}
            onClick={() => onSelect(view)}
          >
            {VIEW_TITLES[view]}
          </button>
        ))}
      </div>
    </nav>
  );
}
