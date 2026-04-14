alter table public.lr_profiles
add column if not exists google_chat_webhook_url text;

delete from public.lr_review_requests
where title in (
  '1월 웹 서비스 로그 검토 요청 드립니다.',
  '1월 웹 서비스 로그 검토 부탁드립니다.'
)
or (
  title like '1월 웹 서비스 로그 검토%'
  and requester_name = '이종범 / 인프라'
);
