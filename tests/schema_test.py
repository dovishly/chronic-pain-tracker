"""Tests for schema.sql in a throwaway local Postgres, with stand-ins for Supabase's auth schema.

Checks that the file applies cleanly (twice: it must be idempotent), that row-level security keeps
users apart, and that the analysis views give the same figures as the app's export for the shared
fixture (tests/fixtures/analysis.json; tests/e2e_test.py checks the export).

Run:  pip install pgserver "psycopg[binary]"
      python tests/schema_test.py        # exits 0 when all checks pass
"""
import json, os, re, sys, tempfile
from decimal import Decimal
import pgserver
import psycopg
from psycopg.types.json import Jsonb

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCHEMA = open(os.path.join(ROOT, 'schema.sql')).read()
FIXTURE = json.load(open(os.path.join(ROOT, 'tests', 'fixtures', 'analysis.json')))

# What the app expects of the database, read from its source so the two can't drift apart.
MODEL_TS = open(os.path.join(ROOT, 'src', 'lib', 'model.ts')).read()
SYNC_TS = open(os.path.join(ROOT, 'src', 'lib', 'sync.ts')).read()
def ts_list(name):
    return re.findall(r"'([a-z]+)'", re.search(name + r' = \[(.*?)\] as const', MODEL_TS).group(1))
APP_TRACKER_TYPES = ts_list('TRACKER_TYPES')
APP_ENTRY_KINDS = ts_list('ENTRY_KINDS')
APP_SCHEMA_VERSION = int(re.search(r'const SCHEMA_VERSION = (\d+);', SYNC_TS).group(1))

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

USER_1 = '11111111-1111-4111-8111-111111111111'
USER_2 = '22222222-2222-4222-8222-222222222222'

results = []
def check(name, cond):
    results.append((name, bool(cond))); print(('PASS ' if cond else 'FAIL ') + name)

def as_user(cur, user_id):
    cur.execute('reset role')
    cur.execute("select set_config('request.jwt.claim.sub', %s, false)", (user_id or '',))
    cur.execute('set role authenticated' if user_id else 'set role anon')

def rows(cur, sql, params=()):
    cur.execute(sql, params)
    names = [c.name for c in cur.description]
    return [dict(zip(names, r)) for r in cur.fetchall()]

def matches(row, expected):
    # Numbers compare by value, whatever their Postgres type.
    norm = lambda v: float(v) if isinstance(v, (int, float, Decimal)) and not isinstance(v, bool) else v
    wrong = {k: (row.get(k), v) for k, v in expected.items() if norm(row.get(k)) != norm(v)}
    if wrong: print('   mismatch:', wrong)
    return not wrong

E = lambda n: f'00000000-0000-4000-9000-0000000000{n:02d}'

with tempfile.TemporaryDirectory() as data_dir:
    server = pgserver.get_server(data_dir, cleanup_mode='stop')
    with psycopg.connect(server.get_uri(), autocommit=True) as conn, conn.cursor() as cur:
        cur.execute(SUPABASE_STANDINS)
        cur.execute(SCHEMA)
        cur.execute(SCHEMA)
        check('schema applies twice', True)

        def allowed(constraint):
            cur.execute('select pg_get_constraintdef(oid) from pg_constraint where conname = %s', (constraint,))
            return re.findall(r"'([a-z]+)'::text", cur.fetchone()[0])
        check('tracker types match the app', sorted(allowed('trackers_type_check')) == sorted(APP_TRACKER_TYPES))
        check('entry kinds match the app', sorted(allowed('entries_kind_check')) == sorted(APP_ENTRY_KINDS))
        cur.execute('select public.logbook_schema_version()')
        check('schema version matches the app', cur.fetchone()[0] == APP_SCHEMA_VERSION)

        cur.execute('insert into auth.users (id) values (%s), (%s)', (USER_1, USER_2))

        # User 1 adds the fixture through row-level security, as the app would.
        as_user(cur, USER_1)
        for t in FIXTURE['trackers']:
            cur.execute('insert into public.trackers (id, name, type, grp, color, config, sort, archived) '
                        'values (%s, %s, %s, %s, %s, %s, %s, %s)',
                        (t['id'], t['name'], t['type'], t['grp'], t['color'], Jsonb(t['config']), t['sort'], t['archived']))
        for e in FIXTURE['entries']:
            cur.execute('insert into public.entries (id, tracker_id, ts, kind, num, txt, note, checkin_id, deleted) '
                        'values (%s, %s, %s, %s, %s, %s, %s, %s, %s)',
                        (e['id'], e['tracker_id'], e['ts'], e['kind'], e['num'], e['txt'], e['note'], e['checkin_id'], e['deleted']))

        # ---------- analysis views (same figures as the export checks in e2e_test.py) ----------
        episodes = rows(cur, 'select * from public.episodes_readable order by start_utc')
        by_id = {str(r['episode_id']): r for r in episodes}
        check('episodes: five, oldest first', [str(r['episode_id']) for r in episodes] == [E(8), E(12), E(18), E(19), E(23)])
        check('episodes: levels and notes', matches(by_id[E(8)], {
            'tracker': 'Headache', 'start_time': '10:00', 'end_time': '12:00', 'duration_min': 120, 'status': 'ended',
            'max_level': 3, 'max_level_label': 'Severe', 'levels_logged': 2, 'notes': 'woke with it'}))
        check('episodes: across midnight', matches(by_id[E(12)], {
            'start_time': '22:00', 'end_time': '01:30', 'duration_min': 210})
              and str(by_id[E(12)]['start_date']) == '2026-09-01' and str(by_id[E(12)]['end_date']) == '2026-09-02')
        check('episodes: restarted', matches(by_id[E(18)], {'duration_min': 60, 'status': 'restarted'})
              and matches(by_id[E(19)], {'duration_min': 30, 'status': 'ended'}))
        check('episodes: ongoing', matches(by_id[E(23)], {'status': 'ongoing', 'end_date': None, 'end_utc': None}))

        entries = {str(r['entry_id']): r for r in rows(cur, 'select * from public.entries_readable')}
        check('entries: deleted left out', len(entries) == 22 and E(21) not in entries)
        check('entries: level linked to episode', matches(entries[E(9)], {'event': 'level', 'value': 2, 'label': 'Moderate'})
              and str(entries[E(9)]['episode_id']) == E(8))
        check('entries: end linked to episode', str(entries[E(13)]['episode_id']) == E(12) and str(entries[E(20)]['episode_id']) == E(19))
        check('entries: answer in local time', matches(entries[E(6)], {'event': 'answer', 'time': '20:00', 'weekday': 'Tue'})
              and str(entries[E(6)]['date']) == '2026-09-01')
        check('entries: text answer in text column', matches(entries[E(5)], {'text': 'Slept ok', 'label': None}))

        daily = {(str(r['date']), r['tracker']): r for r in rows(cur, 'select * from public.daily_summary')}
        check('daily: Sep 1', all([
            matches(daily[('2026-09-01', 'Mood')], {'answers': 2, 'value_avg': 3, 'value_total': 6}),
            matches(daily[('2026-09-01', 'Water')], {'value_total': 8, 'value_avg': 4}),
            matches(daily[('2026-09-01', 'Activities')], {'answers': 2, 'answer_text': 'Exercise | Work'}),
            matches(daily[('2026-09-01', 'Journal')], {'answer_text': 'Slept ok'}),
            matches(daily[('2026-09-01', 'Headache')], {'episodes': 1, 'episode_minutes': 120, 'max_level': 3}),
            matches(daily[('2026-09-01', 'Tired')], {'episodes': 1, 'episode_minutes': 120}),
            matches(daily[('2026-09-01', 'Coffee')], {'moments': 2}),
        ]))
        check('daily: Sep 2', all([
            matches(daily[('2026-09-02', 'Mood')], {'value_avg': 5}),
            matches(daily[('2026-09-02', 'Headache')], {'episodes': 2, 'episode_minutes': 90, 'max_level': None}),
            matches(daily[('2026-09-02', 'Tired')], {'episodes': 0, 'episode_minutes': 90}),
            matches(daily[('2026-09-02', 'Snack')], {'moments': 1}),
            ('2026-09-02', 'Coffee') not in daily,   # the only coffee that day was deleted
        ]))
        check('daily: running episode', matches(daily[('2026-09-04', 'Tired')], {'episodes': 1, 'episode_minutes': 1020})
              and matches(daily[('2026-09-05', 'Tired')], {'episode_minutes': 1440}))
        check('daily: weekday', daily[('2026-09-02', 'Mood')]['weekday'] == 'Wed')

        # ---------- row-level security ----------
        as_user(cur, USER_2)
        check('user 2 sees no trackers or entries', rows(cur, 'select count(*) as n from public.trackers')[0]['n'] == 0
              and rows(cur, 'select count(*) as n from public.entries')[0]['n'] == 0)
        check('user 2 sees nothing in the views', all(
            rows(cur, f'select count(*) as n from public.{view}')[0]['n'] == 0
            for view in ['entries_readable', 'episodes_readable', 'daily_summary']))
        cur.execute("update public.entries set note = 'changed' where id = %s", (E(1),))
        check("user 2 can't update user 1's rows", cur.rowcount == 0)
        try:
            cur.execute('insert into public.trackers (id, user_id, name, type) values (gen_random_uuid(), %s, %s, %s)',
                        (USER_1, 'Forged', 'moment'))
            forged = True
        except psycopg.errors.InsufficientPrivilege:
            forged = False
        check("user 2 can't forge rows for user 1", not forged)

        as_user(cur, None)
        denied = []
        for view in ['trackers', 'entries', 'entries_readable', 'episodes_readable', 'daily_summary']:
            try:
                cur.execute(f'select 1 from public.{view} limit 1')
                denied.append(False)
            except psycopg.errors.InsufficientPrivilege:
                denied.append(True)
        check('signed-out (anon) reads are refused', all(denied))
        cur.execute('reset role')

passed = sum(1 for _, c in results if c)
print(passed, '/', len(results), 'passed')
sys.exit(0 if passed == len(results) else 1)
