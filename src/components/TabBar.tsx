import { VIEW_TITLES, type View } from '../navigation';

export function TabBar({ current, onSelect }: { current: View; onSelect: (view: View) => void }) {
  return (
    <nav className="tab-bar" aria-label="Sections">
      <div className="tab-bar-inner">
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
