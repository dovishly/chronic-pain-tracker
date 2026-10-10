"""Tests for schema.sql in a throwaway local Postgres, with stand-ins for Supabase's auth schema.

Checks that the file can be run again over existing data, that it allows the same tracker types and
entry kinds as the app, that deletions are final, and that row-level security keeps users apart.
The data is the known data in tests/fixtures/analysis.json.

Run:  pip install -r tests/requirements.txt
      npm run test:schema
"""
import datetime, os, re, tempfile, uuid
from contextlib import contextmanager
from decimal import Decimal
import pgserver
import psycopg
import pytest
from psycopg.types.json import Jsonb
from analysis_data import FIXTURE, JOURNAL_ANSWER, DELETED_COFFEE

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


def test_a_deletion_is_final(cur):
    # A phone that hadn't heard of the deletions uploads its own copies, as the app does (an upsert of the whole row).
    upsert_tracker = ('insert into public.trackers (id, name, type, sort_order, deleted) values (%s, %s, %s, %s, false) '
                      'on conflict (id) do update set name = excluded.name, sort_order = excluded.sort_order, deleted = excluded.deleted')
    upsert_entry = ('insert into public.entries (id, tracker_id, occurred_at, kind, note, deleted) values (%s, %s, %s, %s, %s, false) '
                    'on conflict (id) do update set note = excluded.note, deleted = excluded.deleted')
    coffee = next(t for t in FIXTURE['trackers'] if t['name'] == 'Coffee')
    deleted_coffee = next(e for e in FIXTURE['entries'] if e['id'] == DELETED_COFFEE)
    with signed_in_as(cur, USER_1), cur.connection.transaction(force_rollback=True):
        cur.execute("update public.trackers set deleted = true where name = 'Coffee'")
        cur.execute(upsert_tracker, (coffee['id'], 'Coffee', 'moment', 99))
        cur.execute(upsert_entry, (DELETED_COFFEE, deleted_coffee['tracker_id'], deleted_coffee['occurred_at'], deleted_coffee['kind'], 'stale'))
        tracker = rows(cur, 'select name, sort_order, deleted from public.trackers where id = %s', (coffee['id'],))[0]
        assert tracker == {'name': '', 'sort_order': 99, 'deleted': True}  # the reorder lands, the name doesn't
        entry = rows(cur, 'select note, deleted from public.entries where id = %s', (DELETED_COFFEE,))[0]
        assert entry == {'note': None, 'deleted': True}


def test_a_deletion_wipes_what_the_row_held(cur):
    mood = next(t for t in FIXTURE['trackers'] if t['name'] == 'Mood')
    with signed_in_as(cur, USER_1), cur.connection.transaction(force_rollback=True):
        cur.execute('update public.trackers set deleted = true where id = %s', (mood['id'],))
        cur.execute('update public.entries set deleted = true where id = %s', (JOURNAL_ANSWER,))
        tracker = rows(cur, 'select name, group_name, config, type from public.trackers where id = %s', (mood['id'],))[0]
        assert tracker == {'name': '', 'group_name': None, 'config': {}, 'type': 'rating'}
        entry = rows(cur, 'select value, text, note, kind from public.entries where id = %s', (JOURNAL_ANSWER,))[0]
        assert entry == {'value': None, 'text': None, 'note': None, 'kind': 'answer'}


def test_a_row_uploaded_already_deleted_keeps_nothing(cur):
    # As an app version from before deleted rows were wiped would upload one.
    journal = next(t for t in FIXTURE['trackers'] if t['name'] == 'Journal')
    with signed_in_as(cur, USER_1), cur.connection.transaction(force_rollback=True):
        cur.execute('insert into public.entries (id, tracker_id, occurred_at, kind, text, note, deleted) '
                    "values (gen_random_uuid(), %s, now(), 'answer', 'private', 'also private', true) returning text, note",
                    (journal['id'],))
        assert cur.fetchone() == (None, None)


# ---------- row-level security ----------

def test_other_user_sees_nothing(cur):
    with signed_in_as(cur, USER_2):
        for table in ['trackers', 'entries']:
            assert count(cur, table) == 0, table


def test_other_user_cant_change_rows(cur):
    with signed_in_as(cur, USER_2):
        cur.execute("update public.entries set note = 'changed' where id = %s", (JOURNAL_ANSWER,))
        assert cur.rowcount == 0


def test_other_user_cant_add_rows_for_someone_else(cur):
    with signed_in_as(cur, USER_2), pytest.raises(psycopg.errors.InsufficientPrivilege):
        cur.execute('insert into public.trackers (id, user_id, name, type) values (gen_random_uuid(), %s, %s, %s)',
                    (USER_1, 'Forged', 'moment'))


@pytest.mark.parametrize('table', ['trackers', 'entries'])
def test_signed_out_reads_are_refused(cur, table):
    with signed_in_as(cur, None), pytest.raises(psycopg.errors.InsufficientPrivilege):
        cur.execute(f'select 1 from public.{table} limit 1')
