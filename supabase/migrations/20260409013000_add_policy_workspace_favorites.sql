create table if not exists public.policy_workspace_favorites (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  selected_document_id uuid,
  target_document_ids uuid[] not null default '{}'::uuid[],
  reference_document_ids uuid[] not null default '{}'::uuid[],
  law_version_ids uuid[] not null default '{}'::uuid[],
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint policy_workspace_favorites_owner_name_key unique (owner_user_id, name)
);
create index if not exists policy_workspace_favorites_owner_updated_idx
  on public.policy_workspace_favorites (owner_user_id, updated_at desc);
alter table public.policy_workspace_favorites enable row level security;
drop policy if exists "policy actors can read their workspace favorites" on public.policy_workspace_favorites;
create policy "policy actors can read their workspace favorites"
  on public.policy_workspace_favorites
  for select
  using (owner_user_id = auth.uid());
drop policy if exists "policy actors can create their workspace favorites" on public.policy_workspace_favorites;
create policy "policy actors can create their workspace favorites"
  on public.policy_workspace_favorites
  for insert
  with check (owner_user_id = auth.uid());
drop policy if exists "policy actors can update their workspace favorites" on public.policy_workspace_favorites;
create policy "policy actors can update their workspace favorites"
  on public.policy_workspace_favorites
  for update
  using (owner_user_id = auth.uid())
  with check (owner_user_id = auth.uid());
drop policy if exists "policy actors can delete their workspace favorites" on public.policy_workspace_favorites;
create policy "policy actors can delete their workspace favorites"
  on public.policy_workspace_favorites
  for delete
  using (owner_user_id = auth.uid());
grant select, insert, update, delete on public.policy_workspace_favorites to authenticated;
