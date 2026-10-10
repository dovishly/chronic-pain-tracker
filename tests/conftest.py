"""Fixtures for the tests. The end-to-end tests (all but schema_test.py) serve the built app (dist/), drive it in
headless Chromium at phone size, and fake Supabase's REST and Auth APIs in-process (see harness.py), so no real
project or network is needed.

Set up:  pip install -r tests/requirements.txt && python -m playwright install chromium
Run:     npm test            (builds, then runs every test)
         npm run test:e2e    (builds, then runs the end-to-end tests)
Screenshots land in tests/screenshots/ (git-ignored).
"""
import functools, http.server, os, socketserver, threading
import pytest
from playwright.sync_api import sync_playwright
from harness import APP_PORT, DIST, SCREENSHOTS, FakeSupabase, browser_errors


@pytest.fixture(scope='session')
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

    server = Server(('127.0.0.1', APP_PORT), functools.partial(QuietHandler, directory=DIST))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield
    server.shutdown()


@pytest.fixture(scope='session')
def browser(app_server):
    """Headless Chromium for the whole run, with the app being served."""
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        yield browser
        browser.close()


@pytest.fixture(scope='module')
def supabase():
    """A fake Supabase of each test file's own, so each starts with empty accounts."""
    return FakeSupabase()


@pytest.fixture(autouse=True)
def no_browser_errors():
    """Fails a test (at teardown) if a page logged an error or threw since the previous test."""
    yield
    # Failed requests are expected: the fake Supabase refuses some on purpose, and some tests go offline.
    errors = [e for e in browser_errors if 'Failed to load resource' not in e and 'fonts' not in e]
    browser_errors.clear()
    assert not errors
