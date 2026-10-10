"""Today, each test on a new phone, most with known data: the day's log and its bars, and changing episodes."""
import re
from playwright.sync_api import expect
from harness import Phone, make_entry, make_tracker, minutes_ago, phone_with


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
    # An episode is counted on the day it started; each day adds up the part of its time that fell on it.
    expect(phone.locator('.day-total', has_text='Tired')).to_have_text('Tired · 7 h 00 min')
    phone.page.click('#previous-day')
    expect(phone.locator('.day-name')).to_contain_text('Mon, Nov 10')
    expect(phone.locator('.day-total', has_text='Tired')).to_have_text('Tired 1× · 2 h 00 min')
    phone.page.click('#next-day')
    expect(phone.locator('.day-name')).to_contain_text('Tue, Nov 11')

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


def test_day_when_the_clocks_go_back_has_25_hours(browser, supabase):
    coffee = make_tracker('Coffee', 'moment')
    phone = phone_with(browser, supabase, [coffee], [
        make_entry(coffee, 'moment', '2025-11-03T04:30:00.000Z'),  # Nov 2, 23:30 in New York, after the clocks went back
    ])
    phone.page.click('#previous-day')
    expect(phone.locator('.day-name')).to_contain_text('Sun, Nov 2')
    expect(phone.locator('#day-log')).to_contain_text('Coffee')


def test_moving_an_episode_earlier_keeps_it_whole(browser, supabase):
    phone = Phone(browser, supabase)
    pain = phone.locator('.episode-card .episode-button', has_text='Pain')
    running = phone.locator('.episode-card.is-running', has_text='Pain')
    # Started and stopped at once, then −15 on the "ended" toast: it would end before it started, so the
    # whole episode moves back instead of Pain coming back on.
    pain.click()
    expect(running).to_have_count(1)
    pain.click()
    expect(running).to_have_count(0)
    phone.locator('.toast button', has_text='15').click()
    expect(phone.locator('.toast')).to_contain_text('Moved Pain to')
    expect(running).to_have_count(0)
    expect(phone.locator('#day-log')).to_contain_text('Pain · until')
    expect(phone.locator('#day-log')).not_to_contain_text('Pain ended')

    # Started again: one −15 is fine, a second would overlap the first episode, so it's refused.
    pain.click()
    phone.locator('.toast button', has_text='15').click()
    expect(phone.locator('.toast')).to_contain_text('Moved to')
    phone.locator('.toast button', has_text='15').click()
    expect(phone.locator('.toast')).to_contain_text('That would overlap another Pain.')
    expect(running).to_have_count(1)
    expect(phone.locator('#day-log .entry-row.is-episode', has_text='Pain')).to_have_count(2)


def test_tapping_a_level_starts_the_episode_at_it(browser, supabase):
    phone = Phone(browser, supabase)
    pain = phone.locator('.episode-card', has_text='Pain')
    expect(pain.locator('.level-buttons button')).to_have_count(3)  # shown before it's started, too
    pain.locator('.level-buttons button[data-level="3"]').click()
    expect(pain).to_have_class(re.compile(r'\bis-running\b'))
    expect(pain.locator('.level-buttons button[aria-pressed="true"]')).to_have_text('Severe')
    expect(phone.locator('#day-log')).to_contain_text('Pain: Severe')

    # Undo takes the level away with the start, rather than leave it on its own.
    phone.locator('.toast button', has_text='Undo').click()
    expect(pain).not_to_have_class(re.compile(r'\bis-running\b'))
    expect(phone.locator('#day-log')).not_to_contain_text('Pain')


def test_deleting_an_episode_takes_its_levels_along(browser, supabase):
    headache, coffee = make_tracker('Headache', 'episode'), make_tracker('Coffee', 'moment')
    moderate = {**make_entry(headache, 'level', minutes_ago(40)), 'value': 2, 'text': 'Moderate'}
    later = {**make_entry(headache, 'level', minutes_ago(5)), 'value': 1, 'text': 'Mild'}  # after it ended
    phone = phone_with(browser, supabase, [headache, coffee], [
        make_entry(headache, 'start', minutes_ago(50)),
        moderate,
        make_entry(coffee, 'moment', minutes_ago(30)),
        make_entry(headache, 'end', minutes_ago(20)),
        later,
    ], timezone=None)
    log = phone.locator('#day-log')
    expect(log).to_contain_text('Headache: Moderate')
    phone.locator('.entry-row.is-episode').click()
    phone.locator('.entry-editor .button.danger').click()
    expect(log).not_to_contain_text('Headache: Moderate')
    expect(log).to_contain_text('Coffee')             # logged during it, but not its own
    expect(log).to_contain_text('Headache: Mild')     # logged after it ended
    assert phone.stored('entries', moderate['id'])['deleted']


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
