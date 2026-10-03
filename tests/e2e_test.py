"""End-to-end test for Logbook.

Serves the built app (dist/) locally, drives it in headless Chromium at phone size, and fakes
the Supabase REST/Auth API in-process, so no real project or network is needed.

Run:  pip install playwright && python -m playwright install chromium
      npm test        (builds, then runs this file)
Screenshots land in tests/screenshots/ (git-ignored).
"""
import csv, json, threading, http.server, socketserver, functools, datetime, re, uuid, sys, os
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(ROOT, 'dist')
OUT = os.path.join(ROOT, 'tests', 'screenshots')
if not os.path.exists(os.path.join(DIST, 'index.html')):
    sys.exit('No build found. Run `npm run build` first, or use `npm test`.')
os.makedirs(OUT, exist_ok=True)

# ---------- static server ----------
Handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=DIST)
class Q(socketserver.ThreadingTCPServer): allow_reuse_address = True
srv = Q(('127.0.0.1', 8765), Handler)
threading.Thread(target=srv.serve_forever, daemon=True).start()
Handler.log_message = lambda *a: None

# ---------- mock Supabase ----------
DB = {'trackers': {}, 'entries': {}}
SCHEMA_VERSION = [1]   # what the fake database reports; 0 = schema.sql from before versions (function missing)
USERS = {'me@example.com': 'u1'}
TOKENS = {}
calls = []
seq = [0]
def ts_now():
    seq[0] += 1
    return (datetime.datetime(2026, 10, 3, 12, 0, 0) + datetime.timedelta(microseconds=seq[0])).isoformat() + '+00:00'

def handle(route):
    req = route.request
    u = urlparse(req.url); path = u.path; q = parse_qs(u.query)
    body = json.loads(req.post_data) if req.post_data else None
    h = req.headers
    calls.append((req.method, path))
    def ok(obj=None, status=200):
        route.fulfill(status=status, content_type='application/json', body='' if obj is None else json.dumps(obj))
    if 'apikey' not in h: return ok({'message': 'no apikey'}, 401)
    if path == '/auth/v1/otp':
        if body['email'] not in USERS: return ok({'code': 422, 'error_code': 'otp_disabled', 'msg': 'Signups not allowed for otp'}, 422)
        return ok({})
    if path == '/auth/v1/verify':
        if body.get('token') != '123456': return ok({'msg': 'Token has expired or is invalid'}, 403)
        tok = 'tok-' + uuid.uuid4().hex; TOKENS[tok] = USERS[body['email']]
        return ok({'access_token': tok, 'refresh_token': 'r-' + tok, 'expires_in': 3600, 'user': {'email': body['email']}})
    if path == '/auth/v1/logout': return ok(None, 204)
    auth = h.get('authorization', '')[7:]
    uid = TOKENS.get(auth)
    if not uid: return ok({'message': 'JWT invalid'}, 401)
    if path == '/rest/v1/rpc/logbook_schema_version':
        if not SCHEMA_VERSION[0]: return ok({'code': 'PGRST202', 'message': 'Could not find the function'}, 404)
        return ok(SCHEMA_VERSION[0])
    m = re.match(r'/rest/v1/(trackers|entries)$', path)
    if not m: return ok({'message': 'not found'}, 404)
    table = m.group(1)
    if req.method == 'POST':
        assert 'merge-duplicates' in h.get('prefer', ''), h.get('prefer')
        t = ts_now()
        for row in body:
            row = dict(row); row['user_id'] = uid; row['updated_at'] = t
            DB[table][row['id']] = row
        return ok(None, 201)
    rows = [r for r in DB[table].values() if r['user_id'] == uid]
    if 'updated_at' in q:
        op, val = q['updated_at'][0].split('.', 1)
        rows = [r for r in rows if (r['updated_at'] >= val if op == 'gte' else r['updated_at'] > val)]
    rows.sort(key=lambda r: r['updated_at'])
    lim = int(q.get('limit', ['1000'])[0]); rows = rows[:lim]
    if q.get('select', ['*'])[0] == 'id': rows = [{'id': r['id']} for r in rows]
    return ok(rows)

results = []
def check(name, cond):
    results.append((name, bool(cond))); print(('PASS ' if cond else 'FAIL ') + name)

def export_tables(page):
    """Clicks Export for analysis and returns {table name: (csv text, rows as dicts)}."""
    downloads = []
    def collect(download): downloads.append(download)
    page.on('download', collect)
    page.locator('#exportAnalysis').click()
    for _ in range(60):
        if len(downloads) >= 5: break
        page.wait_for_timeout(100)
    page.remove_listener('download', collect)
    tables = {}
    for d in downloads:
        name = d.suggested_filename.rsplit('-', 1)[1][:-len('.csv')]   # logbook-2026-10-03-daily.csv -> daily
        text = open(d.path(), encoding='utf-8').read()
        tables[name] = (text, list(csv.DictReader(text.splitlines())))
    return tables

INJECT_FIXTURE = '''async (fixture) => {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('logbook', 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise((resolve, reject) => {
    const tx = db.transaction(['trackers', 'entries', 'outbox', 'meta'], 'readwrite');
    for (const store of ['trackers', 'entries', 'outbox']) tx.objectStore(store).clear();
    fixture.trackers.forEach(t => tx.objectStore('trackers').put(t));
    fixture.entries.forEach(e => tx.objectStore('entries').put(e));
    tx.objectStore('meta').put({ k: 'seeded', v: true });
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}'''

errors = []
with sync_playwright() as p:
    br = p.chromium.launch()
    def newpage(scheme='light', timezone=None):
        ctx = br.new_context(viewport={'width': 390, 'height': 844}, color_scheme=scheme, accept_downloads=True,
                             service_workers='block', timezone_id=timezone)
        ctx.route('https://mock.supabase.co/**', handle)
        pg = ctx.new_page()
        pg.on('pageerror', lambda e: errors.append(str(e)))
        pg.on('console', lambda m: errors.append(m.text) if m.type == 'error' and 'fonts' not in m.text else None)
        pg.goto('http://127.0.0.1:8765/index.html'); pg.wait_for_timeout(600)
        return ctx, pg

    ctx, pg = newpage()
    check('defaults seeded', pg.locator('[data-episode]').count() >= 5 and pg.get_by_text('Headache').count() > 0)
    check('local-only pill', 'device only' in pg.locator('#syncPill').inner_text())

    # episodes
    pg.locator('.episode-card .episode-button', has_text='Tired').click(); pg.wait_for_timeout(150)
    check('Tired active', pg.locator('#now .running-pill', has_text='Tired').count() == 1)
    pg.locator('.episode-card .episode-button', has_text='Headache').click(); pg.wait_for_timeout(150)
    pg.locator('.episode-card.is-running .level-buttons button[data-level="2"]').first.click(); pg.wait_for_timeout(150)
    check('Headache level shows', 'Moderate' in pg.locator('#now').inner_text())
    pg.locator('#now .running-pill', has_text='Tired').click(); pg.wait_for_timeout(150)
    check('Tired ended', pg.locator('#now .running-pill', has_text='Tired').count() == 0)
    pg.locator('.moment-button', has_text='Coffee').click(); pg.wait_for_timeout(150)
    log = pg.locator('#log').inner_text()
    check('log has entries', 'Coffee' in log and 'Tired ended' in log and 'Headache: Moderate' in log)
    check('timeline has rows', pg.locator('.timeline-row').count() >= 2)
    # toast shift + undo
    pg.locator('.toast button', has_text='Undo').click(); pg.wait_for_timeout(150)
    check('undo removed coffee', 'Coffee' not in pg.locator('#log').inner_text())
    pg.locator('.moment-button', has_text='Coffee').click(); pg.wait_for_timeout(100)
    pg.locator('.toast button', has_text='15').click(); pg.wait_for_timeout(150)
    # edit note
    pg.locator('.entry-row', has_text='Coffee').click(); pg.wait_for_timeout(100)
    pg.locator('.entry-editor input[type=text]').fill('second cup'); pg.locator('[data-save-entry]').click(); pg.wait_for_timeout(150)
    check('note saved', 'second cup' in pg.locator('#log').inner_text())
    pg.screenshot(path=OUT + '/today-light.png', full_page=True)

    # check-in
    pg.locator('.tab-bar button', has_text='Check in').click(); pg.wait_for_timeout(150)
    pg.locator('.question', has_text='Mood').locator('button[data-value="4"]').click()
    pg.locator('.chip', has_text='Exercise').click(); pg.locator('.chip', has_text='Friends').click()
    pg.locator('.question', has_text='Water').locator('input').fill('3')
    pg.locator('.question', has_text='Journal').locator('textarea').fill('Felt okay after lunch')
    check('picked label shows', 'Good' in pg.locator('.question', has_text='Mood').inner_text())
    pg.screenshot(path=OUT + '/checkin-light.png', full_page=True)
    pg.locator('#ciSave').click(); pg.wait_for_timeout(200)
    log = pg.locator('#log').inner_text()
    check('check-in saved', 'Mood: Good' in log and 'Activities: Exercise' in log and 'Activities: Friends' in log and 'Water: 3 glasses' in log and 'Journal: Felt okay' in log)

    # settings: add number tracker, rename, archive
    pg.locator('.tab-bar button', has_text='Settings').click(); pg.wait_for_timeout(150)
    pg.locator('#addTracker').click(); pg.fill('#edName', 'Stiffness')
    pg.select_option('#edType', 'number'); pg.wait_for_timeout(50)
    pg.fill('#edUnit', 'minutes'); pg.fill('#edGrp', 'Check-in'); pg.locator('[data-color="rose"]').click(); pg.wait_for_timeout(50)
    check('editor kept name after color', pg.input_value('#edName') == 'Stiffness' and pg.input_value('#edUnit') == 'minutes')
    pg.locator('#edSave').click(); pg.wait_for_timeout(150)
    check('new tracker listed', 'Stiffness' in pg.locator('#trackerList').inner_text())
    pg.locator('.tracker-list li', has_text='Tired').locator('[data-edit-tracker]').click(); pg.fill('#edName', 'Sleepy')
    check('type locked with entries', pg.locator('#edType').is_disabled())
    pg.locator('#edSave').click(); pg.wait_for_timeout(150)
    pg.locator('.tracker-list li', has_text='Meal').locator('[data-edit-tracker]').click(); pg.locator('#edArchive').click(); pg.wait_for_timeout(150)
    check('archived hidden', 'Meal' not in pg.locator('#trackerList').inner_text() and 'Meal' in (pg.locator('#archList').text_content() or ''))
    pg.locator('.tracker-list li', has_text='Low mood').locator('[data-move-up]').click(); pg.wait_for_timeout(150)
    order = [x.strip() for x in pg.locator('#trackerList .tracker-name').all_inner_texts()]
    check('reorder', [o for o in order if o.startswith('Low mood') or o.startswith('Anxious')][0].startswith('Low mood'))
    # rating validation
    pg.locator('#addTracker').click(); pg.fill('#edName', 'X'); pg.select_option('#edType', 'rating'); pg.fill('#edLevels', 'only one'); pg.locator('#edSave').click(); pg.wait_for_timeout(100)
    check('rating validation', '2 to 10' in pg.locator('#edErr').inner_text()); pg.locator('#edCancel').click()
    pg.screenshot(path=OUT + '/settings-light.png', full_page=True)

    # export for analysis
    tables = export_tables(pg)
    check('export has five tables', sorted(tables) == ['checkins', 'daily', 'entries', 'episodes', 'trackers'])
    entries_csv = tables['entries'][0]
    check('entries header', entries_csv.startswith('entry_id,date,time,weekday,timestamp_utc,tracker_id,tracker,type,group,event,value,label,text,note,checkin_id,episode_id'))
    check('entries rows', ',Sleepy,episode,Symptoms,end,' in entries_csv and ',Mood,rating,Check-in,answer,4,Good,' in entries_csv and 'second cup' in entries_csv)
    check('entries exclude undone', entries_csv.count('Coffee') == 1)

    # ---------- sync ----------
    pg.fill('#cfgUrl', 'http://example.com'); pg.fill('#cfgKey', 'anon-key-0123456789abcdefghij'); pg.locator('#cfgSave').click(); pg.wait_for_timeout(100)
    check('plain http project refused', 'https://' in pg.locator('#cfgErr').inner_text())
    pg.fill('#cfgUrl', 'http://127.0.0.1:54321'); pg.locator('#cfgSave').click(); pg.wait_for_timeout(150)
    check('local http project accepted', pg.locator('#authEmail').count() == 1)
    pg.locator('#cfgDisconnect').click(); pg.wait_for_timeout(150)
    pg.fill('#cfgUrl', 'https://mock.supabase.co'); pg.fill('#cfgKey', 'anon-key-0123456789abcdefghij'); pg.locator('#cfgSave').click(); pg.wait_for_timeout(150)
    pg.fill('#authEmail', 'stranger@example.com'); pg.locator('#authSend').click(); pg.wait_for_timeout(200)
    check('unknown email refused', 'isn' in pg.locator('#authErr').inner_text())
    pg.fill('#authEmail', 'me@example.com'); pg.locator('#authSend').click(); pg.wait_for_timeout(200)
    pg.fill('#authCode', '000000'); pg.locator('#authVerify').click(); pg.wait_for_timeout(200)
    check('bad code refused', 'didn' in pg.locator('#authErr').inner_text())
    pg.fill('#authCode', '123456'); pg.locator('#authVerify').click(); pg.wait_for_timeout(1500)
    n_entries = len([r for r in DB['entries'].values()])
    check('uploaded trackers', len(DB['trackers']) == 16)
    check('uploaded entries', n_entries == len(tables['entries'][1]) + 1)  # +1 = undone coffee synced as deleted
    check('deleted flag synced', any(r['deleted'] for r in DB['entries'].values()))
    check('pill synced', 'Synced' in pg.locator('#syncPill').inner_text())
    pg.screenshot(path=OUT + '/settings-synced.png', full_page=True)

    # remote edit -> pull
    tid = [k for k, v in DB['trackers'].items() if v['name'] == 'Sleepy'][0]
    DB['trackers'][tid] = {**DB['trackers'][tid], 'name': 'Drowsy', 'updated_at': ts_now()}
    pg.locator('#syncNow').click(); pg.wait_for_timeout(800)
    check('pulled remote rename', 'Drowsy' in pg.locator('#trackerList').inner_text())

    # offline write queues, then flushes
    ctx.set_offline(True)
    pg.locator('.tab-bar button', has_text='Today').click(); pg.wait_for_timeout(100)
    pg.locator('.moment-button', has_text='Medication').click(); pg.wait_for_timeout(1200)
    check('offline pill', 'Offline' in pg.locator('#syncPill').inner_text())
    before = len(DB['entries'])
    ctx.set_offline(False); pg.evaluate('window.dispatchEvent(new Event("online"))'); pg.wait_for_timeout(1500)
    check('offline entry flushed', len(DB['entries']) == before + 1)

    # second device: fresh install, links to existing account, no local entries -> silently replaced
    ctx2, pg2 = newpage('dark')
    pg2.locator('.tab-bar button', has_text='Settings').click()
    pg2.fill('#cfgUrl', 'https://mock.supabase.co'); pg2.fill('#cfgKey', 'anon-key-0123456789abcdefghij'); pg2.locator('#cfgSave').click(); pg2.wait_for_timeout(300)
    pg2.fill('#authEmail', 'me@example.com'); pg2.locator('#authSend').click(); pg2.wait_for_timeout(200)
    SCHEMA_VERSION[0] = 0   # the account's database hasn't had the current schema.sql run yet
    pg2.fill('#authCode', '123456'); pg2.locator('#authVerify').click(); pg2.wait_for_timeout(1500)
    check('outdated database stops sync', 'Sync problem' in pg2.locator('#syncPill').inner_text()
          and 'needs an update' in pg2.locator('#syncPanel').inner_text() and 'Drowsy' not in pg2.locator('#trackerList').inner_text())
    SCHEMA_VERSION[0] = 1   # schema.sql run again
    pg2.locator('#syncNow').click(); pg2.wait_for_timeout(1500)
    names2 = pg2.locator('#trackerList').inner_text()
    check('device 2 got account trackers', 'Drowsy' in names2 and 'Stiffness' in names2)
    check('device 2 no duplicate defaults', names2.count('Headache') == 1 and len(DB['trackers']) == 16)
    pg2.locator('.tab-bar button', has_text='Today').click(); pg2.wait_for_timeout(200)
    check('device 2 sees entries', 'Medication' in pg2.locator('#log').inner_text())
    pg2.screenshot(path=OUT + '/today-dark.png', full_page=True)

    # third device: logs locally first, then links -> asked to choose
    ctx3, pg3 = newpage()
    pg3.locator('.moment-button', has_text='Coffee').click(); pg3.wait_for_timeout(100)
    # markup typed into a name is shown as text, never parsed as HTML
    tricky = '<b>Bold</b> & "Q"'
    pg3.locator('.tab-bar button', has_text='Settings').click()
    pg3.locator('#addTracker').click(); pg3.fill('#edName', tricky); pg3.select_option('#edType', 'moment'); pg3.locator('#edSave').click(); pg3.wait_for_timeout(150)
    check('name escaped in settings', tricky in pg3.locator('#trackerList').inner_text() and pg3.locator('#trackerList b').count() == 0)
    pg3.locator('.tracker-list li', has_text='Bold').locator('[data-edit-tracker]').click(); pg3.locator('#edArchive').click(); pg3.wait_for_timeout(150)
    pg3.locator('#archWrap summary').click(); pg3.locator('#archList [data-restore-tracker]').click(); pg3.wait_for_timeout(150)
    check('restore tracker', tricky in pg3.locator('#trackerList').inner_text())
    pg3.locator('.tab-bar button', has_text='Today').click(); pg3.wait_for_timeout(100)
    pg3.locator('.moment-button', has_text='Bold').click(); pg3.wait_for_timeout(150)
    check('name escaped on today', tricky in pg3.locator('#marks').inner_text() and tricky in pg3.locator('#log').inner_text()
          and pg3.locator('#marks b, #log b, #toastHost b').count() == 0)
    pg3.locator('.tab-bar button', has_text='Settings').click()
    pg3.fill('#cfgUrl', 'https://mock.supabase.co'); pg3.fill('#cfgKey', 'anon-key-0123456789abcdefghij'); pg3.locator('#cfgSave').click()
    pg3.fill('#authEmail', 'me@example.com'); pg3.locator('#authSend').click(); pg3.wait_for_timeout(200)
    pg3.fill('#authCode', '123456'); pg3.locator('#authVerify').click(); pg3.wait_for_timeout(1500)
    check('device 3 asked to choose', 'already has data' in pg3.locator('#syncPanel').inner_text())
    check('nothing uploaded from device 3', len(DB['trackers']) == 16)
    pg3.locator('#useAccount').click(); pg3.wait_for_timeout(1500)
    check('device 3 replaced', 'Drowsy' in pg3.locator('#trackerList').inner_text() and len(DB['trackers']) == 16)

    # analysis tables from known data (tests/fixtures/analysis.json; tests/schema_test.py checks the same figures in SQL)
    fixture = json.load(open(os.path.join(ROOT, 'tests', 'fixtures', 'analysis.json')))
    ctx4, pg4 = newpage(timezone=fixture['timezone'])
    pg4.evaluate(INJECT_FIXTURE, fixture)
    pg4.reload(); pg4.wait_for_timeout(600)
    pg4.locator('.tab-bar button', has_text='Settings').click()
    tables = export_tables(pg4)
    E = lambda n: f'00000000-0000-4000-9000-0000000000{n:02d}'
    C = lambda n: f'00000000-0000-4000-a000-0000000000{n:02d}'
    def matches(row, expected):
        wrong = {k: (row.get(k), v) for k, v in expected.items() if row.get(k) != v}
        if wrong: print('   mismatch:', wrong)
        return not wrong

    daily = {r['date']: r for r in tables['daily'][1]}
    check('daily: one row per day, gaps included', all(d in daily for d in ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04']))
    check('daily: Sep 1', matches(daily['2026-09-01'], {
        'weekday': 'Tue', 'checkins': '2', 'Mood (avg)': '3', 'Water (total)': '8', 'Water (avg)': '4',
        'Activities: Exercise': '1', 'Activities: Work': '1', 'Activities: Friends': '0', 'Journal (text)': 'Slept ok',
        'Headache (episodes)': '1', 'Headache (minutes)': '120', 'Headache (max level)': '3',
        'Tired (episodes)': '1', 'Tired (minutes)': '120', 'Coffee (count)': '2', 'Snack (count)': '0'}))
    check('daily: Sep 2', matches(daily['2026-09-02'], {
        'weekday': 'Wed', 'checkins': '1', 'Mood (avg)': '5', 'Water (total)': '', 'Activities: Friends': '1',
        'Activities: Exercise': '0', 'Headache (episodes)': '2', 'Headache (minutes)': '90', 'Headache (max level)': '',
        'Tired (episodes)': '0', 'Tired (minutes)': '90', 'Coffee (count)': '0', 'Snack (count)': '1'}))
    check('daily: empty day', matches(daily['2026-09-03'], {
        'checkins': '0', 'Mood (avg)': '', 'Activities: Exercise': '', 'Tired (minutes)': '0', 'Coffee (count)': '0'}))
    check('daily: running episode', matches(daily['2026-09-04'], {'Tired (episodes)': '1', 'Tired (minutes)': '1020'})
          and matches(daily['2026-09-05'], {'Tired (minutes)': '1440'}))
    check('daily: no level column without levels', 'Tired (max level)' not in tables['daily'][1][0])

    episodes = {r['episode_id']: r for r in tables['episodes'][1]}
    check('episodes: five, oldest first', [r['episode_id'] for r in tables['episodes'][1]] == [E(8), E(12), E(18), E(19), E(23)])
    check('episodes: levels and notes', matches(episodes[E(8)], {
        'tracker': 'Headache', 'start_date': '2026-09-01', 'start_time': '10:00', 'end_time': '12:00', 'duration_min': '120',
        'status': 'ended', 'max_level': '3', 'max_level_label': 'Severe', 'levels_logged': '2', 'notes': 'woke with it'}))
    check('episodes: across midnight', matches(episodes[E(12)], {
        'start_date': '2026-09-01', 'start_time': '22:00', 'end_date': '2026-09-02', 'end_time': '01:30', 'duration_min': '210'}))
    check('episodes: restarted', matches(episodes[E(18)], {'duration_min': '60', 'status': 'restarted'})
          and matches(episodes[E(19)], {'duration_min': '30', 'status': 'ended'}))
    check('episodes: ongoing', matches(episodes[E(23)], {'status': 'ongoing', 'end_date': '', 'start_date': '2026-09-04'}))

    checkins = {r['checkin_id']: r for r in tables['checkins'][1]}
    check('checkins: one row each', len(checkins) == 3)
    check('checkins: answers side by side', matches(checkins[C(1)], {
        'date': '2026-09-01', 'time': '09:00', 'Mood': '4', 'Water': '3', 'Activities: Exercise': '1',
        'Activities: Work': '1', 'Activities: Friends': '0', 'Journal': 'Slept ok'}))
    check('checkins: local date, skipped question blank', matches(checkins[C(2)], {
        'date': '2026-09-01', 'time': '20:00', 'Mood': '2', 'Water': '5', 'Activities: Exercise': ''}))
    check('checkins: notes', matches(checkins[C(3)], {'Mood': '5', 'Water': '', 'Activities: Friends': '1', 'notes': 'Mood: after a run'}))

    entries = {r['entry_id']: r for r in tables['entries'][1]}
    check('entries: deleted left out', len(entries) == 22 and E(21) not in entries)
    check('entries: level linked to episode', matches(entries[E(9)], {'event': 'level', 'value': '2', 'label': 'Moderate', 'episode_id': E(8)}))
    check('entries: end linked to episode', matches(entries[E(13)], {'episode_id': E(12)}) and matches(entries[E(20)], {'episode_id': E(19)}))
    check('entries: answer in local time', matches(entries[E(6)], {'event': 'answer', 'date': '2026-09-01', 'time': '20:00', 'timestamp_utc': '2026-09-02T00:00:00.000Z'}))
    check('entries: text answer in text column', matches(entries[E(5)], {'text': 'Slept ok', 'label': ''}))

    trackers = {r['tracker']: r for r in tables['trackers'][1]}
    check('trackers: archived with history included', matches(trackers['Snack'], {'archived': 'true'}) and len(trackers) == 8)
    check('trackers: levels and options spelled out', matches(trackers['Mood'], {'levels': '1=Awful; 2=Bad; 3=Okay; 4=Good; 5=Great'})
          and matches(trackers['Activities'], {'options': 'Exercise; Work; Friends', 'multiple_choice': 'true'}))
    pg4.screenshot(path=OUT + '/today-fixture.png', full_page=True)

    # overflow check
    for name, page in [('p1', pg), ('p2', pg2), ('p3', pg3)]:
        sw = page.evaluate('document.documentElement.scrollWidth'); check('no horizontal scroll ' + name, sw <= 390)
    br.close()

srv.shutdown()
errs = [e for e in errors if 'Failed to load resource' not in e]
print('console/page errors:', errs[:10])
passed = sum(1 for _, c in results if c)
print(passed, '/', len(results), 'passed')
sys.exit(0 if passed == len(results) and not errs else 1)
