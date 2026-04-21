# Log Review System

React + Vite + Supabase로 만든 로그 검토 시스템입니다.  
요청자가 로그 파일과 검토 설명을 올리면, 검토자가 AI 보조 안내와 함께 결과를 정리하고, 결과 로그와 권한 설정까지 한 화면 흐름으로 이어지도록 구성되어 있습니다.

## 주요 기능

- 좌측 네비게이션 기반 대시보드
- 검토 요청 작성 화면
- 검토 결과 요약 화면
- 결과 로그 목록 화면
- 권한 및 사용자 설정 화면
- Google OAuth 로그인 연동
- Supabase Storage 업로드
- OpenAI 기반 검토 안내 생성
- 역할 기반 메뉴 접근 제어
- 로그 파일 미리보기와 텍스트 기반 분석

## 화면 구성

- `대시보드`
  - 전체 현황 진입점
  - 서비스별 상태와 작업 흐름을 확인하는 시작 화면
- `검토 작성`
  - 요청 제목, 요청자, 서비스명 입력
  - `.log`, `.csv`, `.json`, `.xlsx` 계열 파일 업로드
  - 업로드 파일의 텍스트 미리보기 사용
- `검토 결과`
  - OpenAI 응답을 Markdown 표 형태로 표시
  - `항목 | 내용 | 판단 | 근거 | 조치` 구조를 파싱해서 렌더링
- `결과 로그`
  - 요청일, 완료일, 서비스, 요청자, 검토자, 결과를 확인
  - 상태 변경 이력과 검토 기록을 추적
- `설정`
  - 회원명, 유닛명, 이메일, 권한, 접근 메뉴를 관리
  - 역할별 접근 가능 메뉴를 제어

## 동작 방식

1. 사용자가 검토 요청을 생성하고 파일을 업로드합니다.
2. 업로드된 텍스트 파일은 앞부분을 추출해 미리보기로 사용합니다.
3. OpenAI가 요청 정보와 파일 내용을 바탕으로 검토 안내를 생성합니다.
4. 결과는 Markdown 표로 정규화되어 검토 결과 화면에 표시됩니다.
5. 요청과 결과는 Supabase 백엔드와 Storage에 저장됩니다.

## 로컬 실행

```bash
npm install
npm run dev
```

기본 개발 서버는 `http://127.0.0.1:5173/` 또는 `http://localhost:5173/`에서 열 수 있습니다.

### 빌드 확인

```bash
npm run build
```

### 미리보기 실행

```bash
npm run preview
```

## 환경 변수

프로젝트 루트에는 보통 다음 두 파일을 사용합니다.

- `.env.example`
  - 필요한 키 목록을 보여주는 예시 파일
  - 새 환경을 만들 때 복사해 참고하는 용도
- `.env.local`
  - 실제 로컬 개발 값이 들어가는 파일
  - 이 저장소에서는 개발 시 이 파일을 사용합니다

`.env.local` 파일에 아래 값을 설정합니다.

```bash
VITE_SUPABASE_URL=https://your-project-ref.supabase.co
VITE_SUPABASE_ANON_KEY=your-supabase-anon-key
OPENAI_API_KEY=your-openai-api-key
OPENAI_MODEL=gpt-4o-mini
LLM_PROVIDER=openai
```

### 변수 설명

- `VITE_SUPABASE_URL`
  - Supabase 프로젝트 URL
- `VITE_SUPABASE_ANON_KEY`
  - Supabase 공개 anon key
- `OPENAI_API_KEY`
  - 검토 안내 생성을 위한 OpenAI API 키
- `OPENAI_MODEL`
  - 사용할 모델 이름
  - 기본값은 `gpt-4o-mini`
- `LLM_PROVIDER`
  - 현재는 `openai`일 때만 AI 기능이 활성화됨

환경 변수가 없으면 앱은 렌더링되지만, Supabase 로그인과 OpenAI 검토 안내 생성은 비활성화됩니다.

## Supabase 설정

Supabase 초기화와 정책은 `supabase/migrations` 아래의 마이그레이션을 기준으로 적용합니다.

권장 순서는 다음과 같습니다.

1. `supabase/migrations/20260413100000_init.sql`
2. `supabase/migrations/20260413120000_allow_profile_insert.sql`
3. `supabase/migrations/20260413130000_create_review_uploads_bucket.sql`
4. `supabase/migrations/20260413131000_add_review_prompt_text_to_profiles.sql`
5. `supabase/migrations/20260413132000_add_review_prompt_slots_to_profiles.sql`

추가로 다음 항목을 확인합니다.

- Supabase Auth에서 Google provider 활성화
- Vite 앱 origin을 Redirect URL로 등록
- Storage 버킷 `review-uploads` 사용 가능 여부 확인
- RLS 정책이 프로필, 요청, 첨부, 결과, 로그 테이블에 적용되었는지 확인

### Google Chat 웹훅 릴레이

브라우저에서 Google Chat 웹훅으로 직접 POST하면 CORS 정책 때문에 실패할 수 있습니다. 운영 환경에서는 Supabase Edge Function 릴레이를 배포합니다.

```bash
supabase functions deploy google-chat-webhook
```

앱은 로컬 개발 중에는 Vite dev 서버의 `/api/google-chat-webhook` 릴레이를 먼저 사용하고, 운영 배포에서는 Supabase Edge Function `google-chat-webhook`을 사용합니다.

### 빠른 확인 쿼리

```sql
select id, email, full_name, role, created_at, updated_at
from public.lr_profiles
order by created_at desc;
```

프로필이 정상적으로 생성되면 로그인 후 몇 초 안에 `public.lr_profiles`에서 확인할 수 있습니다.

## Google OAuth

Google OAuth를 사용하려면 Supabase Auth와 Google Cloud Console을 둘 다 설정해야 합니다.

1. Supabase 프로젝트를 생성합니다.
2. `Authentication > Providers > Google`에서 Google provider를 활성화합니다.
3. Google Cloud Console의 OAuth 클라이언트에 제공된 Client ID를 등록합니다.
4. Supabase가 보여주는 Redirect URL을 Google Cloud Console의 승인된 리디렉션 URI에 추가합니다.
5. Supabase `Authentication > URL Configuration`에 로컬 개발 주소를 추가합니다.
   - `http://localhost:5173`
6. `.env.local`에 Supabase URL과 anon key를 넣습니다.
7. 개발 서버를 다시 시작합니다.

설정이 없더라도 UI는 동작하지만, 로그인 버튼과 데이터 연동 기능은 제한됩니다.

## 저장 데이터

- 검토 요청 정보
- 요청자와 서비스 정보
- 첨부 파일 요약
- 검토 결과 텍스트
- 결과 로그
- 사용자 프로필과 권한
- 사용자별 검토 프롬프트 설정

## 개발 메모

- 파일 미리보기는 텍스트, `.log`, `.csv`, `.json` 위주로 처리합니다. `.xlsx`는 업로드만 지원합니다.
- AI 응답은 Markdown 표 하나만 반환하도록 유도합니다.
- 날짜가 들어간 결과는 달력 기준 요일을 기준으로 검증합니다.
- 역할별 접근 메뉴는 `requester`, `reviewer`, `admin` 기준으로 분기됩니다.

## 문제 해결

- `VITE_SUPABASE_URL` 또는 `VITE_SUPABASE_ANON_KEY`가 없으면 Supabase 기능이 비활성화됩니다.
- `OPENAI_API_KEY` 또는 `LLM_PROVIDER=openai`가 없으면 AI 검토 안내가 동작하지 않습니다.
- 개발 서버가 포트를 바인딩하지 못하면 `127.0.0.1`로 명시해서 다시 실행합니다.

```bash
npm run dev -- --host 127.0.0.1 --port 5173
```

## GitHub Pages 배포

이 저장소에는 `main` 브랜치 푸시 시 동작하는 GitHub Actions 워크플로우가 포함되어 있습니다.

- 워크플로우 파일: `.github/workflows/deploy.yml`
- 정적 빌드 결과물: `dist`
- 배포 대상: GitHub Pages

배포 전에 GitHub repository secrets에 아래 값을 등록합니다.

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`
- `OPENAI_API_KEY`
- `OPENAI_MODEL`
- `LLM_PROVIDER`

워크플로우는 이 값을 빌드 시점에 주입해서 배포합니다. 값이 없으면 앱은 열리지만 Supabase 및 OpenAI 연동 기능은 비활성화됩니다.

## 다음 작업 후보

- 파일 업로드 흐름의 세부 UX 개선
- 결과 로그 필터와 검색 추가
- 관리자 권한 편집 화면 고도화
- 검토 템플릿 프롬프트 관리 기능 확장
