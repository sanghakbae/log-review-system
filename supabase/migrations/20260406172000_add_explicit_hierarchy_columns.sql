alter table public.policy_document_sections
  add column if not exists chapter_label text,
  add column if not exists chapter_text text,
  add column if not exists article_label text,
  add column if not exists article_text text,
  add column if not exists paragraph_label text,
  add column if not exists paragraph_text text,
  add column if not exists item_label text,
  add column if not exists item_text text,
  add column if not exists sub_item_label text,
  add column if not exists sub_item_text text;
alter table public.policy_law_sections
  add column if not exists chapter_label text,
  add column if not exists chapter_text text,
  add column if not exists article_label text,
  add column if not exists article_text text,
  add column if not exists paragraph_label text,
  add column if not exists paragraph_text text,
  add column if not exists item_label text,
  add column if not exists item_text text,
  add column if not exists sub_item_label text,
  add column if not exists sub_item_text text;
with recursive policy_document_lineage as (
  select
    ds.id,
    ds.parent_section_id,
    ds.hierarchy_type,
    ds.hierarchy_label,
    ds.original_text,
    case when ds.hierarchy_type = 'chapter' then ds.hierarchy_label end as chapter_label,
    case when ds.hierarchy_type = 'chapter' then ds.original_text end as chapter_text,
    case when ds.hierarchy_type = 'article' then ds.hierarchy_label end as article_label,
    case when ds.hierarchy_type = 'article' then ds.original_text end as article_text,
    case when ds.hierarchy_type = 'paragraph' then ds.hierarchy_label end as paragraph_label,
    case when ds.hierarchy_type = 'paragraph' then ds.original_text end as paragraph_text,
    case when ds.hierarchy_type = 'item' then ds.hierarchy_label end as item_label,
    case when ds.hierarchy_type = 'item' then ds.original_text end as item_text,
    case when ds.hierarchy_type = 'sub_item' then ds.hierarchy_label end as sub_item_label,
    case when ds.hierarchy_type = 'sub_item' then ds.original_text end as sub_item_text
  from public.policy_document_sections ds
  where ds.parent_section_id is null
     or not exists (
      select 1
      from public.policy_document_sections parent_ds
      where parent_ds.id = ds.parent_section_id
    )

  union all

  select
    child.id,
    child.parent_section_id,
    child.hierarchy_type,
    child.hierarchy_label,
    child.original_text,
    case when child.hierarchy_type = 'chapter' then child.hierarchy_label else parent.chapter_label end,
    case when child.hierarchy_type = 'chapter' then child.original_text else parent.chapter_text end,
    case when child.hierarchy_type = 'article' then child.hierarchy_label else parent.article_label end,
    case when child.hierarchy_type = 'article' then child.original_text else parent.article_text end,
    case when child.hierarchy_type = 'paragraph' then child.hierarchy_label else parent.paragraph_label end,
    case when child.hierarchy_type = 'paragraph' then child.original_text else parent.paragraph_text end,
    case when child.hierarchy_type = 'item' then child.hierarchy_label else parent.item_label end,
    case when child.hierarchy_type = 'item' then child.original_text else parent.item_text end,
    case when child.hierarchy_type = 'sub_item' then child.hierarchy_label else parent.sub_item_label end,
    case when child.hierarchy_type = 'sub_item' then child.original_text else parent.sub_item_text end
  from public.policy_document_sections child
  join policy_document_lineage parent on parent.id = child.parent_section_id
)
update public.policy_document_sections target
set
  chapter_label = lineage.chapter_label,
  chapter_text = lineage.chapter_text,
  article_label = lineage.article_label,
  article_text = lineage.article_text,
  paragraph_label = lineage.paragraph_label,
  paragraph_text = lineage.paragraph_text,
  item_label = lineage.item_label,
  item_text = lineage.item_text,
  sub_item_label = lineage.sub_item_label,
  sub_item_text = lineage.sub_item_text
from policy_document_lineage lineage
where target.id = lineage.id;
with recursive policy_law_lineage as (
  select
    ds.id,
    ds.parent_section_id,
    ds.hierarchy_type,
    ds.hierarchy_label,
    ds.original_text,
    case when ds.hierarchy_type = 'chapter' then ds.hierarchy_label end as chapter_label,
    case when ds.hierarchy_type = 'chapter' then ds.original_text end as chapter_text,
    case when ds.hierarchy_type = 'article' then ds.hierarchy_label end as article_label,
    case when ds.hierarchy_type = 'article' then ds.original_text end as article_text,
    case when ds.hierarchy_type = 'paragraph' then ds.hierarchy_label end as paragraph_label,
    case when ds.hierarchy_type = 'paragraph' then ds.original_text end as paragraph_text,
    case when ds.hierarchy_type = 'item' then ds.hierarchy_label end as item_label,
    case when ds.hierarchy_type = 'item' then ds.original_text end as item_text,
    case when ds.hierarchy_type = 'sub_item' then ds.hierarchy_label end as sub_item_label,
    case when ds.hierarchy_type = 'sub_item' then ds.original_text end as sub_item_text
  from public.policy_law_sections ds
  where ds.parent_section_id is null
     or not exists (
      select 1
      from public.policy_law_sections parent_ds
      where parent_ds.id = ds.parent_section_id
    )

  union all

  select
    child.id,
    child.parent_section_id,
    child.hierarchy_type,
    child.hierarchy_label,
    child.original_text,
    case when child.hierarchy_type = 'chapter' then child.hierarchy_label else parent.chapter_label end,
    case when child.hierarchy_type = 'chapter' then child.original_text else parent.chapter_text end,
    case when child.hierarchy_type = 'article' then child.hierarchy_label else parent.article_label end,
    case when child.hierarchy_type = 'article' then child.original_text else parent.article_text end,
    case when child.hierarchy_type = 'paragraph' then child.hierarchy_label else parent.paragraph_label end,
    case when child.hierarchy_type = 'paragraph' then child.original_text else parent.paragraph_text end,
    case when child.hierarchy_type = 'item' then child.hierarchy_label else parent.item_label end,
    case when child.hierarchy_type = 'item' then child.original_text else parent.item_text end,
    case when child.hierarchy_type = 'sub_item' then child.hierarchy_label else parent.sub_item_label end,
    case when child.hierarchy_type = 'sub_item' then child.original_text else parent.sub_item_text end
  from public.policy_law_sections child
  join policy_law_lineage parent on parent.id = child.parent_section_id
)
update public.policy_law_sections target
set
  chapter_label = lineage.chapter_label,
  chapter_text = lineage.chapter_text,
  article_label = lineage.article_label,
  article_text = lineage.article_text,
  paragraph_label = lineage.paragraph_label,
  paragraph_text = lineage.paragraph_text,
  item_label = lineage.item_label,
  item_text = lineage.item_text,
  sub_item_label = lineage.sub_item_label,
  sub_item_text = lineage.sub_item_text
from policy_law_lineage lineage
where target.id = lineage.id;
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
          'path_display', ds.path_display,
          'chapter_label', ds.chapter_label,
          'chapter_text', ds.chapter_text,
          'article_label', ds.article_label,
          'article_text', ds.article_text,
          'paragraph_label', ds.paragraph_label,
          'paragraph_text', ds.paragraph_text,
          'item_label', ds.item_label,
          'item_text', ds.item_text,
          'sub_item_label', ds.sub_item_label,
          'sub_item_text', ds.sub_item_text
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
grant select on public.policy_document_details to authenticated;
