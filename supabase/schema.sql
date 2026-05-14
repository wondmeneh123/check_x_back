-- Run in Supabase → SQL Editor (or use as a migration).
-- Order: extension → types → profiles → companies → profiles.company_id → links → auth trigger
--        → workers → transactions (tenant-scoped via company_id)

-- =========================
-- ENABLE EXTENSION
-- =========================
create extension if not exists "pgcrypto";

-- =========================
-- ROLES ENUM
-- =========================
create type public.user_role as enum (
  'SUPER_ADMIN',
  'COMPANY_ADMIN'
);

-- =========================
-- PROFILES TABLE (auth.users first; company_id added after companies)
-- =========================
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,

  role public.user_role not null default 'COMPANY_ADMIN',

  full_name text,

  created_at timestamptz default now ()
);

-- =========================
-- COMPANIES TABLE
-- =========================
create table public.companies (
  id uuid primary key default gen_random_uuid (),

  name text not null,

  business_type text,

  email text unique not null,

  phone text,

  address text,

  logo_url text,

  is_active boolean default true,

  created_by uuid references public.profiles (id),

  created_at timestamptz default now ()
);

-- =========================
-- PROFILES: company scope (nullable until user is tied to a company)
-- =========================
alter table public.profiles
  add column if not exists company_id uuid references public.companies (id) on delete set null;

create index if not exists profiles_company_id_idx on public.profiles (company_id);

-- =========================
-- COMPANY USERS TABLE
-- =========================
create table public.company_users (
  id uuid primary key default gen_random_uuid (),

  company_id uuid not null references public.companies (id) on delete cascade,

  user_id uuid not null references public.profiles (id) on delete cascade,

  created_at timestamptz default now (),

  unique (company_id, user_id)
);

create index if not exists company_users_company_id_idx on public.company_users (company_id);

create index if not exists company_users_user_id_idx on public.company_users (user_id);

-- =========================
-- AUTO CREATE PROFILE
-- =========================
create or replace function public.handle_new_user ()
  returns trigger
  language plpgsql
  security definer
  set search_path = public
  as $$
begin
  insert into public.profiles (
    id,
    full_name)
  values (
    new.id,
    new.raw_user_meta_data ->> 'full_name');

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;

create trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute function public.handle_new_user ();

-- =========================
-- WORKERS (id + name)
-- =========================
create table if not exists public.workers (
  worker_id text primary key,
  name text not null
);

-- =========================
-- TRANSACTIONS (receipt rows; scoped by company_id)
-- Telebirr app-style sample:
--   transaction_id = transaction number (e.g. DCT0CO707U)
--   amount / currency = e.g. -2075.00 ETB
--   occurred_at = transaction time (e.g. 2026-03-29 14:57:05+00)
--   transaction_type = e.g. Buy Goods
--   receiver = transaction to / merchant (e.g. Belayab Foods Production Plc)
-- =========================
create table if not exists public.transactions (
  id uuid primary key default gen_random_uuid (),
  company_id uuid not null references public.companies (id) on delete cascade,
  provider text not null,
  transaction_id text not null,
  date text,
  time text,
  occurred_at timestamptz,
  amount numeric,
  currency text,
  transaction_type text,
  sender text,
  receiver text,
  approved boolean not null default false,
  approved_at timestamptz,
  approved_by_worker_id text references public.workers (worker_id) on delete set null,
  claimed boolean not null default false,
  claimed_at timestamptz,
  claimed_by_worker_id text references public.workers (worker_id) on delete set null,
  claimed_by_name text,
  created_at timestamptz not null default now (),
  constraint transactions_company_provider_tx_unique unique (company_id, provider, transaction_id)
);

-- Add Telebirr-oriented columns on existing databases (no-op if already present)
alter table public.transactions
  add column if not exists occurred_at timestamptz;

alter table public.transactions
  add column if not exists currency text;

alter table public.transactions
  add column if not exists transaction_type text;

create index if not exists transactions_occurred_at_idx on public.transactions (occurred_at);

create index if not exists transactions_company_id_idx on public.transactions (company_id);

create index if not exists transactions_approved_by_worker_id_idx on public.transactions (approved_by_worker_id);

create index if not exists transactions_claimed_by_worker_id_idx on public.transactions (claimed_by_worker_id);

-- =========================
-- OPTIONAL: backfill profiles.company_id from company_users (run after data exists)
-- =========================
-- update public.profiles p
-- set company_id = cu.company_id
-- from (
--   select distinct on (user_id)
--     user_id,
--     company_id
--   from public.company_users
--   order by user_id, created_at asc
-- ) cu
-- where p.id = cu.user_id
--   and p.company_id is null;

-- =========================
-- OPTIONAL: approve / read patterns
-- =========================
-- update public.transactions
-- set approved = true,
--     approved_at = now(),
--     approved_by_worker_id = '<worker_id from session>'
-- where id = '<transaction uuid>'
--   and company_id = '<company uuid from session>';

-- select
--   t.*,
--   w.name as approved_by_name
-- from public.transactions t
-- left join public.workers w on w.worker_id = t.approved_by_worker_id
-- where t.company_id = '<company uuid>';
