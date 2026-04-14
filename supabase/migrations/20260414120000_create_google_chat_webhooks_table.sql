create table if not exists public.lr_google_chat_webhooks (
  id uuid primary key default gen_random_uuid(),
  url text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.lr_google_chat_webhooks enable row level security;

drop policy if exists "Google Chat webhooks readable by authenticated users" on public.lr_google_chat_webhooks;
drop policy if exists "Google Chat webhooks manageable by admin" on public.lr_google_chat_webhooks;

create policy "Google Chat webhooks readable by authenticated users"
on public.lr_google_chat_webhooks
for select
to authenticated
using (auth.role() = 'authenticated');

create policy "Google Chat webhooks manageable by admin"
on public.lr_google_chat_webhooks
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

insert into public.lr_google_chat_webhooks (url)
select distinct trimmed.url
from (
  select trim(google_chat_webhook_url) as url
  from public.lr_profiles
  where google_chat_webhook_url is not null
    and trim(google_chat_webhook_url) <> ''
) as trimmed
on conflict (url) do nothing;
