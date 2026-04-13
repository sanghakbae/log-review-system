create extension if not exists "pgcrypto";
do $$
begin
  if not exists (select 1 from pg_type where typname = 'document_type') then
    create type public.document_type as enum ('POLICY', 'GUIDELINE');
  end if;

  if not exists (select 1 from pg_type where typname = 'hierarchy_type') then
    create type public.hierarchy_type as enum ('document', 'chapter', 'article', 'paragraph', 'item', 'sub_item');
  end if;

  if not exists (select 1 from pg_type where typname = 'audit_result') then
    create type public.audit_result as enum ('SUCCESS', 'FAILURE');
  end if;

  if not exists (select 1 from pg_type where typname = 'match_type') then
    create type public.match_type as enum ('STRUCTURAL_EXACT', 'STRUCTURAL_FALLBACK', 'UNMATCHED');
  end if;

  if not exists (select 1 from pg_type where typname = 'diff_type') then
    create type public.diff_type as enum ('ADDITION', 'DELETION', 'MODIFICATION');
  end if;

  if not exists (select 1 from pg_type where typname = 'revision_status') then
    create type public.revision_status as enum ('REQUIRED', 'RECOMMENDED', 'NOT_REQUIRED', 'LOW_CONFIDENCE_REVIEW');
  end if;
end
$$;
create table if not exists public.policy_workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  owner_user_id uuid not null references auth.users (id) on delete restrict,
  created_at timestamptz not null default now()
);
create table if not exists public.policy_workspace_members (
  workspace_id uuid not null references public.policy_workspaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('owner', 'member')),
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create table if not exists public.policy_documents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.policy_workspaces (id) on delete set null,
  owner_user_id uuid not null references auth.users (id) on delete restrict,
  title text not null,
  description text,
  document_type public.document_type not null,
  source_storage_path text not null,
  source_file_name text not null,
  created_at timestamptz not null default now()
);
create table if not exists public.policy_document_versions (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.policy_documents (id) on delete cascade,
  version_number integer not null,
  raw_text text not null,
  parse_warnings jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  unique (document_id, version_number)
);
create table if not exists public.policy_document_sections (
  id uuid primary key default gen_random_uuid(),
  document_version_id uuid not null references public.policy_document_versions (id) on delete cascade,
  parent_section_id uuid references public.policy_document_sections (id) on delete set null,
  hierarchy_type public.hierarchy_type not null,
  hierarchy_label text not null,
  hierarchy_order integer not null,
  normalized_text text not null,
  original_text text not null,
  text_hash text not null,
  path_display text not null default '',
  created_at timestamptz not null default now()
);
create table if not exists public.policy_law_sources (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.policy_workspaces (id) on delete set null,
  owner_user_id uuid not null references auth.users (id) on delete restrict,
  source_link text not null,
  source_title text,
  retrieval_timestamp timestamptz not null default now(),
  version_effective_date date,
  created_at timestamptz not null default now()
);
create table if not exists public.policy_law_versions (
  id uuid primary key default gen_random_uuid(),
  law_source_id uuid not null references public.policy_law_sources (id) on delete cascade,
  version_label text,
  effective_date date,
  raw_text text not null,
  parse_warnings jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);
create table if not exists public.policy_law_sections (
  id uuid primary key default gen_random_uuid(),
  law_version_id uuid not null references public.policy_law_versions (id) on delete cascade,
  parent_section_id uuid references public.policy_law_sections (id) on delete set null,
  hierarchy_type public.hierarchy_type not null,
  hierarchy_label text not null,
  hierarchy_order integer not null,
  normalized_text text not null,
  original_text text not null,
  text_hash text not null,
  path_display text not null default '',
  created_at timestamptz not null default now()
);
create table if not exists public.policy_comparison_runs (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid not null references auth.users (id) on delete restrict,
  source_document_version_id uuid not null references public.policy_document_versions (id) on delete cascade,
  target_law_version_id uuid not null references public.policy_law_versions (id) on delete cascade,
  warning_messages jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);
create table if not exists public.policy_comparison_results (
  id uuid primary key default gen_random_uuid(),
  comparison_run_id uuid not null references public.policy_comparison_runs (id) on delete cascade,
  source_section_id uuid references public.policy_document_sections (id) on delete set null,
  target_section_id uuid references public.policy_law_sections (id) on delete set null,
  affected_path text not null,
  hierarchy_type public.hierarchy_type not null,
  match_type public.match_type not null,
  diff_type public.diff_type not null,
  confidence numeric(4, 3) not null check (confidence >= 0 and confidence <= 1),
  before_text text not null,
  after_text text not null,
  explanation text not null,
  reasoning_trace jsonb not null default '[]'::jsonb,
  ai_used boolean not null default false,
  created_at timestamptz not null default now()
);
create table if not exists public.policy_revision_decisions (
  id uuid primary key default gen_random_uuid(),
  comparison_run_id uuid not null references public.policy_comparison_runs (id) on delete cascade,
  status public.revision_status not null,
  rationale text not null,
  confidence numeric(4, 3) not null check (confidence >= 0 and confidence <= 1),
  ai_used boolean not null default false,
  human_review_required boolean not null default false,
  model_name text,
  request_purpose text,
  output_used_in_recommendation boolean not null default false,
  created_at timestamptz not null default now()
);
create table if not exists public.policy_audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid not null references auth.users (id) on delete restrict,
  action text not null,
  target_document_id uuid references public.policy_documents (id) on delete set null,
  result public.audit_result not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create or replace view public.policy_document_latest_versions as
select
  d.id,
  d.title,
  d.document_type,
  dv.version_number,
  dv.created_at,
  (
    select count(*)
    from public.policy_document_sections ds
    where ds.document_version_id = dv.id
  ) as section_count
from public.policy_documents d
join lateral (
  select *
  from public.policy_document_versions dv_inner
  where dv_inner.document_id = d.id
  order by dv_inner.version_number desc
  limit 1
) dv on true;
create or replace view public.policy_document_details as
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
      from public.policy_document_sections ds
      where ds.document_version_id = dv.id
    ),
    '[]'::jsonb
  ) as sections
from public.policy_documents d
join lateral (
  select *
  from public.policy_document_versions dv_inner
  where dv_inner.document_id = d.id
  order by dv_inner.version_number desc
  limit 1
) dv on true;
create or replace view public.policy_comparison_review_overview as
select
  cr.id,
  cr.created_at,
  d.title as policy_title,
  dv.version_number as policy_version_number,
  coalesce(ls.source_title, 'Law Source') as law_title,
  lv.version_label as law_version_label,
  lv.effective_date as law_effective_date,
  (
    select count(*)
    from public.policy_comparison_results cmp_result
    where cmp_result.comparison_run_id = cr.id
  ) as diff_count,
  rd.status as revision_status,
  rd.confidence as revision_confidence,
  rd.ai_used as revision_ai_used,
  rd.human_review_required
from public.policy_comparison_runs cr
join public.policy_document_versions dv on dv.id = cr.source_document_version_id
join public.policy_documents d on d.id = dv.document_id
join public.policy_law_versions lv on lv.id = cr.target_law_version_id
join public.policy_law_sources ls on ls.id = lv.law_source_id
left join lateral (
  select *
  from public.policy_revision_decisions rd_inner
  where rd_inner.comparison_run_id = cr.id
  order by rd_inner.created_at desc
  limit 1
) rd on true;
create or replace view public.policy_comparison_review_detail as
select
  cr.id,
  cr.created_at,
  cr.warning_messages,
  d.title as policy_title,
  dv.version_number as policy_version_number,
  dv.raw_text as policy_raw_text,
  coalesce(ls.source_title, 'Law Source') as law_title,
  lv.version_label as law_version_label,
  lv.effective_date as law_effective_date,
  lv.raw_text as law_raw_text,
  rd.id as revision_decision_id,
  rd.status as revision_status,
  rd.rationale as revision_rationale,
  rd.confidence as revision_confidence,
  rd.ai_used as revision_ai_used,
  rd.human_review_required
from public.policy_comparison_runs cr
join public.policy_document_versions dv on dv.id = cr.source_document_version_id
join public.policy_documents d on d.id = dv.document_id
join public.policy_law_versions lv on lv.id = cr.target_law_version_id
join public.policy_law_sources ls on ls.id = lv.law_source_id
left join lateral (
  select *
  from public.policy_revision_decisions rd_inner
  where rd_inner.comparison_run_id = cr.id
  order by rd_inner.created_at desc
  limit 1
) rd on true;
alter table public.policy_workspaces enable row level security;
alter table public.policy_workspace_members enable row level security;
alter table public.policy_documents enable row level security;
alter table public.policy_document_versions enable row level security;
alter table public.policy_document_sections enable row level security;
alter table public.policy_law_sources enable row level security;
alter table public.policy_law_versions enable row level security;
alter table public.policy_law_sections enable row level security;
alter table public.policy_comparison_runs enable row level security;
alter table public.policy_comparison_results enable row level security;
alter table public.policy_revision_decisions enable row level security;
alter table public.policy_audit_logs enable row level security;
drop policy if exists "policy workspace members can read workspaces" on public.policy_workspaces;
create policy "policy workspace members can read workspaces"
  on public.policy_workspaces
  for select
  using (
    exists (
      select 1
      from public.policy_workspace_members wm
      where wm.workspace_id = policy_workspaces.id
        and wm.user_id = auth.uid()
    )
  );
drop policy if exists "policy workspace members can read memberships" on public.policy_workspace_members;
create policy "policy workspace members can read memberships"
  on public.policy_workspace_members
  for select
  using (user_id = auth.uid());
drop policy if exists "policy owners can create documents" on public.policy_documents;
create policy "policy owners can create documents"
  on public.policy_documents
  for insert
  with check (owner_user_id = auth.uid());
drop policy if exists "policy owners and members can read documents" on public.policy_documents;
create policy "policy owners and members can read documents"
  on public.policy_documents
  for select
  using (
    owner_user_id = auth.uid()
    or exists (
      select 1
      from public.policy_workspace_members wm
      where wm.workspace_id = policy_documents.workspace_id
        and wm.user_id = auth.uid()
    )
  );
drop policy if exists "policy owners can read versions" on public.policy_document_versions;
create policy "policy owners can read versions"
  on public.policy_document_versions
  for select
  using (
    exists (
      select 1
      from public.policy_documents d
      where d.id = policy_document_versions.document_id
        and d.owner_user_id = auth.uid()
    )
  );
drop policy if exists "policy owners can create versions" on public.policy_document_versions;
create policy "policy owners can create versions"
  on public.policy_document_versions
  for insert
  with check (
    exists (
      select 1
      from public.policy_documents d
      where d.id = policy_document_versions.document_id
        and d.owner_user_id = auth.uid()
    )
  );
drop policy if exists "policy owners can read sections" on public.policy_document_sections;
create policy "policy owners can read sections"
  on public.policy_document_sections
  for select
  using (
    exists (
      select 1
      from public.policy_document_versions dv
      join public.policy_documents d on d.id = dv.document_id
      where dv.id = policy_document_sections.document_version_id
        and d.owner_user_id = auth.uid()
    )
  );
drop policy if exists "policy owners can create sections" on public.policy_document_sections;
create policy "policy owners can create sections"
  on public.policy_document_sections
  for insert
  with check (
    exists (
      select 1
      from public.policy_document_versions dv
      join public.policy_documents d on d.id = dv.document_id
      where dv.id = policy_document_sections.document_version_id
        and d.owner_user_id = auth.uid()
    )
  );
drop policy if exists "policy owners can create law sources" on public.policy_law_sources;
create policy "policy owners can create law sources"
  on public.policy_law_sources
  for insert
  with check (owner_user_id = auth.uid());
drop policy if exists "policy owners can read law sources" on public.policy_law_sources;
create policy "policy owners can read law sources"
  on public.policy_law_sources
  for select
  using (owner_user_id = auth.uid());
drop policy if exists "policy owners can create law versions" on public.policy_law_versions;
create policy "policy owners can create law versions"
  on public.policy_law_versions
  for insert
  with check (
    exists (
      select 1
      from public.policy_law_sources ls
      where ls.id = policy_law_versions.law_source_id
        and ls.owner_user_id = auth.uid()
    )
  );
drop policy if exists "policy owners can read law versions" on public.policy_law_versions;
create policy "policy owners can read law versions"
  on public.policy_law_versions
  for select
  using (
    exists (
      select 1
      from public.policy_law_sources ls
      where ls.id = policy_law_versions.law_source_id
        and ls.owner_user_id = auth.uid()
    )
  );
drop policy if exists "policy owners can create law sections" on public.policy_law_sections;
create policy "policy owners can create law sections"
  on public.policy_law_sections
  for insert
  with check (
    exists (
      select 1
      from public.policy_law_versions lv
      join public.policy_law_sources ls on ls.id = lv.law_source_id
      where lv.id = policy_law_sections.law_version_id
        and ls.owner_user_id = auth.uid()
    )
  );
drop policy if exists "policy owners can read law sections" on public.policy_law_sections;
create policy "policy owners can read law sections"
  on public.policy_law_sections
  for select
  using (
    exists (
      select 1
      from public.policy_law_versions lv
      join public.policy_law_sources ls on ls.id = lv.law_source_id
      where lv.id = policy_law_sections.law_version_id
        and ls.owner_user_id = auth.uid()
    )
  );
drop policy if exists "policy actors can create comparison runs" on public.policy_comparison_runs;
create policy "policy actors can create comparison runs"
  on public.policy_comparison_runs
  for insert
  with check (actor_user_id = auth.uid());
drop policy if exists "policy actors can read comparison runs" on public.policy_comparison_runs;
create policy "policy actors can read comparison runs"
  on public.policy_comparison_runs
  for select
  using (actor_user_id = auth.uid());
drop policy if exists "policy actors can create comparison results" on public.policy_comparison_results;
create policy "policy actors can create comparison results"
  on public.policy_comparison_results
  for insert
  with check (
    exists (
      select 1
      from public.policy_comparison_runs cr
      where cr.id = policy_comparison_results.comparison_run_id
        and cr.actor_user_id = auth.uid()
    )
  );
drop policy if exists "policy actors can read comparison results" on public.policy_comparison_results;
create policy "policy actors can read comparison results"
  on public.policy_comparison_results
  for select
  using (
    exists (
      select 1
      from public.policy_comparison_runs cr
      where cr.id = policy_comparison_results.comparison_run_id
        and cr.actor_user_id = auth.uid()
    )
  );
drop policy if exists "policy actors can create revision decisions" on public.policy_revision_decisions;
create policy "policy actors can create revision decisions"
  on public.policy_revision_decisions
  for insert
  with check (
    exists (
      select 1
      from public.policy_comparison_runs cr
      where cr.id = policy_revision_decisions.comparison_run_id
        and cr.actor_user_id = auth.uid()
    )
  );
drop policy if exists "policy actors can read revision decisions" on public.policy_revision_decisions;
create policy "policy actors can read revision decisions"
  on public.policy_revision_decisions
  for select
  using (
    exists (
      select 1
      from public.policy_comparison_runs cr
      where cr.id = policy_revision_decisions.comparison_run_id
        and cr.actor_user_id = auth.uid()
    )
  );
drop policy if exists "policy actors can read their audit logs" on public.policy_audit_logs;
create policy "policy actors can read their audit logs"
  on public.policy_audit_logs
  for select
  using (actor_user_id = auth.uid());
drop policy if exists "policy actors can create audit logs" on public.policy_audit_logs;
create policy "policy actors can create audit logs"
  on public.policy_audit_logs
  for insert
  with check (actor_user_id = auth.uid());
grant select on public.policy_document_latest_versions to authenticated;
grant select on public.policy_document_details to authenticated;
grant select on public.policy_comparison_review_overview to authenticated;
grant select on public.policy_comparison_review_detail to authenticated;
insert into storage.buckets (id, name, public)
values ('source-documents', 'source-documents', false)
on conflict (id) do nothing;
drop policy if exists "policy authenticated users upload their own source files" on storage.objects;
create policy "policy authenticated users upload their own source files"
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'source-documents'
    and auth.uid()::text = (storage.foldername(name))[1]
  );
drop policy if exists "policy authenticated users read their own source files" on storage.objects;
create policy "policy authenticated users read their own source files"
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'source-documents'
    and auth.uid()::text = (storage.foldername(name))[1]
  );
