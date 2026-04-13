create table if not exists public.policy_review_execution_history (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users (id) on delete cascade,
  reviewer_email text not null,
  target_titles text[] not null default '{}'::text[],
  reference_titles text[] not null default '{}'::text[],
  comparison_run_ids uuid[] not null default '{}'::uuid[],
  created_at timestamptz not null default now()
);
create index if not exists policy_review_execution_history_owner_created_idx
  on public.policy_review_execution_history (owner_user_id, created_at desc);
alter table public.policy_review_execution_history enable row level security;
drop policy if exists "policy actors can read their review execution history" on public.policy_review_execution_history;
create policy "policy actors can read their review execution history"
  on public.policy_review_execution_history
  for select
  using (owner_user_id = auth.uid());
drop policy if exists "policy actors can create their review execution history" on public.policy_review_execution_history;
create policy "policy actors can create their review execution history"
  on public.policy_review_execution_history
  for insert
  with check (owner_user_id = auth.uid());
grant select, insert on public.policy_review_execution_history to authenticated;
