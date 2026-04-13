create table if not exists public.policy_openai_api_calls (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid not null references auth.users (id) on delete restrict,
  source_function text not null,
  analysis_stage text,
  model_name text,
  request_purpose text,
  request_payload jsonb not null default '{}'::jsonb,
  response_payload jsonb,
  response_status integer,
  response_status_text text,
  success boolean not null default false,
  error_message text,
  created_at timestamptz not null default now()
);
alter table public.policy_openai_api_calls enable row level security;
drop policy if exists "policy actors can read their openai api calls" on public.policy_openai_api_calls;
create policy "policy actors can read their openai api calls"
  on public.policy_openai_api_calls
  for select
  using (actor_user_id = auth.uid());
drop policy if exists "policy actors can create their openai api calls" on public.policy_openai_api_calls;
create policy "policy actors can create their openai api calls"
  on public.policy_openai_api_calls
  for insert
  with check (actor_user_id = auth.uid());
grant select on public.policy_openai_api_calls to authenticated;
