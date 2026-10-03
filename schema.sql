-- Tracker app: database setup
-- Paste this whole file into Supabase → SQL Editor → New query, then click Run.
-- Safe to run more than once. When the app is updated with database changes, run the whole file again:
-- the app checks logbook_schema_version() (at the end) and says so when this is needed.

-- ---------- Tables ----------

-- What you track. Every tracker belongs to one user.
create table if not exists public.trackers (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name        text not null,
  type        text not null,                 -- allowed values: see trackers_type_check below
  grp         text,                          -- group label shown in the app
  color       text,                          -- color key used by the app
  config      jsonb not null default '{}',   -- levels, options, unit, etc.
  sort        integer not null default 0,
  archived    boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Every reading, tap or note. One long table: easy to export and analyze.
create table if not exists public.entries (
  id          uuid primary key,              -- made on the phone, so offline saves never duplicate
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  tracker_id  uuid not null references public.trackers(id) on delete cascade,
  ts          timestamptz not null,          -- when it happened
  kind        text not null,                 -- allowed values: see entries_kind_check below
  num         numeric,                       -- rating level or number
  txt         text,                          -- choice or free text
  note        text,
  checkin_id  uuid,                          -- groups answers saved together in one check-in
  deleted     boolean not null default false,-- deletions sync as a flag
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ---------- Upgrades ----------
-- "create table if not exists" leaves an existing table alone, so any later change to a table goes here,
-- written to be safe to run again: "add column if not exists", or drop a constraint and add it back.
-- Then raise logbook_schema_version() at the end of this file and SCHEMA_VERSION in src/lib/sync.ts.

-- The allowed tracker types and entry kinds. Keep in step with TRACKER_TYPES and ENTRY_KINDS in src/lib/model.ts.
alter table public.trackers drop constraint if exists trackers_type_check;
alter table public.trackers add constraint trackers_type_check
  check (type in ('rating', 'episode', 'moment', 'number', 'choice', 'text'));
alter table public.entries drop constraint if exists entries_kind_check;
alter table public.entries add constraint entries_kind_check
  check (kind in ('start', 'end', 'level', 'moment', 'value'));

-- ---------- Indexes ----------

create index if not exists entries_user_updated on public.entries (user_id, updated_at);
create index if not exists entries_user_ts      on public.entries (user_id, ts);
create index if not exists trackers_user_updated on public.trackers (user_id, updated_at);

-- ---------- Server-side timestamps (used for syncing) ----------

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists trackers_touch on public.trackers;
create trigger trackers_touch before insert or update on public.trackers
  for each row execute function public.touch_updated_at();

drop trigger if exists entries_touch on public.entries;
create trigger entries_touch before insert or update on public.entries
  for each row execute function public.touch_updated_at();

-- ---------- Security: only the signed-in owner can see or change a row ----------

alter table public.trackers enable row level security;
alter table public.entries  enable row level security;

drop policy if exists "own trackers" on public.trackers;
create policy "own trackers" on public.trackers
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "own entries" on public.entries;
create policy "own entries" on public.entries
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Nobody who isn't signed in gets anything.
revoke all on public.trackers from anon;
revoke all on public.entries  from anon;
grant select, insert, update, delete on public.trackers to authenticated;
grant select, insert, update, delete on public.entries  to authenticated;

-- ---------- Analysis views ----------
-- The same tables the app's "Export for analysis" produces, for querying here in the SQL Editor:
--   entries_readable   one row per entry, with readable columns and the episode it belongs to
--   episodes_readable  one row per start/stop episode: start, end, duration, status, peak severity
--   daily_summary      one row per day per tracker: averages, totals, episode minutes, counts
-- Dates and times are local to this time zone. If you live elsewhere, change it here and run the file again
-- (names are listed at https://en.wikipedia.org/wiki/List_of_tz_database_time_zones).

create or replace function public.logbook_timezone()
returns text language sql immutable as $$ select 'America/New_York' $$;

-- Dropped and recreated so their columns can change between versions.
drop view if exists public.daily_summary;
drop view if exists public.entries_readable;
drop view if exists public.episodes_readable;

-- One line describing an entry, e.g. 'Headache started', 'Mood: Good', 'Water: 3 glasses'.
-- Matches entryText() in src/lib/model.ts.
create or replace function public.logbook_entry_text(
  kind text, tracker text, tracker_type text, unit text, num numeric, txt text)
returns text language sql immutable as $$
  select case kind
    when 'start'  then tracker || ' started'
    when 'end'    then tracker || ' ended'
    when 'moment' then tracker
    when 'value'  then case when tracker_type = 'number'
                         then tracker || ': ' || coalesce(num::text, '') || coalesce(' ' || nullif(unit, ''), '')
                         else tracker || ': ' || coalesce(nullif(txt, ''), num::text, '') end
    else tracker || ': ' || coalesce(nullif(txt, ''), num::text, '')
  end
$$;

-- An episode runs from a start to the next start or end of the same tracker:
-- status 'ended' (closed by an end), 'restarted' (closed by another start), or 'ongoing' (still running).
-- "timeline" lists everything logged while it ran, e.g. '10:00 started · 10:30 Moderate · 11:30 Coffee · 12:00 ended'.
create view public.episodes_readable
with (security_invoker = true) as
with events as (
  select e.id, e.tracker_id, e.ts, e.kind, e.note,
         lead(e.kind) over w as next_kind,
         lead(e.ts)   over w as next_ts,
         lead(e.id)   over w as next_id,
         lead(e.note) over w as next_note
  from public.entries e
  where not e.deleted and e.kind in ('start', 'end')
  window w as (partition by e.tracker_id order by e.ts, e.id)
),
spans as (
  select id as episode_id,
         tracker_id,
         ts as start_utc,
         coalesce(next_ts, now()) as end_or_now,
         case next_kind when 'end' then 'ended' when 'start' then 'restarted' else 'ongoing' end as status,
         case when next_kind = 'end' then next_id end as end_entry_id,
         note as start_note,
         case when next_kind = 'end' then next_note end as end_note
  from events
  where kind = 'start'
)
select
  s.episode_id,
  t.name as tracker,
  date_trunc('second', s.start_utc at time zone public.logbook_timezone()) as start,
  case when s.status <> 'ongoing' then date_trunc('second', s.end_or_now at time zone public.logbook_timezone()) end as "end",
  round(extract(epoch from s.end_or_now - s.start_utc) / 60, 1) as duration_min,  -- so far, if ongoing
  s.status,
  lv.max_level,
  lv.max_level_label,
  tl.timeline,
  nullif(concat_ws(' | ', s.start_note, s.end_note, lv.notes), '') as notes,
  s.tracker_id,
  t.grp  as "group",
  (s.start_utc at time zone public.logbook_timezone())::date as start_date,
  to_char(s.start_utc at time zone public.logbook_timezone(), 'HH24:MI') as start_time,
  case when s.status <> 'ongoing' then (s.end_or_now at time zone public.logbook_timezone())::date end as end_date,
  case when s.status <> 'ongoing' then to_char(s.end_or_now at time zone public.logbook_timezone(), 'HH24:MI') end as end_time,
  s.start_utc,
  case when s.status <> 'ongoing' then s.end_or_now end as end_utc,
  lv.levels_logged,
  s.end_entry_id
from spans s
join public.trackers t on t.id = s.tracker_id
cross join lateral (
  -- Severity levels logged while the episode was running.
  select max(l.num) as max_level,
         (array_agg(l.txt order by l.num desc, l.ts))[1] as max_level_label,
         count(*)::integer as levels_logged,
         string_agg(l.note, ' | ' order by l.ts) as notes
  from public.entries l
  where l.tracker_id = s.tracker_id and l.kind = 'level' and not l.deleted
    and l.ts between s.start_utc and s.end_or_now
) lv
cross join lateral (
  -- Everything logged while it ran (at most 100 items). Times on a later day than the start get the date.
  select string_agg(item, ' · ' order by n) filter (where n <= 100)
         || case when count(*) > 100 then ' · … and ' || (count(*) - 100) || ' more' else '' end as timeline
  from (
    select row_number() over (order by x.ts, xt.sort, x.id) as n,
           case when (x.ts at time zone public.logbook_timezone())::date
                     <> (s.start_utc at time zone public.logbook_timezone())::date
                then to_char(x.ts at time zone public.logbook_timezone(), 'MM-DD ') else '' end
           || to_char(x.ts at time zone public.logbook_timezone(), 'HH24:MI') || ' '
           || case
                when x.id = s.episode_id then 'started'
                when x.id = s.end_entry_id then 'ended'
                when x.tracker_id = s.tracker_id and x.kind = 'start' then 'restarted'
                when x.tracker_id = s.tracker_id and x.kind = 'level' then coalesce(nullif(x.txt, ''), x.num::text, '')
                else public.logbook_entry_text(x.kind, xt.name, xt.type, xt.config->>'unit', x.num, x.txt)
              end as item
    from public.entries x
    join public.trackers xt on xt.id = x.tracker_id
    where not x.deleted and x.ts between s.start_utc and s.end_or_now
  ) items
) tl;

create view public.entries_readable
with (security_invoker = true) as
with episodes as (
  select e.episode_id, e.tracker_id, e.tracker, t.sort as tracker_sort,
         e.start_utc, coalesce(e.end_utc, now()) as end_or_now, e.end_entry_id
  from public.episodes_readable e
  join public.trackers t on t.id = e.tracker_id
)
select
  e.id as entry_id,
  date_trunc('second', e.ts at time zone public.logbook_timezone()) as datetime,
  (e.ts at time zone public.logbook_timezone())::date as date,
  to_char(e.ts at time zone public.logbook_timezone(), 'HH24:MI') as time,
  to_char(e.ts at time zone public.logbook_timezone(), 'Dy') as weekday,
  e.ts as timestamp_utc,
  e.tracker_id,
  t.name as tracker,
  t.type,
  t.grp  as "group",
  case e.kind when 'value' then 'answer' else e.kind end as event,
  e.num as value,                                                              -- rating level, number, or severity
  case when e.kind = 'value' and t.type = 'text' then null else e.txt end as label,  -- level label or chosen option
  case when e.kind = 'value' and t.type = 'text' then e.txt end as text,             -- free text
  e.note,
  e.checkin_id,
  coalesce(started.episode_id, ended.episode_id, during_own.episode_id) as episode_id,
  running.during,               -- other trackers' episodes running at the time
  running.during_episode_ids
from public.entries e
join public.trackers t on t.id = e.tracker_id
left join episodes started on e.kind = 'start' and started.episode_id = e.id
left join episodes ended   on e.kind = 'end' and ended.end_entry_id = e.id
left join lateral (
  select x.episode_id from episodes x
  where e.kind = 'level' and x.tracker_id = e.tracker_id and e.ts between x.start_utc and x.end_or_now
  order by x.start_utc
  limit 1
) during_own on true
left join lateral (
  select string_agg(x.tracker, '; ' order by x.tracker_sort, x.start_utc) as during,
         string_agg(x.episode_id::text, '; ' order by x.tracker_sort, x.start_utc) as during_episode_ids
  from episodes x
  where x.tracker_id <> e.tracker_id and e.ts between x.start_utc and x.end_or_now
) running on true
where not e.deleted;

-- One row per day and tracker that has anything that day. Episode minutes are clipped at local midnight,
-- so an episode across midnight counts toward both days.
create view public.daily_summary
with (security_invoker = true) as
with live as (
  select e.*, (e.ts at time zone public.logbook_timezone())::date as local_date
  from public.entries e
  where not e.deleted
),
episode_days as (
  select ep.tracker_id,
         d::date as local_date,
         extract(epoch from
           least(ep.end_or_now, (d + interval '1 day') at time zone public.logbook_timezone())
           - greatest(ep.start_utc, d at time zone public.logbook_timezone())) as seconds
  from (select tracker_id, start_utc, coalesce(end_utc, now()) as end_or_now from public.episodes_readable) ep
  cross join lateral generate_series(
    (ep.start_utc  at time zone public.logbook_timezone())::date::timestamp,
    (ep.end_or_now at time zone public.logbook_timezone())::date::timestamp,
    interval '1 day') as d
),
facts as (
  select local_date, tracker_id, 'answer' as fact, num, txt, ts, null::numeric as seconds from live where kind = 'value'
  union all
  select local_date, tracker_id, 'moment', null, null, ts, null from live where kind = 'moment'
  union all
  select local_date, tracker_id, 'level', num, null, ts, null from live where kind = 'level'
  union all
  select start_date, tracker_id, 'start', null, null, start_utc, null from public.episodes_readable
  union all
  select local_date, tracker_id, 'running', null, null, null, seconds from episode_days
)
select
  f.local_date as date,
  to_char(f.local_date, 'Dy') as weekday,
  f.tracker_id,
  t.name as tracker,
  t.type,
  t.grp  as "group",
  count(*) filter (where f.fact = 'answer')::integer             as answers,
  round(avg(f.num) filter (where f.fact = 'answer'), 2)            as value_avg,
  sum(f.num) filter (where f.fact = 'answer')                      as value_total,
  min(f.num) filter (where f.fact = 'answer')                      as value_min,
  max(f.num) filter (where f.fact = 'answer')                      as value_max,
  string_agg(f.txt, ' | ' order by f.ts)
    filter (where f.fact = 'answer' and t.type in ('choice', 'text')) as answer_text,
  count(*) filter (where f.fact = 'start')::integer              as episodes,
  round(coalesce(sum(f.seconds) filter (where f.fact = 'running'), 0) / 60)::integer as episode_minutes,
  max(f.num) filter (where f.fact = 'level')                       as max_level,
  count(*) filter (where f.fact = 'moment')::integer             as moments
from facts f
join public.trackers t on t.id = f.tracker_id
group by f.local_date, f.tracker_id, t.name, t.type, t.grp;

revoke all on public.entries_readable, public.episodes_readable, public.daily_summary from anon;
grant select on public.entries_readable, public.episodes_readable, public.daily_summary to authenticated;

-- ---------- Version ----------
-- Last, so it only goes up once everything above has run. The app compares it with SCHEMA_VERSION in
-- src/lib/sync.ts before syncing, and asks for this file to be run again if it's older.

create or replace function public.logbook_schema_version()
returns integer language sql immutable as $$ select 1 $$;

revoke all on function public.logbook_schema_version() from public, anon;
grant execute on function public.logbook_schema_version() to authenticated;
