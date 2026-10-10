"""The README's picture of the app: three phone screens side by side (Today's buttons, the day's timeline, a
check-in), with a full, made-up day. Saves docs/screens-light.png and docs/screens-dark.png.

Usage: npm run screenshots   (builds, then runs this with the test tools from tests/requirements.txt)

The browser's clock is fixed at 4:05 PM today, so the day looks the same whenever this runs. Each screen is taken at
twice the phone's size, so the picture stays sharp on high-resolution screens.
"""
import base64, datetime, functools, http.server, os, socketserver, sys, threading, uuid
from playwright.sync_api import sync_playwright, expect

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'tests'))
from harness import DIST, LOAD_FIXTURE  # noqa: E402  (the same loader the tests use)

OUT = os.path.join(ROOT, 'docs')
PORT = 8766
NOW = datetime.datetime.now().astimezone().replace(hour=16, minute=5, second=0, microsecond=0)


def tracker(name, type_, color, group, sort, config=None):
    return {'id': str(uuid.uuid4()), 'name': name, 'type': type_, 'group_name': group, 'color': color,
            'config': config or {}, 'sort_order': sort, 'archived': False, 'deleted': False}


def entry(t, kind, minutes_ago, value=None, text=None, note=None, checkin=None):
    when = (NOW - datetime.timedelta(minutes=minutes_ago)).astimezone(datetime.timezone.utc)
    return {'id': str(uuid.uuid4()), 'tracker_id': t['id'], 'kind': kind,
            'occurred_at': when.isoformat(timespec='milliseconds').replace('+00:00', 'Z'),
            'value': value, 'text': text, 'note': note, 'checkin_id': checkin, 'deleted': False}


mood = tracker('Mood', 'rating', 'amber', 'Check-in', 10, {'levels': ['Awful', 'Bad', 'Okay', 'Good', 'Great']})
sleep = tracker('Sleep', 'rating', 'violet', 'Check-in', 20, {'levels': ['Very poor', 'Poor', 'Okay', 'Good', 'Great']})
water = tracker('Water', 'number', 'sky', 'Check-in', 25, {'unit': 'glasses', 'min': 0, 'max': 30, 'step': 1})
where = tracker('Pain where', 'choice', 'rose', 'Check-in', 27,
                {'options': ['Knees', 'Hands', 'Back', 'Hips', 'Jaw'], 'multi': True})
notes = tracker('Notes', 'text', 'slate', 'Check-in', 28)
pain = tracker('Joint pain', 'episode', 'rose', 'Symptoms', 30, {'levels': ['Mild', 'Moderate', 'Severe']})
headache = tracker('Headache', 'episode', 'violet', 'Symptoms', 35)
fatigue = tracker('Fatigue', 'episode', 'indigo', 'Symptoms', 40)
dizzy = tracker('Dizzy spell', 'moment', 'sky', 'Symptoms', 50)
nausea = tracker('Nausea', 'moment', 'green', 'Symptoms', 55)
rescue = tracker('Rescue dose', 'moment', 'teal', 'Moments', 60)
meal = tracker('Ate', 'moment', 'slate', 'Moments', 65)
coffee = tracker('Coffee', 'moment', 'amber', 'Moments', 70)
TRACKERS = [mood, sleep, water, where, notes, pain, headache, fatigue, dizzy, nausea, rescue, meal, coffee]

morning, afternoon = str(uuid.uuid4()), str(uuid.uuid4())
ENTRIES = [  # minutes before 4:05 PM
    entry(mood, 'answer', 510, 2, 'Bad', checkin=morning),  # 7:35 AM
    entry(sleep, 'answer', 510, 1, 'Very poor', note='woke at 3', checkin=morning),
    entry(pain, 'start', 505), entry(pain, 'level', 505, 2, 'Moderate', note='both knees, stiff'),
    entry(coffee, 'moment', 490),
    entry(rescue, 'moment', 480),
    entry(meal, 'moment', 465, note='toast'),
    entry(pain, 'level', 420, 1, 'Mild'),
    entry(pain, 'end', 375),
    entry(fatigue, 'start', 360),
    entry(dizzy, 'moment', 335, note='standing up'),
    entry(headache, 'start', 305),
    entry(nausea, 'moment', 285),
    entry(fatigue, 'end', 230, note='better after lying down'),
    entry(meal, 'moment', 215, note='lunch'),
    entry(headache, 'end', 190),
    entry(mood, 'answer', 155, 3, 'Okay', checkin=afternoon),
    entry(water, 'answer', 155, 4, checkin=afternoon),
    entry(coffee, 'moment', 125),
    entry(pain, 'start', 70), entry(pain, 'level', 70, 1, 'Mild'),
    entry(pain, 'level', 25, 2, 'Moderate', note='left knee'),
    entry(dizzy, 'moment', 15),
    entry(rescue, 'moment', 0, note='with food'),
]


# Each phone screen with rounded corners and a soft shadow, side by side on a transparent background.
LAYOUT = """<!doctype html><html><body style="margin:0;background:transparent">
<div id="screens" style="display:flex;gap:56px;padding:48px">{phones}</div></body></html>"""
PHONE = ('<img src="data:image/png;base64,{png}" style="width:390px;height:844px;border-radius:44px;'
         'box-shadow:0 0 0 1.5px rgba(0,0,0,.12),0 18px 44px rgba(0,0,0,.18)">')


def screens(page):
    """Today's buttons, the day's timeline and a check-in being answered, each a phone screen's worth."""
    shots = [page.screenshot()]
    page.locator('.day-log-panel').evaluate('el => window.scrollTo(0, el.getBoundingClientRect().top + scrollY - 8)')
    page.wait_for_timeout(300)
    shots.append(page.screenshot())

    page.locator('.tab-bar button', has_text='Check in').click()
    page.locator('.question', has_text='Mood').locator('button[data-value="3"]').click()
    page.locator('.question', has_text='Sleep').locator('button[data-value="2"]').click()
    page.locator('.question', has_text='Water').locator('input').fill('5')
    page.locator('.question', has_text='Pain where').locator('.chip', has_text='Knees').click()
    page.locator('.question', has_text='Pain where').locator('.chip', has_text='Hands').click()
    page.locator('.question', has_text='Notes').locator('textarea').fill('Rain all day. Stiff after sitting.')
    page.evaluate('() => { document.activeElement.blur(); window.scrollTo(0, 0); }')
    page.wait_for_timeout(300)
    shots.append(page.screenshot())
    return shots


def main():
    if not os.path.exists(os.path.join(DIST, 'index.html')):
        sys.exit('No build found. Run `npm run build` first, or use `npm run screenshots`.')
    os.makedirs(OUT, exist_ok=True)

    socketserver.ThreadingTCPServer.allow_reuse_address = True
    quiet = type('Quiet', (http.server.SimpleHTTPRequestHandler,), {'log_message': lambda *args: None})
    server = socketserver.ThreadingTCPServer(('127.0.0.1', PORT), functools.partial(quiet, directory=DIST))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f'http://127.0.0.1:{PORT}/index.html'

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        for scheme in ['light', 'dark']:
            context = browser.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2,
                                          color_scheme=scheme, service_workers='block')
            page = context.new_page()
            page.clock.set_fixed_time(NOW)
            page.goto(url)
            page.evaluate(LOAD_FIXTURE, {'trackers': TRACKERS, 'entries': ENTRIES})
            page.goto(url)
            expect(page.locator('#day-log')).to_contain_text('left knee')
            page.wait_for_timeout(1500)  # for the web fonts
            phones = ''.join(PHONE.format(png=base64.b64encode(shot).decode()) for shot in screens(page))

            sheet = context.new_page()
            sheet.set_viewport_size({'width': 1400, 'height': 1000})  # room for three side by side
            sheet.set_content(LAYOUT.format(phones=phones))
            path = os.path.join(OUT, f'screens-{scheme}.png')
            sheet.locator('#screens').screenshot(path=path, omit_background=True)
            print('Saved', os.path.relpath(path, ROOT))
            context.close()
        browser.close()
    server.shutdown()


if __name__ == '__main__':
    main()
