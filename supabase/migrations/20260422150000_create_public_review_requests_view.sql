create or replace view public.lr_public_review_requests as
select
  id,
  title,
  requester_name,
  status,
  request_created_at,
  created_at,
  coalesce(request_body::jsonb ->> 'serviceName', '') as service_name,
  coalesce(jsonb_array_length(coalesce(request_body::jsonb -> 'logFiles', '[]'::jsonb)), 0) as log_file_count
from public.lr_review_requests;

grant select on public.lr_public_review_requests to anon, authenticated;
