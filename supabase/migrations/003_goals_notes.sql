-- MYOS 003 — goals and notes, Phase 2 (additive; no table is rebuilt, no data is lost)
--
-- Goals gain importance, a target date, and completed / archived states.
-- Notes can link to a goal and a task, and can be archived.
-- Note ↔ task links move to notes.task_id (one place for each link);
-- existing links in tasks.note_ids are copied across first.

-- ---------------------------------------------------------------------------
-- goals
-- ---------------------------------------------------------------------------
alter table public.goals
  add column if not exists importance text not null default 'normal',
  add column if not exists target_date date,
  add column if not exists completed_at timestamptz,
  add column if not exists archived_at timestamptz;

alter table public.goals drop constraint if exists goals_importance_check;
alter table public.goals add constraint goals_importance_check check (importance in ('low', 'normal', 'high'));

-- 'achieved' becomes 'completed'; 'archived' is new.
alter table public.goals drop constraint if exists goals_status_check;
update public.goals set status = 'completed', completed_at = coalesce(completed_at, updated_at) where status = 'achieved';
alter table public.goals add constraint goals_status_check check (status in ('active', 'paused', 'completed', 'archived'));

-- ---------------------------------------------------------------------------
-- notes
-- ---------------------------------------------------------------------------
alter table public.notes
  add column if not exists goal_id uuid,
  add column if not exists task_id uuid,
  add column if not exists archived_at timestamptz;

-- Ownership-safe links, like every other relationship: a note can only point
-- at a goal or task that belongs to the same user.
alter table public.notes drop constraint if exists notes_goal_id_user_id_fkey;
alter table public.notes add constraint notes_goal_id_user_id_fkey
  foreign key (goal_id, user_id) references public.goals (id, user_id) on delete set null (goal_id);
alter table public.notes drop constraint if exists notes_task_id_user_id_fkey;
alter table public.notes add constraint notes_task_id_user_id_fkey
  foreign key (task_id, user_id) references public.tasks (id, user_id) on delete set null (task_id);

create index if not exists notes_goal_idx on public.notes (goal_id);
create index if not exists notes_task_idx on public.notes (task_id);

-- Copy existing task → note links onto the notes, then clear the old list.
-- (tasks.note_ids stays as a column for older app versions, but is no longer used.)
update public.notes n
set task_id = t.id
from public.tasks t
where n.task_id is null
  and n.user_id = t.user_id
  and n.id = any (t.note_ids);

update public.tasks set note_ids = '{}' where note_ids <> '{}';

comment on column public.tasks.note_ids is 'Deprecated since 003: notes link to tasks through notes.task_id.';
