delete from public.policy_law_sections pls
using public.policy_law_versions plv
join public.policy_law_sources pls2 on pls2.id = plv.law_source_id
where pls.law_version_id = plv.id
  and pls2.source_title = '정보통신망 이용촉진 및 정보보호 등에 관한 법률'
  and pls.original_text ~ '삭제'
  and pls.original_text ~ '.*[12][0-9]{3}\s*\.\s*[0-9]{1,2}\s*\.\s*[0-9]{1,2}\.?';
