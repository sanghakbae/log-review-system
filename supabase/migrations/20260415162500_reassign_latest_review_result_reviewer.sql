with target_reviewer as (
  select id
  from public.lr_profiles
  where full_name = '배상학'
    and unit_name = '정보보호'
  limit 1
),
source_reviewer as (
  select id
  from public.lr_profiles
  where full_name = '엔돌핀'
  limit 1
),
latest_result as (
  select r.id
  from public.lr_review_results r
  join source_reviewer s on s.id = r.reviewer_id
  order by r.created_at desc
  limit 1
)
update public.lr_review_results r
set reviewer_id = t.id,
    updated_at = now()
from target_reviewer t
join latest_result lr on true
where r.id = lr.id;
