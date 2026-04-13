create type public.match_type as enum ('STRUCTURAL_EXACT', 'STRUCTURAL_FALLBACK', 'UNMATCHED');
create type public.diff_type as enum ('ADDITION', 'DELETION', 'MODIFICATION');
create type public.revision_status as enum ('REQUIRED', 'RECOMMENDED', 'NOT_REQUIRED', 'LOW_CONFIDENCE_REVIEW');
create table public.law_sources (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces (id) on delete set null,
  owner_user_id uuid not null references auth.users (id) on delete restrict,
  source_link text not null,
  source_title text,
  retrieval_timestamp timestamptz not null default now(),
  version_effective_date date,
  created_at timestamptz not null default now()
);
create table public.law_versions (
  id uuid primary key default gen_random_uuid(),
  law_source_id uuid not null references public.law_sources (id) on delete cascade,
  version_label text,
  effective_date date,
  raw_text text not null,
  parse_warnings jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);
create table public.law_sections (
  id uuid primary key default gen_random_uuid(),
  law_version_id uuid not null references public.law_versions (id) on delete cascade,
  parent_section_id uuid references public.law_sections (id) on delete set null,
  hierarchy_type public.hierarchy_type not null,
  hierarchy_label text not null,
  hierarchy_order integer not null,
  normalized_text text not null,
  original_text text not null,
  text_hash text not null,
  path_display text not null default '',
  created_at timestamptz not null default now()
);
create table public.comparison_runs (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid not null references auth.users (id) on delete restrict,
  source_document_version_id uuid not null references public.document_versions (id) on delete cascade,
  target_law_version_id uuid not null references public.law_versions (id) on delete cascade,
  warning_messages jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);
create table public.comparison_results (
  id uuid primary key default gen_random_uuid(),
  comparison_run_id uuid not null references public.comparison_runs (id) on delete cascade,
  source_section_id uuid references public.document_sections (id) on delete set null,
  target_section_id uuid references public.law_sections (id) on delete set null,
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
create table public.revision_decisions (
  id uuid primary key default gen_random_uuid(),
  comparison_run_id uuid not null references public.comparison_runs (id) on delete cascade,
  status public.revision_status not null,
  rationale text not null,
  confidence numeric(4, 3) not null check (confidence >= 0 and confidence <= 1),
  ai_used boolean not null default false,
  human_review_required boolean not null default false,
  created_at timestamptz not null default now()
);
alter table public.law_sources enable row level security;
alter table public.law_versions enable row level security;
alter table public.law_sections enable row level security;
alter table public.comparison_runs enable row level security;
alter table public.comparison_results enable row level security;
alter table public.revision_decisions enable row level security;
create policy "owners can create law sources"
  on public.law_sources
  for insert
  with check (owner_user_id = auth.uid());
create policy "owners can read law sources"
  on public.law_sources
  for select
  using (owner_user_id = auth.uid());
create policy "owners can create law versions"
  on public.law_versions
  for insert
  with check (
    exists (
      select 1
      from public.law_sources ls
      where ls.id = law_versions.law_source_id
        and ls.owner_user_id = auth.uid()
    )
  );
create policy "owners can read law versions"
  on public.law_versions
  for select
  using (
    exists (
      select 1
      from public.law_sources ls
      where ls.id = law_versions.law_source_id
        and ls.owner_user_id = auth.uid()
    )
  );
create policy "owners can create law sections"
  on public.law_sections
  for insert
  with check (
    exists (
      select 1
      from public.law_versions lv
      join public.law_sources ls on ls.id = lv.law_source_id
      where lv.id = law_sections.law_version_id
        and ls.owner_user_id = auth.uid()
    )
  );
create policy "owners can read law sections"
  on public.law_sections
  for select
  using (
    exists (
      select 1
      from public.law_versions lv
      join public.law_sources ls on ls.id = lv.law_source_id
      where lv.id = law_sections.law_version_id
        and ls.owner_user_id = auth.uid()
    )
  );
create policy "actors can create comparison runs"
  on public.comparison_runs
  for insert
  with check (actor_user_id = auth.uid());
create policy "actors can read comparison runs"
  on public.comparison_runs
  for select
  using (actor_user_id = auth.uid());
create policy "actors can create comparison results"
  on public.comparison_results
  for insert
  with check (
    exists (
      select 1
      from public.comparison_runs cr
      where cr.id = comparison_results.comparison_run_id
        and cr.actor_user_id = auth.uid()
    )
  );
create policy "actors can read comparison results"
  on public.comparison_results
  for select
  using (
    exists (
      select 1
      from public.comparison_runs cr
      where cr.id = comparison_results.comparison_run_id
        and cr.actor_user_id = auth.uid()
    )
  );
create policy "actors can create revision decisions"
  on public.revision_decisions
  for insert
  with check (
    exists (
      select 1
      from public.comparison_runs cr
      where cr.id = revision_decisions.comparison_run_id
        and cr.actor_user_id = auth.uid()
    )
  );
create policy "actors can read revision decisions"
  on public.revision_decisions
  for select
  using (
    exists (
      select 1
      from public.comparison_runs cr
      where cr.id = revision_decisions.comparison_run_id
        and cr.actor_user_id = auth.uid()
    )
  );
