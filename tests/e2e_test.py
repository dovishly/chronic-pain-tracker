"""End-to-end tests for Logbook.

Serves the built app (dist/) locally, drives it in headless Chromium at phone size, and fakes the
Supabase REST/Auth API in-process, so no real project or network is needed.

Most tests run in order and build on each other, like one person using the app: the first phone logs
entries and changes settings, then signs in to the fake Supabase; a second and a third phone link to
the same account. So when one fails, look at the first failure: the ones after it may only be
following on. The tests after the third phone stand alone, each with a new phone and known data:
the analysis export tests at the end load tests/fixtures/analysis.json.

Run:  pip install pytest playwright && python -m playwright install chromium
      npm run test:e2e        (builds, then runs this file)
Screenshots land in tests/screenshots/ (git-ignored).
"""
import csv, datetime, functools, http.server, json, os, re, socketserver, threading, time, uuid, zipfile
from urllib.parse import urlparse, parse_qs
import pytest
from playwright.sync_api import sync_playwright, expect
from analysis_data import (
    FIXTURE, TIMEZONE, HEADACHE_SEP1, TIRED_OVERNIGHT, HEADACHE_RESTARTED, HEADACHE_SEP2, TIRED_ONGOING,
    JOURNAL_ANSWER, MOOD_EVENING, HEADACHE_MODERATE, TIRED_OVERNIGHT_END, HEADACHE_SEP2_END,
    DELETED_COFFEE, COFFEE_DURING_HEADACHE, MOOD_WHILE_TIRED,
    MORNING_SEP1, EVENING_SEP1, MORNING_SEP2, MORNING_SEP4,
)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(ROOT, 'dist')
SCREENSHOTS = os.path.join(ROOT, 'tests', 'screenshots')

APP_URL = 'http://127.0.0.1:8765/index.html'
SUPABASE_URL = 'https://mock.supabase.co'
ANON_KEY = 'anon-key-0123456789abcdefghij'
EMAIL = 'me@example.com'   # the account in the fake Supabase that most tests use
OTHER_EMAIL = 'other@example.com'  # a second account there
PASSWORD = 'correct horse battery staple'  # both accounts' password
# The schema version the app needs; the fake database reports it once "schema.sql has been run".
APP_SCHEMA_VERSION = int(re.search(r'const SCHEMA_VERSION = (\d+);', open(os.path.join(ROOT, 'src', 'lib', 'sync.ts')).read()).group(1))
ACCOUNT_TRACKERS = 16      # the 15 starter trackers plus Stiffness, added on the first phone
TRICKY_NAME = '<b>Bold</b> & "Q"'  # must be shown as typed, never turned into HTML


# ---------- fake Supabase ----------

class FakeSupabase:
    """Just enough of Supabase's Auth and REST APIs for the app, kept in memory."""

    def __init__(self):
        self.tables = {'trackers': {}, 'entries': {}}
        self.schema_version = APP_SCHEMA_VERSION  # 0 acts like a schema.sql from before versions (the function is missing)
        self.users = {EMAIL: 'u1', OTHER_EMAIL: 'u2'}
        self.tokens = {}          # access token -> user id
        self.refresh_tokens = {}  # refresh token -> user id
        self.clock = 0

    def rows(self, table):
        return list(self.tables[table].values())

    def rename_tracker(self, old, new):
        """An edit made on another device that has already reached the server."""
        row = next(row for row in self.rows('trackers') if row['name'] == old)
        self.tables['trackers'][row['id']] = {**row, 'name': new, 'updated_at': self.now()}

    def now(self):
        # Every write gets a later updated_at, as the server's trigger would give it.
        self.clock += 1
        return (datetime.datetime(2026, 10, 3, 12) + datetime.timedelta(microseconds=self.clock)).isoformat() + '+00:00'

    def new_session(self, user_id, email):
        token = 'tok-' + uuid.uuid4().hex
        self.tokens[token] = user_id
        self.refresh_tokens['r-' + token] = user_id
        return {'access_token': token, 'refresh_token': 'r-' + token, 'token_type': 'bearer', 'expires_in': 3600,
                'user': {'id': user_id, 'email': email}}

    def handle(self, route):
        """Answers one request from the app (a Playwright route handler)."""
        request = route.request
        url = urlparse(request.url)
        body = json.loads(request.post_data) if request.post_data else None
        status, reply = self.answer(request.method, url.path, parse_qs(url.query), request.headers, body)
        route.fulfill(status=status, content_type='application/json', body='' if reply is None else json.dumps(reply))

    def answer(self, method, path, query, headers, body):
        if 'apikey' not in headers:
            return 401, {'message': 'no apikey'}

        if path == '/auth/v1/token' and query.get('grant_type') == ['password']:
            if body.get('email') not in self.users or body.get('password') != PASSWORD:
                return 400, {'error_code': 'invalid_credentials', 'msg': 'Invalid login credentials'}
            return 200, self.new_session(self.users[body['email']], body['email'])
        if path == '/auth/v1/token' and query.get('grant_type') == ['refresh_token']:
            user_id = self.refresh_tokens.pop(body.get('refresh_token'), None)
            if not user_id:
                return 400, {'error_code': 'refresh_token_not_found', 'msg': 'Invalid Refresh Token'}
            email = next(address for address, id in self.users.items() if id == user_id)
            return 200, self.new_session(user_id, email)
        if path == '/auth/v1/logout':
            return 204, None

        user_id = self.tokens.get(headers.get('authorization', '').removeprefix('Bearer '))
        if not user_id:
            return 401, {'message': 'JWT invalid'}
        if path == '/rest/v1/rpc/logbook_schema_version':
            if not self.schema_version:
                return 404, {'code': 'PGRST202', 'message': 'Could not find the function'}
            return 200, self.schema_version
        match = re.match(r'/rest/v1/(trackers|entries)$', path)
        if not match:
            return 404, {'message': 'not found'}
        table = match.group(1)

        if method == 'POST':  # upsert
            assert 'merge-duplicates' in headers.get('prefer', ''), headers.get('prefer')
            updated_at = self.now()
            for row in body:
                self.tables[table][row['id']] = {**row, 'user_id': user_id, 'updated_at': updated_at}
            return 201, None

        rows = [row for row in self.rows(table) if row['user_id'] == user_id]
        filters = {column: values[0].removeprefix('eq.') for column, values in query.items() if values[0].startswith('eq.')}
        rows = [row for row in rows if all(json.dumps(row.get(column)) == value or str(row.get(column)) == value
                                           for column, value in filters.items())]
        if method == 'PATCH':  # update, filtered by column=eq.value; one updated_at for all, as in one transaction
            updated_at = self.now()
            for row in rows:
                self.tables[table][row['id']] = {**row, **body, 'updated_at': updated_at}
            return 204, None
        if 'or' in query:  # the rows after the pull's cursor (an updated_at, and the id of the last row that had it)
            cursor = re.fullmatch(r'\(updated_at\.gt\.(.+),and\(updated_at\.eq\.\1,id\.gt\.(.+)\)\)', query['or'][0]).groups()
            rows = [row for row in rows if (row['updated_at'], row['id']) > cursor]
        rows.sort(key=lambda row: (row['updated_at'], row['id']))
        rows = rows[:int(query.get('limit', ['1000'])[0])]
        if query.get('select', ['*'])[0] == 'id':
            rows = [{'id': row['id']} for row in rows]
        return 200, rows


# ---------- phones ----------

browser_errors = []  # errors logged or thrown by any page; see no_browser_errors


class Phone:
    """A browser at iPhone size with storage of its own, like a separate device running the app."""

    def __init__(self, browser, supabase, color_scheme='light', timezone=None):
        self.context = browser.new_context(viewport={'width': 390, 'height': 844}, color_scheme=color_scheme,
                                           timezone_id=timezone, accept_downloads=True, service_workers='block')
        self.context.route(SUPABASE_URL + '/**', supabase.handle)
        self.page = self.context.new_page()
        self.page.on('pageerror', lambda error: browser_errors.append(str(error)))
        self.page.on('console', lambda message: browser_errors.append(message.text) if message.type == 'error' else None)
        self.open()

    def open(self):
        self.page.goto(APP_URL)
        expect(self.page.locator('#sync-pill')).to_be_visible()

    def locator(self, selector, **options):
        return self.page.locator(selector, **options)

    def go_to(self, tab):
        self.locator('.tab-bar button', has_text=tab).click()

    def connect(self, url=SUPABASE_URL, key=ANON_KEY):
        """Enters a project in Settings → Sync."""
        self.page.fill('#project-url', url)
        self.page.fill('#project-key', key)
        self.page.click('#project-connect')

    def sign_in(self, password=PASSWORD, email=EMAIL):
        self.page.fill('#sign-in-email', email)
        self.page.fill('#sign-in-password', password)
        self.page.click('#sign-in')

    def wait_for(self, condition, timeout_s=5):
        """Waits until condition() is true or time runs out; the test then asserts it.

        Waits with the page's own timer rather than time.sleep, which would also stop the fake
        Supabase from answering.
        """
        deadline = time.monotonic() + timeout_s
        while not condition() and time.monotonic() < deadline:
            self.page.wait_for_timeout(50)

    def screenshot(self, name):
        self.page.screenshot(path=os.path.join(SCREENSHOTS, name + '.png'), full_page=True)

    def stored(self, store, key):
        """A row as this phone keeps it in IndexedDB."""
        return self.page.evaluate('''([store, key]) => new Promise((resolve, reject) => {
          const request = indexedDB.open('logbook');
          request.onsuccess = () => {
            const get = request.result.transaction(store).objectStore(store).get(key);
            get.onsuccess = () => { request.result.close(); resolve(get.result); };
            get.onerror = () => reject(get.error);
          };
          request.onerror = () => reject(request.error);
        })''', [store, key])


def tracker_names(phone):
    """Tracker names in the order Settings lists them, without the type shown after each."""
    return phone.locator('#trackers .tracker-name').evaluate_all('spans => spans.map(s => s.firstChild.textContent.trim())')


# ---------- the analysis export ----------

class Export:
    """The .zip from "Export for analysis": a CSV file per table."""

    def __init__(self, download):
        self.filename = download.suggested_filename
        archive = zipfile.ZipFile(download.path())
        self.files = archive.namelist()
        self.intact = archive.testzip() is None
        self.tables = {os.path.basename(name).removesuffix('.csv'):
                       list(csv.DictReader(archive.read(name).decode('utf-8').splitlines()))
                       for name in self.files}


def export_for_analysis(phone):
    phone.go_to('Settings')
    with phone.page.expect_download() as download:
        phone.page.click('#export-analysis')
    return Export(download.value)


def fields(row, expected):
    """The row's values for just the fields named in expected, to compare with ==."""
    return {name: row.get(name) for name in expected}


# ---------- phones with known data ----------

# Loads trackers and entries into the app's IndexedDB, replacing what's there, as if logged on this phone.
LOAD_FIXTURE = '''async (fixture) => {
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
    tx.objectStore('meta').put({ key: 'seeded', value: true });
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}'''


def phone_with(browser, supabase, trackers, entries, timezone='America/New_York'):
    """A new phone that has just these trackers and entries."""
    phone = Phone(browser, supabase, timezone=timezone)
    phone.page.evaluate(LOAD_FIXTURE, {'trackers': trackers, 'entries': entries})
    phone.open()
    return phone


def make_tracker(name, type_, color='amber', sort_order=10):
    return {'id': str(uuid.uuid4()), 'name': name, 'type': type_, 'group_name': None, 'color': color,
            'config': {}, 'sort_order': sort_order, 'archived': False}


def make_entry(tracker, kind, occurred_at, note=None):
    return {'id': str(uuid.uuid4()), 'tracker_id': tracker['id'], 'kind': kind, 'occurred_at': occurred_at,
            'value': None, 'text': None, 'note': note, 'checkin_id': None, 'deleted': False}


def minutes_ago(minutes):
    """A UTC timestamp, as the app stores them."""
    when = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(minutes=minutes)
    return when.isoformat(timespec='milliseconds').replace('+00:00', 'Z')


# ---------- pytest fixtures ----------

@pytest.fixture(scope='module', autouse=True)
def app_server():
    """Serves dist/ at APP_URL."""
    if not os.path.exists(os.path.join(DIST, 'index.html')):
        pytest.exit('No build found. Run `npm run build` first, or use `npm run test:e2e`.', returncode=1)
    os.makedirs(SCREENSHOTS, exist_ok=True)

    class QuietHandler(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *args):
            pass

    class Server(socketserver.ThreadingTCPServer):
        allow_reuse_address = True

    server = Server(('127.0.0.1', 8765), functools.partial(QuietHandler, directory=DIST))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield
    server.shutdown()


@pytest.fixture(autouse=True)
def no_browser_errors():
    """Fails a test (at teardown) if a page logged an error or threw since the previous test."""
    yield
    # Failed requests are expected: the fake Supabase refuses some on purpose, and some tests go offline.
    errors = [e for e in browser_errors if 'Failed to load resource' not in e and 'fonts' not in e]
    browser_errors.clear()
    assert not errors


@pytest.fixture(scope='module')
def supabase():
    return FakeSupabase()


@pytest.fixture(scope='module')
def browser():
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        yield browser
        browser.close()


@pytest.fixture(scope='module')
def phone1(browser, supabase):
    return Phone(browser, supabase)


@pytest.fixture(scope='module')
def phone2(browser, supabase):
    return Phone(browser, supabase, color_scheme='dark', timezone='Europe/Berlin')


@pytest.fixture(scope='module')
def phone3(browser, supabase):
    return Phone(browser, supabase)


@pytest.fixture(scope='module')
def phone1_export(phone1):
    """phone1's analysis export, taken once its entries and settings are made."""
    return export_for_analysis(phone1)


# ---------- phone 1: Today ----------

def test_fresh_phone_has_the_starter_trackers(phone1):
    expect(phone1.locator('#sync-pill')).to_have_text('On this device only')
    assert phone1.locator('[data-episode]').count() >= 5
    expect(phone1.locator('[data-episode]', has_text='Headache')).to_have_count(1)


def test_help_explains_where_data_is_kept(phone1):
    help_dialog = phone1.locator('#storage-help-dialog')
    phone1.page.click('#storage-help')
    expect(help_dialog).to_be_visible()
    expect(help_dialog).to_contain_text("At the moment, it's only on this phone")
    expect(help_dialog).to_contain_text('Free projects are paused after about a week')
    expect(phone1.locator('#storage-help-title')).to_be_focused()  # so it opens at the top, not at the buttons
    phone1.screenshot('help-light')
    phone1.page.click('#storage-help-close')
    expect(help_dialog).to_be_hidden()

    phone1.page.click('#storage-help')
    phone1.page.click('#storage-help-sync')
    expect(help_dialog).to_be_hidden()
    expect(phone1.locator('h1')).to_have_text('Settings')
    phone1.go_to('Today')


def test_start_and_stop_episodes(phone1):
    tired = phone1.locator('#running .running-pill', has_text='Tired')
    phone1.locator('.episode-card .episode-button', has_text='Tired').click()
    expect(tired).to_have_count(1)

    phone1.locator('.episode-card .episode-button', has_text='Headache').click()
    phone1.locator('.episode-card.is-running .level-buttons button[data-level="2"]').first.click()
    expect(phone1.locator('#running')).to_contain_text('Moderate')

    tired.click()  # tapping a running episode's pill stops it
    expect(tired).to_have_count(0)


def test_moments_and_the_days_log(phone1):
    phone1.locator('.moment-button', has_text='Coffee').click()
    log = phone1.locator('#day-log')
    expect(log).to_contain_text('Coffee')
    expect(log).to_contain_text('Tired · until')  # one row for the whole episode
    expect(log).to_contain_text('Headache: Moderate')
    expect(phone1.locator('#day-log')).to_have_attribute('data-lanes', '2')  # Tired and Headache overlapped
    expect(phone1.locator('#day-log > li').first).to_have_class('day-row day-now')
    expect(phone1.locator('#day-log .lane-bar.is-now')).to_have_count(1)  # Headache, still going, reaches Now
    expect(phone1.locator('#day-log .lane-bar.is-end, #day-log .lane-bar.is-start-end')).to_have_count(1)  # Tired's ring
    shown_times = [t for t in phone1.locator('#day-log .entry-time').all_inner_texts() if t.strip()]
    assert len(shown_times) == len(set(shown_times))  # each time once, on the newest row that has it
    expect(phone1.locator('.day-totals')).to_contain_text('Tired 1×')
    expect(phone1.locator('.day-totals')).to_contain_text('Coffee 1×')


def test_toast_undo(phone1):
    phone1.locator('.toast button', has_text='Undo').click()
    expect(phone1.locator('#day-log')).not_to_contain_text('Coffee')


def test_toast_moves_the_entry_earlier(phone1):
    phone1.locator('.moment-button', has_text='Coffee').click()
    phone1.locator('.toast button', has_text='15').click()
    expect(phone1.locator('.toast')).to_contain_text('Moved to')


def test_edit_an_entrys_note(phone1):
    phone1.locator('.entry-row', has_text='Coffee').click()
    phone1.locator('.entry-editor input[type=text]').fill('second cup')
    phone1.locator('[data-save-entry]').click()
    expect(phone1.locator('#day-log')).to_contain_text('second cup')
    phone1.screenshot('today-light')


# ---------- phone 1: Check in ----------

def test_check_in(phone1):
    phone1.go_to('Check in')
    mood = phone1.locator('.question', has_text='Mood')
    mood.locator('button[data-value="4"]').click()
    expect(mood).to_contain_text('Good')  # the picked level's label
    phone1.locator('.chip', has_text='Exercise').click()
    phone1.locator('.chip', has_text='Friends').click()
    phone1.locator('.question', has_text='Water').locator('input').fill('3')
    phone1.locator('.question', has_text='Journal').locator('textarea').fill('Felt okay after lunch')
    phone1.screenshot('checkin-light')

    phone1.page.click('#save-checkin')  # saves and goes back to Today
    checkin = phone1.locator('.entry-row.is-checkin')
    expect(checkin).to_have_count(1)  # one row for the whole check-in
    expect(checkin).to_contain_text('Check-in · Mood: Good, Water: 3 glasses +2 more')
    checkin.click()  # shows each answer
    log = phone1.locator('#day-log')
    for text in ['Mood: Good', 'Activities: Exercise', 'Activities: Friends', 'Water: 3 glasses', 'Journal: Felt okay']:
        expect(log).to_contain_text(text)


# ---------- phone 1: Settings ----------

def test_add_a_tracker(phone1):
    phone1.go_to('Settings')
    phone1.page.click('#add-tracker')
    phone1.page.fill('#editor-name', 'Stiffness')
    phone1.page.select_option('#editor-type', 'number')
    phone1.page.fill('#editor-unit', 'minutes')
    phone1.page.fill('#editor-group', 'Check-in')
    phone1.locator('[data-color="rose"]').click()
    # Picking a color keeps what's been typed.
    assert phone1.page.input_value('#editor-name') == 'Stiffness'
    assert phone1.page.input_value('#editor-unit') == 'minutes'
    phone1.page.click('#editor-save')
    expect(phone1.locator('#trackers')).to_contain_text('Stiffness')


def test_custom_color(phone1):
    phone1.locator('.tracker-list li', has_text='Stiffness').locator('[data-edit-tracker]').click()
    phone1.page.fill('#editor-custom-color', '#ffd60a')  # a light yellow, where white text wouldn't read
    expect(phone1.locator('.custom-color')).to_have_class('custom-color is-selected')
    phone1.page.click('#editor-save')
    dot = phone1.locator('.tracker-list li', has_text='Stiffness').locator('.color-dot')
    expect(dot).to_have_css('background-color', 'rgb(255, 214, 10)')
    assert dot.evaluate("dot => dot.style.getPropertyValue('--on')") == '#15202B'  # dark text on it


def test_rename_a_tracker_but_not_change_its_type(phone1):
    phone1.locator('.tracker-list li', has_text='Tired').locator('[data-edit-tracker]').click()
    expect(phone1.locator('#editor-type')).to_be_disabled()  # Tired has entries
    phone1.page.fill('#editor-name', 'Sleepy')
    phone1.page.click('#editor-save')
    expect(phone1.locator('#trackers')).to_contain_text('Sleepy')


def test_archive_a_tracker(phone1):
    phone1.locator('.tracker-list li', has_text='Meal').locator('[data-edit-tracker]').click()
    phone1.page.click('#editor-archive')
    expect(phone1.locator('#trackers')).not_to_contain_text('Meal')
    expect(phone1.locator('#archived-trackers')).to_contain_text('Meal')


def test_move_a_tracker_up(phone1):
    def low_mood_before_anxious():
        names = tracker_names(phone1)
        return names.index('Low mood') < names.index('Anxious')
    assert not low_mood_before_anxious()
    phone1.locator('.tracker-list li', has_text='Low mood').locator('[data-move-up]').click()
    phone1.wait_for(low_mood_before_anxious)
    assert low_mood_before_anxious()


def test_rating_needs_two_to_ten_levels(phone1):
    phone1.page.click('#add-tracker')
    phone1.page.fill('#editor-name', 'X')
    phone1.page.select_option('#editor-type', 'rating')
    phone1.page.fill('#editor-levels', 'only one')
    phone1.page.click('#editor-save')
    expect(phone1.locator('#editor-error')).to_contain_text('A rating needs 2 to 10 levels.')
    phone1.page.click('#editor-cancel')
    phone1.screenshot('settings-light')


# ---------- phone 1: export ----------

def test_export_is_one_zip_of_five_csvs_in_a_dated_folder(phone1_export):
    assert re.match(r'logbook-\d{4}-\d{2}-\d{2}\.zip$', phone1_export.filename)
    folder = phone1_export.filename.removesuffix('.zip')
    tables = ['daily', 'checkins', 'episodes', 'entries', 'trackers']
    assert sorted(phone1_export.files) == sorted(f'{folder}/{table}.csv' for table in tables)
    assert phone1_export.intact


def test_exported_entries(phone1_export):
    entries = phone1_export.tables['entries']
    assert list(entries[0]) == [
        'entry_id', 'datetime', 'date', 'time', 'weekday', 'timestamp_utc', 'tracker_id', 'tracker', 'type', 'group',
        'event', 'value', 'label', 'text', 'note', 'checkin_id', 'episode_id', 'during', 'during_episode_ids']
    assert all(re.match(r'\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$', row['datetime']) for row in entries)
    assert any(row['tracker'] == 'Sleepy' and row['event'] == 'end' for row in entries)
    assert any(row['tracker'] == 'Mood' and row['event'] == 'answer' and row['value'] == '4' and row['label'] == 'Good'
               for row in entries)
    assert any(row['note'] == 'second cup' for row in entries)
    assert sum(row['tracker'] == 'Coffee' for row in entries) == 1  # the undone one is left out


# ---------- phone 1: sync ----------

def test_plain_http_project_refused(phone1):
    phone1.connect('http://example.com')
    expect(phone1.locator('#project-error')).to_contain_text('should start with https://')


def test_http_project_on_this_computer_accepted(phone1):
    phone1.connect('http://127.0.0.1:54321')
    expect(phone1.locator('#sign-in-email')).to_have_count(1)
    phone1.page.click('#project-disconnect')


def test_sign_in_refuses_wrong_password(phone1):
    phone1.connect()
    phone1.sign_in('not my password')
    expect(phone1.locator('#sign-in-error')).to_contain_text("don't match a user in this project")


def test_signing_in_uploads_everything(phone1, supabase, phone1_export):
    phone1.sign_in()
    expect(phone1.locator('#sync-pill')).to_contain_text('Synced')
    assert len(supabase.rows('trackers')) == ACCOUNT_TRACKERS
    # Every exported entry, plus the undone coffee: deletes sync as deleted = true.
    assert len(supabase.rows('entries')) == len(phone1_export.tables['entries']) + 1
    assert any(row['deleted'] for row in supabase.rows('entries'))
    phone1.screenshot('settings-synced')


def test_changes_from_other_devices_are_pulled(phone1, supabase):
    supabase.rename_tracker('Sleepy', 'Drowsy')
    phone1.page.click('#sync-now')
    expect(phone1.locator('#trackers')).to_contain_text('Drowsy')


WIPED_ENTRY = {'deleted': True, 'value': None, 'text': None, 'note': None}


def test_deleting_an_entry_wipes_it_here_and_in_supabase(phone1, supabase):
    cup = next(row['id'] for row in supabase.rows('entries') if row['note'] == 'second cup')
    phone1.go_to('Today')
    phone1.locator('.entry-row', has_text='second cup').click()
    phone1.locator('.entry-editor .button.danger').click()
    expect(phone1.locator('#day-log')).not_to_contain_text('second cup')
    phone1.wait_for(lambda: fields(supabase.tables['entries'][cup], WIPED_ENTRY) == WIPED_ENTRY)
    assert fields(supabase.tables['entries'][cup], WIPED_ENTRY) == WIPED_ENTRY
    assert fields(phone1.stored('entries', cup), WIPED_ENTRY) == WIPED_ENTRY


def test_backup_leaves_out_deleted_rows(phone1):
    phone1.go_to('Settings')
    with phone1.page.expect_download() as download:
        phone1.page.click('#export-backup')
    backup = json.load(open(download.value.path()))
    assert backup['trackers'] and backup['entries']
    assert not any(row['deleted'] for row in backup['trackers'] + backup['entries'])


def test_offline_entries_wait_then_upload(phone1, supabase):
    uploaded = len(supabase.rows('entries'))
    phone1.context.set_offline(True)
    phone1.go_to('Today')
    phone1.locator('.moment-button', has_text='Medication').click()
    expect(phone1.locator('#sync-pill')).to_contain_text('Offline')

    phone1.context.set_offline(False)
    phone1.page.evaluate('window.dispatchEvent(new Event("online"))')
    phone1.wait_for(lambda: len(supabase.rows('entries')) == uploaded + 1)
    assert len(supabase.rows('entries')) == uploaded + 1


def test_signing_out_needs_a_connection(phone1):
    phone1.go_to('Settings')
    phone1.context.set_offline(True)
    phone1.page.click('#sign-out')
    expect(phone1.locator('.toast')).to_contain_text('Signing out needs a connection.')
    expect(phone1.locator('#sync-panel')).to_contain_text('Signed in as')
    phone1.context.set_offline(False)
    browser_errors[:] = [e for e in browser_errors if 'Signing out needs a connection' not in e]  # logged by the toast


def test_last_sync_on_an_earlier_day(phone1, supabase):
    phone1.page.evaluate("localStorage.setItem('logbook.lastSync', String(new Date(2026, 8, 3, 12).getTime()))")
    supabase.schema_version = 0  # so the sync after reopening fails and leaves that time alone
    phone1.open()
    phone1.go_to('Settings')
    expect(phone1.locator('#sync-panel')).to_contain_text('Last synced on Thu, Sep 3 at')
    supabase.schema_version = APP_SCHEMA_VERSION


# ---------- phone 2: a fresh phone joins the account ----------

def test_outdated_database_stops_sync(phone2, supabase):
    phone2.go_to('Settings')
    phone2.connect()
    supabase.schema_version = 0  # the owner hasn't run the latest schema.sql yet
    phone2.sign_in()
    expect(phone2.locator('#sync-pill')).to_contain_text('Action needed')
    expect(phone2.locator('#sync-panel')).to_contain_text("Your Supabase project needs Logbook's tables")
    expect(phone2.locator('#trackers')).not_to_contain_text('Drowsy')


def test_setup_sql_can_be_copied_into_the_sql_editor(phone2):
    expect(phone2.locator('#schema-editor')).to_have_attribute('href', 'https://supabase.com/dashboard/project/mock/sql/new')
    phone2.context.grant_permissions(['clipboard-read', 'clipboard-write'])
    phone2.page.click('#schema-copy')
    expect(phone2.locator('.toast')).to_contain_text('Setup SQL copied')
    assert 'create table if not exists public.trackers' in phone2.page.evaluate('navigator.clipboard.readText()')


def test_fresh_phone_takes_the_accounts_trackers(phone2, supabase):
    supabase.schema_version = APP_SCHEMA_VERSION  # schema.sql run again
    phone2.page.click('#sync-now')
    trackers = phone2.locator('#trackers')
    expect(trackers).to_contain_text('Drowsy')
    expect(trackers).to_contain_text('Stiffness')
    # Its own starter trackers were replaced, not added to the account.
    assert trackers.inner_text().count('Headache') == 1
    assert len(supabase.rows('trackers')) == ACCOUNT_TRACKERS
    # The custom color picked on the first phone came along.
    stiffness_dot = phone2.locator('.tracker-list li', has_text='Stiffness').locator('.color-dot')
    expect(stiffness_dot).to_have_css('background-color', 'rgb(255, 214, 10)')


def test_fresh_phone_shows_the_accounts_entries(phone2):
    phone2.go_to('Today')
    expect(phone2.locator('#day-log')).to_contain_text('Medication')
    phone2.screenshot('today-dark')


# ---------- phone 3: logs on its own first, then joins ----------

def test_names_are_shown_as_typed_in_settings(phone3):
    phone3.locator('.moment-button', has_text='Coffee').click()  # an entry of this phone's own, for later
    phone3.go_to('Settings')
    phone3.page.click('#add-tracker')
    phone3.page.fill('#editor-name', TRICKY_NAME)
    phone3.page.select_option('#editor-type', 'moment')
    phone3.page.click('#editor-save')
    expect(phone3.locator('#trackers')).to_contain_text(TRICKY_NAME)
    assert phone3.locator('#trackers b').count() == 0


def test_restore_an_archived_tracker(phone3):
    phone3.locator('.tracker-list li', has_text='Bold').locator('[data-edit-tracker]').click()
    phone3.page.click('#editor-archive')
    phone3.locator('#archived-trackers summary').click()
    phone3.locator('#archived-trackers [data-restore-tracker]').click()
    expect(phone3.locator('#trackers')).to_contain_text(TRICKY_NAME)


def test_names_are_shown_as_typed_on_today(phone3):
    phone3.go_to('Today')
    phone3.locator('.moment-button', has_text='Bold').click()
    expect(phone3.locator('#moments')).to_contain_text(TRICKY_NAME)
    expect(phone3.locator('#day-log')).to_contain_text(TRICKY_NAME)
    assert phone3.locator('#moments b, #day-log b, #toast-host b').count() == 0


def test_joining_asks_before_replacing_this_phones_data(phone3, supabase):
    phone3.go_to('Settings')
    phone3.connect()
    phone3.sign_in()
    expect(phone3.locator('#sync-panel')).to_contain_text('Your account already has data')
    assert len(supabase.rows('trackers')) == ACCOUNT_TRACKERS  # nothing uploaded yet


def test_choosing_the_account_replaces_this_phones_data(phone3, supabase):
    phone3.page.click('#use-account-data')
    expect(phone3.locator('#trackers')).to_contain_text('Drowsy')
    assert len(supabase.rows('trackers')) == ACCOUNT_TRACKERS


def test_delete_a_tracker_everywhere(phone1, phone3, supabase):
    drowsy = next(row['id'] for row in supabase.rows('trackers') if row['name'] == 'Drowsy')
    phone3.locator('.tracker-list li', has_text='Drowsy').locator('[data-edit-tracker]').click()
    phone3.page.click('#editor-delete')
    expect(phone3.locator('.tracker-editor .notice')).to_contain_text('Delete Drowsy for good?')
    expect(phone3.locator('.tracker-editor .notice')).to_contain_text('entries go with it')
    phone3.page.click('#editor-delete-confirm')
    expect(phone3.locator('#trackers')).not_to_contain_text('Drowsy')

    wiped = {'deleted': True, 'name': '', 'group_name': None, 'config': {}}
    its_entries = lambda: [row for row in supabase.rows('entries') if row['tracker_id'] == drowsy]
    deleted_everywhere = lambda: (fields(supabase.tables['trackers'][drowsy], wiped) == wiped
                                  and all(fields(row, WIPED_ENTRY) == WIPED_ENTRY for row in its_entries()))
    phone3.wait_for(deleted_everywhere)
    assert its_entries() and deleted_everywhere()

    # Another phone on the account drops it at its next sync.
    phone1.go_to('Settings')
    phone1.page.click('#sync-now')
    expect(phone1.locator('#trackers')).not_to_contain_text('Drowsy')


def test_delete_an_archived_tracker_takes_a_second_tap(phone3, supabase):
    meal = next(row['id'] for row in supabase.rows('trackers') if row['name'] == 'Meal')
    phone3.page.evaluate("document.querySelector('#archived-trackers').open = true")
    delete = phone3.locator('#archived-trackers li', has_text='Meal').locator('[data-delete-tracker]')
    delete.click()
    expect(delete).to_have_text('Delete for good?')
    delete.click()
    expect(phone3.locator('#archived-trackers')).to_have_count(0)  # Meal was the only archived tracker
    # Uploaded before the next test looks at what's in Supabase.
    meal_deleted = lambda: supabase.tables['trackers'][meal]['deleted']
    phone3.wait_for(meal_deleted)
    assert meal_deleted()


def live_tracker_names(supabase):
    return sorted(row['name'] for row in supabase.rows('trackers') if not row['deleted'])


def test_reset_this_phone_leaves_supabase_alone(phone2, supabase):
    in_supabase = live_tracker_names(supabase)
    phone2.go_to('Settings')
    phone2.page.click('#reset-device')
    expect(phone2.locator('.notice', has_text='Reset this phone?')).to_contain_text('Your synced data stays in Supabase')
    phone2.page.click('#reset-device-confirm')
    expect(phone2.locator('#sync-pill')).to_have_text('On this device only')  # reopened, signed out
    phone2.go_to('Settings')
    expect(phone2.locator('#trackers')).to_contain_text('Tired')  # the starter trackers again
    expect(phone2.locator('#trackers')).not_to_contain_text('Stiffness')
    assert live_tracker_names(supabase) == in_supabase


def test_reset_everywhere(phone1, phone3, supabase):
    phone3.go_to('Settings')
    phone3.page.click('#reset-everywhere')
    phone3.page.click('#reset-everywhere-confirm')
    expect(phone3.locator('.toast')).to_contain_text('Everything was reset')
    expect(phone3.locator('#trackers')).not_to_contain_text('Stiffness')
    starters = sorted(phone3.locator('#trackers .tracker-name').evaluate_all('spans => spans.map(s => s.firstChild.textContent.trim())'))
    phone3.wait_for(lambda: live_tracker_names(supabase) == starters)
    assert live_tracker_names(supabase) == starters
    assert not [row for row in supabase.rows('entries') if not row['deleted']]

    # Another phone on the account follows at its next sync.
    phone1.go_to('Settings')
    phone1.page.click('#sync-now')
    expect(phone1.locator('#trackers')).not_to_contain_text('Stiffness')
    assert phone1.locator('#trackers').inner_text().count('Headache') == 1


def test_another_project_gets_its_schema_checked(phone1, supabase):
    # Connecting a project in the same session as another: this one may not have Logbook's tables yet.
    phone1.page.click('#sign-out')
    phone1.page.click('#project-disconnect')
    supabase.schema_version = 0
    phone1.connect()
    phone1.sign_in()
    expect(phone1.locator('#sync-pill')).to_contain_text('Action needed')
    supabase.schema_version = APP_SCHEMA_VERSION
    phone1.page.click('#sync-now')
    expect(phone1.locator('#sync-pill')).to_contain_text('Synced')


def test_pull_gets_past_more_rows_than_a_page_changed_at_once(phone1, supabase):
    # One update of many rows, like Reset everywhere's, gives them all the same updated_at. A page's worth
    # of them mustn't keep the pull from reaching the rows after them.
    coffee = next(row for row in supabase.rows('trackers') if row['user_id'] == 'u1' and row['name'] == 'Coffee' and not row['deleted'])
    updated_at = supabase.now()
    def row(id, deleted, note=None):
        return {'id': id, 'user_id': 'u1', 'tracker_id': coffee['id'], 'kind': 'moment', 'value': None, 'text': None,
                'occurred_at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'note': note, 'checkin_id': None,
                'deleted': deleted, 'updated_at': updated_at}
    for n in range(1000):
        supabase.tables['entries'][f'00000000-0000-4000-a000-{n:012d}'] = row(f'00000000-0000-4000-a000-{n:012d}', True)
    last = 'ffffffff-ffff-4fff-bfff-ffffffffffff'  # sorts after the others, so it's on the second page
    supabase.tables['entries'][last] = row(last, False, 'after a thousand')
    phone1.page.click('#sync-now')
    phone1.go_to('Today')
    expect(phone1.locator('#day-log')).to_contain_text('after a thousand')


def test_no_sideways_scrolling(phone1, phone2, phone3):
    for phone in [phone1, phone2, phone3]:
        assert phone.page.evaluate('document.documentElement.scrollWidth') <= 390


def test_an_account_with_only_deleted_trackers_counts_as_empty(browser, supabase):
    # So a phone joining it keeps its own trackers and entries, without asking.
    old = '00000000-0000-4000-8000-0000000000a1'
    supabase.tables['trackers'][old] = {'id': old, 'user_id': 'u2', 'name': 'Old', 'type': 'moment', 'group_name': None,
                                        'color': 'slate', 'config': {}, 'sort_order': 0, 'archived': False,
                                        'deleted': True, 'updated_at': supabase.now()}
    phone = Phone(browser, supabase)
    phone.locator('.moment-button', has_text='Coffee').click()
    phone.go_to('Settings')
    phone.connect()
    phone.sign_in(email=OTHER_EMAIL)
    expect(phone.locator('#sync-pill')).to_contain_text('Synced')
    expect(phone.locator('#trackers')).to_contain_text('Coffee')
    assert len([row for row in supabase.rows('entries') if row['user_id'] == 'u2']) == 1  # its coffee went up


def test_day_timeline_shows_gaps_and_overnight_episodes(browser, supabase):
    tired, coffee = make_tracker('Tired', 'episode', 'indigo'), make_tracker('Coffee', 'moment')
    phone = phone_with(browser, supabase, [tired, coffee], [  # New York times, November 2025 (UTC-5)
        make_entry(tired, 'start', '2025-11-11T03:00:00.000Z'),    # Nov 10, 22:00
        make_entry(tired, 'end', '2025-11-11T12:00:00.000Z'),      # Nov 11, 07:00
        make_entry(coffee, 'moment', '2025-11-11T13:00:00.000Z'),  # Nov 11, 08:00
        make_entry(coffee, 'moment', '2025-11-11T16:30:00.000Z'),  # Nov 11, 11:30
    ])
    phone.page.click('#previous-day')
    expect(phone.locator('.day-name')).to_contain_text('Tue, Nov 11')

    rows = phone.locator('#day-log > li')
    expect(rows).to_have_count(4)
    assert [rows.nth(i).inner_text().replace('\n', ' ') for i in range(4)] == [
        '11:30 AM Coffee', '3 h 30 min', '8:00 AM Coffee', 'Tired · since Mon, Nov 10 10:00 PM · until 7:00 AM · 9 h 00 min']
    expect(phone.locator('#day-log')).to_have_attribute('data-lanes', '1')
    expect(phone.locator('.day-totals')).to_contain_text('Tired 1× · 7 h 00 min')  # the part on this day

    # The episode's row edits its start and end together, and deletes both.
    phone.locator('.entry-row.is-episode').click()
    expect(phone.locator('.entry-editor')).to_contain_text('Start')
    expect(phone.locator('.entry-editor')).to_contain_text('End')
    phone.locator('.entry-editor .button.danger').click()
    expect(phone.locator('#day-log')).not_to_contain_text('Tired')
    expect(phone.locator('.day-totals')).not_to_contain_text('Tired')


def test_day_timeline_never_draws_two_bars_in_one_lane(browser, supabase):
    headache, tired, anxious = make_tracker('Headache', 'episode'), make_tracker('Tired', 'episode'), make_tracker('Anxious', 'episode')
    coffee = make_tracker('Coffee', 'moment')
    phone = phone_with(browser, supabase, [headache, tired, anxious, coffee], [
        # Nov 12, 2025, New York: Anxious starts and ends in the row where Headache's bar stops
        make_entry(headache, 'start', '2025-11-12T14:04:00.000Z'),
        make_entry(tired, 'start', '2025-11-12T14:23:00.000Z'),
        make_entry(tired, 'end', '2025-11-12T14:24:00.000Z'),
        make_entry(coffee, 'moment', '2025-11-12T14:24:30.000Z'),
        make_entry(anxious, 'start', '2025-11-12T14:25:10.000Z'),
        make_entry(anxious, 'end', '2025-11-12T14:25:20.000Z'),
        make_entry(headache, 'end', '2025-11-12T14:25:30.000Z'),
    ])
    phone.page.click('#previous-day')
    expect(phone.locator('.day-name')).to_contain_text('Wed, Nov 12')
    expect(phone.locator('#day-log')).to_have_attribute('data-lanes', '2')
    bars_per_cell = phone.locator('#day-log .lane').evaluate_all('lanes => lanes.map(lane => lane.children.length)')
    assert max(bars_per_cell) == 1


def test_ended_episode_stops_below_now(browser, supabase):
    # Ended ten minutes after the last thing logged: its bar must end in a ring, not run up to Now like a running one.
    headache, coffee = make_tracker('Headache', 'episode'), make_tracker('Coffee', 'moment')
    phone = phone_with(browser, supabase, [headache, coffee], [
        make_entry(headache, 'start', minutes_ago(30)),
        make_entry(coffee, 'moment', minutes_ago(20)),
        make_entry(headache, 'end', minutes_ago(10)),
    ], timezone=None)
    rows = phone.locator('#day-log > li')
    expect(rows.first).to_have_class('day-row day-now')
    expect(phone.locator('#day-log .lane-bar.is-now')).to_have_count(0)
    expect(rows.nth(1).locator('.lane-bar.is-end')).to_have_count(1)  # the ring, beside Coffee


def test_moving_an_episode_earlier_keeps_it_whole(browser, supabase):
    phone = Phone(browser, supabase)
    pain = phone.locator('.episode-card .episode-button', has_text='Pain')
    running = phone.locator('#running')
    # Started and stopped at once, then −15 on the "ended" toast: it would end before it started, so the
    # whole episode moves back instead of Pain coming back on.
    pain.click()
    expect(running).to_contain_text('Pain')
    pain.click()
    expect(running).not_to_contain_text('Pain')
    phone.locator('.toast button', has_text='15').click()
    expect(phone.locator('.toast')).to_contain_text('Moved Pain to')
    expect(running).not_to_contain_text('Pain')
    expect(phone.locator('#day-log')).to_contain_text('Pain · until')
    expect(phone.locator('#day-log')).not_to_contain_text('Pain ended')

    # Started again: one −15 is fine, a second would overlap the first episode, so it's refused.
    pain.click()
    phone.locator('.toast button', has_text='15').click()
    expect(phone.locator('.toast')).to_contain_text('Moved to')
    phone.locator('.toast button', has_text='15').click()
    expect(phone.locator('.toast')).to_contain_text('That would overlap another Pain.')
    expect(running).to_contain_text('Pain')
    expect(phone.locator('#day-log .entry-row.is-episode', has_text='Pain')).to_have_count(2)


def test_editing_episodes_keeps_them_whole(browser, supabase):
    headache, pain = make_tracker('Headache', 'episode'), make_tracker('Pain', 'episode')
    phone = phone_with(browser, supabase, [headache, pain], [  # Nov 13, 2025, New York (UTC-5)
        make_entry(headache, 'end', '2025-11-13T13:00:00.000Z'),    # 8:00, with no start before it
        make_entry(headache, 'start', '2025-11-13T14:00:00.000Z'),  # 9:00, cut short by the next start
        make_entry(headache, 'start', '2025-11-13T15:00:00.000Z'),  # 10:00, still going
        make_entry(pain, 'start', '2025-11-13T17:00:00.000Z'),      # 12:00
        make_entry(pain, 'end', '2025-11-13T18:00:00.000Z'),        # 13:00
        make_entry(pain, 'start', '2025-11-13T19:00:10.000Z'),      # 14:00:10
        make_entry(pain, 'end', '2025-11-13T19:00:50.000Z', note='took ibuprofen'),  # 14:00:50, in the same minute
    ])
    phone.page.click('#previous-day')
    expect(phone.locator('.day-name')).to_contain_text('Thu, Nov 13')
    log, toast = phone.locator('#day-log'), phone.locator('.toast')

    # The 9:00 Headache can't move past the one that cut it short.
    phone.locator('.entry-row.is-episode', has_text='until 10:00 AM').click()
    phone.locator('.entry-editor input[type=time]').first.fill('11:00')
    phone.locator('[data-save-entry]').click()
    expect(toast).to_contain_text('That would overlap another Headache.')

    # An end that belongs to no episode can't be moved into one.
    phone.locator('.entry-row', has_text='Headache ended').click()
    phone.locator('.entry-editor input[type=time]').fill('09:30')
    phone.locator('[data-save-entry]').click()
    expect(toast).to_contain_text('That would overlap another Headache.')
    expect(log).to_contain_text('Headache · until 10:00 AM')

    # Pain began and ended within a minute, and its note, kept on its end, can still be changed.
    pain_at_two = phone.locator('.entry-row.is-episode', has_text='until 2:00 PM')
    pain_at_two.click()
    note = phone.locator('.entry-editor input[type=text]')
    expect(note).to_have_value('took ibuprofen')
    note.fill('better after lunch')
    phone.locator('[data-save-entry]').click()
    expect(phone.locator('.entry-editor')).to_have_count(0)
    expect(log).to_contain_text('better after lunch')
    expect(log).not_to_contain_text('took ibuprofen')

    # Nor can it be moved, start and end together, into the middle of the 12:00 Pain.
    pain_at_two.click()
    phone.locator('.entry-editor input[type=time]').nth(0).fill('12:15')
    phone.locator('.entry-editor input[type=time]').nth(1).fill('12:30')
    phone.locator('[data-save-entry]').click()
    expect(toast).to_contain_text('That would overlap another Pain.')
    expect(log).to_contain_text('Pain · until 2:00 PM')


def test_day_when_the_clocks_go_back_has_25_hours(browser, supabase):
    coffee = make_tracker('Coffee', 'moment')
    phone = phone_with(browser, supabase, [coffee], [
        make_entry(coffee, 'moment', '2025-11-03T04:30:00.000Z'),  # Nov 2, 23:30 in New York, after the clocks went back
    ])
    phone.page.click('#previous-day')
    expect(phone.locator('.day-name')).to_contain_text('Sun, Nov 2')
    expect(phone.locator('#day-log')).to_contain_text('Coffee')


# ---------- the analysis export, from known data ----------

@pytest.fixture(scope='module')
def fixture_export(browser, supabase):
    phone = phone_with(browser, supabase, FIXTURE['trackers'], FIXTURE['entries'], timezone=TIMEZONE)
    phone.screenshot('today-fixture')
    return export_for_analysis(phone).tables


@pytest.fixture(scope='module')
def daily(fixture_export):
    return {row['date']: row for row in fixture_export['daily']}


@pytest.fixture(scope='module')
def episode(fixture_export):
    return {row['episode_id']: row for row in fixture_export['episodes']}


@pytest.fixture(scope='module')
def checkin(fixture_export):
    return {row['checkin_id']: row for row in fixture_export['checkins']}


@pytest.fixture(scope='module')
def entry(fixture_export):
    return {row['entry_id']: row for row in fixture_export['entries']}


@pytest.fixture(scope='module')
def tracker(fixture_export):
    return {row['tracker']: row for row in fixture_export['trackers']}


def test_daily_has_a_row_for_every_day(daily):
    assert {'2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04'} <= set(daily)


@pytest.mark.parametrize('date, expected', [
    ('2026-09-01', {
        'weekday': 'Tue', 'checkins': '2', 'Mood (avg)': '3', 'Water (total)': '8', 'Water (avg)': '4',
        'Activities: Exercise': '1', 'Activities: Work': '1', 'Activities: Friends': '0', 'Journal (text)': 'Slept ok',
        'Headache (episodes)': '1', 'Headache (minutes)': '120', 'Headache (max level)': '3',
        'Tired (episodes)': '1', 'Tired (minutes)': '120', 'Coffee (count)': '3', 'Snack (count)': '0'}),
    ('2026-09-02', {
        'weekday': 'Wed', 'checkins': '1', 'Mood (avg)': '5', 'Water (total)': '', 'Activities: Friends': '1',
        'Activities: Exercise': '0', 'Headache (episodes)': '2', 'Headache (minutes)': '90', 'Headache (max level)': '',
        'Tired (episodes)': '0', 'Tired (minutes)': '90', 'Coffee (count)': '0', 'Snack (count)': '1'}),
    ('2026-09-03', {  # nothing logged
        'checkins': '0', 'Mood (avg)': '', 'Activities: Exercise': '', 'Tired (minutes)': '0', 'Coffee (count)': '0'}),
    ('2026-09-04', {'Tired (episodes)': '1', 'Tired (minutes)': '1020', 'Mood (avg)': '3'}),  # still running: counted to midnight
    ('2026-09-05', {'Tired (minutes)': '1440'}),
])
def test_daily(daily, date, expected):
    assert fields(daily[date], expected) == expected


def test_daily_has_no_level_column_for_a_tracker_without_levels(fixture_export):
    assert 'Tired (max level)' not in fixture_export['daily'][0]


def test_episodes_oldest_first(fixture_export):
    assert [row['episode_id'] for row in fixture_export['episodes']] == [
        HEADACHE_SEP1, TIRED_OVERNIGHT, HEADACHE_RESTARTED, HEADACHE_SEP2, TIRED_ONGOING]


def test_episode_start_end_levels_and_notes(episode):
    expected = {
        'tracker': 'Headache', 'start': '2026-09-01 10:00:00', 'end': '2026-09-01 12:00:00',
        'start_date': '2026-09-01', 'start_time': '10:00', 'end_time': '12:00', 'duration_min': '120',
        'status': 'ended', 'max_level': '3', 'max_level_label': 'Severe', 'levels_logged': '2', 'notes': 'woke with it',
    }
    assert fields(episode[HEADACHE_SEP1], expected) == expected


def test_episode_timeline_lists_what_happened_in_between(episode):
    assert episode[HEADACHE_SEP1]['timeline'] == '10:00 started · 10:30 Moderate · 11:00 Severe · 11:30 Coffee · 12:00 ended'


def test_episode_across_midnight(episode):
    expected = {
        'start_date': '2026-09-01', 'start_time': '22:00', 'end_date': '2026-09-02', 'end_time': '01:30',
        'end': '2026-09-02 01:30:00', 'duration_min': '210', 'timeline': '22:00 started · 09-02 01:30 ended',
    }
    assert fields(episode[TIRED_OVERNIGHT], expected) == expected


def test_episode_cut_short_by_a_restart(episode):
    expected = {'duration_min': '60', 'status': 'restarted', 'timeline': '15:00 started · 16:00 restarted'}
    assert fields(episode[HEADACHE_RESTARTED], expected) == expected
    expected = {'duration_min': '30', 'status': 'ended'}
    assert fields(episode[HEADACHE_SEP2], expected) == expected


def test_episode_still_running(episode):
    expected = {'status': 'ongoing', 'end': '', 'end_date': '', 'start_date': '2026-09-04',
                'timeline': '07:00 started · 09:00 Mood: Okay'}
    assert fields(episode[TIRED_ONGOING], expected) == expected


def test_checkins_one_row_each(checkin):
    assert set(checkin) == {MORNING_SEP1, EVENING_SEP1, MORNING_SEP2, MORNING_SEP4}


def test_checkin_answers_side_by_side(checkin):
    expected = {
        'date': '2026-09-01', 'time': '09:00', 'Mood': '4', 'Water': '3', 'Activities: Exercise': '1',
        'Activities: Work': '1', 'Activities: Friends': '0', 'Journal': 'Slept ok',
    }
    assert fields(checkin[MORNING_SEP1], expected) == expected


def test_checkin_in_local_time_with_skipped_questions_blank(checkin):
    expected = {
        'datetime': '2026-09-01 20:00:00', 'date': '2026-09-01', 'time': '20:00',
        'Mood': '2', 'Water': '5', 'Activities: Exercise': '', 'during': '',
    }
    assert fields(checkin[EVENING_SEP1], expected) == expected


def test_checkin_during_an_episode(checkin):
    expected = {'Mood': '3', 'during': 'Tired'}
    assert fields(checkin[MORNING_SEP4], expected) == expected


def test_checkin_notes(checkin):
    expected = {'Mood': '5', 'Water': '', 'Activities: Friends': '1', 'notes': 'Mood: after a run'}
    assert fields(checkin[MORNING_SEP2], expected) == expected


def test_entries_leave_out_deleted(entry):
    assert DELETED_COFFEE not in entry
    assert len(entry) == len(FIXTURE['entries']) - 1


def test_entry_level_belongs_to_its_episode(entry):
    expected = {'event': 'level', 'value': '2', 'label': 'Moderate', 'episode_id': HEADACHE_SEP1}
    assert fields(entry[HEADACHE_MODERATE], expected) == expected


def test_entry_end_belongs_to_its_episode(entry):
    assert entry[TIRED_OVERNIGHT_END]['episode_id'] == TIRED_OVERNIGHT
    assert entry[HEADACHE_SEP2_END]['episode_id'] == HEADACHE_SEP2


def test_entry_in_local_time(entry):
    expected = {'event': 'answer', 'datetime': '2026-09-01 20:00:00', 'date': '2026-09-01', 'time': '20:00',
                'timestamp_utc': '2026-09-02T00:00:00.000Z'}
    assert fields(entry[MOOD_EVENING], expected) == expected


def test_entry_during_other_trackers_episodes(entry):
    expected = {'tracker': 'Coffee', 'during': 'Headache', 'during_episode_ids': HEADACHE_SEP1}
    assert fields(entry[COFFEE_DURING_HEADACHE], expected) == expected
    assert entry[MOOD_WHILE_TIRED]['during'] == 'Tired'
    # An episode's own entries aren't "during" it.
    assert entry[HEADACHE_MODERATE]['during'] == ''
    assert entry[HEADACHE_SEP2]['during'] == ''


def test_entry_text_answer_in_text_column(entry):
    expected = {'text': 'Slept ok', 'label': ''}
    assert fields(entry[JOURNAL_ANSWER], expected) == expected


def test_trackers_include_archived_ones_with_history(tracker):
    assert len(tracker) == len(FIXTURE['trackers'])
    assert tracker['Snack']['archived'] == 'true'


def test_trackers_spell_out_levels_and_options(tracker):
    assert tracker['Mood']['levels'] == '1=Awful; 2=Bad; 3=Okay; 4=Good; 5=Great'
    expected = {'options': 'Exercise; Work; Friends', 'multiple_choice': 'true'}
    assert fields(tracker['Activities'], expected) == expected
