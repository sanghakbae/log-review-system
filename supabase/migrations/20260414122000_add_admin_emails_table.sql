create table if not exists public.lr_admin_emails (
  email text primary key,
  created_at timestamptz not null default now()
);

alter table public.lr_admin_emails enable row level security;

drop policy if exists "Admin emails readable by authenticated users" on public.lr_admin_emails;
drop policy if exists "Admin emails manageable by admin" on public.lr_admin_emails;

create policy "Admin emails readable by authenticated users"
on public.lr_admin_emails
for select
to authenticated
using (auth.role() = 'authenticated');

create policy "Admin emails manageable by admin"
on public.lr_admin_emails
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

create or replace function public.set_profile_role_from_admin_emails()
returns trigger
language plpgsql
security definer
as $$
begin
  if exists (
    select 1
    from public.lr_admin_emails a
    where lower(a.email) = lower(new.email)
  ) then
    new.role := 'admin';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_set_profile_role_from_admin_emails on public.lr_profiles;
create trigger trg_set_profile_role_from_admin_emails
before insert or update on public.lr_profiles
for each row
execute function public.set_profile_role_from_admin_emails();

insert into public.lr_admin_emails (email)
values ('shbae@muhayu.com')
on conflict (email) do nothing;

update public.lr_profiles
set role = 'admin'
where lower(email) = 'shbae@muhayu.com';
