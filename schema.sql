-- Tracker app: database setup
-- Paste this whole file into Supabase → SQL Editor → New query, then click Run.
-- Safe to run more than once.

-- ---------- Tables ----------

-- What you track. Every tracker belongs to one user.
create table if not exists public.trackers (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name        text not null,
  type        text not null check (type in ('rating','episode','moment','number','choice','text')),
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
  kind        text not null check (kind in ('value','start','end','level','moment')),
  num         numeric,                       -- rating level or number
  txt         text,                          -- choice or free text
  note        text,
  checkin_id  uuid,                          -- groups answers saved together in one check-in
  deleted     boolean not null default false,-- deletions sync as a flag
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

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

-- ---------- Analysis view: one readable row per entry ----------
-- In Table Editor or SQL, query "entries_readable" for a spreadsheet-like view.

create or replace view public.entries_readable
with (security_invoker = true) as
select
  e.ts,
  (e.ts at time zone 'America/New_York')::date   as local_date,
  to_char(e.ts at time zone 'America/New_York', 'HH24:MI') as local_time,
  t.name  as tracker,
  t.type,
  t.grp   as grp,
  e.kind,
  e.num,
  e.txt,
  e.note,
  e.checkin_id,
  e.id
from public.entries e
join public.trackers t on t.id = e.tracker_id
where not e.deleted;

grant select on public.entries_readable to authenticated;
