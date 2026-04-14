create table if not exists public.lr_ai_settings (
  id text primary key default 'default',
  openai_api_key text not null default '',
  openai_model text not null default 'gpt-4o-mini',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.lr_ai_settings enable row level security;

drop policy if exists "AI settings readable by authenticated users" on public.lr_ai_settings;
drop policy if exists "AI settings manageable by admin" on public.lr_ai_settings;

create policy "AI settings readable by authenticated users"
on public.lr_ai_settings
for select
to authenticated
using (auth.role() = 'authenticated');

create policy "AI settings manageable by admin"
on public.lr_ai_settings
for all
to authenticated
using (
  exists (
    select 1
    from public.lr_profiles p
    where p.id = auth.uid()
      and p.role = 'admin'
  )
)
with check (
  exists (
    select 1
    from public.lr_profiles p
    where p.id = auth.uid()
      and p.role = 'admin'
  )
);

insert into public.lr_ai_settings (id, openai_api_key, openai_model, updated_at)
values ('default', '', 'gpt-4o-mini', now())
on conflict (id) do nothing;
