# Log Review System

React + Vite 프론트와 Supabase 백엔드로 구성된 로그 검토 시스템의 초기 뼈대입니다.

## 포함된 기능

- 좌측 대시보드 네비게이션
- 검토 작성 화면
- 검토 결과 화면
- 결과 로그 화면
- 권한 설정 화면
- Google OAuth 로그인
- Supabase 스키마와 RLS 정책

## 실행

```bash
npm install
npm run dev
```

## 환경 변수

```bash
VITE_SUPABASE_URL=
VITE_SUPABASE_ANON_KEY=
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4o-mini
LLM_PROVIDER=
```

`.env.local` 파일을 만들고 위 값을 채워야 Google OAuth 로그인과 OpenAI 검토 안내 생성이 동작합니다.

## Google OAuth 연결

1. Supabase 프로젝트를 생성합니다.
2. `Authentication > Providers > Google`에서 Google provider를 활성화합니다.
3. Google Cloud Console의 OAuth 클라이언트에 아래 Client ID를 사용합니다.

```text
924920443826-k59m97pgabmdb42qv9cq63plmuuvvn7s.apps.googleusercontent.com
```

4. Supabase가 보여주는 Redirect URL을 Google Cloud Console의 OAuth 클라이언트 `승인된 리디렉션 URI`에 등록합니다.
5. 로컬 개발용 주소를 Supabase `Authentication > URL Configuration`에 추가합니다.
   - `http://localhost:5173`
6. 프로젝트 루트에 `.env.local`을 만들고 아래 값을 넣습니다.

```bash
VITE_SUPABASE_URL=https://your-project-ref.supabase.co
VITE_SUPABASE_ANON_KEY=your-supabase-anon-key
```

7. 개발 서버를 다시 실행합니다.

```bash
npm run dev
```

설정이 없으면 앱은 렌더링되지만, Google 로그인 버튼은 비활성화됩니다.

## 다음 단계

- 파일 업로드를 Supabase Storage에 연결
- 검토 요청/결과 CRUD를 실제 테이블에 바인딩
- 관리자용 권한 관리 UI 추가
- 결과 로그 필터와 검색 추가
