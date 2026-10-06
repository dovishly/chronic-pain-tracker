"""End-to-end tests for Logbook.

Serves the built app (dist/) locally, drives it in headless Chromium at phone size, and fakes the
Supabase REST/Auth API in-process, so no real project or network is needed.

Most tests run in order and build on each other, like one person using the app: the first phone logs
entries and changes settings, then signs in to the fake Supabase; a second and a third phone link to
the same account. So when one fails, look at the first failure: the ones after it may only be
following on. The analysis export tests at the end stand alone: they load known data
(tests/fixtures/analysis.json) into a fourth phone and check the same figures as schema_test.py.

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
EMAIL = 'me@example.com'   # the only account in the fake Supabase
PASSWORD = 'correct horse battery staple'  # the account's password
CODE = '123456'            # the sign-in code it always accepts; each email also has a one-time link
ACCOUNT_TRACKERS = 16      # the 15 starter trackers plus Stiffness, added on the first phone
TRICKY_NAME = '<b>Bold</b> & "Q"'  # must be shown as typed, never turned into HTML


# ---------- fake Supabase ----------

class FakeSupabase:
    """Just enough of Supabase's Auth and REST APIs for the app, kept in memory."""

    def __init__(self):
        self.tables = {'trackers': {}, 'entries': {}}
        self.schema_version = 1  # 0 acts like a schema.sql from before versions (the function is missing)
        self.users = {EMAIL: 'u1'}
        self.links = {}           # token in an emailed sign-in link -> email address
        self.last_link = None     # the link in the latest email
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

        if path == '/auth/v1/otp':
            if body['email'] not in self.users:
                return 422, {'code': 422, 'error_code': 'otp_disabled', 'msg': 'Signups not allowed for otp'}
            # The email Supabase sends a new free project: a link, built the way Supabase builds it.
            token_hash = uuid.uuid4().hex
            self.links[token_hash] = body['email']
            self.last_link = f'{SUPABASE_URL}/auth/v1/verify?token={token_hash}&type=magiclink&redirect_to=https%3A%2F%2Fexample.github.io%2F'
            return 200, {}
        if path == '/auth/v1/verify':
            if 'token_hash' in body:  # from a link, which works once
                email = self.links.pop(body['token_hash'], None) if body.get('type') == 'email' else None
            else:
                email = body.get('email') if body.get('token') == CODE else None
            if not email:
                return 403, {'msg': 'Token has expired or is invalid'}
            return 200, self.new_session(self.users[email], email)
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
        if 'updated_at' in query:  # gte.<cursor> or gt.<cursor>
            op, cursor = query['updated_at'][0].split('.', 1)
            rows = [row for row in rows if (row['updated_at'] >= cursor if op == 'gte' else row['updated_at'] > cursor)]
        rows.sort(key=lambda row: row['updated_at'])
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
        if self.locator('#use-password').count():
            self.page.click('#use-password')
        self.page.fill('#sign-in-email', email)
        self.page.fill('#sign-in-password', password)
        self.page.click('#sign-in')

    def request_code(self, email=EMAIL):
        """Asks for a sign-in email, the fallback for a forgotten password."""
        if self.locator('#use-email-link').count():
            self.page.click('#use-email-link')
        self.page.fill('#sign-in-email', email)
        self.page.click('#send-code')

    def enter_code(self, code_or_link=CODE):
        self.page.fill('#sign-in-code', code_or_link)
        self.page.click('#sign-in-with-link')

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


# Loads the fixture into the app's IndexedDB, replacing what's there, as if it had been logged on this phone.
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
    expect(log).to_contain_text('Tired ended')
    expect(log).to_contain_text('Headache: Moderate')
    assert phone1.locator('.timeline-row').count() >= 2


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


def test_sign_in_refuses_unknown_email(phone1):
    phone1.request_code('stranger@example.com')
    expect(phone1.locator('#sign-in-error')).to_contain_text("isn't a user in this project")


def test_sign_in_refuses_wrong_code(phone1):
    phone1.request_code()
    phone1.enter_code('000000')
    expect(phone1.locator('#sign-in-error')).to_contain_text("didn't work")


def test_sign_in_refuses_wrong_link(phone1):
    phone1.enter_code(f'{SUPABASE_URL}/auth/v1/verify?token=not-a-real-token&type=magiclink')
    expect(phone1.locator('#sign-in-error')).to_contain_text("didn't work")


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


def test_last_sync_on_an_earlier_day(phone1, supabase):
    phone1.page.evaluate("localStorage.setItem('logbook.lastSync', String(new Date(2026, 8, 3, 12).getTime()))")
    supabase.schema_version = 0  # so the sync after reopening fails and leaves that time alone
    phone1.open()
    phone1.go_to('Settings')
    expect(phone1.locator('#sync-panel')).to_contain_text('Last synced on Thu, Sep 3 at')
    supabase.schema_version = 1


# ---------- phone 2: a fresh phone joins the account ----------

def test_outdated_database_stops_sync(phone2, supabase):
    phone2.go_to('Settings')
    phone2.connect()
    phone2.request_code()
    supabase.schema_version = 0  # the owner hasn't run the latest schema.sql yet
    phone2.enter_code()
    expect(phone2.locator('#sync-pill')).to_contain_text('Action needed')
    expect(phone2.locator('#sync-panel')).to_contain_text("Your Supabase project needs Logbook's tables")
    expect(phone2.locator('#trackers')).not_to_contain_text('Drowsy')


def test_setup_sql_can_be_copied_into_the_sql_editor(phone2):
    expect(phone2.locator('#schema-editor')).to_have_attribute('href', 'https://supabase.com/dashboard/project/mock/sql/new')
    phone2.context.grant_permissions(['clipboard-read', 'clipboard-write'])
    phone2.page.click('#schema-copy')
    expect(phone2.locator('.toast')).to_contain_text('Setup SQL copied')
    sql = phone2.page.evaluate('navigator.clipboard.readText()')
    assert 'create table if not exists public.trackers' in sql
    assert "$$ select 'Europe/Berlin' $$" in sql  # the views use this phone's time zone


def test_fresh_phone_takes_the_accounts_trackers(phone2, supabase):
    supabase.schema_version = 1  # schema.sql run again
    phone2.page.click('#sync-now')
    trackers = phone2.locator('#trackers')
    expect(trackers).to_contain_text('Drowsy')
    expect(trackers).to_contain_text('Stiffness')
    # Its own starter trackers were replaced, not added to the account.
    assert trackers.inner_text().count('Headache') == 1
    assert len(supabase.rows('trackers')) == ACCOUNT_TRACKERS


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
    phone3.request_code()
    phone3.enter_code(supabase.last_link)  # pasted from the email instead of a code
    expect(phone3.locator('#sync-panel')).to_contain_text('Your account already has data')
    assert len(supabase.rows('trackers')) == ACCOUNT_TRACKERS  # nothing uploaded yet


def test_choosing_the_account_replaces_this_phones_data(phone3, supabase):
    phone3.page.click('#use-account-data')
    expect(phone3.locator('#trackers')).to_contain_text('Drowsy')
    assert len(supabase.rows('trackers')) == ACCOUNT_TRACKERS


def test_no_sideways_scrolling(phone1, phone2, phone3):
    for phone in [phone1, phone2, phone3]:
        assert phone.page.evaluate('document.documentElement.scrollWidth') <= 390


def test_day_when_the_clocks_go_back_has_25_hours(browser, supabase):
    coffee = {'id': '00000000-0000-4000-8000-0000000000c1', 'name': 'Coffee', 'type': 'moment', 'group_name': 'Moments',
              'color': 'amber', 'config': {}, 'sort_order': 10, 'archived': False}
    late = {'id': '00000000-0000-4000-9000-0000000000c1', 'tracker_id': coffee['id'], 'kind': 'moment',
            'occurred_at': '2025-11-03T04:30:00.000Z',  # Nov 2, 23:30 in New York, after the clocks went back
            'value': None, 'text': None, 'note': None, 'checkin_id': None, 'deleted': False}
    phone = Phone(browser, supabase, timezone='America/New_York')
    phone.page.evaluate(LOAD_FIXTURE, {'trackers': [coffee], 'entries': [late]})
    phone.open()
    phone.page.click('#previous-day')
    expect(phone.locator('.day-name')).to_contain_text('Sun, Nov 2')
    expect(phone.locator('#day-log')).to_contain_text('Coffee')


# ---------- the analysis export, from known data (schema_test.py checks the same figures in SQL) ----------

@pytest.fixture(scope='module')
def fixture_export(browser, supabase):
    phone = Phone(browser, supabase, timezone=TIMEZONE)
    phone.page.evaluate(LOAD_FIXTURE, FIXTURE)
    phone.open()
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
