create extension if not exists "pgcrypto";
create type public.document_type as enum ('POLICY', 'GUIDELINE');
create type public.hierarchy_type as enum ('document', 'chapter', 'article', 'paragraph', 'item', 'sub_item');
create type public.audit_result as enum ('SUCCESS', 'FAILURE');
create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  owner_user_id uuid not null references auth.users (id) on delete restrict,
  created_at timestamptz not null default now()
);
create table public.workspace_members (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('owner', 'member')),
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create table public.documents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces (id) on delete set null,
  owner_user_id uuid not null references auth.users (id) on delete restrict,
  title text not null,
  description text,
  document_type public.document_type not null,
  source_storage_path text not null,
  source_file_name text not null,
  created_at timestamptz not null default now()
);
create table public.document_versions (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents (id) on delete cascade,
  version_number integer not null,
  raw_text text not null,
  parse_warnings jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  unique (document_id, version_number)
);
create table public.document_sections (
  id uuid primary key default gen_random_uuid(),
  document_version_id uuid not null references public.document_versions (id) on delete cascade,
  parent_section_id uuid references public.document_sections (id) on delete set null,
  hierarchy_type public.hierarchy_type not null,
  hierarchy_label text not null,
  hierarchy_order integer not null,
  normalized_text text not null,
  original_text text not null,
  text_hash text not null,
  path_display text not null default '',
  created_at timestamptz not null default now()
);
create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid not null references auth.users (id) on delete restrict,
  action text not null,
  target_document_id uuid references public.documents (id) on delete set null,
  result public.audit_result not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
as $$
declare
  workspace_id uuid;
begin
  insert into public.workspaces (name, owner_user_id)
  values (coalesce(new.raw_user_meta_data ->> 'workspace_name', new.email || ' workspace'), new.id)
  returning id into workspace_id;

  insert into public.workspace_members (workspace_id, user_id, role)
  values (workspace_id, new.id, 'owner');

  return new;
end;
$$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();
create or replace view public.document_latest_versions as
select
  d.id,
  d.title,
  d.document_type,
  dv.version_number,
  dv.created_at,
  (
    select count(*)
    from public.document_sections ds
    where ds.document_version_id = dv.id
  ) as section_count
from public.documents d
join lateral (
  select *
  from public.document_versions dv_inner
  where dv_inner.document_id = d.id
  order by dv_inner.version_number desc
  limit 1
) dv on true;
create or replace view public.document_details as
select
  d.id,
  d.title,
  d.description,
  d.document_type,
  dv.version_number,
  dv.raw_text,
  array(
    select jsonb_array_elements_text(dv.parse_warnings)
  ) as parse_warnings,
  coalesce(
    (
      select jsonb_agg(
        jsonb_build_object(
          'id', ds.id,
          'hierarchy_type', ds.hierarchy_type,
          'hierarchy_label', ds.hierarchy_label,
          'hierarchy_order', ds.hierarchy_order,
          'original_text', ds.original_text,
          'path_display', ds.path_display
        )
        order by ds.hierarchy_order
      )
      from public.document_sections ds
      where ds.document_version_id = dv.id
    ),
    '[]'::jsonb
  ) as sections
from public.documents d
join lateral (
  select *
  from public.document_versions dv_inner
  where dv_inner.document_id = d.id
  order by dv_inner.version_number desc
  limit 1
) dv on true;
alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.documents enable row level security;
alter table public.document_versions enable row level security;
alter table public.document_sections enable row level security;
alter table public.audit_logs enable row level security;
create policy "workspace members can read workspaces"
  on public.workspaces
  for select
  using (
    exists (
      select 1
      from public.workspace_members wm
      where wm.workspace_id = workspaces.id
        and wm.user_id = auth.uid()
    )
  );
create policy "workspace members can read memberships"
  on public.workspace_members
  for select
  using (user_id = auth.uid());
create policy "owners can create documents"
  on public.documents
  for insert
  with check (owner_user_id = auth.uid());
create policy "owners and members can read documents"
  on public.documents
  for select
  using (
    owner_user_id = auth.uid()
    or exists (
      select 1
      from public.workspace_members wm
      where wm.workspace_id = documents.workspace_id
        and wm.user_id = auth.uid()
    )
  );
create policy "owners can read versions"
  on public.document_versions
  for select
  using (
    exists (
      select 1
      from public.documents d
      where d.id = document_versions.document_id
        and d.owner_user_id = auth.uid()
    )
  );
create policy "owners can create versions"
  on public.document_versions
  for insert
  with check (
    exists (
      select 1
      from public.documents d
      where d.id = document_versions.document_id
        and d.owner_user_id = auth.uid()
    )
  );
create policy "owners can read sections"
  on public.document_sections
  for select
  using (
    exists (
      select 1
      from public.document_versions dv
      join public.documents d on d.id = dv.document_id
      where dv.id = document_sections.document_version_id
        and d.owner_user_id = auth.uid()
    )
  );
create policy "owners can create sections"
  on public.document_sections
  for insert
  with check (
    exists (
      select 1
      from public.document_versions dv
      join public.documents d on d.id = dv.document_id
      where dv.id = document_sections.document_version_id
        and d.owner_user_id = auth.uid()
    )
  );
create policy "actors can read their audit logs"
  on public.audit_logs
  for select
  using (actor_user_id = auth.uid());
create policy "actors can create audit logs"
  on public.audit_logs
  for insert
  with check (actor_user_id = auth.uid());
grant select on public.document_latest_versions to authenticated;
grant select on public.document_details to authenticated;
insert into storage.buckets (id, name, public)
values ('source-documents', 'source-documents', false)
on conflict (id) do nothing;
create policy "authenticated users upload their own source files"
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'source-documents'
    and auth.uid()::text = (storage.foldername(name))[1]
  );
create policy "authenticated users read their own source files"
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'source-documents'
    and auth.uid()::text = (storage.foldername(name))[1]
  );
