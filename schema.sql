-- Log Lightly: database setup
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
  group_name  text,                          -- heading the tracker is listed under in the app
  color       text,                          -- color key used by the app
  config      jsonb not null default '{}',   -- levels, options, unit, etc.
  sort_order  integer not null default 0,
  archived    boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Every reading, tap or note. One long table: easy to export and analyze.
create table if not exists public.entries (
  id          uuid primary key,              -- made on the device, so offline saves never duplicate
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  tracker_id  uuid not null references public.trackers(id) on delete cascade,
  occurred_at timestamptz not null,          -- when it happened
  kind        text not null,                 -- allowed values: see entries_kind_check below
  value       numeric,                       -- a severity level, rating level, or number
  text        text,                          -- the level's label, a chosen option, or free text
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

-- Version 2: deleting a tracker (a flag, like entries have, so the deletion syncs).
alter table public.trackers add column if not exists deleted boolean not null default false;
-- Version 3: a deleted row is wiped (see "A deletion is final" below).

-- The allowed tracker types and entry kinds. Keep in step with TRACKER_TYPES and ENTRY_KINDS in src/lib/model.ts.
alter table public.trackers drop constraint if exists trackers_type_check;
alter table public.trackers add constraint trackers_type_check
  check (type in ('rating', 'episode', 'moment', 'number', 'choice', 'text'));
alter table public.entries drop constraint if exists entries_kind_check;
alter table public.entries add constraint entries_kind_check
  check (kind in ('start', 'end', 'level', 'moment', 'answer'));

-- Earlier versions had analysis views; the app's "Export for analysis" replaces them.
drop view if exists public.daily_summary;
drop view if exists public.entries_readable;
drop view if exists public.episodes_readable;
drop function if exists public.logbook_entry_text(text, text, text, text, numeric, text);
drop function if exists public.logbook_timezone();

-- ---------- Indexes ----------

create index if not exists entries_user_updated on public.entries (user_id, updated_at);
create index if not exists entries_user_occurred on public.entries (user_id, occurred_at);
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

-- ---------- A deletion is final, and keeps nothing ----------
-- A deleted row stays, marked deleted, so the deletion reaches every device. It stays deleted even when a device
-- that hadn't heard of it yet uploads its own copy (a tracker reordered offline, say), and whatever it held is
-- wiped. The app wipes the same fields: deletedTracker() and deletedEntry() in src/lib/model.ts.

create or replace function public.final_tracker_deletion()
returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    new.deleted := new.deleted or old.deleted;
  end if;
  if new.deleted then
    new.name := '';
    new.group_name := null;
    new.config := '{}';
  end if;
  return new;
end $$;

create or replace function public.final_entry_deletion()
returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    new.deleted := new.deleted or old.deleted;
  end if;
  if new.deleted then
    new.value := null;
    new.text := null;
    new.note := null;
  end if;
  return new;
end $$;

drop trigger if exists trackers_keep_deleted on public.trackers;
create trigger trackers_keep_deleted before insert or update on public.trackers
  for each row execute function public.final_tracker_deletion();

drop trigger if exists entries_keep_deleted on public.entries;
create trigger entries_keep_deleted before insert or update on public.entries
  for each row execute function public.final_entry_deletion();

drop function if exists public.keep_deleted(); -- what earlier versions' triggers used

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

-- ---------- Version ----------
-- Last, so it only goes up once everything above has run. The app compares it with SCHEMA_VERSION in
-- src/lib/sync.ts before syncing, and asks for this file to be run again if it's older.

create or replace function public.logbook_schema_version()
returns integer language sql immutable as $$ select 3 $$;

revoke all on function public.logbook_schema_version() from public, anon;
grant execute on function public.logbook_schema_version() to authenticated;
