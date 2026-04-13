drop view if exists public.comparison_review_detail;
drop view if exists public.comparison_review_overview;
alter view public.document_latest_versions rename to policy_document_latest_versions;
alter view public.document_details rename to policy_document_details;
alter table public.workspace_members rename to policy_workspace_members;
alter table public.workspaces rename to policy_workspaces;
alter table public.document_sections rename to policy_document_sections;
alter table public.document_versions rename to policy_document_versions;
alter table public.documents rename to policy_documents;
alter table public.audit_logs rename to policy_audit_logs;
alter table public.law_sections rename to policy_law_sections;
alter table public.law_versions rename to policy_law_versions;
alter table public.law_sources rename to policy_law_sources;
alter table public.comparison_results rename to policy_comparison_results;
alter table public.comparison_runs rename to policy_comparison_runs;
alter table public.revision_decisions rename to policy_revision_decisions;
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
grant select on public.policy_document_latest_versions to authenticated;
grant select on public.policy_document_details to authenticated;
grant select on public.policy_comparison_review_overview to authenticated;
grant select on public.policy_comparison_review_detail to authenticated;
