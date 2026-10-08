-- MYOS 002 — wallet identities (additive; changes no existing table)
--
-- Wallet sign-in uses Supabase Auth's built-in "Sign in with Web3" (EIP-4361 / SIWE).
-- Supabase Auth verifies the signature server-side and records the wallet as an
-- identity of a normal Supabase user (auth.identities, provider = 'web3').
--
-- public.wallets mirrors those VERIFIED identities so the app can show and, later,
-- manage them. The app can read its own rows but can never write them: rows are
-- created only by the trigger below, from identities Supabase Auth has verified.
-- That way nobody can claim a wallet address they haven't signed for.
--
-- A wallet identifies a MYOS account; it is not the account. One user can have
-- an email and several wallets (more can be linked later with
-- supabase.auth.linkIdentity, and they will appear here automatically).

create table public.wallets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  -- CAIP-2 namespace: 'eip155' covers Ethereum and every EVM chain; 'solana' later.
  chain text not null check (chain in ('eip155', 'solana')),
  -- Stored normalised: lowercase for eip155 addresses.
  address text not null,
  -- CAIP-2 network of the most recent sign-in, e.g. 'eip155:1' (informational only).
  last_network text,
  -- The Supabase Auth identity this row mirrors.
  identity_provider_id text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- One wallet belongs to one MYOS account.
  unique (chain, address),
  check (chain <> 'eip155' or address ~ '^0x[0-9a-f]{40}$')
);

create index wallets_user_idx on public.wallets (user_id);

create trigger touch_wallets before update on public.wallets for each row execute function public.touch_updated_at();

-- Supabase Auth stores a wallet identity as:
--   provider    = 'web3'
--   provider_id = 'web3:<chain>:<address>'              e.g. 'web3:ethereum:0xAbC…'
--   identity_data = { "sub": <provider_id>, "custom_claims": { "address", "chain", "network", … } }
-- These helpers read it, preferring custom_claims and falling back to provider_id.
create or replace function public.web3_identity_part(p_identity_data jsonb, p_provider_id text, p_key text, p_index int)
returns text
language sql
immutable
set search_path = ''
as $$
  select nullif(coalesce(
    p_identity_data -> 'custom_claims' ->> p_key,
    p_identity_data ->> p_key,
    case when p_index > 0 then split_part(p_provider_id, ':', p_index) end
  ), '')
$$;

-- Copies a verified web3 identity into public.wallets.
-- This is a mirror for the app's benefit: if copying ever fails, the sign-in
-- itself still succeeds (the error is logged as a warning, never raised).
create or replace function public.sync_wallet_identity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_chain text;
  v_address text;
  v_network text;
begin
  if new.provider <> 'web3' then
    return new;
  end if;

  begin
    v_chain := case public.web3_identity_part(new.identity_data, new.provider_id, 'chain', 2)
      when 'ethereum' then 'eip155'
      when 'solana' then 'solana'
      else null
    end;
    v_address := public.web3_identity_part(new.identity_data, new.provider_id, 'address', 3);
    if v_chain is null or v_address is null then
      raise warning 'MYOS: unrecognised web3 identity %', new.provider_id;
      return new;
    end if;

    v_network := public.web3_identity_part(new.identity_data, new.provider_id, 'network', 0);
    if v_chain = 'eip155' then
      v_address := lower(v_address);
      v_network := 'eip155:' || coalesce(v_network, '1');
    else
      v_network := 'solana:' || coalesce(v_network, 'mainnet');
    end if;

    insert into public.wallets (user_id, chain, address, last_network, identity_provider_id)
    values (new.user_id, v_chain, v_address, v_network, new.provider_id)
    on conflict (identity_provider_id) do update
      set user_id = excluded.user_id,
          last_network = excluded.last_network,
          updated_at = now();
  exception when others then
    raise warning 'MYOS: could not record wallet % (%)', new.provider_id, sqlerrm;
  end;
  return new;
end;
$$;

create trigger on_auth_identity_saved
  after insert or update on auth.identities
  for each row execute function public.sync_wallet_identity();

-- When an identity is unlinked, its wallet row goes too.
create or replace function public.remove_wallet_identity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.wallets where identity_provider_id = old.provider_id;
  return old;
end;
$$;

create trigger on_auth_identity_removed
  after delete on auth.identities
  for each row when (old.provider = 'web3')
  execute function public.remove_wallet_identity();

-- Wallets that already signed in before this migration.
insert into public.wallets (user_id, chain, address, last_network, identity_provider_id)
select
  i.user_id,
  'eip155',
  lower(public.web3_identity_part(i.identity_data, i.provider_id, 'address', 3)),
  'eip155:' || coalesce(public.web3_identity_part(i.identity_data, i.provider_id, 'network', 0), '1'),
  i.provider_id
from auth.identities i
where i.provider = 'web3'
  and public.web3_identity_part(i.identity_data, i.provider_id, 'chain', 2) = 'ethereum'
on conflict do nothing;

-- These helper functions are for the triggers only.
revoke all on function public.web3_identity_part(jsonb, text, text, int) from public, anon, authenticated;
revoke all on function public.sync_wallet_identity() from public, anon, authenticated;
revoke all on function public.remove_wallet_identity() from public, anon, authenticated;

-- Row Level Security: read your own wallets; no writes from the app.
alter table public.wallets enable row level security;
revoke all on public.wallets from anon;
revoke insert, update, delete, truncate on public.wallets from authenticated;

create policy "wallets: read own" on public.wallets for select to authenticated using (user_id = (select auth.uid()));
