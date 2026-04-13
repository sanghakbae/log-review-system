# Supabase setup

1. Apply `supabase/migrations/20260413100000_init.sql`.
2. If the old tables already exist, the rename migration runs first because its timestamp is earlier than the init migration.
3. Apply `supabase/migrations/20260413120000_allow_profile_insert.sql` so logged-in users can sync their profile row automatically.
4. Apply `supabase/migrations/20260413130000_create_review_uploads_bucket.sql` so log files are stored in the `review-uploads` bucket.
5. Apply `supabase/migrations/20260413131000_add_review_prompt_text_to_profiles.sql`.
6. Apply `supabase/migrations/20260413132000_add_review_prompt_slots_to_profiles.sql`.
7. Enable Google provider in Supabase Auth.
8. Set redirect URL to your Vite app origin.
9. Add environment variables to the frontend:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`

## Quick checks

- 확인용 쿼리:

```sql
select id, email, full_name, role, created_at, updated_at
from public.lr_profiles
order by created_at desc;
```

- Supabase Dashboard에서는 `Table Editor`에서 `public.lr_profiles`를 먼저 확인하면 됩니다.
- 새로 생성된 계정은 로그인 후 몇 초 안에 `lr_profiles`에 나타나야 합니다.
- 로그인 후 프로필이 안 보이면 `Auth -> Users`와 `Table Editor -> public.lr_profiles`를 함께 확인하세요.
- 업로드된 로그 파일은 `Storage -> review-uploads`와 `public.lr_review_attachments`를 함께 확인하면 됩니다.

## Recommended workflow

- 요청자는 로그 파일과 검토 설명을 업로드한다.
- 검토자는 요청을 받아 결과 요약과 피드백을 저장한다.
- 결과 로그는 모든 상태 변경과 검토 히스토리를 기록한다.
- 권한 설정은 `lr_profiles.role` 값으로 제어한다.
- 사용자별 AI 프롬프트는 `lr_profiles.review_prompt_text`, `lr_profiles.review_prompt_slots`, `lr_profiles.review_prompt_selected_slot`에 저장한다.
- 현재 RLS는 프로필, 요청, 첨부, 결과, 로그에 필요한 읽기/쓰기 정책을 모두 포함한다.
