-- MYOS 004 — Phase 3: intelligence settings and the rewards foundation (additive)
--
-- Principles:
-- * MYOS works fully without a wallet. Nothing here is required for normal use.
-- * Users can READ reward results but never WRITE them. Periods, leaderboard
--   entries, verified balances and allocations are written only by the server
--   (service role: the future snapshot job), never by the browser.
-- * A finalised snapshot is immutable: its entries and allocations cannot change,
--   even if someone's token balance changes later.

-- ---------------------------------------------------------------------------
-- Daily plan: how much focused time the person usually has (minutes per day).
-- ---------------------------------------------------------------------------
alter table public.settings add column if not exists daily_minutes integer not null default 240;
alter table public.settings drop constraint if exists settings_daily_minutes_check;
alter table public.settings add constraint settings_daily_minutes_check check (daily_minutes between 30 and 960);

-- ---------------------------------------------------------------------------
-- History events that aren't about one task (e.g. "weekly review completed").
-- ---------------------------------------------------------------------------
alter table public.user_events alter column task_id drop not null;

-- ---------------------------------------------------------------------------
-- Reward identity: one reward wallet per user, chosen from their verified wallets.
-- (Wallets are only ever created from verified signatures; see 002 and the
-- link-wallet function.) The choice can only be made through the function below.
-- ---------------------------------------------------------------------------
alter table public.wallets add column if not exists is_reward boolean not null default false;
alter table public.wallets add column if not exists reward_selected_at timestamptz;
create unique index if not exists wallets_one_reward_wallet_per_user on public.wallets (user_id) where is_reward;

-- Wallets linked by signature (not by signing in) have no auth identity.
alter table public.wallets alter column identity_provider_id drop not null;
alter table public.wallets add column if not exists linked_via text not null default 'sign-in'
  check (linked_via in ('sign-in', 'signature'));

/**
 * Choose which verified wallet represents you in rewards.
 * Switching is limited to once per 7 days, so wallets can't be swapped around
 * snapshots to borrow someone else's holdings. A change applies to rankings
 * from the next snapshot (the snapshot job reads reward_selected_at).
 */
create or replace function public.set_reward_wallet(p_wallet_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_last timestamptz;
begin
  if not exists (select 1 from public.wallets where id = p_wallet_id and user_id = auth.uid()) then
    raise exception 'Not your wallet';
  end if;
  select max(reward_selected_at) into v_last from public.wallets where user_id = auth.uid();
  if v_last is not null and v_last > now() - interval '7 days'
     and not exists (select 1 from public.wallets where id = p_wallet_id and is_reward) then
    raise exception 'The reward wallet can be changed once every 7 days';
  end if;
  update public.wallets set is_reward = false where user_id = auth.uid() and id <> p_wallet_id and is_reward;
  -- Always the time of this choice: switching back to an older wallet must not
  -- inherit its old date (which would let it count mid-period).
  update public.wallets set is_reward = true, reward_selected_at = now() where id = p_wallet_id and not is_reward;
end;
$$;
revoke all on function public.set_reward_wallet(uuid) from public, anon;
grant execute on function public.set_reward_wallet(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Reward periods: one row per daily or weekly competition window (UTC).
-- The config used is copied in, so later config changes never rewrite history.
-- ---------------------------------------------------------------------------
create table if not exists public.reward_periods (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('daily', 'weekly')),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  state text not null default 'UPCOMING' check (state in (
    'UPCOMING', 'SNAPSHOT_PENDING', 'SNAPSHOT_TAKEN', 'CALCULATING', 'DISTRIBUTION_PENDING', 'DISTRIBUTED'
  )),
  config jsonb not null,
  snapshot_taken_at timestamptz,
  distributed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (kind, starts_at),
  check (ends_at > starts_at)
);

-- Verified token holdings at snapshot time (chain = real, mock = development only).
create table if not exists public.balance_verifications (
  id uuid primary key default gen_random_uuid(),
  period_id uuid not null references public.reward_periods (id),
  user_id uuid not null references auth.users (id) on delete cascade,
  wallet_address text not null,
  token_balance numeric not null,
  usd_value numeric not null,
  source text not null check (source in ('chain', 'mock')),
  verified_at timestamptz not null default now(),
  unique (period_id, user_id)
);

-- The locked ranking of a period.
create table if not exists public.leaderboard_entries (
  period_id uuid not null references public.reward_periods (id),
  user_id uuid not null references auth.users (id) on delete cascade,
  display_address text not null, -- shortened, e.g. 0x82…91a
  activity_score integer not null check (activity_score >= 0),
  holder_usd numeric not null,
  multiplier numeric not null check (multiplier >= 1),
  final_score numeric not null,
  rank integer not null check (rank >= 1),
  created_at timestamptz not null default now(),
  primary key (period_id, user_id),
  unique (period_id, rank)
);

-- What each ranked user receives (Top N only). tx_ref stays empty until real transfers exist.
create table if not exists public.reward_allocations (
  period_id uuid not null references public.reward_periods (id),
  user_id uuid not null references auth.users (id) on delete cascade,
  rank integer not null,
  asset text not null,
  amount numeric not null check (amount >= 0),
  status text not null default 'pending' check (status in ('pending', 'distributed', 'failed')),
  tx_ref text,
  created_at timestamptz not null default now(),
  primary key (period_id, user_id)
);

create index if not exists leaderboard_entries_user_idx on public.leaderboard_entries (user_id);
create index if not exists reward_allocations_user_idx on public.reward_allocations (user_id);
create index if not exists balance_verifications_user_idx on public.balance_verifications (user_id);

-- ---------------------------------------------------------------------------
-- Immutability: once a snapshot is taken, its rankings can't be edited or removed.
-- Allocation status may still move forward (pending → distributed) to record payment.
-- ---------------------------------------------------------------------------
create or replace function public.lock_finalised_rewards()
returns trigger
language plpgsql
set search_path = ''
as $$
-- Order of a reward period, and what may be written at each step:
--   SNAPSHOT_PENDING      the snapshot job writes rankings (leaderboard_entries)
--   SNAPSHOT_TAKEN        rankings are locked: no inserts, updates or deletes
--   CALCULATING           the job writes payouts (reward_allocations)
--   DISTRIBUTION_PENDING+ payouts are locked except payment status / tx_ref
declare
  v_period uuid;
  v_state text;
begin
  if tg_op = 'DELETE' then v_period := old.period_id; else v_period := new.period_id; end if;
  select state into v_state from public.reward_periods where id = v_period;

  if tg_table_name = 'leaderboard_entries' then
    if tg_op = 'INSERT' and v_state = 'SNAPSHOT_PENDING' then
      return new;
    end if;
    if v_state = 'SNAPSHOT_PENDING' and tg_op = 'UPDATE' then
      return new;
    end if;
    raise exception 'Rankings for reward period % are locked (state %)', v_period, v_state;
  end if;

  -- reward_allocations
  if v_state = 'CALCULATING' then
    return coalesce(new, old);
  end if;
  if tg_op = 'UPDATE' and v_state in ('DISTRIBUTION_PENDING', 'DISTRIBUTED') then
    if new.amount = old.amount and new.rank = old.rank and new.user_id = old.user_id
       and new.asset = old.asset and new.period_id = old.period_id then
      return new; -- recording payment: status / tx_ref only
    end if;
  end if;
  raise exception 'Payouts for reward period % are locked (state %)', v_period, v_state;
end;
$$;

drop trigger if exists lock_leaderboard_entries on public.leaderboard_entries;
create trigger lock_leaderboard_entries before insert or update or delete on public.leaderboard_entries
  for each row execute function public.lock_finalised_rewards();
drop trigger if exists lock_reward_allocations on public.reward_allocations;
create trigger lock_reward_allocations before insert or update or delete on public.reward_allocations
  for each row execute function public.lock_finalised_rewards();

-- States only move forward; a period's config can't change after the snapshot.
create or replace function public.guard_reward_period()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_order text[] := array['UPCOMING', 'SNAPSHOT_PENDING', 'SNAPSHOT_TAKEN', 'CALCULATING', 'DISTRIBUTION_PENDING', 'DISTRIBUTED'];
begin
  if tg_op = 'DELETE' then
    raise exception 'Reward periods are history and cannot be deleted';
  end if;
  if array_position(v_order, new.state) < array_position(v_order, old.state) then
    raise exception 'Reward period state can only move forward (% → %)', old.state, new.state;
  end if;
  if old.state <> 'UPCOMING' and old.state <> 'SNAPSHOT_PENDING'
     and (new.config is distinct from old.config or new.starts_at <> old.starts_at or new.ends_at <> old.ends_at) then
    raise exception 'A finalised reward period cannot be changed';
  end if;
  return new;
end;
$$;

drop trigger if exists guard_reward_periods on public.reward_periods;
create trigger guard_reward_periods before update or delete on public.reward_periods
  for each row execute function public.guard_reward_period();

-- ---------------------------------------------------------------------------
-- Row Level Security: read-only for signed-in users; no write policies at all.
-- ---------------------------------------------------------------------------
alter table public.reward_periods enable row level security;
alter table public.balance_verifications enable row level security;
alter table public.leaderboard_entries enable row level security;
alter table public.reward_allocations enable row level security;

revoke all on public.reward_periods, public.balance_verifications, public.leaderboard_entries, public.reward_allocations from anon;
revoke insert, update, delete, truncate on public.reward_periods, public.balance_verifications, public.leaderboard_entries, public.reward_allocations from authenticated;

drop policy if exists "reward_periods: read" on public.reward_periods;
create policy "reward_periods: read" on public.reward_periods for select to authenticated using (true);
-- Leaderboards are public within MYOS (shortened addresses only, no names or emails).
drop policy if exists "leaderboard_entries: read" on public.leaderboard_entries;
create policy "leaderboard_entries: read" on public.leaderboard_entries for select to authenticated using (true);
drop policy if exists "reward_allocations: read" on public.reward_allocations;
create policy "reward_allocations: read" on public.reward_allocations for select to authenticated using (true);
-- Your verified balance is private to you.
drop policy if exists "balance_verifications: read own" on public.balance_verifications;
create policy "balance_verifications: read own" on public.balance_verifications for select to authenticated using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- History arrival times are stamped by the database, never by a device.
-- Reward scoring ignores events stored long after the time they claim
-- (see ACTIVITY_RULES.limits.maxBackdateHours), so events can't be backdated.
-- ---------------------------------------------------------------------------
create or replace function public.stamp_received_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.created_at := now();
  return new;
end;
$$;

drop trigger if exists stamp_work_events_received on public.work_events;
create trigger stamp_work_events_received before insert on public.work_events
  for each row execute function public.stamp_received_at();
drop trigger if exists stamp_user_events_received on public.user_events;
create trigger stamp_user_events_received before insert on public.user_events
  for each row execute function public.stamp_received_at();
