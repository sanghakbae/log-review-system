create extension if not exists "pgcrypto";

create table if not exists public.lr_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  full_name text,
  role text not null default 'requester' check (role in ('requester', 'reviewer', 'admin')),
  google_chat_webhook_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.lr_admin_emails (
  email text primary key,
  created_at timestamptz not null default now()
);

create table if not exists public.lr_service_names (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists public.lr_google_chat_webhooks (
  id uuid primary key default gen_random_uuid(),
  url text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.lr_review_requests (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  requester_id uuid not null references auth.users(id) on delete cascade,
  requester_name text not null,
  request_body text,
  request_created_at timestamptz,
  status text not null default 'submitted' check (status in ('submitted', 'in_review', 'done', 'rejected')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.lr_review_attachments (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.lr_review_requests(id) on delete cascade,
  file_name text not null,
  storage_bucket text not null,
  storage_path text not null,
  mime_type text,
  created_at timestamptz not null default now()
);

create table if not exists public.lr_review_results (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.lr_review_requests(id) on delete cascade,
  reviewer_id uuid not null references auth.users(id) on delete cascade,
  summary text not null,
  feedback text,
  recommendation text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.lr_review_logs (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.lr_review_requests(id) on delete cascade,
  actor_id uuid references auth.users(id) on delete set null,
  action text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.lr_profiles enable row level security;
alter table public.lr_admin_emails enable row level security;
alter table public.lr_service_names enable row level security;
alter table public.lr_google_chat_webhooks enable row level security;
alter table public.lr_review_requests enable row level security;
alter table public.lr_review_attachments enable row level security;
alter table public.lr_review_results enable row level security;
alter table public.lr_review_logs enable row level security;

create policy "Profiles readable by authenticated users"
on public.lr_profiles
for select
to authenticated
using (auth.role() = 'authenticated');

create policy "Profiles update by self or admin"
on public.lr_profiles
for update
to authenticated
using (
  auth.uid() = id
  or exists (
    select 1
    from public.lr_profiles p
    where p.id = auth.uid()
      and p.role = 'admin'
  )
);

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

create trigger trg_set_profile_role_from_admin_emails
before insert or update on public.lr_profiles
for each row
execute function public.set_profile_role_from_admin_emails();

create policy "Service names readable by authenticated users"
on public.lr_service_names
for select
to authenticated
using (auth.role() = 'authenticated');

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

create policy "Requests readable by owner or reviewer"
on public.lr_review_requests
for select
to authenticated
using (
  requester_id = auth.uid()
  or exists (
    select 1
    from public.lr_profiles p
    where p.id = auth.uid()
      and p.role in ('reviewer', 'admin')
  )
);

create policy "Requests insert by authenticated users"
on public.lr_review_requests
for insert
to authenticated
with check (requester_id = auth.uid());

create policy "Requests update by owner or reviewer"
on public.lr_review_requests
for update
to authenticated
using (
  requester_id = auth.uid()
  or exists (
    select 1
    from public.lr_profiles p
    where p.id = auth.uid()
      and p.role in ('reviewer', 'admin')
  )
);

create policy "Attachments readable by related users"
on public.lr_review_attachments
for select
to authenticated
using (
  exists (
    select 1
    from public.lr_review_requests r
    where r.id = request_id
      and (
        r.requester_id = auth.uid()
        or exists (
          select 1
          from public.lr_profiles p
          where p.id = auth.uid()
            and p.role in ('reviewer', 'admin')
        )
      )
  )
);

create policy "Attachments insert by owner or reviewer"
on public.lr_review_attachments
for insert
to authenticated
with check (
  exists (
    select 1
    from public.lr_review_requests r
    where r.id = request_id
      and (
        r.requester_id = auth.uid()
        or exists (
          select 1
          from public.lr_profiles p
          where p.id = auth.uid()
            and p.role in ('reviewer', 'admin')
        )
      )
  )
);

create policy "Results readable by related users"
on public.lr_review_results
for select
to authenticated
using (
  exists (
    select 1
    from public.lr_review_requests r
    where r.id = request_id
      and (
        r.requester_id = auth.uid()
        or exists (
          select 1
          from public.lr_profiles p
          where p.id = auth.uid()
            and p.role in ('reviewer', 'admin')
        )
      )
  )
);

create policy "Results insert by reviewer or admin"
on public.lr_review_results
for insert
to authenticated
with check (
  exists (
    select 1
    from public.lr_profiles p
    where p.id = auth.uid()
      and p.role in ('reviewer', 'admin')
  )
);

create policy "Logs readable by related users"
on public.lr_review_logs
for select
to authenticated
using (
  exists (
    select 1
    from public.lr_review_requests r
    where r.id = request_id
      and (
        r.requester_id = auth.uid()
        or exists (
          select 1
          from public.lr_profiles p
          where p.id = auth.uid()
            and p.role in ('reviewer', 'admin')
        )
      )
  )
);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
as $$
begin
  insert into public.lr_profiles (id, email, full_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name', split_part(new.email, '@', 1))
  )
  on conflict (id) do update
    set email = excluded.email,
        full_name = excluded.full_name,
        updated_at = now();
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();
