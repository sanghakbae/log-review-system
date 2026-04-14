create table if not exists public.lr_service_names (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  created_at timestamptz not null default now()
);

alter table public.lr_service_names enable row level security;

drop policy if exists "Service names readable by authenticated users" on public.lr_service_names;
create policy "Service names readable by authenticated users"
on public.lr_service_names
for select
to authenticated
using (auth.role() = 'authenticated');

drop policy if exists "Service names manageable by admin" on public.lr_service_names;
create policy "Service names manageable by admin"
on public.lr_service_names
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
