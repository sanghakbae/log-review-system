import { useEffect, useMemo, useRef, useState } from 'react';
import { isSupabaseConfigured, supabase } from './lib/supabase';
import { generateReviewGuide, isOpenAIConfigured } from './lib/openai';

type ViewId = 'dashboard' | 'review-write' | 'review-result' | 'result-log' | 'permissions';
type UserRole = 'requester' | 'reviewer' | 'admin';

type ReviewRequest = {
  id: string;
  title: string;
  requester_name: string;
  service_name?: string;
  log_file_count?: number;
  request_body?: string;
  file_summaries?: ReviewFileSummary[];
  status: 'submitted' | 'in_review' | 'done';
  request_created_at?: string;
  created_at: string;
};

type ReviewFileSummary = {
  fileName: string;
  extension: string;
  mimeType: string;
  size: number;
  previewText: string | null;
  storagePath?: string;
};

type ReviewResultEntry = {
  id: string;
  requestId: string;
  requestName: string;
  serviceName: string;
  requestCreatedAt: string;
  reviewerName: string;
  completedAt: string;
  resultText: string;
};

type WorkItem = {
  label: string;
  value: string;
};

type Member = {
  id: string;
  name: string;
  email: string;
  unitName?: string;
  role: UserRole;
};

type SessionUser = {
  id: string;
  name: string;
  email: string;
};

type ReviewSubmission = {
  title: string;
  requesterName: string;
  serviceName: string;
  logFiles: ReviewUploadFile[];
};

type ReviewUploadFile = {
  id: string;
  file: File;
  previewText: string | null;
};

type StoredReviewRequestBody = {
  serviceName?: string;
  logFiles?: ReviewFileSummary[];
};

type ReviewGuideRow = {
  item: string;
  content: string;
  judgment: string;
  evidence: string;
  action: string;
};

const navItems: Array<{ id: ViewId; label: string; description: string }> = [
  { id: 'dashboard', label: '대시보드', description: '전체 현황' },
  { id: 'review-write', label: '검토 작성', description: '로그 요청' },
  { id: 'review-result', label: '검토 결과', description: '' },
  { id: 'result-log', label: '결과 로그', description: '변경 이력' },
  { id: 'permissions', label: '설정', description: '서비스 관리' },
];

const roleLabel: Record<UserRole, string> = {
  requester: '요청자',
  reviewer: '검토자',
  admin: '관리자',
};

const accessByRole: Record<UserRole, ViewId[]> = {
  requester: ['dashboard', 'review-write'],
  reviewer: ['dashboard', 'review-write', 'review-result', 'result-log', 'permissions'],
  admin: ['dashboard', 'review-write', 'review-result', 'result-log', 'permissions'],
};

const reviewPromptSlotCount = 10;
const adminAccountMatchers = ['배상학', 'shbae@muhayu.com'];
const reviewUploadBucket = 'review-uploads';
const defaultReviewPromptSlots = [
  [
    '너는 범용 업무 검토 분석가다.',
    '아래 등록 프롬프트와 입력 자료를 바탕으로, 보안·운영·품질·장애·권한·감사·이상행위 관점에서 한국어로 판단한다.',
    '입력은 신청 건 제목, 요청자, 서비스명, 첨부 파일, 선택된 프롬프트 보조 지시문이 될 수 있다.',
    '출력은 반드시 Markdown 표 1개만 사용한다.',
    '표 컬럼은 `항목 | 내용 | 판단 | 근거 | 조치` 로 고정한다.',
    '판단 값은 `양호`, `주의`, `위험` 중 하나만 사용한다.',
    '근거는 입력된 사실만 적고, 추측은 최소화한다.',
    '날짜가 있으면 달력 기준 요일을 확인하고, 주말 여부는 실제 토요일/일요일일 때만 판단한다.',
    '파일이 .log, .csv, .json이면 형식별 특징을 함께 본다.',
    '- .log: 시간 순서, 에러 레벨, 세션 흐름, 반복 요청, 예외 흐름',
    '- .csv: 컬럼 분포, 반복 행, 이상치, 특정 값 편중, 집계 패턴',
    '- .json: 중첩 구조, 배열 반복, 오류 객체, 키별 패턴, 메타데이터',
    '결과는 실행 가능한 조치 중심으로 짧고 명확하게 쓴다.',
    '표 외의 머리말, 번호 목록, 맺음말, 코드블록은 쓰지 않는다.',
  ].join('\n'),
  ...Array.from({ length: reviewPromptSlotCount - 1 }, () => ''),
];
const defaultReviewPrompt = defaultReviewPromptSlots[0];
const getDefaultReviewPromptSlot = (index: number) => defaultReviewPromptSlots[index] ?? '';

const normalizeText = (value: string) => value.trim().toLowerCase();

const isAdminAccount = (name: string, email: string) => {
  const normalizedName = normalizeText(name);
  const normalizedEmail = normalizeText(email);
  return adminAccountMatchers.some((matcher) => {
    const normalizedMatcher = normalizeText(matcher);
    return normalizedName === normalizedMatcher || normalizedEmail === normalizedMatcher;
  });
};

const getSessionUser = (
  session: {
    user: {
      id: string;
      email?: string | null;
      user_metadata?: Record<string, unknown> | null;
    };
  } | null,
): SessionUser | null => {
  if (!session?.user) return null;

  const email = session.user.email ?? '';
  const metadata = session.user.user_metadata ?? {};
  const fullName = typeof metadata.full_name === 'string' ? metadata.full_name : '';
  const metaName = typeof metadata.name === 'string' ? metadata.name : '';
  const name = fullName || metaName || email.split('@')[0] || '미지정';

  return {
    id: session.user.id,
    name,
    email,
  };
};

const getAvatarInitials = (name: string) => {
  const compact = name.replace(/\s+/g, '');
  if (!compact) return '미지';
  const chars = Array.from(compact);
  return chars.slice(0, 2).join('');
};

const parseReviewGuideTable = (text: string) => {
  const lines = text
    .replace(/```[\s\S]*?```/g, (match) => match.replace(/```/g, ''))
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const tableLines = lines.filter((line) => line.includes('|'));
  if (tableLines.length < 2) return null;

  const isSeparatorLine = (line: string) => /^[:\-\s|]+$/.test(line);
  const rows = tableLines.filter((line, index) => index === 0 || !isSeparatorLine(line));
  if (rows.length < 2) return null;

  const normalizeCells = (line: string) =>
    line
      .split('|')
      .map((cell) => cell.trim())
      .filter((cell, index, cells) => !(index === 0 && cell === '') && !(index === cells.length - 1 && cell === ''));

  const header = normalizeCells(rows[0]).map((cell) => cell.replace(/\s+/g, ' '));
  const itemIndex = header.findIndex((cell) => /항목/.test(cell));
  const contentIndex = header.findIndex((cell) => /내용/.test(cell));
  const judgmentIndex = header.findIndex((cell) => /판단/.test(cell));
  const evidenceIndex = header.findIndex((cell) => /근거/.test(cell));
  const actionIndex = header.findIndex((cell) => /조치/.test(cell));

  if ([itemIndex, contentIndex, judgmentIndex, evidenceIndex, actionIndex].some((index) => index < 0)) {
    return null;
  }

  const dataRows = rows.slice(1).map((line) => normalizeCells(line));
  const parsedRows: ReviewGuideRow[] = [];

  for (const cells of dataRows) {
    const item = cells[itemIndex] ?? '-';
    const content = cells[contentIndex] ?? '-';
    const judgment = cells[judgmentIndex] ?? '-';
    const evidence = cells[evidenceIndex] ?? '-';
    const action = cells[actionIndex] ?? '-';
    if (!item && !content && !judgment && !evidence && !action) continue;
    parsedRows.push({ item, content, judgment, evidence, action });
  }

  return parsedRows.length ? parsedRows : null;
};

const getJudgmentTone = (value: string) => {
  const normalized = value.trim();
  if (normalized.includes('위험') || normalized.includes('고위험')) return 'danger';
  if (normalized.includes('주의') || normalized.includes('경고')) return 'warning';
  if (normalized.includes('양호') || normalized.includes('정상') || normalized.includes('안전')) return 'success';
  return 'neutral';
};

const sanitizeStorageFileName = (name: string) => name.replace(/[^a-zA-Z0-9._-]+/g, '_');

const allowedLogExtensions = new Set(['log', 'csv', 'json']);

const shouldPreviewFile = (file: File) => {
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  return file.type.startsWith('text/') || allowedLogExtensions.has(extension);
};

const buildFilePreview = async (file: File) => {
  if (!shouldPreviewFile(file)) return null;

  try {
    const text = await file.text();
    const preview = text.trim().slice(0, 4000);
    return preview || null;
  } catch {
    return null;
  }
};

const parseStoredRequestBody = (requestBody?: string | null): StoredReviewRequestBody | null => {
  if (!requestBody) return null;

  try {
    const parsed = JSON.parse(requestBody) as StoredReviewRequestBody;
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
};

const normalizePromptSlots = (slots: unknown): string[] => {
  if (!Array.isArray(slots)) {
    return defaultReviewPromptSlots;
  }

  return Array.from({ length: reviewPromptSlotCount }, (_unused, index) => {
    const value = slots[index];
    if (typeof value === 'string') {
      return value.trim();
    }
    return getDefaultReviewPromptSlot(index);
  });
};

const normalizePromptIndex = (value: unknown) => {
  if (typeof value !== 'number' || !Number.isInteger(value)) return 0;
  if (value < 0 || value >= reviewPromptSlotCount) return 0;
  return value;
};

const getPromptStorageKey = (userId: string) => `log-review-system:review-prompts:${userId}`;
const getRequestStorageKey = (userId: string) => `log-review-system:review-requests:${userId}`;
const getResultStorageKey = (userId: string) => `log-review-system:review-results:${userId}`;
const getGuideStorageKey = (userId: string) => `log-review-system:review-guide:${userId}`;
const getUnitNameStorageKey = (userId: string) => `log-review-system:unit-name:${userId}`;
const getServiceNamesStorageKey = (userId: string) => `log-review-system:service-names:${userId}`;
const getOAuthRedirectUrl = () => `${window.location.origin}${window.location.pathname}`;

const readPromptBackup = (userId: string) => {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(getPromptStorageKey(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { slots?: unknown; selectedSlot?: unknown };
    return {
      slots: normalizePromptSlots(parsed.slots),
      selectedSlot: normalizePromptIndex(parsed.selectedSlot),
    };
  } catch {
    return null;
  }
};

const writePromptBackup = (userId: string, slots: string[], selectedSlot: number) => {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.setItem(
      getPromptStorageKey(userId),
      JSON.stringify({
        slots,
        selectedSlot,
      }),
    );
  } catch {
    // Ignore storage failures and keep the DB save path as the primary source.
  }
};

const readRequestBackup = (userId: string) => {
  if (typeof window === 'undefined') {
    return [];
  }

  try {
    const raw = window.localStorage.getItem(getRequestStorageKey(userId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is ReviewRequest => {
      return (
        Boolean(item) &&
        typeof item === 'object' &&
        typeof (item as ReviewRequest).id === 'string' &&
        typeof (item as ReviewRequest).title === 'string' &&
        typeof (item as ReviewRequest).requester_name === 'string' &&
        typeof (item as ReviewRequest).request_created_at === 'string' &&
        typeof (item as ReviewRequest).created_at === 'string'
      );
    });
  } catch {
    return [];
  }
};

const writeRequestBackup = (userId: string, requests: ReviewRequest[]) => {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.setItem(getRequestStorageKey(userId), JSON.stringify(requests));
  } catch {
    // Ignore local backup failures.
  }
};

const readReviewResultsBackup = (userId: string) => {
  if (typeof window === 'undefined') {
    return [];
  }

  try {
    const raw = window.localStorage.getItem(getResultStorageKey(userId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
      .map((item) => ({
        id: typeof item.id === 'string' ? item.id : `review-${Date.now()}`,
        requestId: typeof item.requestId === 'string' ? item.requestId : '',
        requestName: typeof item.requestName === 'string' ? item.requestName : '미지정',
        serviceName: typeof item.serviceName === 'string' ? item.serviceName : '',
        requestCreatedAt: typeof item.requestCreatedAt === 'string' ? item.requestCreatedAt : '',
        reviewerName: typeof item.reviewerName === 'string' ? item.reviewerName : '미지정',
        completedAt: typeof item.completedAt === 'string' ? item.completedAt : '',
        resultText: typeof item.resultText === 'string' ? item.resultText : '',
      }))
      .filter((item) => item.completedAt && item.resultText);
  } catch {
    return [];
  }
};

const writeReviewResultsBackup = (userId: string, results: ReviewResultEntry[]) => {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.setItem(getResultStorageKey(userId), JSON.stringify(results));
  } catch {
    // Ignore local backup failures.
  }
};

const readReviewGuideBackup = (userId: string) => {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(getGuideStorageKey(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { selectedRequestId?: unknown; reviewGuideText?: unknown };
    return {
      selectedRequestId: typeof parsed.selectedRequestId === 'string' ? parsed.selectedRequestId : null,
      reviewGuideText: typeof parsed.reviewGuideText === 'string' ? parsed.reviewGuideText : '',
    };
  } catch {
    return null;
  }
};

const writeReviewGuideBackup = (userId: string, selectedRequestId: string | null, reviewGuideText: string) => {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.setItem(
      getGuideStorageKey(userId),
      JSON.stringify({
        selectedRequestId,
        reviewGuideText,
      }),
    );
  } catch {
    // Ignore local backup failures.
  }
};

const readUnitNameBackup = (userId: string) => {
  if (typeof window === 'undefined') {
    return '';
  }

  try {
    const raw = window.localStorage.getItem(getUnitNameStorageKey(userId));
    return typeof raw === 'string' ? raw : '';
  } catch {
    return '';
  }
};

const writeUnitNameBackup = (userId: string, unitName: string) => {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.setItem(getUnitNameStorageKey(userId), unitName);
  } catch {
    // Ignore local backup failures.
  }
};

const readServiceNamesBackup = (userId: string) => {
  if (typeof window === 'undefined') {
    return [];
  }

  try {
    const raw = window.localStorage.getItem(getServiceNamesStorageKey(userId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim());
  } catch {
    return [];
  }
};

const writeServiceNamesBackup = (userId: string, serviceNames: string[]) => {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.setItem(getServiceNamesStorageKey(userId), JSON.stringify(serviceNames));
  } catch {
    // Ignore storage failures and keep the UI usable.
  }
};

function App() {
  const [activeView, setActiveView] = useState<ViewId>(() => {
    if (typeof window === 'undefined') return 'dashboard';
    const storedView = window.localStorage.getItem('active-view') as ViewId | null;
    const allowedViews: ViewId[] = ['dashboard', 'review-write', 'review-result', 'result-log', 'permissions'];
    return storedView && allowedViews.includes(storedView) ? storedView : 'dashboard';
  });
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem('sidebar-collapsed') === 'true';
  });
  const [sessionUser, setSessionUser] = useState<SessionUser | null>(null);
  const [loadingAuth, setLoadingAuth] = useState(true);
  const [requests, setRequests] = useState<ReviewRequest[]>([]);
  const [requestsLoaded, setRequestsLoaded] = useState(false);
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null);
  const [reviewGuideText, setReviewGuideText] = useState('');
  const [reviewGuideLoading, setReviewGuideLoading] = useState(false);
  const [reviewGuideProgress, setReviewGuideProgress] = useState(0);
  const [reviewGuideError, setReviewGuideError] = useState<string | null>(null);
  const [serviceNames, setServiceNames] = useState<string[]>([]);
  const [reviewPromptSlots, setReviewPromptSlots] = useState<string[]>(defaultReviewPromptSlots);
  const [editingReviewPromptIndex, setEditingReviewPromptIndex] = useState(0);
  const [selectedReviewPromptIndex, setSelectedReviewPromptIndex] = useState(0);
  const [reviewPromptLoaded, setReviewPromptLoaded] = useState(false);
  const [currentUserUnitName, setCurrentUserUnitName] = useState('');
  const [members, setMembers] = useState<Member[]>([]);
  const [membersLoaded, setMembersLoaded] = useState(false);
  const [reviewResults, setReviewResults] = useState<ReviewResultEntry[]>([]);
  const [authError, setAuthError] = useState<string | null>(null);
  const reviewGuideProgressTimerRef = useRef<number | null>(null);
  const activeReviewPromptText = reviewPromptSlots[selectedReviewPromptIndex] ?? defaultReviewPrompt;

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem('sidebar-collapsed', String(sidebarCollapsed));
  }, [sidebarCollapsed]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem('active-view', activeView);
  }, [activeView]);

  useEffect(() => {
    if (!isSupabaseConfigured) {
      setLoadingAuth(false);
      return;
    }

    let mounted = true;

    supabase.auth.getSession().then(({ data }) => {
      if (!mounted) return;
      setSessionUser(getSessionUser(data.session));
      setLoadingAuth(false);
    });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      setSessionUser(getSessionUser(session));
    });

    return () => {
      mounted = false;
      listener.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    const syncProfile = async () => {
      if (!isSupabaseConfigured || !sessionUser) {
        return;
      }

      const role: UserRole = isAdminAccount(sessionUser.name, sessionUser.email) ? 'admin' : 'requester';

      const { error } = await supabase.from('lr_profiles').upsert(
        {
          id: sessionUser.id,
          email: sessionUser.email,
          full_name: sessionUser.name,
          role,
        },
        { onConflict: 'id' },
      );

      if (error) {
        console.error('Failed to sync profile on login:', error.message);
      }
    };

    void syncProfile();
  }, [sessionUser]);

  useEffect(() => {
    const loadMembers = async () => {
      if (!isSupabaseConfigured || !sessionUser) {
        setMembers([]);
        setServiceNames([]);
        setCurrentUserUnitName('');
        setReviewPromptSlots(defaultReviewPromptSlots);
        setEditingReviewPromptIndex(0);
        setSelectedReviewPromptIndex(0);
        setReviewPromptLoaded(false);
        setMembersLoaded(true);
        return;
      }

      setMembersLoaded(false);
      setReviewPromptLoaded(false);

      const { data, error } = await supabase
        .from('lr_profiles')
        .select('id, email, full_name, unit_name, role, review_prompt_text, review_prompt_slots, review_prompt_selected_slot');

      if (error) {
        const promptBackup = readPromptBackup(sessionUser.id);
        const unitNameBackup = readUnitNameBackup(sessionUser.id);
        setMembers((current) => {
          const currentUserRole = isAdminAccount(sessionUser.name, sessionUser.email) ? 'admin' : 'requester';
          const currentUser = {
            id: sessionUser.id,
            name: sessionUser.name,
            email: sessionUser.email,
            unitName: unitNameBackup,
            role: currentUserRole as UserRole,
          };
          return current.some((member) => member.name === currentUser.name || member.email === currentUser.email)
            ? current
            : [...current, currentUser];
        });
        setCurrentUserUnitName(unitNameBackup);
        if (promptBackup) {
          setReviewPromptSlots(promptBackup.slots);
          setEditingReviewPromptIndex(promptBackup.selectedSlot);
          setSelectedReviewPromptIndex(promptBackup.selectedSlot);
        } else {
          setReviewPromptSlots(defaultReviewPromptSlots);
          setEditingReviewPromptIndex(0);
          setSelectedReviewPromptIndex(0);
        }
        setReviewPromptLoaded(true);
        setMembersLoaded(true);
        return;
      }

      const fetchedMembers = (data ?? []).map((profile) => ({
        id: profile.id,
        name: profile.full_name ?? profile.email ?? '미지정',
        email: profile.email ?? '',
        unitName: profile.unit_name ?? '',
        role: isAdminAccount(profile.full_name ?? '', profile.email ?? '') ? 'admin' : profile.role,
      }));

      const currentProfile = (data ?? []).find((profile) => profile.id === sessionUser.id) ?? null;
      const legacyPromptText =
        typeof currentProfile?.review_prompt_text === 'string' && currentProfile.review_prompt_text.trim()
          ? currentProfile.review_prompt_text
          : undefined;
      const normalizedSlots = normalizePromptSlots(currentProfile?.review_prompt_slots ?? (legacyPromptText ? [legacyPromptText] : undefined));
      const normalizedIndex = normalizePromptIndex(currentProfile?.review_prompt_selected_slot);
      const promptBackup = readPromptBackup(sessionUser.id);
      const serviceBackup = readServiceNamesBackup(sessionUser.id);
      const unitNameBackup = readUnitNameBackup(sessionUser.id);
      const mergedSlots = promptBackup
        ? normalizedSlots.map((slot, index) => slot || promptBackup.slots[index] || getDefaultReviewPromptSlot(index))
        : normalizedSlots;
      const mergedIndex = normalizedIndex || promptBackup?.selectedSlot || 0;
      setReviewPromptSlots(mergedSlots);
      setEditingReviewPromptIndex(mergedIndex);
      setSelectedReviewPromptIndex(mergedIndex);
      setCurrentUserUnitName(currentProfile?.unit_name ?? unitNameBackup);

      const currentUserRole = isAdminAccount(sessionUser.name, sessionUser.email) ? 'admin' : 'requester';
      const currentUser = {
        id: sessionUser.id,
        name: sessionUser.name,
        email: sessionUser.email,
        unitName: currentProfile?.unit_name ?? unitNameBackup,
        role: currentUserRole as UserRole,
      };

      const mergedMembers = fetchedMembers.some(
        (member) => member.name === currentUser.name || member.email === currentUser.email,
      )
        ? fetchedMembers
        : [...fetchedMembers, currentUser];

      setMembers(mergedMembers);
      setServiceNames(serviceBackup);
      setReviewPromptLoaded(true);
      setMembersLoaded(true);
    };

    void loadMembers();
  }, [sessionUser]);

  useEffect(() => {
    if (!isSupabaseConfigured || !sessionUser || !reviewPromptLoaded) {
      return;
    }

    const timer = window.setTimeout(() => {
      void (async () => {
        writePromptBackup(sessionUser.id, reviewPromptSlots, selectedReviewPromptIndex);

        const { error } = await supabase
          .from('lr_profiles')
          .upsert(
            {
              id: sessionUser.id,
              email: sessionUser.email,
              full_name: sessionUser.name,
              review_prompt_text: activeReviewPromptText,
              review_prompt_slots: reviewPromptSlots,
              review_prompt_selected_slot: selectedReviewPromptIndex,
              updated_at: new Date().toISOString(),
            },
            { onConflict: 'id' },
          );

        if (error) {
          console.error('Failed to save review prompt:', error.message);
        }
      })();
    }, 400);

    return () => window.clearTimeout(timer);
  }, [activeReviewPromptText, reviewPromptLoaded, reviewPromptSlots, selectedReviewPromptIndex, sessionUser]);

  useEffect(() => {
    return () => {
      if (reviewGuideProgressTimerRef.current !== null) {
        window.clearInterval(reviewGuideProgressTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const loadRequests = async () => {
      if (!isSupabaseConfigured || !sessionUser) {
        setRequests([]);
        setRequestsLoaded(false);
        return;
      }

      const backupRequests = readRequestBackup(sessionUser.id);

      const { data, error } = await supabase
        .from('lr_review_requests')
        .select('id, title, requester_name, status, created_at, request_body')
        .order('created_at', { ascending: false });

      if (error) {
        console.error('Failed to load review requests:', error.message);
        setRequests(backupRequests);
        setRequestsLoaded(true);
        return;
      }

      const requestIds = (data ?? []).map((item) => item.id);
      const { data: attachmentData, error: attachmentError } = requestIds.length
        ? await supabase
            .from('lr_review_attachments')
            .select('request_id, file_name, mime_type, storage_path')
            .in('request_id', requestIds)
        : { data: [], error: null };

      if (attachmentError) {
        console.error('Failed to load review attachments:', attachmentError.message);
      }

      const attachmentCounts = new Map<string, number>();
      const attachmentSummaries = new Map<string, ReviewFileSummary[]>();
      for (const attachment of attachmentData ?? []) {
        attachmentCounts.set(attachment.request_id, (attachmentCounts.get(attachment.request_id) ?? 0) + 1);
        const parsedSummary: ReviewFileSummary = {
          fileName: attachment.file_name,
          extension: attachment.file_name.split('.').pop()?.toLowerCase() ?? '',
          mimeType: attachment.mime_type ?? '',
          size: 0,
          previewText: null,
          storagePath: attachment.storage_path,
        };
        const currentSummaries = attachmentSummaries.get(attachment.request_id) ?? [];
        attachmentSummaries.set(attachment.request_id, [...currentSummaries, parsedSummary]);
      }

      const dbRequests = (data ?? []).map((item) => ({
          ...item,
          request_created_at: item.created_at,
          service_name: parseStoredRequestBody(item.request_body)?.serviceName ?? '',
          log_file_count:
            attachmentCounts.get(item.id) ?? parseStoredRequestBody(item.request_body)?.logFiles?.length ?? 0,
          file_summaries:
            attachmentSummaries.get(item.id) ??
            parseStoredRequestBody(item.request_body)?.logFiles ??
            [],
        })) as ReviewRequest[];

      const mergedRequests = [
        ...dbRequests,
        ...backupRequests.filter((backup) => !dbRequests.some((item) => item.id === backup.id)),
      ];

      setRequests(mergedRequests);
      setRequestsLoaded(true);
    };

    void loadRequests();
  }, [sessionUser]);

  useEffect(() => {
    if (!isSupabaseConfigured || !sessionUser || !requestsLoaded) {
      return;
    }

    writeRequestBackup(sessionUser.id, requests);
  }, [requests, requestsLoaded, sessionUser]);

  useEffect(() => {
    if (!sessionUser) {
      return;
    }

    writeServiceNamesBackup(sessionUser.id, serviceNames);
  }, [serviceNames, sessionUser]);

  useEffect(() => {
    if (!sessionUser || !membersLoaded) {
      return;
    }

    writeUnitNameBackup(sessionUser.id, currentUserUnitName);

    if (!isSupabaseConfigured) {
      return;
    }

    const timer = window.setTimeout(() => {
      void (async () => {
        const role: UserRole = isAdminAccount(sessionUser.name, sessionUser.email) ? 'admin' : 'requester';
        const { error } = await supabase
          .from('lr_profiles')
          .upsert(
            {
              id: sessionUser.id,
              email: sessionUser.email,
              full_name: sessionUser.name,
              unit_name: currentUserUnitName,
              role,
              updated_at: new Date().toISOString(),
            },
            { onConflict: 'id' },
          );

        if (error) {
          console.error('Failed to save unit name:', error.message);
        }
      })();
    }, 400);

    return () => window.clearTimeout(timer);
  }, [currentUserUnitName, membersLoaded, sessionUser]);

  useEffect(() => {
    if (!sessionUser || !requestsLoaded || reviewGuideLoading) {
      return;
    }

    const backup = readReviewGuideBackup(sessionUser.id);
    if (!backup) return;

    if (backup.selectedRequestId && requests.some((item) => item.id === backup.selectedRequestId)) {
      setSelectedRequestId(backup.selectedRequestId);
      setReviewGuideText(backup.reviewGuideText);
    }
  }, [requests, requestsLoaded, reviewGuideLoading, sessionUser]);

  useEffect(() => {
    const loadReviewResults = async () => {
      if (!isSupabaseConfigured || !sessionUser) {
        setReviewResults([]);
        return;
      }

      const backupResults = readReviewResultsBackup(sessionUser.id);

      const { data, error } = await supabase
        .from('lr_review_results')
        .select(
          'id, request_id, reviewer_id, summary, created_at, request:lr_review_requests(created_at, service_name, requester_name)',
        )
        .order('created_at', { ascending: false });

      if (error) {
        console.error('Failed to load review results:', error.message);
        setReviewResults(backupResults);
        return;
      }

      const dbResults = (data ?? []).map((row) => {
        const requestRow = Array.isArray(row.request) ? row.request[0] : row.request;
        const reviewerName =
          members.find((member) => member.id === row.reviewer_id)?.name ??
          (row.reviewer_id === sessionUser.id ? sessionUser.name : '미지정');

        return {
          id: row.id,
          requestId: row.request_id ?? '',
          requestName: requestRow?.requester_name ?? '미지정',
          serviceName: requestRow?.service_name ?? '',
          requestCreatedAt: requestRow?.created_at ? new Date(requestRow.created_at).toLocaleDateString('ko-KR') : '',
          reviewerName,
          completedAt: new Date(row.created_at).toLocaleString('ko-KR'),
          resultText: row.summary ?? '',
        };
      });

      const enrichResult = (result: ReviewResultEntry) => {
        const request = requests.find((item) => item.id === result.requestId);
        return {
          ...result,
          requestName: result.requestName || request?.requester_name || '미지정',
          serviceName: result.serviceName || request?.service_name || '',
          requestCreatedAt:
            result.requestCreatedAt ||
            (request?.request_created_at ? new Date(request.request_created_at).toLocaleString('ko-KR') : ''),
        };
      };

      setReviewResults([
        ...dbResults.map(enrichResult),
        ...backupResults
          .filter((backup) => !dbResults.some((item) => item.id === backup.id))
          .map(enrichResult),
      ]);
    };

    void loadReviewResults();
  }, [members, requests, sessionUser]);

  const stats = useMemo(
    () => ({
      total: requests.length,
      submitted: requests.filter((item) => item.status === 'submitted').length,
      inReview: requests.filter((item) => item.status === 'in_review').length,
      done: requests.filter((item) => item.status === 'done').length,
    }),
    [requests],
  );

  const currentUserRole = useMemo<UserRole>(() => {
    if (!sessionUser) return 'requester';

    const normalized = sessionUser.name.trim().toLowerCase();
    const matchedMember = members.find(
      (member) => member.name.toLowerCase() === normalized || member.email.toLowerCase() === normalized,
    );

    if (matchedMember) return matchedMember.role;
    return isAdminAccount(sessionUser.name, sessionUser.email) ? 'admin' : 'requester';
  }, [members, sessionUser]);

  const availableNavItems = useMemo(
    () => navItems.filter((item) => accessByRole[currentUserRole].includes(item.id)),
    [currentUserRole],
  );

  const pendingRequestCount = useMemo(
    () => requests.filter((item) => item.status !== 'done').length,
    [requests],
  );

  const selectedRequest = useMemo(
    () => requests.find((item) => item.id === selectedRequestId) ?? null,
    [requests, selectedRequestId],
  );

  const loadAttachmentPreviews = async (attachments: ReviewFileSummary[]) => {
    const resolvedAttachments = await Promise.all(
      attachments.map(async (attachment) => {
        if (attachment.previewText) {
          return attachment;
        }

        if (!attachment.storagePath) {
          return attachment;
        }

        try {
          const { data, error } = await supabase.storage.from(reviewUploadBucket).download(attachment.storagePath);
          if (error || !data) {
            return attachment;
          }

          const previewText = shouldPreviewFile({
            name: attachment.fileName,
            type: attachment.mimeType || '',
          } as File)
            ? (await data.text()).trim().slice(0, 4000) || null
            : null;

          return {
            ...attachment,
            previewText,
          };
        } catch {
          return attachment;
        }
      }),
    );

    return resolvedAttachments;
  };

  const submitReviewRequest = async (submission: ReviewSubmission) => {
    const title = submission.title.trim();
    const requesterName = submission.requesterName.trim();
    const serviceName = submission.serviceName.trim();
    if (!title || !requesterName) return false;
    if (submission.logFiles.length === 0) return false;

    const fileSummaries = submission.logFiles.map((entry) => ({
      fileName: entry.file.name,
      extension: entry.file.name.split('.').pop()?.toLowerCase() ?? '',
      mimeType: entry.file.type,
      size: entry.file.size,
      previewText: entry.previewText,
    }));

    const requestBody = JSON.stringify({
      serviceName,
      logFiles: fileSummaries,
    });

    if (isSupabaseConfigured && sessionUser) {
      const requestId = crypto.randomUUID();
      const requestRow = {
        id: requestId,
        title,
        requester_id: sessionUser.id,
        requester_name: requesterName,
        request_body: requestBody,
        status: 'submitted' as const,
        request_created_at: new Date().toISOString(),
      };

      const { error: requestError } = await supabase.from('lr_review_requests').insert(requestRow);
      if (requestError) {
        console.error('Review request save failed:', requestError.message);
        return false;
      }

      const uploadedFiles: Array<{
        request_id: string;
        file_name: string;
        storage_bucket: string;
        storage_path: string;
        mime_type: string | null;
      }> = [];

      for (const [index, entry] of submission.logFiles.entries()) {
        const safeName = sanitizeStorageFileName(entry.file.name || `file-${index + 1}`);
        const storagePath = `${sessionUser.id}/${requestId}/${String(index + 1).padStart(2, '0')}-${safeName}`;
        const { error: uploadError } = await supabase.storage.from(reviewUploadBucket).upload(storagePath, entry.file, {
          contentType: entry.file.type || 'application/octet-stream',
          upsert: false,
        });

        if (uploadError) {
          console.error('File upload failed:', uploadError.message);
          continue;
        }

        uploadedFiles.push({
          request_id: requestId,
          file_name: entry.file.name,
          storage_bucket: reviewUploadBucket,
          storage_path: storagePath,
          mime_type: entry.file.type || null,
        });
      }

      if (uploadedFiles.length > 0) {
        const { error: attachmentError } = await supabase.from('lr_review_attachments').insert(uploadedFiles);
        if (attachmentError) {
          console.error('Attachment metadata save failed:', attachmentError.message);
        }
      }

      const newRequest: ReviewRequest = {
        id: requestId,
        title,
        requester_name: requesterName,
        service_name: serviceName,
        log_file_count: uploadedFiles.length,
        request_body: requestBody,
        file_summaries: fileSummaries,
        status: 'submitted',
        request_created_at: requestRow.request_created_at,
        created_at: new Date().toISOString(),
      };

      setRequests((current) => [newRequest, ...current]);
      setSelectedRequestId(requestId);
      setReviewGuideText('');
      setActiveView('review-result');
      return true;
    }

    const newRequest: ReviewRequest = {
      id: `request-${Date.now()}`,
      title,
      requester_name: requesterName,
      service_name: serviceName,
      log_file_count: fileSummaries.length,
      request_body: requestBody,
      file_summaries: fileSummaries,
      status: 'submitted',
      request_created_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    };

    setRequests((current) => [newRequest, ...current]);
    setSelectedRequestId(newRequest.id);
    setReviewGuideText('');
    setActiveView('review-result');
    return true;
  };

  const startReview = async (requestId: string) => {
    const request = requests.find((item) => item.id === requestId);
    if (!request) return;

    setSelectedRequestId(requestId);
    setRequests((current) =>
      current.map((item) => (item.id === requestId ? { ...item, status: 'in_review' } : item)),
    );
    setReviewGuideLoading(true);
    setReviewGuideProgress(0);
    setReviewGuideError(null);

    if (reviewGuideProgressTimerRef.current !== null) {
      window.clearInterval(reviewGuideProgressTimerRef.current);
    }
    reviewGuideProgressTimerRef.current = window.setInterval(() => {
      setReviewGuideProgress((current) => (current >= 90 ? current : current + 8));
    }, 180);

    try {
      if (isOpenAIConfigured) {
        const attachments = await loadAttachmentPreviews(request.file_summaries ?? []);
        const guide = await generateReviewGuide({
          title: request.title,
          requesterName: request.requester_name,
          serviceName: request.service_name,
          logFileCount: request.log_file_count,
          promptText: activeReviewPromptText,
          attachments,
        });
        setReviewGuideText(guide);
        if (sessionUser) {
          writeReviewGuideBackup(sessionUser.id, requestId, guide);
        }
      } else {
        setReviewGuideText('');
        setReviewGuideError('OpenAI 설정이 없어 AI 검토 안내를 생성하지 못했습니다.');
        if (sessionUser) {
          writeReviewGuideBackup(sessionUser.id, requestId, '');
        }
      }
    } catch (error) {
      setReviewGuideText('');
      setReviewGuideError(error instanceof Error ? error.message : 'OpenAI 검토 안내 생성에 실패했습니다.');
      console.error('OpenAI review guide generation failed:', error);
      if (sessionUser) {
        writeReviewGuideBackup(sessionUser.id, requestId, '');
      }
    } finally {
      if (reviewGuideProgressTimerRef.current !== null) {
        window.clearInterval(reviewGuideProgressTimerRef.current);
        reviewGuideProgressTimerRef.current = null;
      }
      setReviewGuideProgress(100);
      setReviewGuideLoading(false);
      window.setTimeout(() => setReviewGuideProgress(0), 300);
    }
  };

  const completeReview = (reviewText: string) => {
    if (!selectedRequest) return;

    const trimmed = reviewText.trim();
    if (!trimmed) return;

    const completedAt = new Date().toLocaleString('ko-KR');
    const resultId = `review-${Date.now()}`;
    const resultEntry = {
      id: resultId,
      requestId: selectedRequest.id,
      requestName: selectedRequest.requester_name,
      serviceName: selectedRequest.service_name || '',
      requestCreatedAt: selectedRequest.request_created_at
        ? new Date(selectedRequest.request_created_at).toLocaleString('ko-KR')
        : new Date(selectedRequest.created_at).toLocaleString('ko-KR'),
      reviewerName: sessionUser?.name ?? '미지정',
      completedAt,
      resultText: trimmed,
    };

    setRequests((current) =>
      current.map((item) => (item.id === selectedRequest.id ? { ...item, status: 'done' } : item)),
    );
    setReviewGuideText('');
    setReviewResults((current) => {
      const next = [resultEntry, ...current.filter((item) => item.id !== resultId)];
      if (sessionUser) {
        writeReviewResultsBackup(sessionUser.id, next);
        writeReviewGuideBackup(sessionUser.id, null, '');
      }
      return next;
    });

    if (isSupabaseConfigured && sessionUser) {
      void (async () => {
        const { error } = await supabase.from('lr_review_results').insert({
          id: resultId,
          request_id: selectedRequest.id,
          reviewer_id: sessionUser.id,
          summary: trimmed,
          feedback: trimmed,
          recommendation: null,
        });

        if (error) {
          console.error('Review result save failed:', error.message);
        }
      })();
      return;
    }
  };

  const login = async () => {
    if (!isSupabaseConfigured) {
      setAuthError('Supabase 환경 변수가 없어 Google 로그인을 시작할 수 없습니다.');
      return;
    }

    setAuthError(null);
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: getOAuthRedirectUrl(),
        queryParams: {
          access_type: 'offline',
          prompt: 'select_account',
        },
      },
    });

    if (error) {
      setAuthError(error.message);
    }
  };

  const logout = async () => {
    if (!isSupabaseConfigured) {
      return;
    }

    await supabase.auth.signOut();
    setSessionUser(null);
    setRequests([]);
    setRequestsLoaded(false);
    setSelectedRequestId(null);
    setReviewGuideText('');
    setReviewGuideLoading(false);
    setReviewGuideError(null);
    setReviewResults([]);
    setReviewPromptSlots(defaultReviewPromptSlots);
    setSelectedReviewPromptIndex(0);
    setReviewPromptLoaded(false);
    setMembersLoaded(false);
    setServiceNames([]);
    setAuthError(null);
  };

  useEffect(() => {
    if (loadingAuth || !sessionUser || !membersLoaded) {
      return;
    }

    if (!accessByRole[currentUserRole].includes(activeView)) {
      setActiveView(accessByRole[currentUserRole][0]);
    }
  }, [activeView, currentUserRole, loadingAuth, membersLoaded, sessionUser]);

  const pageTitle = availableNavItems.find((item) => item.id === activeView)?.label ?? '대시보드';
  const pageDescription = {
    dashboard: '업로드된 로그 파일과 검토 상태를 요약해서 보여줍니다.',
    'review-write': '검토 요청자가 로그 파일과 문제 상황을 입력하면 분석 작업이 시작됩니다.',
    'review-result': '',
    'result-log': '검토 과정에서 발생한 상태 변경과 기록을 추적합니다.',
    permissions: '등록된 회원의 권한을 설정하고 서비스명을 관리합니다.',
  }[activeView];

  const addServiceName = (name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setServiceNames((current) => (current.includes(trimmed) ? current : [...current, trimmed]));
  };

  const removeServiceName = (name: string) => {
    setServiceNames((current) => current.filter((item) => item !== name));
  };

  const updateMemberRole = (memberId: string, role: UserRole) => {
    setMembers((current) => current.map((member) => (member.id === memberId ? { ...member, role } : member)));

    if (!isSupabaseConfigured || !sessionUser) {
      return;
    }

    void (async () => {
      const { error } = await supabase
        .from('lr_profiles')
        .update({
          role,
          updated_at: new Date().toISOString(),
        })
        .eq('id', memberId);

      if (error) {
        console.error('Failed to update member role:', error.message);
      }
    })();
  };

  const updateMemberUnitName = (memberId: string, unitName: string) => {
    const trimmed = unitName.trim();
    setMembers((current) =>
      current.map((member) => (member.id === memberId ? { ...member, unitName: trimmed } : member)),
    );

    if (sessionUser?.id === memberId) {
      setCurrentUserUnitName(trimmed);
    }

    if (!isSupabaseConfigured || !sessionUser) {
      return;
    }

    void (async () => {
      const { error } = await supabase
        .from('lr_profiles')
        .update({
          unit_name: trimmed,
          updated_at: new Date().toISOString(),
        })
        .eq('id', memberId);

      if (error) {
        console.error('Failed to update member unit name:', error.message);
      }
    })();
  };

  const isAuthenticated = Boolean(sessionUser);

  return (
    <div className={`shell ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
      <aside className={`sidebar ${sidebarCollapsed ? 'collapsed' : ''}`}>
        <div className="brand">
          <div className="brand-mark">LR</div>
          <div className="brand-copy">
            <div className="brand-title text-14">Log Review</div>
            <div className="brand-subtitle text-12">Internal Operations</div>
          </div>
          <button
            className="sidebar-toggle icon-btn text-12"
            type="button"
            aria-label={sidebarCollapsed ? '사이드바 펼치기' : '사이드바 접기'}
            title={sidebarCollapsed ? '사이드바 펼치기' : '사이드바 접기'}
            onClick={() => setSidebarCollapsed((current) => !current)}
          >
            <span className="text-12">{sidebarCollapsed ? '>' : '<'}</span>
          </button>
        </div>

        <nav className="nav">
          {isAuthenticated && availableNavItems.map((item) => (
            <button
              key={item.id}
              className={`nav-item ${activeView === item.id ? 'active' : ''}`}
              onClick={() => setActiveView(item.id)}
              type="button"
              aria-label={item.label}
              title={item.label}
            >
              <span className="nav-icon" aria-hidden="true">
                <NavIcon viewId={item.id} />
              </span>
              <span className="nav-copy">
                <span className="nav-label-row">
                  <span className="nav-label text-14">
                    {item.label}
                    {item.id === 'review-result' && pendingRequestCount > 0 && (
                      <span className="count-badge text-xxs" aria-label={`검토 요청 ${pendingRequestCount}건`}>
                        {pendingRequestCount}
                      </span>
                    )}
                  </span>
                </span>
                <small className="text-12">{item.description}</small>
              </span>
            </button>
          ))}
        </nav>

        <div className="sidebar-footer">
          <div className="help-links">
            <button className="text-12" type="button">Help</button>
            <button className="text-12" type="button">Settings</button>
          </div>
        </div>
      </aside>

      <main className="content">
        <header className="topbar">
          <div className="topbar-title">
            <h1 className="text-16">{isAuthenticated ? pageTitle : '로그인 필요'}</h1>
            <p className="text-14">
              {isAuthenticated ? pageDescription : '로그인 후 로그 검토 요청, 결과, 설정 화면을 확인할 수 있습니다.'}
            </p>
          </div>
          <div className="topbar-actions">
            <div className="auth-inline">
              <div className="auth-user">
                {loadingAuth ? '확인 중...' : sessionUser?.name ?? (isSupabaseConfigured ? '미로그인' : '설정 필요')}
              </div>
              <button
                className="primary-btn text-12"
                onClick={sessionUser ? logout : login}
                disabled={!sessionUser && !isSupabaseConfigured}
                type="button"
              >
                <span className="text-12">{sessionUser ? '로그아웃' : 'Google로 로그인'}</span>
              </button>
            </div>
          </div>
        </header>

        {isAuthenticated ? (
          <>
            <div className="hero-banner">
              <div className="hero-row">
                <span className="text-14">상태 알림</span>
                <strong className="text-14">로그 검토 요청과 분석 결과를 한 화면에서 관리합니다.</strong>
              </div>
              <p className="text-14">로그 파일, 분석 결과, 이력, 권한을 하나의 작업 공간에서 관리합니다.</p>
            </div>

            {activeView === 'dashboard' && <Dashboard stats={stats} recent={requests} />}
            {activeView === 'review-write' && (
              <ReviewWriteView
                onSubmitRequest={submitReviewRequest}
                serviceNames={serviceNames}
                currentRequesterName={
                  sessionUser
                    ? currentUserUnitName
                      ? `${sessionUser.name} (${currentUserUnitName})`
                      : sessionUser.name
                    : ''
                }
              />
            )}
            {activeView === 'review-result' && (
              <ReviewResultView
                currentUserName={sessionUser?.name ?? '미로그인'}
                pendingRequestCount={pendingRequestCount}
                requests={requests}
                selectedRequestId={selectedRequestId}
                reviewGuideText={reviewGuideText}
                reviewGuideLoading={reviewGuideLoading}
                reviewGuideProgress={reviewGuideProgress}
                reviewGuideError={reviewGuideError}
                onSelectRequest={setSelectedRequestId}
                onStartReview={startReview}
                onCompleteReview={completeReview}
              />
            )}
            {activeView === 'result-log' && <ResultLogView results={reviewResults} />}
            {activeView === 'permissions' && (
              <PermissionsView
                members={members}
                currentUserRole={currentUserRole}
                currentUserName={sessionUser?.name ?? '미로그인'}
                currentUserEmail={sessionUser?.email ?? ''}
                currentUserUnitName={currentUserUnitName}
                onChangeCurrentUserUnitName={setCurrentUserUnitName}
                reviewPromptSlots={reviewPromptSlots}
                editingReviewPromptIndex={editingReviewPromptIndex}
                selectedReviewPromptIndex={selectedReviewPromptIndex}
                onUpdateMemberRole={updateMemberRole}
                onUpdateMemberUnitName={updateMemberUnitName}
                serviceNames={serviceNames}
                onAddServiceName={addServiceName}
                onRemoveServiceName={removeServiceName}
                onSelectPromptForEditing={setEditingReviewPromptIndex}
                onSelectReviewPromptSlot={setSelectedReviewPromptIndex}
                onChangeReviewPrompt={(value) =>
                  setReviewPromptSlots((current) =>
                    current.map((item, index) => (index === editingReviewPromptIndex ? value : item)),
                  )
                }
                onResetReviewPrompt={() =>
                  setReviewPromptSlots((current) =>
                    current.map((item, index) => (index === editingReviewPromptIndex ? getDefaultReviewPromptSlot(index) : item)),
                  )
                }
              />
            )}
          </>
        ) : (
          <section className="workspace">
            <article className="detail-card auth-gate">
              <div className="hero-row">
                <span className="text-14">접근 제한</span>
                <strong className="text-14">로그인 전에는 요청 정보와 검토 데이터를 볼 수 없습니다.</strong>
              </div>
              <p className="text-14">
                {isSupabaseConfigured
                  ? '우측 상단의 Google 로그인 버튼을 눌러 접속을 시작하세요.'
                  : '먼저 Supabase URL과 Anon Key를 설정한 뒤 Google OAuth를 활성화해야 합니다.'}
              </p>
              {authError && <p className="text-12">{authError}</p>}
            </article>
          </section>
        )}
      </main>
    </div>
  );
}

function Dashboard({ stats, recent }: { stats: { total: number; submitted: number; inReview: number; done: number }; recent: ReviewRequest[] }) {
  const summaryRows: WorkItem[] = [
    { label: '전체', value: String(stats.total) },
    { label: '대기', value: String(stats.submitted) },
    { label: '진행', value: String(stats.inReview) },
    { label: '완료', value: String(stats.done) },
  ];

  return (
    <section className="workspace">
      <article className="detail-card dense-card">
        <div className="detail-header compact">
          <div>
            <h2 className="text-14">Review Queue</h2>
            <div className="meta-line">
              <span className="status-dot" />
              <span className="text-12">Active workspace</span>
            </div>
          </div>
          <button className="secondary-btn text-12" type="button">
            <span className="text-12">Refresh</span>
          </button>
        </div>

        <div className="stat-strip summary-strip">
          {summaryRows.map((item, index) => (
            <div className={`stat-chip stat-chip-${index + 1} summary-chip`} key={item.label}>
              <span className="text-lg">{item.label}</span>
              <strong className="text-24">{item.value}</strong>
            </div>
          ))}
        </div>
      </article>

      <article className="detail-card">
        <div className="table-header split">
          <h3 className="text-14">Recent requests</h3>
          <span className="text-12">{recent.length} items</span>
        </div>
        <div className="table-card dense-table">
          <div className="table">
            <div className="table-row table-head recent-head">
              <span className="text-14">Title</span>
              <span className="text-14">Requester</span>
              <span className="text-14">Status</span>
              <span className="text-14">Created</span>
            </div>
            {recent.map((item) => (
              <div className="table-row" key={item.id}>
                <span className="text-12 table-cell-center">{item.title}</span>
                <span className="text-12 table-cell-center">{item.requester_name}</span>
                <span className={`pill ${item.status} text-12 table-cell-center`}>{item.status}</span>
                <span className="text-12 table-cell-center">{new Date(item.created_at).toLocaleDateString('ko-KR')}</span>
              </div>
            ))}
            {recent.length === 0 && <div className="empty-state">아직 요청이 없습니다.</div>}
          </div>
        </div>
      </article>

    </section>
  );
}

function ReviewWriteView({
  onSubmitRequest,
  serviceNames,
  currentRequesterName,
}: {
  onSubmitRequest: (submission: ReviewSubmission) => Promise<boolean>;
  serviceNames: string[];
  currentRequesterName: string;
}) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [logFiles, setLogFiles] = useState<ReviewUploadFile[]>([]);
  const [requestTitle, setRequestTitle] = useState('');
  const [requesterName, setRequesterName] = useState(currentRequesterName);
  const [serviceName, setServiceName] = useState(serviceNames[0] ?? '');
  const [requestError, setRequestError] = useState('');

  useEffect(() => {
    setRequesterName(currentRequesterName);
  }, [currentRequesterName]);

  useEffect(() => {
    if (serviceNames.length === 0) {
      if (serviceName !== '') {
        setServiceName('');
      }
      return;
    }

    if (!serviceName || !serviceNames.includes(serviceName)) {
      setServiceName(serviceNames[0]);
    }
  }, [serviceNames, serviceName]);

  const addLogFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;

    const acceptedFiles = Array.from(files).filter((file) => {
      const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
      return allowedLogExtensions.has(extension);
    });

    if (acceptedFiles.length === 0) {
      return;
    }

    const nextFiles = await Promise.all(
      acceptedFiles.map(async (file) => ({
        id: `${file.name}-${file.size}-${file.lastModified}`,
        file,
        previewText: await buildFilePreview(file),
      })),
    );

    setLogFiles((current) => {
      const seen = new Set(current.map((entry) => entry.id));
      const merged = [...current];
      for (const entry of nextFiles) {
        if (seen.has(entry.id)) continue;
        seen.add(entry.id);
        merged.push(entry);
      }
      return merged;
    });
  };

  const openFilePicker = () => {
    fileInputRef.current?.click();
  };

  const submitRequest = async () => {
    const title = requestTitle.trim();
    const requester = requesterName.trim();
    if (!title || !requester || logFiles.length === 0) {
      setRequestError('요청 제목, 요청자, 로그 파일을 모두 입력하세요.');
      return;
    }

    const saved = await onSubmitRequest({
      title: requestTitle,
      requesterName,
      serviceName,
      logFiles,
    });
    if (saved) {
      setRequestError('');
    } else {
      setRequestError('검토 요청을 저장하지 못했습니다. 입력값과 파일 업로드를 확인하세요.');
    }
  };

  return (
    <section className="workspace">
      <article className="detail-card">
        <div className="detail-header compact">
          <div>
            <h2 className="text-14">로그 검토 요청</h2>
            <div className="meta-line">
              <span className="status-dot" />
              <span className="text-12">접수</span>
            </div>
          </div>
        </div>

        <div className="request-form">
          <div className="request-row request-row-wide">
            <div className="request-label">
              <strong className="text-14">요청 제목</strong>
              <span className="text-12">분석 대상과 목적을 짧게 적습니다</span>
            </div>
            <div className="request-value">
              <input
                className="text-12"
                value={requestTitle}
                onChange={(event) => setRequestTitle(event.target.value)}
                placeholder="1월 웹 서비스 로그 검토 요청 드립니다."
              />
            </div>
          </div>

          <div className="request-row">
            <div className="request-label">
              <strong className="text-14">요청자</strong>
              <span className="text-12">담당자 이름 또는 부서를 입력합니다</span>
            </div>
            <div className="request-value">
              <input className="text-12" value={requesterName} onChange={(event) => setRequesterName(event.target.value)} placeholder="이름 / 부서" />
            </div>
          </div>

          <div className="request-row request-row-service">
            <div className="request-label">
              <strong className="text-14">서비스명</strong>
              <span className="text-12">검토 대상 서비스 이름을 선택합니다</span>
            </div>
            <div className="request-value request-value-service">
              <select className="text-12" value={serviceName} onChange={(event) => setServiceName(event.target.value)}>
                {serviceNames.length === 0 ? (
                  <option value="" disabled>
                    등록된 서비스명이 없습니다
                  </option>
                ) : (
                  <>
                    <option value="" disabled>
                      서비스 선택
                    </option>
                    {serviceNames.map((serviceName) => (
                      <option key={serviceName} value={serviceName}>
                        {serviceName}
                      </option>
                    ))}
                  </>
                )}
              </select>
            </div>
          </div>

          <div className="request-row">
            <div className="request-label">
              <strong className="text-14">로그 파일</strong>
              <span className="text-12">.log, .csv, .json 파일만 등록합니다</span>
            </div>
            <div className="request-value file-upload">
              <input
                ref={fileInputRef}
                className="file-input"
                type="file"
                multiple
                accept=".log,.csv,.json"
                onChange={(event) => {
                  void addLogFiles(event.target.files);
                }}
              />
              <div className="file-row file-row-upload">
                <button className="secondary-btn text-12 file-upload-btn" type="button" onClick={openFilePicker}>
                  <span className="text-12">파일 선택</span>
                </button>
                <div className="file-actions">
                  <button className="secondary-btn text-12 file-icon-btn" type="button" onClick={openFilePicker}>
                    <span className="text-12">+</span>
                  </button>
                  <button
                    className="secondary-btn text-12 file-icon-btn"
                    type="button"
                    onClick={() => setLogFiles((current) => current.slice(0, -1))}
                    disabled={logFiles.length === 0}
                  >
                    <span className="text-12">-</span>
                  </button>
                </div>
              </div>
              <div className="file-list">
                {logFiles.length > 0 ? (
                  logFiles.map((entry) => (
                    <div className="file-row" key={entry.id}>
                      <span className="text-12">{entry.file.name}</span>
                    </div>
                  ))
              ) : null}
              </div>
            </div>
          </div>
          <div className="request-submit-row">
            <div className="request-label request-submit-spacer" aria-hidden="true" />
            <div className="request-actions request-submit-actions">
              <button className="primary-btn text-12" type="button" onClick={() => void submitRequest()}>
                <span className="text-12">검토 요청</span>
              </button>
            </div>
          </div>
          {requestError && <div className="request-error text-12">{requestError}</div>}
        </div>
      </article>

      <article className="detail-card">
        <div className="table-header split">
            <h3 className="text-14">로그 검토 기준</h3>
            <span className="text-12">Rules</span>
          </div>
          <div className="criteria-grid">
            <div className="criteria-item">
              <strong className="text-14">로그 파일</strong>
              <p className="text-14">최소 1개 이상 첨부해야 하며, 가능한 한 원본 로그를 사용합니다.</p>
            </div>
            <div className="criteria-item">
              <strong className="text-14">웹 서비스 범위</strong>
              <p className="text-14">로그인, 회원가입, 결제, 검색, 업로드, 다운로드, 권한, 알림, API 응답, 화면 렌더링을 우선 확인합니다.</p>
            </div>
            <div className="criteria-item">
              <strong className="text-14">검토 기준</strong>
              <p className="text-14">HTTP 상태, 에러율, 응답 지연, 세션 만료, 인증 실패, 예외 스택, 재시도 패턴을 확인합니다.</p>
            </div>
            <div className="criteria-item">
              <strong className="text-14">심각도 분류</strong>
              <p className="text-14">장애, 오류, 경고, 정보성 이벤트를 구분해 우선순위를 정합니다.</p>
            </div>
            <div className="criteria-item">
              <strong className="text-14">출력 항목</strong>
              <p className="text-14">이슈 요약, 영향 범위, 추정 원인, 권고 조치, 관련 로그 구간을 포함합니다.</p>
            </div>
            <div className="criteria-item">
              <strong className="text-14">검토 방식</strong>
              <p className="text-14">반복 실패, 특정 시간대 집중, 특정 사용자/세션 편중, 특정 API 편중 여부를 확인합니다.</p>
            </div>
          </div>
      </article>
    </section>
  );
}

function ReviewResultView({
  requests,
  selectedRequestId,
  reviewGuideText,
  reviewGuideLoading,
  reviewGuideProgress,
  reviewGuideError,
  pendingRequestCount,
  currentUserName,
  onSelectRequest,
  onStartReview,
  onCompleteReview,
}: {
  requests: ReviewRequest[];
  selectedRequestId: string | null;
  reviewGuideText: string;
  reviewGuideLoading: boolean;
  reviewGuideProgress: number;
  reviewGuideError: string | null;
  pendingRequestCount: number;
  currentUserName: string;
  onSelectRequest: (requestId: string | null) => void;
  onStartReview: (requestId: string) => Promise<void>;
  onCompleteReview: (reviewText: string) => void;
}) {
  const [reviewResultText, setReviewResultText] = useState('');
  const selectedRequest = requests.find((request) => request.id === selectedRequestId) ?? null;
  const parsedReviewGuideRows = useMemo(
    () => (reviewGuideText ? parseReviewGuideTable(reviewGuideText) : null),
    [reviewGuideText],
  );

  useEffect(() => {
    setReviewResultText('');
  }, [selectedRequestId]);

  const handleStartReview = () => {
    if (!selectedRequest) return;
    void onStartReview(selectedRequest.id);
  };

  const handleCompleteReview = () => {
    const trimmed = reviewResultText.trim();
    if (!trimmed) return;
    onCompleteReview(trimmed);
    setReviewResultText('');
  };

  return (
    <section className="workspace">
      <article className="detail-card">
        <div className="detail-header compact">
          <div>
            <h2 className="text-14">검토 대상 목록</h2>
            <div className="meta-line">
              <span className="status-dot" />
              <span className="text-12">대기 {pendingRequestCount}건</span>
            </div>
          </div>
          <button className="primary-btn text-12" type="button" onClick={handleStartReview} disabled={!selectedRequest || reviewGuideLoading}>
            <span className="text-12">{reviewGuideLoading ? '검토 중...' : '검토'}</span>
          </button>
        </div>
        <div className="table-card dense-table">
          <div className="table">
            <div className="table-row table-head review-queue-head">
              <span className="text-14">신청 건</span>
              <span className="text-14">요청자</span>
              <span className="text-14">서비스명</span>
              <span className="text-14">첨부 파일</span>
              <span className="text-14">선택</span>
            </div>
            {requests.length === 0 ? (
              <div className="empty-state">검토할 신청 건이 없습니다.</div>
            ) : (
              requests.map((request) => (
                <div
                  className={`table-row review-queue-row ${selectedRequestId === request.id ? 'active-row' : ''}`}
                  key={request.id}
                  onClick={() => onSelectRequest(selectedRequestId === request.id ? null : request.id)}
                  role="button"
                  tabIndex={0}
                >
                  <span className="text-12">{request.title}</span>
                  <span className="text-12">{request.requester_name}</span>
                  <span className="text-12">{request.service_name || '-'}</span>
                  <span className="text-12">
                    {request.file_summaries?.length
                      ? `${request.file_summaries.length}개 / ${request.file_summaries
                          .map((file) => file.fileName)
                          .join(', ')}`
                      : `${request.log_file_count ?? 0}개`}
                  </span>
                  <span>
                    <button
                      className={`check-btn ${selectedRequestId === request.id ? 'selected' : ''}`}
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        onSelectRequest(selectedRequestId === request.id ? null : request.id);
                      }}
                      aria-pressed={selectedRequestId === request.id}
                      aria-label={`${request.title} 선택`}
                    >
                      <span className="text-12">{selectedRequestId === request.id ? '✓' : ''}</span>
                    </button>
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      </article>

      <article className="detail-card">
        <div className="detail-header compact">
          <div>
            <h2 className="text-14">AI 검토 안내</h2>
            <div className="meta-line">
              <span className="status-dot" />
              <span className="text-12">선택한 신청 건을 바탕으로 요약합니다</span>
            </div>
          </div>
        </div>
        <div className="review-guide-card">
          {reviewGuideLoading && (
            <div className="review-guide-progress" aria-label="AI 검토 안내 진행률">
              <div className="review-guide-progress-track">
                <div className="review-guide-progress-fill" style={{ width: `${reviewGuideProgress}%` }} />
              </div>
              <div className="review-guide-progress-label text-12">{reviewGuideProgress}%</div>
            </div>
          )}
          <div className="review-guide-panel">
            {reviewGuideLoading ? (
              <div className="review-guide-placeholder text-12">OpenAI가 AI 검토 안내를 생성하는 중입니다...</div>
            ) : parsedReviewGuideRows ? (
              <div className="review-guide-table-wrap">
                <table className="review-guide-table">
                  <thead>
                    <tr>
                      <th>항목</th>
                      <th>내용</th>
                      <th>판단</th>
                      <th>근거</th>
                      <th>조치</th>
                    </tr>
                  </thead>
                  <tbody>
                    {parsedReviewGuideRows.map((row) => {
                      const tone = getJudgmentTone(row.judgment);
                      return (
                        <tr key={`${row.item}-${row.content}-${row.evidence}-${row.action}`}>
                          <td className="guide-cell-item">{row.item}</td>
                          <td className={`guide-cell-content tone-${tone}`}>{row.content}</td>
                          <td className={`guide-cell-judgment tone-${tone}`}>{row.judgment}</td>
                          <td className={`guide-cell-evidence tone-${tone}`}>{row.evidence}</td>
                          <td className={`guide-cell-action tone-${tone}`}>{row.action}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <pre className="review-guide-fallback text-12">
                {reviewGuideText || '검토할 신청 건을 선택한 뒤 [검토]를 누르세요.'}
              </pre>
            )}
          </div>
          {reviewGuideError && <div className="guide-summary text-12">{reviewGuideError}</div>}
        </div>
      </article>

      <article className="detail-card">
        <div className="detail-header compact">
          <div>
            <h2 className="text-14">검토 결과 작성</h2>
            <div className="meta-line">
              <span className="status-dot" />
              <span className="text-12">{selectedRequest ? selectedRequest.requester_name : '신청 건을 선택하세요'}</span>
            </div>
          </div>
        </div>
        <div className="table-card dense-table result-entry-table">
          <div className="table">
            <div className="table-row table-head result-entry-head">
              <span className="text-14">항목</span>
              <span className="text-14">내용</span>
            </div>
            <div className="table-row result-entry-row result-entry-text-row">
              <span className="text-12 result-entry-label-cell">검토 결과</span>
              <textarea
                className="text-12 result-entry-value"
                rows={7}
                placeholder="검토 결과를 입력하세요."
                value={reviewResultText}
                onChange={(event) => setReviewResultText(event.target.value)}
              />
            </div>
          </div>
        </div>
        <div className="request-actions">
          <button className="primary-btn text-12" type="button" onClick={handleCompleteReview} disabled={!selectedRequest}>
            <span className="text-12">검토 완료</span>
          </button>
        </div>
      </article>
    </section>
  );
}

function ResultLogView({ results }: { results: ReviewResultEntry[] }) {
  return (
    <section className="workspace">
      <article className="detail-card wide-card">
        <div className="detail-header compact">
          <div>
            <h2 className="text-14">결과 로그</h2>
            <div className="meta-line">
              <span className="status-dot" />
              <span className="text-12">검토 완료 이력</span>
            </div>
          </div>
        </div>
        <div className="table-card dense-table">
          <div className="table">
            <div className="table-row table-head result-log-head">
              <span className="text-14">검토 요청일</span>
              <span className="text-14">검토 완료일</span>
              <span className="text-14">서비스</span>
              <span className="text-14">요청자</span>
              <span className="text-14">검토자</span>
              <span className="text-14">검토 결과</span>
            </div>
            {results.length === 0 ? (
              <div className="empty-state">아직 결과 로그가 없습니다.</div>
            ) : (
              results.map((result) => (
                <div className="table-row result-log-row" key={result.id}>
                  <span className="text-12">{result.requestCreatedAt || '-'}</span>
                  <span className="text-12">{result.completedAt}</span>
                  <span className="text-12">{result.serviceName || '-'}</span>
                  <span className="text-12">{result.requestName}</span>
                  <span className="text-12">{result.reviewerName}</span>
                  <span className="text-12 result-log-summary">{result.resultText}</span>
                </div>
              ))
            )}
          </div>
        </div>
      </article>
    </section>
  );
}

function PermissionsView({
  members,
  currentUserRole,
  currentUserName,
  currentUserEmail,
  currentUserUnitName,
  onChangeCurrentUserUnitName,
  reviewPromptSlots,
  editingReviewPromptIndex,
  selectedReviewPromptIndex,
  onUpdateMemberRole,
  onUpdateMemberUnitName,
  serviceNames,
  onAddServiceName,
  onRemoveServiceName,
  onSelectPromptForEditing,
  onChangeReviewPrompt,
  onSelectReviewPromptSlot,
  onResetReviewPrompt,
}: {
  members: Member[];
  currentUserRole: UserRole;
  currentUserName: string;
  currentUserEmail: string;
  currentUserUnitName: string;
  onChangeCurrentUserUnitName: (value: string) => void;
  reviewPromptSlots: string[];
  editingReviewPromptIndex: number;
  selectedReviewPromptIndex: number;
  onUpdateMemberRole: (memberId: string, role: UserRole) => void;
  onUpdateMemberUnitName: (memberId: string, unitName: string) => void;
  serviceNames: string[];
  onAddServiceName: (name: string) => void;
  onRemoveServiceName: (name: string) => void;
  onSelectPromptForEditing: (index: number) => void;
  onChangeReviewPrompt: (value: string) => void;
  onSelectReviewPromptSlot: (index: number) => void;
  onResetReviewPrompt: () => void;
}) {
  const [serviceInput, setServiceInput] = useState('');
  const promptTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const selectedPrompt = reviewPromptSlots[editingReviewPromptIndex] ?? defaultReviewPrompt;

  useEffect(() => {
    if (currentUserRole === 'requester') return;
    promptTextareaRef.current?.focus();
  }, [currentUserRole, editingReviewPromptIndex]);

  const submitService = () => {
    onAddServiceName(serviceInput);
    setServiceInput('');
  };

  return (
    <section className="workspace">
      <article className="detail-card">
        <div className="detail-header compact">
          <div>
            <h2 className="text-14">설정</h2>
            <div className="meta-line">
              <span className="status-dot" />
              <span className="text-12">권한 관리</span>
            </div>
          </div>
        </div>

        <div className="permission-note text-12">
          현재 로그인 권한: {roleLabel[currentUserRole]}
        </div>

        <div className="account-card">
          <div className="account-copy">
            <div className="account-label text-12">현재 로그인 계정</div>
            <div className="account-name text-14">
              {currentUserEmail ? `${currentUserName} (${currentUserEmail})` : currentUserName}
            </div>
            {!currentUserEmail && <div className="account-warning text-12">이 계정은 이메일 정보가 없습니다.</div>}
          </div>
        </div>

        <div className="table-card dense-table member-table">
          <div className="table">
            <div className="table-row table-head member-head">
              <span className="text-14">회원명</span>
              <span className="text-14">유닛명</span>
              <span className="text-14">이메일</span>
              <span className="text-14">권한</span>
              <span className="text-14">접근 메뉴</span>
            </div>
            {members.map((member) => (
              <div className="table-row member-row" key={member.id}>
                <span className="text-12">{member.name}</span>
                <span>
                  <input
                    className="text-12 member-unit-input"
                    value={member.unitName || ''}
                    onChange={(event) => onUpdateMemberUnitName(member.id, event.target.value)}
                    placeholder="유닛명 입력"
                    disabled={currentUserRole !== 'admin'}
                  />
                </span>
                <span className="text-12">{member.email}</span>
                <span>
                  <select
                    className="text-12"
                    value={member.role}
                    onChange={(event) => onUpdateMemberRole(member.id, event.target.value as UserRole)}
                    disabled={currentUserRole !== 'admin'}
                  >
                    <option value="requester">요청자</option>
                    <option value="reviewer">검토자</option>
                    <option value="admin">관리자</option>
                  </select>
                </span>
                <span className="text-12">
                  {member.role === 'requester' && '검토 작성'}
                  {member.role === 'reviewer' && '대시보드, 검토 작성, 검토 결과, 결과 로그'}
                  {member.role === 'admin' && '전체 메뉴'}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="prompt-card">
          <div className="prompt-card-header">
            <div>
              <div className="account-label text-12">프롬프트 등록</div>
              <div className="prompt-card-title text-14">AI 검토 요청에 사용할 기본 프롬프트를 저장합니다</div>
            </div>
          </div>
          <div className="prompt-toolbar">
            {reviewPromptSlots.map((_prompt, index) => (
              <button
                key={`prompt-slot-${index + 1}`}
                className={`prompt-slot ${selectedReviewPromptIndex === index ? 'selected' : ''} ${
                  editingReviewPromptIndex === index ? 'editing' : ''
                }`}
                type="button"
                onClick={() => onSelectPromptForEditing(index)}
                disabled={currentUserRole === 'requester'}
                aria-pressed={selectedReviewPromptIndex === index}
                aria-label={`프롬프트 ${index + 1} 선택`}
              >
                <span className="prompt-slot-label text-14">{index + 1}</span>
              </button>
            ))}
            <button
              className="secondary-btn text-12 prompt-select-btn"
              type="button"
              onClick={() => onSelectReviewPromptSlot(editingReviewPromptIndex)}
              disabled={currentUserRole === 'requester'}
            >
              <span className="text-12">선택</span>
            </button>
            <button className="secondary-btn text-12 prompt-default-btn" type="button" onClick={onResetReviewPrompt} disabled={currentUserRole === 'requester'}>
              <span className="text-12">기본값</span>
            </button>
          </div>
          <textarea
            ref={promptTextareaRef}
            className="text-12 prompt-textarea"
            value={selectedPrompt}
            onChange={(event) => onChangeReviewPrompt(event.target.value)}
            placeholder="검토 프롬프트를 입력하세요."
            rows={12}
            disabled={currentUserRole === 'requester'}
          />
          <div className="prompt-card-note text-12">
            {currentUserRole === 'requester'
              ? '요청자는 프롬프트를 수정할 수 없습니다.'
              : '선택한 프롬프트는 자동 저장되며 [검토] 버튼을 눌렀을 때 OpenAI 요청에 반영됩니다.'}
          </div>
        </div>
      </article>

      <article className="detail-card">
        <div className="table-header split">
          <h3 className="text-14">서비스명 관리</h3>
          <span className="text-12">{serviceNames.length} items</span>
        </div>
        <div className="service-manager">
            <div className="service-add">
              <input
                className="text-12"
                value={serviceInput}
                placeholder="서비스명 추가"
                onChange={(event) => setServiceInput(event.target.value)}
                disabled={currentUserRole !== 'admin'}
              />
            <button className="primary-btn text-12" type="button" onClick={submitService} disabled={currentUserRole !== 'admin'}>
              <span className="text-12">추가</span>
            </button>
          </div>

          <div className="service-list">
            {serviceNames.length === 0 ? (
              <div className="empty-state">등록된 서비스명이 없습니다.</div>
            ) : (
              serviceNames.map((serviceName) => (
                <div className="service-item" key={serviceName}>
                  <span className="text-14">{serviceName}</span>
                  <button className="secondary-btn text-12" type="button" onClick={() => onRemoveServiceName(serviceName)} disabled={currentUserRole !== 'admin'}>
                    <span className="text-12">삭제</span>
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      </article>
    </section>
  );
}

export default App;

function NavIcon({ viewId }: { viewId: ViewId }) {
  const common = {
    width: 18,
    height: 18,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };

  switch (viewId) {
    case 'dashboard':
      return (
        <svg {...common}>
          <rect x="3" y="13" width="4" height="8" rx="1.2" />
          <rect x="10" y="9" width="4" height="12" rx="1.2" />
          <rect x="17" y="5" width="4" height="16" rx="1.2" />
        </svg>
      );
    case 'review-write':
      return (
        <svg {...common}>
          <path d="M6 4h9l3 3v13H6z" />
          <path d="M15 4v4h4" />
          <path d="M8 11h8" />
          <path d="M8 15h5" />
        </svg>
      );
    case 'review-result':
      return (
        <svg {...common}>
          <circle cx="11" cy="11" r="6" />
          <path d="m20 20-4.2-4.2" />
          <path d="M8.5 11h5" />
          <path d="M11 8.5v5" />
        </svg>
      );
    case 'result-log':
      return (
        <svg {...common}>
          <path d="M6 4h12v16H6z" />
          <path d="M9 8h6" />
          <path d="M9 12h6" />
          <path d="M9 16h4" />
        </svg>
      );
    case 'permissions':
      return (
        <svg {...common}>
          <path d="M12 3 20 7v6c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V7z" />
          <path d="M9.5 12.5 11 14l3.5-4" />
        </svg>
      );
    default:
      return null;
  }
}
