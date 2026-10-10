"""Settings, each test on a new phone: appearance, joining an account, and restoring a backup."""
from playwright.sync_api import expect
from harness import OTHER_EMAIL, Phone, make_entry, make_tracker, minutes_ago, phone_with, tracker_names


def test_appearance_is_picked_in_settings_and_kept(browser, supabase):
    phone = Phone(browser, supabase)  # a phone in light mode
    html = phone.locator('html')
    background = lambda: phone.page.evaluate('getComputedStyle(document.body).backgroundColor')
    expect(html).to_have_attribute('data-theme', 'light')
    phone.go_to('Settings')
    phone.locator('#theme-choice button', has_text='Dark').click()
    expect(html).to_have_attribute('data-theme', 'dark')
    assert background() == 'rgb(27, 28, 30)'
    assert phone.locator('meta[name="theme-color"]').first.get_attribute('content') == '#1B1C1E'

    phone.open()  # kept when the app is opened again, from the first paint
    expect(html).to_have_attribute('data-theme', 'dark')
    phone.go_to('Settings')
    expect(phone.locator('#theme-choice button[aria-pressed="true"]')).to_have_text('Dark')
    phone.locator('#theme-choice button', has_text='Match device').click()
    expect(html).to_have_attribute('data-theme', 'light')
    assert background() == 'rgb(232, 236, 230)'


def test_an_account_with_only_deleted_trackers_counts_as_empty(browser, supabase):
    # So a phone joining it keeps its own trackers and entries, without asking.
    old = '00000000-0000-4000-8000-0000000000a1'
    supabase.tables['trackers'][old] = {'id': old, 'user_id': 'u2', 'name': 'Old', 'type': 'moment', 'group_name': None,
                                        'color': 'slate', 'config': {}, 'sort_order': 0, 'archived': False,
                                        'deleted': True, 'updated_at': supabase.now()}
    phone = Phone(browser, supabase)
    phone.locator('.moment-button', has_text='Medication').click()
    phone.go_to('Settings')
    phone.connect()
    phone.sign_in(email=OTHER_EMAIL)
    expect(phone.locator('#sync-pill')).to_contain_text('Synced')
    expect(phone.locator('#trackers')).to_contain_text('Medication')
    assert len([row for row in supabase.rows('entries') if row['user_id'] == 'u2']) == 1  # its medication went up


def export_backup(phone):
    """The file Export backup gives, saved where the test can read it."""
    phone.go_to('Settings')
    with phone.page.expect_download() as download:
        phone.page.click('#export-backup')
    return download.value.path()


def test_restore_a_backup_on_a_new_device(browser, supabase):
    pain, coffee = make_tracker('Pain', 'episode'), make_tracker('Coffee', 'moment')
    start = make_entry(pain, 'start', minutes_ago(90), note='woke with it')
    old = phone_with(browser, supabase, [pain, coffee], [
        start, make_entry(pain, 'end', minutes_ago(30)), make_entry(coffee, 'moment', minutes_ago(60)),
    ])
    backup = export_backup(old)

    new = Phone(browser, supabase)  # the starter trackers, and one entry of its own
    new.locator('.moment-button', has_text='Medication').click()
    new.go_to('Settings')
    new.page.set_input_files('#restore-backup-file', backup)
    notice = new.locator('.notice', has_text='Restore the backup from')
    expect(notice).to_contain_text('It has 2 trackers and 3 entries')
    expect(notice).to_contain_text("1 entry here isn't in the backup, so it will be lost.")
    new.page.click('#restore-backup-confirm')
    expect(new.locator('.toast')).to_contain_text('Restored 2 trackers and 3 entries.')
    expect(notice).to_have_count(0)
    assert tracker_names(new) == ['Coffee', 'Pain']  # in place of the starter trackers
    expect(new.locator('#view-settings')).to_contain_text('3 entries on this device')
    assert new.stored('entries', start['id'])['note'] == 'woke with it'

    new.open()  # kept
    new.go_to('Settings')
    assert tracker_names(new) == ['Coffee', 'Pain']


def test_a_file_that_isnt_a_backup_is_refused(browser, supabase):
    phone = Phone(browser, supabase)
    phone.go_to('Settings')
    not_a_backup = {'name': 'notes.json', 'mimeType': 'application/json', 'buffer': b'{"notes": []}'}
    phone.page.set_input_files('#restore-backup-file', files=[not_a_backup])
    expect(phone.locator('#restore-backup-error')).to_have_text("That file isn't a Log Lightly backup.")
    expect(phone.locator('.notice', has_text='Restore the backup')).to_have_count(0)


def test_restoring_is_only_for_a_device_without_sync(browser, supabase):
    phone = Phone(browser, supabase)
    phone.go_to('Settings')
    expect(phone.locator('#restore-backup-file')).to_have_count(1)
    phone.connect()
    expect(phone.locator('#restore-backup-file')).to_have_count(0)  # it gets its data from the account instead
