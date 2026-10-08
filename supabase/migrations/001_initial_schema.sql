-- MYOS 001 — initial schema
--
-- One row per domain record, owned by one user. Row Level Security makes
-- the database itself enforce that people only ever see and change their own data.
--
-- Ownership of related records is enforced with composite foreign keys:
-- a task can only point at a project whose (id, user_id) matches the task's
-- own user_id, so nobody can attach their rows to someone else's records.
--
-- work_events and user_events are append-only: users may read and insert,
-- never update or delete.

-- ---------------------------------------------------------------------------
-- updated_at: the app sets it (latest updated_at wins during sync). If a row is
-- edited without touching updated_at (for example by hand in the dashboard),
-- the database stamps it so the change still syncs.
-- ---------------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.updated_at is not distinct from old.updated_at then
    new.updated_at := now();
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  name text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- A profile row is created automatically for every new account.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id) values (new.id) on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- settings (one row per user; created by the app on first sign-in)
-- ---------------------------------------------------------------------------
create table public.settings (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  name text not null default '',
  show_meaningful_work boolean not null default true,
  theme text not null default 'system' check (theme in ('light', 'dark', 'system')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- goals
-- ---------------------------------------------------------------------------
create table public.goals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title text not null,
  why text not null default '',
  status text not null default 'active' check (status in ('active', 'paused', 'achieved')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id)
);

-- ---------------------------------------------------------------------------
-- projects
-- ---------------------------------------------------------------------------
create table public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title text not null,
  summary text not null default '',
  goal_id uuid,
  status text not null default 'active' check (status in ('active', 'paused', 'done')),
  deadline date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id),
  foreign key (goal_id, user_id) references public.goals (id, user_id) on delete set null (goal_id)
);

-- ---------------------------------------------------------------------------
-- milestones
-- ---------------------------------------------------------------------------
create table public.milestones (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  project_id uuid not null,
  title text not null,
  due_on date,
  done boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id),
  foreign key (project_id, user_id) references public.projects (id, user_id) on delete cascade
);

-- ---------------------------------------------------------------------------
-- tasks
-- depends_on and note_ids stay as arrays for now; checklist and links are
-- embedded task data, so JSONB.
-- ---------------------------------------------------------------------------
create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title text not null,
  description text,
  status text not null default 'open' check (status in ('open', 'done')),
  project_id uuid,
  goal_id uuid,
  milestone_id uuid,
  planned_for date,
  due_on date,
  effort_minutes integer check (effort_minutes is null or effort_minutes > 0),
  impact smallint not null default 3 check (impact between 1 and 5),
  consequence smallint not null default 2 check (consequence between 1 and 5),
  user_importance text not null default 'normal' check (user_importance in ('low', 'normal', 'high')),
  depends_on uuid[] not null default '{}',
  waiting_on text,
  checklist jsonb not null default '[]' check (jsonb_typeof(checklist) = 'array'),
  links jsonb not null default '[]' check (jsonb_typeof(links) = 'array'),
  note_ids uuid[] not null default '{}',
  outcome text,
  suppressed boolean not null default false,
  postpone_count integer not null default 0 check (postpone_count >= 0),
  origin text not null default 'user' check (origin in ('user', 'inbox', 'sample')),
  parent_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (id, user_id),
  foreign key (project_id, user_id) references public.projects (id, user_id) on delete set null (project_id),
  foreign key (goal_id, user_id) references public.goals (id, user_id) on delete set null (goal_id),
  foreign key (milestone_id, user_id) references public.milestones (id, user_id) on delete set null (milestone_id),
  foreign key (parent_id, user_id) references public.tasks (id, user_id) on delete set null (parent_id)
);

-- ---------------------------------------------------------------------------
-- inbox_items
-- ---------------------------------------------------------------------------
create table public.inbox_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  text text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- notes
-- ---------------------------------------------------------------------------
create table public.notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title text not null default '',
  body text not null default '',
  project_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (project_id, user_id) references public.projects (id, user_id) on delete set null (project_id)
);

-- ---------------------------------------------------------------------------
-- work_events — append-only meaningful-work history.
-- task_id, project_id and goal_id are snapshots, not foreign keys: history
-- stays even when the task, project or goal is deleted.
-- ---------------------------------------------------------------------------
create table public.work_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  task_id uuid not null,
  points integer not null,
  at timestamptz not null,
  kind text not null default 'credit' check (kind in ('credit', 'reversal')),
  reverses uuid,
  reason text,
  task_title text,
  impact smallint check (impact is null or impact between 1 and 5),
  breakdown jsonb,
  project_id uuid,
  goal_id uuid,
  scoring_version integer,
  created_at timestamptz not null default now(),
  unique (id, user_id),
  check ((kind = 'reversal') = (reverses is not null)),
  foreign key (reverses, user_id) references public.work_events (id, user_id) deferrable initially deferred
);

-- ---------------------------------------------------------------------------
-- user_events — append-only behaviour log (future personalisation data).
-- ---------------------------------------------------------------------------
create table public.user_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  type text not null,
  task_id uuid not null,
  at timestamptz not null,
  source text,
  was_suggested boolean,
  data jsonb,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------------
create trigger touch_profiles before update on public.profiles for each row execute function public.touch_updated_at();
create trigger touch_settings before update on public.settings for each row execute function public.touch_updated_at();
create trigger touch_goals before update on public.goals for each row execute function public.touch_updated_at();
create trigger touch_projects before update on public.projects for each row execute function public.touch_updated_at();
create trigger touch_milestones before update on public.milestones for each row execute function public.touch_updated_at();
create trigger touch_tasks before update on public.tasks for each row execute function public.touch_updated_at();
create trigger touch_inbox_items before update on public.inbox_items for each row execute function public.touch_updated_at();
create trigger touch_notes before update on public.notes for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- indexes (user_id for RLS lookups, and every foreign key column)
-- ---------------------------------------------------------------------------
create index goals_user_idx on public.goals (user_id);
create index projects_user_idx on public.projects (user_id);
create index projects_goal_idx on public.projects (goal_id);
create index milestones_user_idx on public.milestones (user_id);
create index milestones_project_idx on public.milestones (project_id);
create index tasks_user_status_idx on public.tasks (user_id, status);
create index tasks_project_idx on public.tasks (project_id);
create index tasks_goal_idx on public.tasks (goal_id);
create index tasks_milestone_idx on public.tasks (milestone_id);
create index tasks_parent_idx on public.tasks (parent_id);
create index inbox_items_user_idx on public.inbox_items (user_id);
create index notes_user_idx on public.notes (user_id);
create index notes_project_idx on public.notes (project_id);
create index work_events_user_at_idx on public.work_events (user_id, at);
create index work_events_task_idx on public.work_events (task_id);
create index work_events_reverses_idx on public.work_events (reverses);
create index user_events_user_at_idx on public.user_events (user_id, at);
create index user_events_task_idx on public.user_events (task_id);

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.settings enable row level security;
alter table public.goals enable row level security;
alter table public.projects enable row level security;
alter table public.milestones enable row level security;
alter table public.tasks enable row level security;
alter table public.inbox_items enable row level security;
alter table public.notes enable row level security;
alter table public.work_events enable row level security;
alter table public.user_events enable row level security;

-- Signed-out visitors get nothing.
revoke all on public.profiles, public.settings, public.goals, public.projects, public.milestones, public.tasks,
  public.inbox_items, public.notes, public.work_events, public.user_events from anon;

-- History tables: read and add only.
revoke update, delete, truncate on public.work_events, public.user_events from authenticated;

-- profiles
create policy "profiles: read own" on public.profiles for select to authenticated using (id = (select auth.uid()));
create policy "profiles: insert own" on public.profiles for insert to authenticated with check (id = (select auth.uid()));
create policy "profiles: update own" on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- Owned, editable records: full control over your own rows only.
do $$
declare
  t text;
begin
  foreach t in array array['settings', 'goals', 'projects', 'milestones', 'tasks', 'inbox_items', 'notes'] loop
    execute format('create policy "%1$s: read own" on public.%1$I for select to authenticated using (user_id = (select auth.uid()))', t);
    execute format('create policy "%1$s: insert own" on public.%1$I for insert to authenticated with check (user_id = (select auth.uid()))', t);
    execute format('create policy "%1$s: update own" on public.%1$I for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()))', t);
    execute format('create policy "%1$s: delete own" on public.%1$I for delete to authenticated using (user_id = (select auth.uid()))', t);
  end loop;
end;
$$;

-- Append-only history: read and insert your own rows. No update or delete policy exists.
create policy "work_events: read own" on public.work_events for select to authenticated using (user_id = (select auth.uid()));
create policy "work_events: insert own" on public.work_events for insert to authenticated with check (user_id = (select auth.uid()));
create policy "user_events: read own" on public.user_events for select to authenticated using (user_id = (select auth.uid()));
create policy "user_events: insert own" on public.user_events for insert to authenticated with check (user_id = (select auth.uid()));
