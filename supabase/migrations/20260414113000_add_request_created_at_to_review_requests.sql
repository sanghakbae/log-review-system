alter table public.lr_review_requests
add column if not exists request_created_at timestamptz;

update public.lr_review_requests
set request_created_at = coalesce(request_created_at, created_at)
where request_created_at is null;
