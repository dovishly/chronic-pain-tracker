"""One person using the app, in order: the first phone logs entries and changes settings, then signs in to the
fake Supabase; a second and a third phone link to the same account.

The tests build on each other, so when one fails, look at the first failure: the ones after it may only be
following on.
"""
import datetime, json, re
import pytest
from playwright.sync_api import expect
from harness import APP_SCHEMA_VERSION, Phone, browser_errors, export_for_analysis, fields, tracker_names

ACCOUNT_TRACKERS = 9       # the 8 starter trackers plus Stiffness, added on the first phone
TRICKY_NAME = '<b>Bold</b> & "Q"'  # must be shown as typed, never turned into HTML


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
    expect(phone1.locator('[data-episode]', has_text='Pain')).to_have_count(1)
    expect(phone1.locator('[data-episode]', has_text='Fatigue')).to_have_count(1)
    expect(phone1.locator('[data-moment]', has_text='Medication')).to_have_count(1)


def test_help_explains_where_data_is_kept(phone1):
    help_dialog = phone1.locator('#storage-help-dialog')
    phone1.page.click('#storage-help')
    expect(help_dialog).to_be_visible()
    expect(help_dialog).to_contain_text("At the moment, it's only on this device")
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
    fatigue = phone1.locator('.episode-card.is-running', has_text='Fatigue')
    phone1.locator('.episode-card .episode-button', has_text='Fatigue').click()
    expect(fatigue).to_have_count(1)
    expect(fatigue.locator('.level-buttons')).to_have_count(0)  # Fatigue has no levels

    phone1.locator('.episode-card .episode-button', has_text='Pain').click()
    pain = phone1.locator('.episode-card.is-running', has_text='Pain')
    pain.locator('.level-buttons button[data-level="2"]').click()
    expect(pain.locator('.level-buttons button[aria-pressed="true"]')).to_have_text('Moderate')

    fatigue.locator('.episode-button').click()  # tapping a running episode's tile stops it
    expect(fatigue).to_have_count(0)


def test_moments_and_the_days_log(phone1):
    phone1.locator('.moment-button', has_text='Medication').click()
    expect(phone1.locator('.day-total', has_text='Medication')).to_have_text('Medication 1×')
    log = phone1.locator('#day-log')
    expect(log).to_contain_text('Medication')
    expect(log).to_contain_text('Fatigue · until')  # one row for the whole episode
    expect(log).to_contain_text('Pain: Moderate')
    expect(phone1.locator('#day-log')).to_have_attribute('data-lanes', '2')  # Fatigue and Pain overlapped
    expect(phone1.locator('#day-log > li').first).to_have_class('day-row day-now')
    expect(phone1.locator('#day-log .lane-bar.is-now')).to_have_count(1)  # Pain, still going, reaches Now
    expect(phone1.locator('#day-log .lane-bar.is-end, #day-log .lane-bar.is-start-end')).to_have_count(1)  # Fatigue's ring
    shown_times = [t for t in phone1.locator('#day-log .entry-time').all_inner_texts() if t.strip()]
    assert len(shown_times) == len(set(shown_times))  # each time once, on the newest row that has it
    expect(phone1.locator('.day-totals')).to_contain_text('Fatigue 1×')
    expect(phone1.locator('.day-totals')).to_contain_text('Medication 1×')


def test_toast_undo(phone1):
    phone1.locator('.toast button', has_text='Undo').click()
    expect(phone1.locator('#day-log')).not_to_contain_text('Medication')


def test_toast_moves_the_entry_earlier(phone1):
    phone1.locator('.moment-button', has_text='Medication').click()
    phone1.locator('.toast button', has_text='15').click()
    expect(phone1.locator('.toast')).to_contain_text('Moved to')


def test_edit_an_entrys_note(phone1):
    phone1.locator('.entry-row', has_text='Medication').click()
    phone1.locator('.entry-editor input[type=text]').fill('with food')
    phone1.locator('[data-save-entry]').click()
    expect(phone1.locator('#day-log')).to_contain_text('with food')
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
    phone1.locator('.question', has_text='Notes').locator('textarea').fill('Felt okay after lunch')
    phone1.screenshot('checkin-light')

    phone1.page.click('#save-checkin')  # saves and goes back to Today
    checkin = phone1.locator('.entry-row.is-checkin')
    expect(checkin).to_have_count(1)  # one row for the whole check-in
    expect(checkin).to_contain_text('Check-in · Mood: Good, Water: 3 glasses +2 more')
    checkin.click()  # shows each answer
    log = phone1.locator('#day-log')
    for text in ['Mood: Good', 'Activities: Exercise', 'Activities: Friends', 'Water: 3 glasses', 'Notes: Felt okay']:
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
    assert dot.evaluate("dot => dot.style.getPropertyValue('--on')") == '#1E2A24'  # dark text on it


def test_rename_a_tracker_but_not_change_its_type(phone1):
    phone1.locator('.tracker-list li', has_text='Fatigue').locator('[data-edit-tracker]').click()
    expect(phone1.locator('#editor-type')).to_be_disabled()  # Fatigue has entries
    phone1.page.fill('#editor-name', 'Sleepy')
    phone1.page.click('#editor-save')
    expect(phone1.locator('#trackers')).to_contain_text('Sleepy')


def test_archive_a_tracker(phone1):
    phone1.locator('.tracker-list li', has_text='Water').locator('[data-edit-tracker]').click()
    phone1.page.click('#editor-archive')
    expect(phone1.locator('#trackers')).not_to_contain_text('Water')
    expect(phone1.locator('#archived-trackers')).to_contain_text('Water')


def test_move_a_tracker_up(phone1):
    def notes_before_activities():
        names = tracker_names(phone1)
        return names.index('Notes') < names.index('Activities')
    assert not notes_before_activities()
    phone1.locator('.tracker-list li', has_text='Notes').locator('[data-move-up]').click()
    phone1.wait_for(notes_before_activities)
    assert notes_before_activities()


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
    assert re.match(r'log-lightly-\d{4}-\d{2}-\d{2}\.zip$', phone1_export.filename)
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
    assert any(row['note'] == 'with food' for row in entries)
    assert sum(row['tracker'] == 'Medication' for row in entries) == 1  # the undone one is left out


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
    dose = next(row['id'] for row in supabase.rows('entries') if row['note'] == 'with food')
    phone1.go_to('Today')
    phone1.locator('.entry-row', has_text='with food').click()
    phone1.locator('.entry-editor .button.danger').click()
    expect(phone1.locator('#day-log')).not_to_contain_text('with food')
    phone1.wait_for(lambda: fields(supabase.tables['entries'][dose], WIPED_ENTRY) == WIPED_ENTRY)
    assert fields(supabase.tables['entries'][dose], WIPED_ENTRY) == WIPED_ENTRY
    assert fields(phone1.stored('entries', dose), WIPED_ENTRY) == WIPED_ENTRY


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
    expect(phone2.locator('#sync-panel')).to_contain_text("Your Supabase project needs Log Lightly's tables")
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
    assert trackers.inner_text().count('Pain') == 1
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
    phone3.locator('.moment-button', has_text='Medication').click()  # an entry of this phone's own, for later
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
    expect(phone3.locator('.moment-button', has_text=TRICKY_NAME)).to_have_count(1)
    expect(phone3.locator('#day-log')).to_contain_text(TRICKY_NAME)
    assert phone3.locator('#view-today b, #toast-host b').count() == 0


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
    water = next(row['id'] for row in supabase.rows('trackers') if row['name'] == 'Water')
    phone3.page.evaluate("document.querySelector('#archived-trackers').open = true")
    delete = phone3.locator('#archived-trackers li', has_text='Water').locator('[data-delete-tracker]')
    delete.click()
    expect(delete).to_have_text('Delete for good?')
    delete.click()
    expect(phone3.locator('#archived-trackers')).to_have_count(0)  # Water was the only archived tracker
    # Uploaded before the next test looks at what's in Supabase.
    water_deleted = lambda: supabase.tables['trackers'][water]['deleted']
    phone3.wait_for(water_deleted)
    assert water_deleted()


def live_tracker_names(supabase):
    return sorted(row['name'] for row in supabase.rows('trackers') if not row['deleted'])


def test_reset_this_phone_leaves_supabase_alone(phone2, supabase):
    in_supabase = live_tracker_names(supabase)
    phone2.go_to('Settings')
    phone2.page.click('#reset-device')
    expect(phone2.locator('.notice', has_text='Reset this device?')).to_contain_text('Your synced data stays in Supabase')
    phone2.page.click('#reset-device-confirm')
    expect(phone2.locator('#sync-pill')).to_have_text('On this device only')  # reopened, signed out
    phone2.go_to('Settings')
    expect(phone2.locator('#trackers')).to_contain_text('Fatigue')  # the starter trackers again
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
    assert phone1.locator('#trackers').inner_text().count('Pain') == 1


def test_another_project_gets_its_schema_checked(phone1, supabase):
    # Connecting a project in the same session as another: this one may not have Log Lightly's tables yet.
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
    medication = next(row for row in supabase.rows('trackers') if row['user_id'] == 'u1' and row['name'] == 'Medication' and not row['deleted'])
    updated_at = supabase.now()
    def row(id, deleted, note=None):
        return {'id': id, 'user_id': 'u1', 'tracker_id': medication['id'], 'kind': 'moment', 'value': None, 'text': None,
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
