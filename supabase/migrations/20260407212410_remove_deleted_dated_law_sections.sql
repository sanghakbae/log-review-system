delete from public.policy_law_sections
where original_text ~ '삭제'
  and original_text ~ '[12][0-9]{3}\s*\.\s*[0-9]{1,2}\s*\.\s*[0-9]{1,2}\.?';
