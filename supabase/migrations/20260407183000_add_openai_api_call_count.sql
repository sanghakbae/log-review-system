alter table public.policy_revision_decisions
  add column if not exists openai_api_call_count integer not null default 0;
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
  rd.human_review_required,
  rd.openai_api_call_count as revision_openai_api_call_count
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
  rd.human_review_required,
  rd.openai_api_call_count as revision_openai_api_call_count
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
