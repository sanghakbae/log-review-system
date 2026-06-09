# 이전 가이드 (log-review-system)

이 앱은 Supabase에서 다음 구성으로 이전됐다.

- **Firebase Auth + Firestore** — 인증 + 데이터 (`src/lib/firebase.ts`, export `backend`/`isBackendReady`)
- **Cloudflare R2 (Worker 경유)** — 업로드 파일 저장 (`workers/r2-files/`)
- 보안 규칙: `firestore.rules`, 인덱스: `firestore.indexes.json`
- 사용 도메인: **lrs.sanghak.kr**

앱 런타임에는 Supabase 의존성이 전혀 없다. `@supabase/supabase-js`는 일회성 이전
스크립트(`scripts/migrate-to-firebase.mjs`)에서만 쓰이는 devDependency다.

파일 흐름: 브라우저는 R2 자격증명을 갖지 않는다. Firebase ID 토큰으로 Worker를 호출하고,
Worker가 **R2 바인딩으로 파일 바이트를 직접 중계**한다(`PUT/GET /object`, `POST /list|/delete`).
R2 API 토큰·presigned URL·버킷 CORS가 전혀 필요 없다.

---

## 1. Firebase 콘솔 설정 (최초 1회)

프로젝트: `log-review-system` (생성됨)

1. **Authentication → Sign-in method → Google** 활성화.
2. **Authentication → Settings → Authorized domains** 에 추가:
   - `lrs.sanghak.kr` (운영 도메인 — 필수)
   - `localhost` (로컬, 보통 기본 포함)
   - `log-review-system.firebaseapp.com` (기본 포함)
   > 목록에 없는 도메인에서 띄우면 Google 팝업 로그인이 차단된다.
3. **Firestore Database** 생성 (region `asia-northeast3` 서울 권장, 프로덕션 모드).
   - Firebase Storage는 **사용하지 않는다** (파일은 R2).

## 2. Cloudflare R2 + Worker (`workers/r2-files/`) — 이미 배포됨

아래는 이미 완료된 상태다(재현/재배포 시 참고):

```bash
cd workers/r2-files
npm install
npx wrangler login
npx wrangler r2 bucket create log-review-uploads   # ✅ 생성됨
npx wrangler deploy                                 # ✅ https://lrs-r2-files.totoriverce.workers.dev
```

- **토큰/시크릿 불필요**: Worker가 R2 바인딩으로 바이트를 직접 중계하므로 R2 API 토큰,
  presigned URL, 버킷 CORS 설정이 전혀 필요 없다.
- Worker 인증: 모든 요청은 Firebase ID 토큰(Bearer)을 검증한다. 도메인이 바뀌면
  `wrangler.jsonc`의 `FIREBASE_PROJECT_ID`/`ALLOWED_ORIGINS`만 갱신 후 `npx wrangler deploy`.
- 로컬 개발은 `npx wrangler dev` (별도 시크릿 없음, 로컬 R2 시뮬레이션).

## 3. 환경 변수 (`.env.local`, 커밋 금지)

```
VITE_FIREBASE_API_KEY=...
VITE_FIREBASE_AUTH_DOMAIN=log-review-system.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=log-review-system
VITE_FIREBASE_MESSAGING_SENDER_ID=...
VITE_FIREBASE_APP_ID=...
VITE_R2_WORKER_URL=https://lrs-r2-files.<subdomain>.workers.dev
```

`VITE_FIREBASE_*` 는 공개되어도 안전한 클라이언트 키다(접근 제어는 보안 규칙/Worker가 담당).

## 4. 보안 규칙 배포

```bash
npx firebase deploy --only firestore:rules,firestore:indexes
```

- role 기반 접근 제어는 `lr_profiles/{uid}.role` (requester | reviewer | admin) 조회로 적용.
- `lr_review_requests`(요청 본문 포함)는 **로그인 사용자만** 읽기 가능.
- 로그아웃 공개 목록은 공개 필드만 담은 `lr_public_review_requests` 컬렉션에서 제공.
- ⚠️ `lr_ai_settings.openai_api_key`는 관리자 클라이언트가 읽는 현행 동작 유지(규칙으로 admin read 제한).
  키를 브라우저에 노출하지 않으려면 후속으로 서버 릴레이로 옮기는 것을 권장.

## 5. 데이터 이전 (Supabase → Firebase + R2)

일회성. Firebase 서비스 계정 키 + Supabase **service role 키** 필요. 파일 복사(storage 단계)는
이미 로그인된 `wrangler` CLI를 쓰므로 **R2 토큰 불필요**. 리포 루트에서 실행한다.

```bash
export SUPABASE_URL="https://gfybyxbrmkwbzuyhyqiv.supabase.co"
export SUPABASE_SERVICE_ROLE_KEY="<supabase service_role 키>"
export GOOGLE_APPLICATION_CREDENTIALS="./service-account.json"
# export R2_BUCKET_NAME="log-review-uploads"   # 기본값과 같으면 생략

node scripts/migrate-to-firebase.mjs --dry-run   # 건수만 확인 (쓰기 없음)
node scripts/migrate-to-firebase.mjs             # auth → data → R2 storage(wrangler)
```

핵심:
- **Auth uid 보존 임포트**가 먼저 실행된다. Supabase uid를 그대로 Firebase Auth에 심으므로
  `requester_id`/`reviewer_id` 등 FK 참조가 유효하게 유지된다. 대량 전 한 계정으로 Google 로그인 연결 확인.
- 컬렉션은 의존성 순서로 이전되고 `lr_public_review_requests`는 자동 생성된다.
- 파일은 동일 키(`{requestId}/{file}`)로 R2에 복사돼 `lr_review_attachments.storage_path`가 유효하게 유지된다.
- `--only=auth,data,storage`로 단계 선택 가능. 멱등(재실행 안전).

## 6. 빌드 & 배포

```bash
npm run build                      # tsc + vite (현재 0 에러)
npx firebase deploy --only hosting # dist/ → Firebase Hosting
```

`lrs.sanghak.kr` 커스텀 도메인은 **Hosting → 커스텀 도메인 추가**에서 등록(DNS 설정).
다른 호스팅을 쓰더라도 §1.2 Authorized domains와 §2 R2 CORS의 origin 등록은 필수.

## 7. 컷오버 후 정리

```bash
npm uninstall @supabase/supabase-js aws4fetch   # 이전 스크립트용 devDep
rm -rf supabase/                                # 옛 migrations + edge function
rm scripts/migrate-to-firebase.mjs              # 일회성 스크립트
```

Supabase 프로젝트는 롤백 대비 잠시 read-only로 보존 후 삭제 권장.

## 검증 체크리스트 (스테이징)

- Google 로그인 → 프로필 자동 생성 + role 정상
- 로그아웃 공개 목록 렌더(+`log_file_count`), 요청 본문 미노출
- 요청 생성 + CSV 업로드(R2 presigned PUT) + 첨부 count 갱신, 첨부 다운로드(R2 GET)
- 리뷰어: 전체 조회 + result/log 저장 / 관리자: service_names·webhooks·prompt·AI 설정 편집
- 요청 삭제(cascade + R2 delete), 버킷 일괄 삭제(list→delete)
- Google Chat 알림 발송, 60분 유휴 자동 로그아웃
- 요청 30건 초과 시 `.in()` 청크 조회 정상
- 두 계정으로 교차-role 쓰기 거부(규칙) 확인
