-- MYOS recurring tasks: database rules, checked automatically.
--
-- Run once on a FRESH TEST database that has migrations 001–005 applied (never on production):
--   psql -d your_test_db -f supabase/tests/005_recurring_rules.sql
-- Every line printed starts with "ok" or "FAIL". Nothing may start with FAIL.
\set QUIET on
\pset tuples_only on
\pset format unaligned

create schema if not exists t;
create or replace function t.refused(q text) returns boolean language plpgsql as $$ begin execute q; return false; exception when others then return true; end $$;
create or replace function t.works(q text) returns boolean language plpgsql as $$ begin execute q; return true; exception when others then return false; end $$;
create or replace function t.affected(q text) returns bigint language plpgsql as $$ declare n bigint; begin execute q; get diagnostics n = row_count; return n; end $$;
create or replace function t.say(pass boolean, what text) returns text language sql as $$ select case when pass then 'ok   ' else 'FAIL ' end || what $$;
grant usage on schema t to public;
grant execute on all functions in schema t to public;

\set A '''aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'''
\set B '''bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'''
insert into auth.users (id, email, instance_id, aud, role) values
  (:A,'rec-a@example.com','00000000-0000-0000-0000-000000000000','authenticated','authenticated'),
  (:B,'rec-b@example.com','00000000-0000-0000-0000-000000000000','authenticated','authenticated');

-- Something to attach series to, and an old-style row from before this migration.
insert into public.goals (id, user_id, title) values ('11111111-1111-4111-8111-111111111111', :A, 'A goal'), ('11111111-1111-4111-8111-222222222222', :B, 'B goal');
insert into public.projects (id, user_id, title) values ('22222222-2222-4222-8222-222222222222', :A, 'A project');
insert into public.tasks (id, user_id, title) values ('33333333-3333-4333-8333-333333333333', :A, 'An old ordinary task');

-- ===== user A =====
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated"}', false);

select t.say((select kind = 'finite' and cadence is null and ends_on is null from public.goals where id = '11111111-1111-4111-8111-111111111111'), 'existing goals are finite');
select t.say((select recurrence_id is null and occurrence_date is null and status = 'open' from public.tasks where id = '33333333-3333-4333-8333-333333333333'), 'existing tasks are not recurring');

select t.say(t.works($$insert into public.task_series (id, title, frequency, starts_on, goal_id, project_id, timezone) values ('44444444-4444-4444-8444-444444444444', 'Post on X', 'daily', '2026-10-08', '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', 'Africa/Lagos')$$), 'a user can create a series');
select t.say(t.refused($$insert into public.task_series (title, frequency, starts_on) values ('x', 'hourly', '2026-10-08')$$), 'an unknown frequency is refused');
select t.say(t.refused($$insert into public.task_series (title, frequency, interval_count, starts_on) values ('x', 'daily', 0, '2026-10-08')$$), 'an interval of 0 is refused');
select t.say(t.refused($$insert into public.task_series (title, frequency, days_of_week, starts_on) values ('x', 'weekly', '{9}', '2026-10-08')$$), 'a weekday outside 0–6 is refused');
select t.say(t.refused($$insert into public.task_series (title, frequency, starts_on, ends_on) values ('x', 'daily', '2026-10-08', '2026-10-01')$$), 'ending before starting is refused');
select t.say(t.works($$insert into public.task_series (title, frequency, days_of_week, starts_on, ends_on) values ('Weekly note', 'weekly', '{0,2,4}', '2026-10-08', '2027-01-01')$$), 'weekly on chosen days, with an end date, is fine');

-- occurrences
select t.say(t.works($$insert into public.tasks (id, user_id, title, recurrence_id, occurrence_date) values ('55555555-5555-4555-8555-000000000008', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Post on X', '44444444-4444-4444-8444-444444444444', '2026-10-08')$$), 'an occurrence can be made');
select t.say(t.refused($$insert into public.tasks (user_id, title, recurrence_id, occurrence_date) values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Post on X', '44444444-4444-4444-8444-444444444444', '2026-10-08')$$), 'a second occurrence for the same series and day is refused (no duplicates)');
select t.say(t.works($$insert into public.tasks (user_id, title, recurrence_id, occurrence_date) values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Post on X', '44444444-4444-4444-8444-444444444444', '2026-10-09')$$), 'the next day is a new occurrence');
select t.say(t.works($$insert into public.tasks (user_id, title) values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Two ordinary tasks'), ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'with no recurrence')$$), 'ordinary tasks are unaffected (no limit on them)');
select t.say(t.refused($$insert into public.tasks (user_id, title, recurrence_id) values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'half', '44444444-4444-4444-8444-444444444444')$$), 'a series link without a date is refused');
select t.say(t.refused($$insert into public.tasks (user_id, title, occurrence_date) values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'half', '2026-10-08')$$), 'a date without a series is refused');
select t.say(t.works($$update public.tasks set status = 'skipped' where id = '55555555-5555-4555-8555-000000000008'$$), 'an occurrence can be skipped');
select t.say(t.refused($$update public.tasks set status = 'sleeping' where id = '55555555-5555-4555-8555-000000000008'$$), 'other statuses are still refused');

-- goal kinds
select t.say(t.works($$update public.goals set kind = 'ongoing', cadence = 'daily', target_date = null where id = '11111111-1111-4111-8111-111111111111'$$), 'a goal can be ongoing, with a cadence and no target date');
select t.say(t.refused($$update public.goals set target_date = '2026-12-01' where id = '11111111-1111-4111-8111-111111111111'$$), 'an ongoing goal cannot have a target date');
select t.say(t.refused($$update public.goals set kind = 'forever' where id = '11111111-1111-4111-8111-111111111111'$$), 'an unknown goal kind is refused');
select t.say(t.refused($$update public.goals set cadence = 'hourly' where id = '11111111-1111-4111-8111-111111111111'$$), 'an unknown cadence is refused');

-- history remembers the occurrence
select t.say(t.works($$insert into public.work_events (user_id, task_id, points, at, recurrence_id, occurrence_date, local_day) values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '55555555-5555-4555-8555-000000000008', 10, now(), '44444444-4444-4444-8444-444444444444', '2026-10-08', '2026-10-08')$$), 'a completion records which occurrence it was');
select t.say(t.refused($$update public.work_events set occurrence_date = '2026-10-20'$$), 'that record cannot be rewritten');

-- deleting a series
select t.say(t.works($$delete from public.task_series where id = '44444444-4444-4444-8444-444444444444'$$), 'a series can be deleted');
select t.say((select recurrence_id is null and occurrence_date is null from public.tasks where id = '55555555-5555-4555-8555-000000000008'), '…its occurrences stay as ordinary tasks');
select t.say((select count(*) = 1 from public.work_events where occurrence_date = '2026-10-08'), '…and the work history is untouched');

-- ===== user B can't reach A's data =====
select set_config('request.jwt.claims', '{"sub":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","role":"authenticated"}', false);
reset role;
insert into public.task_series (id, user_id, title, frequency, starts_on) values ('66666666-6666-4666-8666-666666666666', :A, 'A private series', 'daily', '2026-10-08');
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","role":"authenticated"}', false);
select t.say((select count(*) = 0 from public.task_series), 'a user cannot read another user''s series');
select t.say(t.refused($$insert into public.task_series (user_id, title, frequency, starts_on) values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'sneaky', 'daily', '2026-10-08')$$), 'a user cannot create a series for someone else');
select t.say(t.refused($$insert into public.task_series (user_id, title, frequency, starts_on, project_id) values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'hijack', 'daily', '2026-10-08', '22222222-2222-4222-8222-222222222222')$$), 'a series cannot be attached to another user''s project');
select t.say(t.refused($$insert into public.task_series (user_id, title, frequency, starts_on, goal_id) values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'hijack', 'daily', '2026-10-08', '11111111-1111-4111-8111-111111111111')$$), 'a series cannot be attached to another user''s goal');
select t.say(t.refused($$insert into public.tasks (user_id, title, recurrence_id, occurrence_date) values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'hijack', '66666666-6666-4666-8666-666666666666', '2026-10-08')$$), 'an occurrence cannot be attached to another user''s series');
select t.say(t.affected($$delete from public.task_series where id = '66666666-6666-4666-8666-666666666666'$$) = 0, 'a user cannot delete another user''s series');
select t.say(t.works($$insert into public.task_series (title, frequency, starts_on) values ('B own series', 'daily', '2026-10-08')$$), 'but can make their own');

-- ===== signed out =====
reset role;
set role anon;
select t.say(t.refused($$select 1 from public.task_series$$), 'signed-out visitors cannot read series');
reset role;

-- ===== running the migration again changes nothing =====
\i supabase/migrations/005_recurring_tasks.sql
select t.say((select count(*) = 1 from public.task_series where id = '66666666-6666-4666-8666-666666666666'), 'running migration 005 twice is harmless');

drop schema t cascade;
