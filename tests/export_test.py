"""The analysis export, from the known data in tests/fixtures/analysis.json (named in analysis_data.py), on a
phone in that data's time zone."""
import pytest
from harness import export_for_analysis, fields, phone_with
from analysis_data import (
    FIXTURE, TIMEZONE, HEADACHE_SEP1, TIRED_OVERNIGHT, HEADACHE_RESTARTED, HEADACHE_SEP2, TIRED_ONGOING,
    JOURNAL_ANSWER, MOOD_EVENING, HEADACHE_MODERATE, TIRED_OVERNIGHT_END, HEADACHE_SEP2_END,
    DELETED_COFFEE, COFFEE_DURING_HEADACHE, MOOD_WHILE_TIRED,
    MORNING_SEP1, EVENING_SEP1, MORNING_SEP2, MORNING_SEP4,
)


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
