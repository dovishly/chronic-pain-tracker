"""Tests for schema.sql in a throwaway local Postgres, with stand-ins for Supabase's auth schema.

Checks that the file can be run again over existing data, that it allows the same tracker types and
entry kinds as the app, that row-level security keeps users apart, and that the analysis views give
the same figures as the app's export (tests/e2e_test.py) for the data in tests/fixtures/analysis.json.

Run:  pip install pytest pgserver "psycopg[binary]"
      python -m pytest tests/schema_test.py
"""
import datetime, os, re, tempfile, uuid
from contextlib import contextmanager
from decimal import Decimal
import pgserver
import psycopg
import pytest
from psycopg.types.json import Jsonb
from analysis_data import (
    FIXTURE, HEADACHE_SEP1, TIRED_OVERNIGHT, HEADACHE_RESTARTED, HEADACHE_SEP2, TIRED_ONGOING,
    JOURNAL_ANSWER, MOOD_EVENING, HEADACHE_MODERATE, TIRED_OVERNIGHT_END, HEADACHE_SEP2_END,
    DELETED_COFFEE, COFFEE_DURING_HEADACHE, MOOD_WHILE_TIRED,
)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCHEMA = open(os.path.join(ROOT, 'schema.sql')).read()

# Just enough of Supabase for schema.sql: auth.users, auth.uid(), and the anon/authenticated roles.
SUPABASE_STANDINS = """
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key);
create or replace function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
do $$ begin
  create role anon nologin;
  create role authenticated nologin;
exception when duplicate_object then null; end $$;
grant usage on schema public, auth to anon, authenticated;
"""

USER_1 = '11111111-1111-4111-8111-111111111111'  # owns the fixture data
USER_2 = '22222222-2222-4222-8222-222222222222'  # owns nothing
ANALYSIS_VIEWS = ['entries_readable', 'episodes_readable', 'daily_summary']


# ---------- helpers ----------

@contextmanager
def signed_in_as(cur, user_id):
    """Runs queries as Supabase would for a signed-in user, or for a signed-out visitor (None)."""
    cur.execute("select set_config('request.jwt.claim.sub', %s, false)", (user_id or '',))
    cur.execute('set role authenticated' if user_id else 'set role anon')
    try:
        yield
    finally:
        cur.execute('reset role')


def plain(value):
    """Turns Postgres values into the plain Python values the expectations are written in."""
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, (uuid.UUID, datetime.date)):  # dates and timestamps
        return str(value)
    return value


def rows(cur, sql, params=()):
    cur.execute(sql, params)
    names = [column.name for column in cur.description]
    return [{name: plain(value) for name, value in zip(names, row)} for row in cur.fetchall()]


def count(cur, table):
    return rows(cur, f'select count(*) as n from public.{table}')[0]['n']


def fields(row, expected):
    """The row's values for just the fields named in expected, to compare with ==."""
    return {name: row.get(name) for name in expected}


def app_list(name):
    """A list such as TRACKER_TYPES from src/lib/model.ts, so the database and the app can't drift apart."""
    source = open(os.path.join(ROOT, 'src', 'lib', 'model.ts')).read()
    return re.findall(r"'([a-z]+)'", re.search(name + r' = \[(.*?)\] as const', source).group(1))


def allowed_values(cur, constraint):
    """The values a check constraint such as trackers_type_check allows."""
    cur.execute('select pg_get_constraintdef(oid) from pg_constraint where conname = %s', (constraint,))
    return re.findall(r"'([a-z]+)'::text", cur.fetchone()[0])


# ---------- the database ----------

@pytest.fixture(scope='module')
def cur():
    """A fresh database with schema.sql applied and the fixture data added by user 1."""
    with tempfile.TemporaryDirectory() as data_dir:
        server = pgserver.get_server(data_dir, cleanup_mode='stop')  # stops when the tests finish
        with psycopg.connect(server.get_uri(), autocommit=True) as conn, conn.cursor() as cur:
            cur.execute(SUPABASE_STANDINS)
            cur.execute(SCHEMA)
            cur.execute('insert into auth.users (id) values (%s), (%s)', (USER_1, USER_2))
            with signed_in_as(cur, USER_1):  # through row-level security, as the app would
                add_fixture_data(cur)
            yield cur


def add_fixture_data(cur):
    for t in FIXTURE['trackers']:
        cur.execute('insert into public.trackers (id, name, type, group_name, color, config, sort_order, archived) '
                    'values (%s, %s, %s, %s, %s, %s, %s, %s)',
                    (t['id'], t['name'], t['type'], t['group_name'], t['color'], Jsonb(t['config']), t['sort_order'], t['archived']))
    for e in FIXTURE['entries']:
        cur.execute('insert into public.entries (id, tracker_id, occurred_at, kind, value, text, note, checkin_id, deleted) '
                    'values (%s, %s, %s, %s, %s, %s, %s, %s, %s)',
                    (e['id'], e['tracker_id'], e['occurred_at'], e['kind'], e['value'], e['text'], e['note'], e['checkin_id'], e['deleted']))


# ---------- schema.sql itself ----------

def test_schema_can_be_run_again_over_existing_data(cur):
    # The owner upgrades by running the whole file again, so it must be idempotent.
    cur.execute(SCHEMA)
    assert count(cur, 'entries') == len(FIXTURE['entries'])


def test_tracker_types_match_the_app(cur):
    assert sorted(allowed_values(cur, 'trackers_type_check')) == sorted(app_list('TRACKER_TYPES'))


def test_entry_kinds_match_the_app(cur):
    assert sorted(allowed_values(cur, 'entries_kind_check')) == sorted(app_list('ENTRY_KINDS'))


def test_schema_version_matches_the_app(cur):
    source = open(os.path.join(ROOT, 'src', 'lib', 'sync.ts')).read()
    app_version = int(re.search(r'const SCHEMA_VERSION = (\d+);', source).group(1))
    cur.execute('select public.logbook_schema_version()')
    assert cur.fetchone()[0] == app_version


# ---------- analysis views (the same figures as the export checks in e2e_test.py) ----------

@pytest.fixture(scope='module')
def episodes(cur):
    with signed_in_as(cur, USER_1):
        return rows(cur, 'select * from public.episodes_readable order by start_utc')


@pytest.fixture(scope='module')
def episode(episodes):
    return {row['episode_id']: row for row in episodes}


@pytest.fixture(scope='module')
def entry(cur):
    with signed_in_as(cur, USER_1):
        return {row['entry_id']: row for row in rows(cur, 'select * from public.entries_readable')}


@pytest.fixture(scope='module')
def daily(cur):
    """daily_summary rows by (date, tracker name)."""
    with signed_in_as(cur, USER_1):
        return {(row['date'], row['tracker']): row for row in rows(cur, 'select * from public.daily_summary')}


def test_episodes_oldest_first(episodes):
    assert [row['episode_id'] for row in episodes] == [
        HEADACHE_SEP1, TIRED_OVERNIGHT, HEADACHE_RESTARTED, HEADACHE_SEP2, TIRED_ONGOING]


def test_episode_start_end_levels_and_notes(episode):
    expected = {
        'tracker': 'Headache', 'start': '2026-09-01 10:00:00', 'end': '2026-09-01 12:00:00',
        'start_time': '10:00', 'end_time': '12:00', 'duration_min': 120, 'status': 'ended',
        'max_level': 3, 'max_level_label': 'Severe', 'levels_logged': 2, 'notes': 'woke with it',
    }
    assert fields(episode[HEADACHE_SEP1], expected) == expected


def test_episode_timeline_lists_what_happened_in_between(episode):
    assert episode[HEADACHE_SEP1]['timeline'] == '10:00 started · 10:30 Moderate · 11:00 Severe · 11:30 Coffee · 12:00 ended'


def test_episode_across_midnight(episode):
    expected = {
        'start_date': '2026-09-01', 'start_time': '22:00', 'end_date': '2026-09-02', 'end_time': '01:30',
        'duration_min': 210, 'timeline': '22:00 started · 09-02 01:30 ended',
    }
    assert fields(episode[TIRED_OVERNIGHT], expected) == expected


def test_episode_cut_short_by_a_restart(episode):
    expected = {'duration_min': 60, 'status': 'restarted', 'timeline': '15:00 started · 16:00 restarted'}
    assert fields(episode[HEADACHE_RESTARTED], expected) == expected
    expected = {'duration_min': 30, 'status': 'ended'}
    assert fields(episode[HEADACHE_SEP2], expected) == expected


def test_episode_still_running(episode):
    expected = {'status': 'ongoing', 'end': None, 'end_date': None, 'end_utc': None,
                'timeline': '07:00 started · 09:00 Mood: Okay'}
    assert fields(episode[TIRED_ONGOING], expected) == expected


def test_entries_leave_out_deleted(entry):
    assert DELETED_COFFEE not in entry
    assert len(entry) == len(FIXTURE['entries']) - 1


def test_entry_level_belongs_to_its_episode(entry):
    expected = {'event': 'level', 'value': 2, 'label': 'Moderate', 'episode_id': HEADACHE_SEP1}
    assert fields(entry[HEADACHE_MODERATE], expected) == expected


def test_entry_end_belongs_to_its_episode(entry):
    assert entry[TIRED_OVERNIGHT_END]['episode_id'] == TIRED_OVERNIGHT
    assert entry[HEADACHE_SEP2_END]['episode_id'] == HEADACHE_SEP2


def test_entry_in_local_time(entry):
    expected = {'event': 'answer', 'datetime': '2026-09-01 20:00:00', 'date': '2026-09-01', 'time': '20:00', 'weekday': 'Tue'}
    assert fields(entry[MOOD_EVENING], expected) == expected


def test_entry_during_other_trackers_episodes(entry):
    expected = {'tracker': 'Coffee', 'during': 'Headache', 'during_episode_ids': HEADACHE_SEP1}
    assert fields(entry[COFFEE_DURING_HEADACHE], expected) == expected
    assert entry[MOOD_WHILE_TIRED]['during'] == 'Tired'
    # An episode's own entries aren't "during" it.
    assert entry[HEADACHE_MODERATE]['during'] is None
    assert entry[HEADACHE_SEP2]['during'] is None


def test_entry_text_answer_in_text_column(entry):
    expected = {'text': 'Slept ok', 'label': None}
    assert fields(entry[JOURNAL_ANSWER], expected) == expected


@pytest.mark.parametrize('date, tracker, expected', [
    ('2026-09-01', 'Mood', {'answers': 2, 'value_avg': 3, 'value_total': 6}),
    ('2026-09-01', 'Water', {'value_total': 8, 'value_avg': 4}),
    ('2026-09-01', 'Activities', {'answers': 2, 'answer_text': 'Exercise | Work'}),
    ('2026-09-01', 'Journal', {'answer_text': 'Slept ok'}),
    ('2026-09-01', 'Headache', {'episodes': 1, 'episode_minutes': 120, 'max_level': 3}),
    ('2026-09-01', 'Tired', {'episodes': 1, 'episode_minutes': 120}),
    ('2026-09-01', 'Coffee', {'moments': 3}),
    ('2026-09-02', 'Mood', {'value_avg': 5, 'weekday': 'Wed'}),
    ('2026-09-02', 'Headache', {'episodes': 2, 'episode_minutes': 90, 'max_level': None}),
    ('2026-09-02', 'Tired', {'episodes': 0, 'episode_minutes': 90}),  # the rest of the episode that began Sep 1
    ('2026-09-02', 'Snack', {'moments': 1}),
    ('2026-09-04', 'Tired', {'episodes': 1, 'episode_minutes': 1020}),  # still running: counted to midnight
    ('2026-09-04', 'Mood', {'value_avg': 3}),
    ('2026-09-05', 'Tired', {'episode_minutes': 1440}),
])
def test_daily_summary(daily, date, tracker, expected):
    assert fields(daily[(date, tracker)], expected) == expected


def test_daily_summary_leaves_out_deleted(daily):
    assert ('2026-09-02', 'Coffee') not in daily  # the only coffee that day was deleted


def test_views_leave_out_deleted_trackers(cur):
    # Coffee's entries aren't marked deleted, as when a phone logged one before hearing of the deletion.
    with signed_in_as(cur, USER_1):
        cur.execute("update public.trackers set deleted = true where name = 'Coffee'")
        try:
            for view in ANALYSIS_VIEWS:
                assert 'Coffee' not in {row['tracker'] for row in rows(cur, f'select tracker from public.{view}')}, view
            timeline = rows(cur, 'select timeline from public.episodes_readable where episode_id = %s', (HEADACHE_SEP1,))
            assert 'Coffee' not in timeline[0]['timeline']
        finally:
            cur.execute("update public.trackers set deleted = false where name = 'Coffee'")


# ---------- row-level security ----------

def test_other_user_sees_nothing(cur):
    with signed_in_as(cur, USER_2):
        for table in ['trackers', 'entries', *ANALYSIS_VIEWS]:
            assert count(cur, table) == 0, table


def test_other_user_cant_change_rows(cur):
    with signed_in_as(cur, USER_2):
        cur.execute("update public.entries set note = 'changed' where id = %s", (JOURNAL_ANSWER,))
        assert cur.rowcount == 0


def test_other_user_cant_add_rows_for_someone_else(cur):
    with signed_in_as(cur, USER_2), pytest.raises(psycopg.errors.InsufficientPrivilege):
        cur.execute('insert into public.trackers (id, user_id, name, type) values (gen_random_uuid(), %s, %s, %s)',
                    (USER_1, 'Forged', 'moment'))


@pytest.mark.parametrize('table', ['trackers', 'entries', *ANALYSIS_VIEWS])
def test_signed_out_reads_are_refused(cur, table):
    with signed_in_as(cur, None), pytest.raises(psycopg.errors.InsufficientPrivilege):
        cur.execute(f'select 1 from public.{table} limit 1')
