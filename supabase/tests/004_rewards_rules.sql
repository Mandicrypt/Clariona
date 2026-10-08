-- MYOS rewards: database rules, checked automatically.
--
-- Run once on a FRESH TEST database that has migrations 001–004 applied (never on production;
-- the test leaves its own rows behind, and reward periods can't be deleted by design):
--   psql -d your_test_db -f supabase/tests/004_rewards_rules.sql
-- Every line printed starts with "ok" or "FAIL". Nothing may start with FAIL.
\set QUIET on
\pset tuples_only on
\pset format unaligned

create schema if not exists t;
-- Runs a statement as the current role and reports whether the database refused it.
create or replace function t.refused(q text) returns boolean language plpgsql as $$
begin execute q; return false; exception when others then return true; end $$;
create or replace function t.works(q text) returns boolean language plpgsql as $$
begin execute q; return true; exception when others then return false; end $$;
create or replace function t.say(pass boolean, what text) returns text language sql as $$ select case when pass then 'ok   ' else 'FAIL ' end || what $$;
grant usage on schema t to public;
grant execute on all functions in schema t to public;

\set A '''aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'''
\set B '''bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'''
\set P '''11111111-1111-4111-8111-111111111111'''
insert into auth.users (id, email, instance_id, aud, role) values
  (:A,'rules-a@example.com','00000000-0000-0000-0000-000000000000','authenticated','authenticated'),
  (:B,'rules-b@example.com','00000000-0000-0000-0000-000000000000','authenticated','authenticated');

-- ===== The server (service role) runs one period from start to finish =====
set role service_role;
insert into public.reward_periods (id, kind, starts_at, ends_at, config) values (:P,'daily','2026-10-04T00:00Z','2026-10-05T00:00Z','{"minimumUsd":20}');
select t.say(t.refused($$insert into public.leaderboard_entries values ('11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','0xaa…aa',900,500,1.75,1575,1)$$), 'UPCOMING: no rankings can be written yet');
update public.reward_periods set state='SNAPSHOT_PENDING' where id=:P;
select t.say(t.works($$insert into public.leaderboard_entries values ('11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','0xaa…aa',900,500,1.75,1575,1)$$), 'SNAPSHOT_PENDING: the snapshot job can write rankings');
select t.say(t.works($$insert into public.balance_verifications (period_id,user_id,wallet_address,token_balance,usd_value,source) values ('11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','0xaa',1000,500,'mock')$$), 'SNAPSHOT_PENDING: verified balances can be recorded');
update public.reward_periods set state='SNAPSHOT_TAKEN', snapshot_taken_at=now() where id=:P;
select t.say(t.refused($$insert into public.leaderboard_entries values ('11111111-1111-4111-8111-111111111111','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','0xbb…bb',1,20,1,1,2)$$), 'SNAPSHOT_TAKEN: no late entries');
select t.say(t.refused($$update public.leaderboard_entries set final_score = 1$$), 'SNAPSHOT_TAKEN: locked rankings cannot be changed');
select t.say(t.refused($$delete from public.leaderboard_entries$$), 'SNAPSHOT_TAKEN: locked rankings cannot be deleted');
select t.say(t.refused($$update public.reward_periods set state='UPCOMING' where id='11111111-1111-4111-8111-111111111111'$$), 'a period can never move backwards');
select t.say(t.refused($$update public.reward_periods set config='{"minimumUsd":1}' where id='11111111-1111-4111-8111-111111111111'$$), 'the rules a period was run under cannot be rewritten afterwards');
select t.say(t.refused($$insert into public.reward_allocations (period_id,user_id,rank,asset,amount) values ('11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',1,'ZEC',3)$$), 'SNAPSHOT_TAKEN: payouts are not calculated yet');
update public.reward_periods set state='CALCULATING' where id=:P;
select t.say(t.works($$insert into public.reward_allocations (period_id,user_id,rank,asset,amount) values ('11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',1,'ZEC',3)$$), 'CALCULATING: payouts can be written');
update public.reward_periods set state='DISTRIBUTION_PENDING' where id=:P;
select t.say(t.refused($$update public.reward_allocations set amount = 100$$), 'DISTRIBUTION_PENDING: a payout amount cannot change');
select t.say(t.works($$update public.reward_allocations set status='distributed', tx_ref='mock-tx-1'$$), 'DISTRIBUTION_PENDING: payment status can be recorded');
update public.reward_periods set state='DISTRIBUTED', distributed_at=now() where id=:P;
select t.say(t.refused($$delete from public.reward_allocations$$), 'DISTRIBUTED: payouts cannot be deleted');
select t.say(t.refused($$update public.reward_allocations set rank = 9$$), 'DISTRIBUTED: payouts cannot be re-ranked');
reset role;
select t.say((select final_score = 1575 and rank = 1 from public.leaderboard_entries), 'the locked ranking is exactly as it was written');
select t.say((select amount = 3 and status = 'distributed' and tx_ref = 'mock-tx-1' from public.reward_allocations), 'the payout is exactly as written, with its payment recorded');

-- ===== A signed-in user =====
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","role":"authenticated"}', false);
select t.say((select count(*) = 1 from public.leaderboard_entries), 'a user can read the leaderboard');
select t.say((select count(*) = 1 from public.reward_allocations), 'a user can read payouts');
select t.say((select count(*) = 0 from public.balance_verifications), 'a user cannot read other people''s verified balances');
select t.say(t.refused($$insert into public.leaderboard_entries values ('11111111-1111-4111-8111-111111111111','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','0xbb…bb',99999,1e9,2.25,1e9,2)$$), 'a user cannot write themselves into the leaderboard');
select t.say(t.refused($$insert into public.reward_allocations (period_id,user_id,rank,asset,amount) values ('11111111-1111-4111-8111-111111111111','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',1,'ZEC',10)$$), 'a user cannot give themselves a reward');
select t.say(t.refused($$insert into public.balance_verifications (period_id,user_id,wallet_address,token_balance,usd_value,source) values ('11111111-1111-4111-8111-111111111111','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','0xbb',1e9,1e9,'chain')$$), 'a user cannot fake a verified balance');
select t.say(t.refused($$insert into public.reward_periods (kind,starts_at,ends_at,config) values ('daily',now(),now()+interval '1 day','{}')$$), 'a user cannot create a reward period');
select t.say(t.refused($$update public.reward_periods set state='DISTRIBUTED'$$), 'a user cannot change a period''s state');
insert into public.work_events (user_id, task_id, points, at, created_at) values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', gen_random_uuid(), 10, now() - interval '5 days', now() - interval '5 days');
select t.say((select created_at > now() - interval '1 minute' from public.work_events where user_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'), 'a work event claiming an old arrival time is stamped with the real one');
select t.say(t.works($$insert into public.user_events (user_id,type,task_id,at) values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','review.completed',null,now())$$), 'review events (no task) can be stored');
select t.say(t.refused($$update public.work_events set points = 9999$$), 'work history cannot be edited');
select t.say(t.refused($$delete from public.user_events$$), 'user history cannot be deleted');

-- ===== Reward wallet rules =====
reset role;
insert into public.wallets (id, user_id, chain, address, linked_via) values
  ('22222222-2222-4222-8222-222222222222', :B, 'eip155', '0x'||repeat('b',40), 'signature'),
  ('33333333-3333-4333-8333-333333333333', :B, 'eip155', '0x'||repeat('c',40), 'signature'),
  ('44444444-4444-4444-8444-444444444444', :A, 'eip155', '0x'||repeat('a',40), 'signature');
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","role":"authenticated"}', false);
select t.say(t.works($$select public.set_reward_wallet('22222222-2222-4222-8222-222222222222')$$), 'a user can choose their reward wallet');
select t.say(t.refused($$select public.set_reward_wallet('33333333-3333-4333-8333-333333333333')$$), 'switching again within 7 days is refused');
select t.say(t.refused($$select public.set_reward_wallet('44444444-4444-4444-8444-444444444444')$$), 'someone else''s wallet cannot be claimed');
select t.say(t.refused($$insert into public.wallets (user_id,chain,address,linked_via) values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','eip155','0x'||repeat('e',40),'signature')$$), 'wallets can only be added by the server after a signature check');
reset role;
-- The switch-back loophole: wallet C was chosen long ago, B is current, and C is chosen again after the cooldown.
update public.wallets set is_reward=false, reward_selected_at=now()-interval '60 days' where id='33333333-3333-4333-8333-333333333333';
update public.wallets set is_reward=true,  reward_selected_at=now()-interval '30 days' where id='22222222-2222-4222-8222-222222222222';
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","role":"authenticated"}', false);
select public.set_reward_wallet('33333333-3333-4333-8333-333333333333');
reset role;
select t.say((select reward_selected_at > now() - interval '1 minute' from public.wallets where id='33333333-3333-4333-8333-333333333333'), 'switching back to an old wallet starts a fresh date (no inherited eligibility)');
select t.say((select count(*) = 1 from public.wallets where user_id = :B and is_reward), 'a user has exactly one reward wallet');
select t.say(t.refused($$insert into public.wallets (user_id,chain,address,linked_via) values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','eip155','0x'||repeat('c',40),'signature')$$), 'one wallet cannot belong to two accounts');

-- ===== Signed out =====
set role anon;
select t.say(t.refused($$select 1 from public.leaderboard_entries$$), 'signed-out visitors cannot read rankings');
reset role;

drop schema t cascade;
