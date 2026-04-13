create table if not exists public.resume_workspaces (
  owner_id text primary key,
  editor_email text,
  profile jsonb not null,
  companies jsonb not null default '[]'::jsonb,
  experiences jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.resume_workspaces enable row level security;
create policy "public read resume workspaces"
on public.resume_workspaces
for select
using (true);
create policy "authenticated users can create their own resume workspace"
on public.resume_workspaces
for insert
to authenticated
with check ((select auth.jwt()->>'email') = editor_email);
create policy "authenticated editor can update resume workspace"
on public.resume_workspaces
for update
to authenticated
using ((select auth.jwt()->>'email') = editor_email)
with check ((select auth.jwt()->>'email') = editor_email);
insert into storage.buckets (id, name, public)
values ('resume-assets', 'resume-assets', true)
on conflict (id) do nothing;
create policy "public read resume assets"
on storage.objects
for select
using (bucket_id = 'resume-assets');
create policy "authenticated upload resume assets"
on storage.objects
for insert
to authenticated
with check (bucket_id = 'resume-assets');
create policy "authenticated update resume assets"
on storage.objects
for update
to authenticated
using (bucket_id = 'resume-assets')
with check (bucket_id = 'resume-assets');
