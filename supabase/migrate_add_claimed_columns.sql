-- Run once in Supabase → SQL Editor if `transactions` already exists without `claimed*`.
-- Fixes PostgREST PGRST204: missing column in schema cache.

alter table public.transactions
  add column if not exists claimed boolean not null default false,
  add column if not exists claimed_at timestamptz,
  add column if not exists claimed_by_worker_id text references public.workers (worker_id) on delete set null,
  add column if not exists claimed_by_name text;

create index if not exists transactions_claimed_by_worker_id_idx
  on public.transactions (claimed_by_worker_id);

-- Refresh PostgREST schema cache (Supabase usually picks this up quickly; if not, wait ~1 min or reload project).
