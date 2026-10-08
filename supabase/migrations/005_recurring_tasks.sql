-- MYOS 005 — recurring tasks and ongoing goals (additive; safe to run twice, no data is changed)
--
-- A recurring task is a row in task_series (the rule and the template) plus ordinary rows in
-- tasks, one per day, that point back at it (recurrence_id + occurrence_date).
--   * The database allows one occurrence per series per day, so two devices that both make
--     "Post on X, Oct 8" can't leave two behind.
--   * Existing tasks have no recurrence (both columns null) and existing goals are 'finite'.

-- ---------------------------------------------------------------------------
-- task_series
-- ---------------------------------------------------------------------------
create table if not exists public.task_series (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title text not null,
  description text,
  project_id uuid,
  goal_id uuid,
  effort_minutes integer check (effort_minutes is null or effort_minutes > 0),
  impact smallint not null default 3 check (impact between 1 and 5),
  consequence smallint not null default 2 check (consequence between 1 and 5),
  user_importance text not null default 'normal' check (user_importance in ('low', 'normal', 'high')),
  checklist jsonb not null default '[]' check (jsonb_typeof(checklist) = 'array'),
  links jsonb not null default '[]' check (jsonb_typeof(links) = 'array'),
  frequency text not null check (frequency in ('daily', 'weekly', 'monthly')),
  interval_count integer not null default 1 check (interval_count between 1 and 365),
  -- 0 = Monday … 6 = Sunday. Empty means "the weekday of starts_on".
  days_of_week smallint[] not null default '{}' check (days_of_week <@ array[0, 1, 2, 3, 4, 5, 6]::smallint[]),
  day_of_month smallint check (day_of_month is null or day_of_month between 1 and 31),
  starts_on date not null,
  ends_on date,
  timezone text not null default 'UTC',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_on is null or ends_on >= starts_on),
  unique (id, user_id),
  foreign key (project_id, user_id) references public.projects (id, user_id) on delete set null (project_id),
  foreign key (goal_id, user_id) references public.goals (id, user_id) on delete set null (goal_id)
);

drop trigger if exists touch_task_series on public.task_series;
create trigger touch_task_series before update on public.task_series
  for each row execute function public.touch_updated_at();
create index if not exists task_series_user_idx on public.task_series (user_id);
create index if not exists task_series_project_idx on public.task_series (project_id);
create index if not exists task_series_goal_idx on public.task_series (goal_id);

alter table public.task_series enable row level security;
revoke all on public.task_series from anon;
do $$
declare
  t text := 'task_series';
begin
  execute format('drop policy if exists "%1$s: read own" on public.%1$I', t);
  execute format('drop policy if exists "%1$s: insert own" on public.%1$I', t);
  execute format('drop policy if exists "%1$s: update own" on public.%1$I', t);
  execute format('drop policy if exists "%1$s: delete own" on public.%1$I', t);
  execute format('create policy "%1$s: read own" on public.%1$I for select to authenticated using (user_id = (select auth.uid()))', t);
  execute format('create policy "%1$s: insert own" on public.%1$I for insert to authenticated with check (user_id = (select auth.uid()))', t);
  execute format('create policy "%1$s: update own" on public.%1$I for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()))', t);
  execute format('create policy "%1$s: delete own" on public.%1$I for delete to authenticated using (user_id = (select auth.uid()))', t);
end;
$$;

-- ---------------------------------------------------------------------------
-- tasks: occurrences, and the new "skipped" state
-- ---------------------------------------------------------------------------
alter table public.tasks
  add column if not exists recurrence_id uuid,
  add column if not exists occurrence_date date;

alter table public.tasks drop constraint if exists tasks_status_check;
alter table public.tasks add constraint tasks_status_check check (status in ('open', 'done', 'skipped'));

-- Both set (an occurrence) or both empty (an ordinary task), never one without the other.
alter table public.tasks drop constraint if exists tasks_recurrence_pair;
alter table public.tasks add constraint tasks_recurrence_pair check ((recurrence_id is null) = (occurrence_date is null));

-- An occurrence can only belong to a series owned by the same user.
alter table public.tasks drop constraint if exists tasks_recurrence_id_user_id_fkey;
alter table public.tasks add constraint tasks_recurrence_id_user_id_fkey
  foreign key (recurrence_id, user_id) references public.task_series (id, user_id);

-- One occurrence per series per day. This is what makes duplicate generation impossible.
create unique index if not exists tasks_occurrence_unique on public.tasks (recurrence_id, occurrence_date) where recurrence_id is not null;
create index if not exists tasks_recurrence_idx on public.tasks (recurrence_id);

-- Deleting a series detaches its occurrences (they stay as ordinary tasks) instead of failing.
create or replace function public.detach_series_occurrences()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  update public.tasks set recurrence_id = null, occurrence_date = null
  where recurrence_id = old.id and user_id = old.user_id;
  return old;
end;
$$;
drop trigger if exists detach_occurrences on public.task_series;
create trigger detach_occurrences before delete on public.task_series
  for each row execute function public.detach_series_occurrences();

-- ---------------------------------------------------------------------------
-- goals: finite or ongoing
-- ---------------------------------------------------------------------------
alter table public.goals
  add column if not exists kind text not null default 'finite',
  add column if not exists cadence text,
  add column if not exists ends_on date;

alter table public.goals drop constraint if exists goals_kind_check;
alter table public.goals add constraint goals_kind_check check (kind in ('finite', 'ongoing'));
alter table public.goals drop constraint if exists goals_cadence_check;
alter table public.goals add constraint goals_cadence_check check (cadence is null or cadence in ('daily', 'weekly', 'monthly', 'custom'));
-- An ongoing goal has no target date.
alter table public.goals drop constraint if exists goals_ongoing_no_target;
alter table public.goals add constraint goals_ongoing_no_target check (kind = 'finite' or target_date is null);

-- ---------------------------------------------------------------------------
-- work_events: remember which occurrence a completion was (append-only history, no foreign keys)
-- so deleting and recreating an occurrence can never earn twice.
-- ---------------------------------------------------------------------------
alter table public.work_events
  add column if not exists recurrence_id uuid,
  add column if not exists occurrence_date date,
  add column if not exists local_day date;
create index if not exists work_events_occurrence_idx on public.work_events (recurrence_id, occurrence_date);
