import { useState } from 'react';
import { dayKey } from './lib/util';
import { TabBar, VIEW_TITLES, type View } from './components/TabBar';
import { SyncPill } from './components/SyncPill';
import { Toast } from './components/Toast';
import { TodayView } from './views/today/TodayView';
import { CheckinView, emptyCheckin, type CheckinDraft } from './views/CheckinView';
import { SettingsView } from './views/settings/SettingsView';

export function App() {
  const [view, setView] = useState<View>('today');
  // Kept here rather than in the views, so they survive switching tabs.
  const [shownDay, setShownDay] = useState(() => dayKey(Date.now()));
  const [checkin, setCheckin] = useState<CheckinDraft>(emptyCheckin);

  const selectTab = (next: View) => {
    setView(next);
    window.scrollTo(0, 0);
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
          <h1>{VIEW_TITLES[view]}</h1>
          <SyncPill onClick={() => setView('settings')} />
        </div>
        {view === 'today' && <TodayView shownDay={shownDay} onShowDay={setShownDay} />}
        {view === 'checkin' && <CheckinView draft={checkin} onChange={setCheckin} onSaved={showSavedCheckin} />}
        {view === 'settings' && <SettingsView />}
      </main>
      <TabBar current={view} onSelect={selectTab} />
      <div id="toast-host" aria-live="polite">
        <Toast />
      </div>
    </>
  );
}
