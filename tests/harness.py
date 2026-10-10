"""What the end-to-end tests drive the app with: a fake Supabase, phones (browsers at phone size, each with
storage of its own), known data to load into them, and the analysis export to read back. conftest.py has the
fixtures that serve the app and start the browser.
"""
import csv, datetime, json, os, re, time, uuid, zipfile
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import expect

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(ROOT, 'dist')
SCREENSHOTS = os.path.join(ROOT, 'tests', 'screenshots')

APP_PORT = 8765
APP_URL = f'http://127.0.0.1:{APP_PORT}/index.html'
SUPABASE_URL = 'https://mock.supabase.co'
ANON_KEY = 'anon-key-0123456789abcdefghij'
EMAIL = 'me@example.com'   # the account in the fake Supabase that most tests use
OTHER_EMAIL = 'other@example.com'  # a second account there
PASSWORD = 'correct horse battery staple'  # both accounts' password
# The schema version the app needs; the fake database reports it once "schema.sql has been run".
APP_SCHEMA_VERSION = int(re.search(r'const SCHEMA_VERSION = (\d+);', open(os.path.join(ROOT, 'src', 'lib', 'sync.ts')).read()).group(1))


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

browser_errors = []  # errors logged or thrown by any page; see no_browser_errors in conftest.py


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
