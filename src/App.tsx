import { useState } from 'react';
import { dayKey, longDate } from './lib/util';
import { useNow } from './hooks';
import { VIEW_TITLES, type NewTrackerRequest, type View } from './navigation';
import { TabBar } from './components/TabBar';
import { SyncPill } from './components/SyncPill';
import { StorageHelp } from './components/StorageHelp';
import { Toast } from './components/Toast';
import { TodayView } from './views/today/TodayView';
import { CheckinView, emptyCheckin, type CheckinDraft } from './views/CheckinView';
import { SettingsView } from './views/settings/SettingsView';

export function App() {
  const [view, setView] = useState<View>('today');
  // Kept here rather than in the views, so they survive switching tabs.
  const [shownDay, setShownDay] = useState(() => dayKey(Date.now()));
  const [checkin, setCheckin] = useState<CheckinDraft>(emptyCheckin);
  // A tracker being added from "+ Add" on Today or Check in, and where to go back to once it's saved or cancelled.
  const [adding, setAdding] = useState<(NewTrackerRequest & { from: View; scrollY: number }) | null>(null);
  // Arranging Today. Here so it lasts through adding a tracker from it, and ends on changing tabs.
  const [arranging, setArranging] = useState(false);

  const selectTab = (next: View) => {
    setAdding(null);
    setArranging(false);
    setView(next);
    window.scrollTo(0, 0);
  };

  const addTracker = (request: NewTrackerRequest) => {
    setAdding({ ...request, from: view, scrollY: window.scrollY });
    setView('settings');
    window.scrollTo(0, 0);
  };

  /** Back where "+ Add" was tapped (arranging, if it was there), scrolled as it was. */
  const finishAdding = () => {
    if (!adding) return;
    const { from, scrollY } = adding;
    setAdding(null);
    setView(from);
    requestAnimationFrame(() => window.scrollTo(0, scrollY));
  };

  const showSavedCheckin = (time: number) => {
    setCheckin(emptyCheckin);
    setShownDay(dayKey(time));
    selectTab('today');
  };

  return (
    <>
      <main className="page">
        <div className="page-header">
          <div>
            {view === 'today' && <TodayDate />}
            <h1>{VIEW_TITLES[view]}</h1>
          </div>
          <div className="header-actions">
            <SyncPill onClick={() => selectTab('settings')} />
            <StorageHelp onOpenSettings={() => selectTab('settings')} />
          </div>
        </div>
        {view === 'today' && (
          <TodayView shownDay={shownDay} onShowDay={setShownDay} onAddTracker={addTracker}
            arranging={arranging} onArrange={setArranging} />
        )}
        {view === 'checkin' && (
          <CheckinView draft={checkin} onChange={setCheckin} onSaved={showSavedCheckin} onAddTracker={addTracker} />
        )}
        {view === 'settings' && <SettingsView addRequest={adding} onAddDone={finishAdding} />}
      </main>
      <TabBar current={view} onSelect={selectTab} />
      <div id="toast-host" aria-live="polite">
        <Toast />
      </div>
    </>
  );
}

/** Above the Today heading: "Saturday, October 10". Checked every minute, so it turns over at midnight. */
function TodayDate() {
  const now = useNow(60_000);
  return <p className="page-date">{longDate(now)}</p>;
}
