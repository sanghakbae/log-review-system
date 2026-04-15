import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { isSupabaseConfigured, supabase } from './lib/supabase';
import { generateReviewGuide, isOpenAIConfigured } from './lib/openai';

type ViewId = 'dashboard' | 'review-write' | 'review-result' | 'result-log' | 'permissions';
type UserRole = 'requester' | 'reviewer' | 'admin';
type PermissionSectionId = 'members' | 'webhook' | 'prompts' | 'openai' | 'services';

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
  serviceName: string;
  requesterName: string;
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

type ReviewSubmissionResult = {
  ok: boolean;
  errorMessage?: string;
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

type ProfileSummary = {
  id: string;
  email: string | null;
  full_name: string | null;
  unit_name: string | null;
  role: string | null;
  created_at?: string | null;
  updated_at?: string | null;
};

type ReviewGuideRow = {
  item: string;
  content: string;
  judgment: string;
  evidence: string;
  action: string;
};

const isReviewerOrAbove = (role: UserRole) => role === 'reviewer' || role === 'admin';
const isAdminRole = (role: UserRole) => role === 'admin';

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
  reviewer: ['dashboard', 'review-write', 'review-result', 'result-log'],
  admin: ['dashboard', 'review-write', 'review-result', 'result-log', 'permissions'],
};

const reviewPromptSlotCount = 10;
const reviewUploadBucket = 'review-uploads';
const googleChatWebhookTable = 'lr_google_chat_webhooks';
const reviewPromptTable = 'lr_review_prompt_settings';
const reviewPromptScriptsTable = 'lr_review_prompt_scripts';
const aiSettingsTable = 'lr_ai_settings';
const isEndorphinAdminName = (name?: string | null) => name?.trim() === '엔돌핀';
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

const formatKoreaDateTime = (value?: string | Date | null) => {
  if (!value) return '-';

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '-';

  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
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

const sendGoogleChatWebhook = async (webhookUrl: string, payload: { text: string }) => {
  const trimmedWebhookUrl = webhookUrl.trim();
  if (!trimmedWebhookUrl) {
    return false;
  }

  try {
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      const beaconBody = new Blob([JSON.stringify(payload)], { type: 'application/json' });
      if (navigator.sendBeacon(trimmedWebhookUrl, beaconBody)) {
        return true;
      }
    }

    const response = await fetch(trimmedWebhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    return response.ok;
  } catch (error) {
    console.error('Failed to send Google Chat webhook:', error);
    return false;
  }
};

const loadGoogleChatWebhookUrls = async () => {
  const { data, error } = await supabase
    .from(googleChatWebhookTable)
    .select('url')
    .order('created_at', { ascending: true });

  if (error) {
    throw error;
  }

  return (data ?? [])
    .map((row) => row.url)
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => value.trim());
};

const loadReviewPromptSettings = async () => {
  const { data, error } = await supabase
    .from(reviewPromptTable)
    .select('review_prompt_text, review_prompt_slots, review_prompt_selected_slot')
    .eq('id', 'default')
    .maybeSingle();

  if (error) {
    throw error;
  }

  return {
    reviewPromptText: typeof data?.review_prompt_text === 'string' ? data.review_prompt_text : null,
    reviewPromptSlots: data?.review_prompt_slots ?? null,
    reviewPromptSelectedSlot: data?.review_prompt_selected_slot ?? null,
  };
};

const loadReviewPromptScripts = async () => {
  const { data, error } = await supabase
    .from(reviewPromptScriptsTable)
    .select('slot_index, prompt_script, is_selected')
    .order('slot_index', { ascending: true });

  if (error) {
    throw error;
  }

  const rows = (data ?? []).filter(
    (row): row is { slot_index: number; prompt_script: string; is_selected: boolean } =>
      typeof row.slot_index === 'number' && typeof row.prompt_script === 'string',
  );

  if (rows.length === 0) {
    return null;
  }

  const slots = Array.from({ length: reviewPromptSlotCount }, (_, index) => rows.find((row) => row.slot_index === index)?.prompt_script ?? '');
  const selectedSlot = rows.find((row) => row.is_selected)?.slot_index ?? 0;

  return {
    reviewPromptSlots: slots,
    reviewPromptSelectedSlot: selectedSlot,
  };
};

const loadAISettings = async () => {
  const { data, error } = await supabase
    .from(aiSettingsTable)
    .select('openai_api_key, openai_model')
    .eq('id', 'default')
    .maybeSingle();

  if (error) {
    throw error;
  }

  return {
    openaiApiKey: typeof data?.openai_api_key === 'string' ? data.openai_api_key : '',
    openaiModel: typeof data?.openai_model === 'string' && data.openai_model.trim() ? data.openai_model : 'gpt-4o-mini',
  };
};

const getOAuthRedirectUrl = () => `${window.location.origin}${window.location.pathname}`;

function App() {
  const [activeView, setActiveView] = useState<ViewId>('dashboard');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
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
  const [googleChatWebhookInput, setGoogleChatWebhookInput] = useState('');
  const [googleChatWebhookUrls, setGoogleChatWebhookUrls] = useState<string[]>([]);
  const [openAIApiKeyInput, setOpenAIApiKeyInput] = useState('');
  const [openAIModel, setOpenAIModel] = useState('gpt-4o-mini');
  const [members, setMembers] = useState<Member[]>([]);
  const [membersLoaded, setMembersLoaded] = useState(false);
  const [currentProfileRole, setCurrentProfileRole] = useState<UserRole>('requester');
  const [reviewResults, setReviewResults] = useState<ReviewResultEntry[]>([]);
  const [selectedRequestIds, setSelectedRequestIds] = useState<string[]>([]);
  const [selectedResultIds, setSelectedResultIds] = useState<string[]>([]);
  const [authError, setAuthError] = useState<string | null>(null);
  const [saveNotice, setSaveNotice] = useState<{ kind: 'success' | 'error'; message: string } | null>(null);
  const [profileSyncVersion, setProfileSyncVersion] = useState(0);
  const reviewGuideProgressTimerRef = useRef<number | null>(null);
  const reviewPromptSnapshotRef = useRef('');
  const currentUserUnitNameSnapshotRef = useRef('');
  const googleChatWebhookUrlsSnapshotRef = useRef<string[]>([]);
  const activeReviewPromptText = reviewPromptSlots[selectedReviewPromptIndex] ?? defaultReviewPrompt;

  const showSaveNotice = (kind: 'success' | 'error', message: string) => {
    setSaveNotice({ kind, message });
    window.setTimeout(() => setSaveNotice(null), 1800);
  };

  const loadEffectiveWebhookUrls = async () => {
    let effectiveWebhookUrls = googleChatWebhookUrls.map((url) => url.trim()).filter(Boolean);

    if (effectiveWebhookUrls.length === 0) {
      try {
        effectiveWebhookUrls = await loadGoogleChatWebhookUrls();
      } catch (error) {
        console.error('Failed to load Google Chat webhook URLs:', error);
      }
    }

    return effectiveWebhookUrls;
  };

  const sendWebhookNotifications = async (messageLines: string[]) => {
    const effectiveWebhookUrls = await loadEffectiveWebhookUrls();

    if (effectiveWebhookUrls.length === 0) {
      console.warn('No Google Chat webhook URLs are configured.');
      return;
    }

    const webhookDeliveryResults = await Promise.all(
      effectiveWebhookUrls.map((webhookUrl) =>
        sendGoogleChatWebhook(webhookUrl, {
          text: messageLines.join('\n'),
        }),
      ),
    );

    if (!webhookDeliveryResults.some(Boolean)) {
      console.warn('Google Chat webhook delivery failed for every configured URL.');
    } else if (webhookDeliveryResults.some((result) => !result)) {
      console.warn('Google Chat webhook delivery failed for one or more configured URLs.');
    }
  };

  const persistGoogleChatWebhookUrl = async (webhookUrl: string) => {
    if (!isSupabaseConfigured || !sessionUser || currentUserRole !== 'admin') {
      showSaveNotice('error', '저장 실패');
      return;
    }

    const normalized = webhookUrl.trim();
    if (!normalized) {
      showSaveNotice('error', '저장 실패');
      return;
    }

    const { error } = await supabase
      .from(googleChatWebhookTable)
      .upsert({ url: normalized }, { onConflict: 'url' });

    if (error) {
      console.error('Failed to save Google Chat webhook URL:', error.message);
      showSaveNotice('error', '저장 실패');
      return;
    }

    setGoogleChatWebhookUrls((current) => {
      if (current.includes(normalized)) {
        return current;
      }
      return [...current, normalized];
    });
    googleChatWebhookUrlsSnapshotRef.current = Array.from(new Set([...googleChatWebhookUrlsSnapshotRef.current, normalized]));
    setGoogleChatWebhookInput('');
    showSaveNotice('success', '저장 성공');
  };

  const saveOpenAISettings = async () => {
    if (!isSupabaseConfigured || !sessionUser || currentUserRole !== 'admin') {
      showSaveNotice('error', '저장 실패');
      return;
    }

    const { error } = await supabase
      .from(aiSettingsTable)
      .upsert(
        {
          id: 'default',
          openai_api_key: openAIApiKeyInput.trim(),
          openai_model: openAIModel,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'id' },
      );

    if (error) {
      console.error('Failed to save OpenAI settings:', error.message);
      showSaveNotice('error', '저장 실패');
      return;
    }

    showSaveNotice('success', '저장 성공');
  };

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

      const { data: existingProfile, error: selectError } = await supabase
        .from('lr_profiles')
        .select('id, role')
        .eq('id', sessionUser.id)
        .maybeSingle();

      if (selectError) {
        console.error('Failed to check profile on login:', selectError.message);
      }

      const { error } = await supabase.from('lr_profiles').upsert(
        {
          id: sessionUser.id,
          email: sessionUser.email,
          full_name: sessionUser.name,
          role: isEndorphinAdminName(sessionUser.name)
            ? 'admin'
            : (existingProfile?.role as UserRole | undefined) ?? 'requester',
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'id' },
      );

      if (error) {
        console.error('Failed to sync profile on login:', error.message);
      }

      setProfileSyncVersion((current) => current + 1);
    };

    void syncProfile();
  }, [sessionUser]);

  useEffect(() => {
    const loadMembers = async () => {
      if (!isSupabaseConfigured || !sessionUser) {
        setMembers([]);
        setServiceNames([]);
        setCurrentUserUnitName('');
        setGoogleChatWebhookUrls([]);
        setGoogleChatWebhookInput('');
        setOpenAIApiKeyInput('');
        setOpenAIModel('gpt-4o-mini');
        setReviewPromptSlots(defaultReviewPromptSlots);
        setEditingReviewPromptIndex(0);
        setSelectedReviewPromptIndex(0);
        setReviewPromptLoaded(false);
        setMembersLoaded(true);
        setCurrentProfileRole('requester');
        reviewPromptSnapshotRef.current = JSON.stringify({
          slots: defaultReviewPromptSlots,
          selectedSlot: 0,
        });
        currentUserUnitNameSnapshotRef.current = '';
        googleChatWebhookUrlsSnapshotRef.current = [];
        return;
      }

      setMembersLoaded(false);
      setReviewPromptLoaded(false);

      const { data, error } = await supabase
        .from('lr_profiles')
        .select('id, email, full_name, unit_name, role');

      if (error) {
        setMembers([]);
        setCurrentUserUnitName('');
        setGoogleChatWebhookUrls([]);
        setGoogleChatWebhookInput('');
        setOpenAIApiKeyInput('');
        setOpenAIModel('gpt-4o-mini');
        setReviewPromptSlots(defaultReviewPromptSlots);
        setEditingReviewPromptIndex(0);
        setSelectedReviewPromptIndex(0);
        setReviewPromptLoaded(true);
        setMembersLoaded(true);
        setCurrentProfileRole('requester');
        return;
      }

      const profileRows = (data ?? []) as ProfileSummary[];

      const fetchedMembers = profileRows.map((profile) => ({
        id: profile.id,
        name: profile.full_name ?? profile.email ?? '미지정',
        email: profile.email ?? '',
        unitName: profile.unit_name ?? '',
        role: isEndorphinAdminName(profile.full_name) ? 'admin' : (profile.role as UserRole) ?? 'requester',
      }));

      const { data: currentProfileData, error: currentProfileError } = await supabase
        .from('lr_profiles')
        .select('id, email, full_name, unit_name, role')
        .eq('id', sessionUser.id)
        .maybeSingle();

      if (currentProfileError) {
        console.error('Failed to load current profile:', currentProfileError.message);
      }

      const currentProfile = (currentProfileData as ProfileSummary | null) ?? profileRows.find((profile) => profile.id === sessionUser.id) ?? null;
      const currentMember = fetchedMembers.find((member) => member.id === sessionUser.id) ?? null;
      setCurrentUserUnitName(currentProfile?.unit_name ?? '');
      setCurrentProfileRole(
        (isEndorphinAdminName(sessionUser.name) ? 'admin' : currentMember?.role ?? currentProfile?.role ?? 'requester') as UserRole,
      );
      currentUserUnitNameSnapshotRef.current = currentProfile?.unit_name ?? '';
      setMembers(fetchedMembers);

      try {
        const webhookUrls = await loadGoogleChatWebhookUrls();
        setGoogleChatWebhookUrls(webhookUrls);
        googleChatWebhookUrlsSnapshotRef.current = webhookUrls;
      } catch (error) {
        console.error('Failed to load Google Chat webhook URLs:', error);
        setGoogleChatWebhookUrls([]);
        googleChatWebhookUrlsSnapshotRef.current = [];
      }

      try {
        const promptScripts = await loadReviewPromptScripts();
        const promptSettings = promptScripts ?? (await loadReviewPromptSettings());
        const normalizedSlots = normalizePromptSlots(
          promptSettings.reviewPromptSlots ?? ('reviewPromptText' in promptSettings && promptSettings.reviewPromptText
            ? [promptSettings.reviewPromptText]
            : undefined),
        );
        const normalizedIndex = normalizePromptIndex(promptSettings.reviewPromptSelectedSlot);
        setReviewPromptSlots(normalizedSlots);
        setEditingReviewPromptIndex(normalizedIndex);
        setSelectedReviewPromptIndex(normalizedIndex);
        reviewPromptSnapshotRef.current = JSON.stringify({
          slots: normalizedSlots,
          selectedSlot: normalizedIndex,
        });
      } catch (error) {
        console.error('Failed to load review prompt settings:', error);
        setReviewPromptSlots(defaultReviewPromptSlots);
        setEditingReviewPromptIndex(0);
        setSelectedReviewPromptIndex(0);
        reviewPromptSnapshotRef.current = JSON.stringify({
          slots: defaultReviewPromptSlots,
          selectedSlot: 0,
        });
      }

      try {
        const aiSettings = await loadAISettings();
        setOpenAIApiKeyInput(aiSettings.openaiApiKey);
        setOpenAIModel(aiSettings.openaiModel);
      } catch (error) {
        console.error('Failed to load OpenAI settings:', error);
        setOpenAIApiKeyInput('');
        setOpenAIModel('gpt-4o-mini');
      }

      setCurrentUserUnitName(currentProfile?.unit_name ?? '');

      const { data: serviceData, error: serviceError } = await supabase
        .from('lr_service_names')
        .select('name')
        .order('created_at', { ascending: true });

      if (serviceError) {
        console.error('Failed to load service names:', serviceError.message);
      }

      const dbServiceNames = (serviceData ?? [])
        .map((item) => item.name)
        .filter((name): name is string => typeof name === 'string' && name.trim().length > 0)
        .map((name) => name.trim());

      setServiceNames(Array.from(new Set(dbServiceNames)));
      setReviewPromptLoaded(true);
      setMembersLoaded(true);
    };

    void loadMembers();
  }, [sessionUser, profileSyncVersion]);

  useEffect(() => {
    const loadServiceNames = async () => {
      if (!isSupabaseConfigured || !sessionUser) {
        return;
      }

      const { data, error } = await supabase
        .from('lr_service_names')
        .select('name')
        .order('created_at', { ascending: true });

      if (error) {
        console.error('Failed to load service names:', error.message);
        return;
      }

      const dbServiceNames = (data ?? [])
        .map((item) => item.name)
        .filter((name): name is string => typeof name === 'string' && name.trim().length > 0)
        .map((name) => name.trim());

      setServiceNames(Array.from(new Set(dbServiceNames)));
    };

    void loadServiceNames();
  }, [activeView, sessionUser]);

  useEffect(() => {
    if (!isSupabaseConfigured || !sessionUser || !reviewPromptLoaded || currentProfileRole !== 'admin') {
      return;
    }

    const nextSnapshot = JSON.stringify({
      slots: reviewPromptSlots,
      selectedSlot: selectedReviewPromptIndex,
    });
    if (reviewPromptSnapshotRef.current === nextSnapshot) {
      return;
    }

    const timer = window.setTimeout(() => {
      void (async () => {
        const { error } = await supabase
          .from(reviewPromptTable)
          .upsert(
            {
              id: 'default',
              review_prompt_text: activeReviewPromptText,
              review_prompt_slots: reviewPromptSlots,
              review_prompt_selected_slot: selectedReviewPromptIndex,
              updated_at: new Date().toISOString(),
            },
            { onConflict: 'id' },
          );

        if (error) {
          console.error('Failed to save review prompt:', error.message);
          showSaveNotice('error', '저장 실패');
          return;
        }

        const promptScriptRows = reviewPromptSlots.map((prompt, index) => ({
          slot_index: index,
          title: `프롬프트 ${index + 1}`,
          prompt_script: prompt,
          is_selected: index === selectedReviewPromptIndex,
          updated_at: new Date().toISOString(),
        }));

        const { error: scriptError } = await supabase
          .from(reviewPromptScriptsTable)
          .upsert(promptScriptRows, { onConflict: 'slot_index' });

        if (scriptError) {
          console.error('Failed to save review prompt scripts:', scriptError.message);
          showSaveNotice('error', '저장 실패');
          return;
        }

        reviewPromptSnapshotRef.current = nextSnapshot;
        showSaveNotice('success', '저장 성공');
      })();
    }, 400);

    return () => window.clearTimeout(timer);
  }, [activeReviewPromptText, currentProfileRole, reviewPromptLoaded, reviewPromptSlots, selectedReviewPromptIndex, sessionUser]);

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

      const { data, error } = await supabase
        .from('lr_review_requests')
        .select('id, title, requester_name, status, created_at, request_body')
        .order('created_at', { ascending: false });

      if (error) {
        console.error('Failed to load review requests:', error.message);
        setRequests([]);
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

      setRequests(dbRequests);
      setRequestsLoaded(true);
    };

    void loadRequests();
  }, [sessionUser]);

  useEffect(() => {
    if (!sessionUser || !membersLoaded) {
      return;
    }

    if (currentUserUnitNameSnapshotRef.current === currentUserUnitName) {
      return;
    }

    if (!isSupabaseConfigured) {
      return;
    }

    const timer = window.setTimeout(() => {
      void (async () => {
        const { error } = await supabase
          .from('lr_profiles')
          .upsert(
            {
              id: sessionUser.id,
              email: sessionUser.email,
              full_name: sessionUser.name,
              unit_name: currentUserUnitName,
              role: currentProfileRole,
              updated_at: new Date().toISOString(),
            },
            { onConflict: 'id' },
          );

        if (error) {
          console.error('Failed to save unit name:', error.message);
          showSaveNotice('error', '저장 실패');
          return;
        }

        currentUserUnitNameSnapshotRef.current = currentUserUnitName;
        showSaveNotice('success', '저장 성공');
      })();
    }, 400);

    return () => window.clearTimeout(timer);
  }, [currentUserUnitName, membersLoaded, sessionUser]);

  const loadReviewResults = async () => {
    if (!isSupabaseConfigured || !sessionUser) {
      setReviewResults([]);
      return;
    }

    const { data, error } = await supabase
      .from('lr_review_results')
      .select('id, request_id, reviewer_id, summary, created_at')
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Failed to load review results:', error.message);
      setReviewResults([]);
      return;
    }

    const requestIds = Array.from(
      new Set((data ?? []).map((row) => row.request_id).filter((value): value is string => Boolean(value))),
    );
    const { data: requestRows, error: requestLoadError } = requestIds.length
      ? await supabase
          .from('lr_review_requests')
          .select('id, requester_name, service_name, request_created_at, created_at')
          .in('id', requestIds)
      : { data: [], error: null };

    if (requestLoadError) {
      console.error('Failed to load result request details:', requestLoadError.message);
    }

    const requestMap = new Map((requestRows ?? []).map((row) => [row.id, row]));

    const dbResults = (data ?? []).map((row) => {
      const request = requestMap.get(row.request_id ?? '') ?? requests.find((item) => item.id === row.request_id);
      const reviewerName =
        members.find((member) => member.id === row.reviewer_id)?.name ??
        (row.reviewer_id === sessionUser.id ? sessionUser.name : '미지정');

      return {
        id: row.id,
        requestId: row.request_id ?? '',
        serviceName: request?.service_name ?? '',
        requesterName: request?.requester_name ?? '',
        requestCreatedAt: formatKoreaDateTime(request?.request_created_at || request?.created_at),
        reviewerName,
        completedAt: formatKoreaDateTime(row.created_at),
        resultText: row.summary ?? '',
      };
    });

    setReviewResults(dbResults);
  };

  useEffect(() => {
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
    return currentProfileRole;
  }, [currentProfileRole, sessionUser]);
  const isRoleResolved = !sessionUser || (!loadingAuth && membersLoaded);

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

  const submitReviewRequest = async (submission: ReviewSubmission): Promise<ReviewSubmissionResult> => {
    const title = submission.title.trim();
    const requesterName = submission.requesterName.trim();
    const serviceName = submission.serviceName.trim();
    if (!title || !requesterName) {
      return { ok: false, errorMessage: '요청 제목과 요청자명을 입력하세요.' };
    }
    if (submission.logFiles.length === 0) {
      return { ok: false, errorMessage: '최소 1개의 로그 파일을 첨부하세요.' };
    }

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
        return { ok: false, errorMessage: `검토 요청 저장 실패: ${requestError.message}` };
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
          return { ok: false, errorMessage: `첨부 메타데이터 저장 실패: ${attachmentError.message}` };
        }
      }

      await sendWebhookNotifications([
        '검토 요청이 등록되었습니다.',
        `제목: ${title}`,
        `요청자: ${requesterName}`,
        `서비스명: ${serviceName || '-'}`,
        `요청 시각: ${formatKoreaDateTime(requestRow.request_created_at)}`,
        `첨부 파일 수: ${uploadedFiles.length}개`,
        ...(uploadedFiles.length > 0
          ? ['첨부 파일 목록:', ...uploadedFiles.map((file) => `- ${file.file_name}`)]
          : ['첨부 파일 목록: -']),
      ]);

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
      return { ok: true };
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
    return { ok: true };
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
      const openAISettings = { apiKey: openAIApiKeyInput, model: openAIModel };

      if (isOpenAIConfigured(openAISettings)) {
        const attachments = await loadAttachmentPreviews(request.file_summaries ?? []);
        const guide = await generateReviewGuide({
          serviceName: request.service_name,
          logFileCount: request.log_file_count,
          promptText: activeReviewPromptText,
          attachments,
        }, openAISettings);
        setReviewGuideText(guide);
      } else {
        setReviewGuideText('');
        setReviewGuideError('OpenAI 설정이 없어 AI 검토 안내를 생성하지 못했습니다.');
      }
    } catch (error) {
      setReviewGuideText('');
      setReviewGuideError(error instanceof Error ? error.message : 'OpenAI 검토 안내 생성에 실패했습니다.');
      console.error('OpenAI review guide generation failed:', error);
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

    const completedAt = formatKoreaDateTime(new Date());
    const resultId = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}`;
    setReviewGuideText('');

    if (isSupabaseConfigured && sessionUser) {
      void (async () => {
        const { error: resultError } = await supabase.from('lr_review_results').insert({
          id: resultId,
          request_id: selectedRequest.id,
          reviewer_id: sessionUser.id,
          summary: trimmed,
          feedback: trimmed,
          recommendation: null,
        });

        if (resultError) {
          console.error('Review result save failed:', resultError.message);
          showSaveNotice('error', '검토 결과 저장 실패');
          return;
        }

        const { error: logError } = await supabase.from('lr_review_logs').insert({
          request_id: selectedRequest.id,
          actor_id: sessionUser.id,
          action: 'review_completed',
          details: {
            id: resultId,
            result_id: resultId,
            summary: trimmed,
            service_name: selectedRequest.service_name || '',
            requester_name: selectedRequest.requester_name,
          },
        });

        if (logError) {
          console.error('Review log save failed:', logError.message);
          showSaveNotice('error', '결과 로그 저장 실패');
          return;
        }

        const { error: requestError } = await supabase
          .from('lr_review_requests')
          .update({
            status: 'done',
            updated_at: new Date().toISOString(),
          })
          .eq('id', selectedRequest.id);

        if (requestError) {
          console.error('Review request status update failed:', requestError.message);
          showSaveNotice('error', '검토 상태 저장 실패');
          return;
        }

        await sendWebhookNotifications([
          '검토가 완료되었습니다.',
          `제목: ${selectedRequest.title}`,
          `서비스명: ${selectedRequest.service_name || '-'}`,
          `요청자: ${selectedRequest.requester_name}`,
          `검토자: ${sessionUser.name}`,
          `검토 완료 시각: ${completedAt}`,
          '검토 결과:',
          trimmed,
        ]);

        setRequests((current) =>
          current.map((item) => (item.id === selectedRequest.id ? { ...item, status: 'done' } : item)),
        );
        await loadReviewResults();
        showSaveNotice('success', '저장 성공');
      })();
      return;
    }

    setRequests((current) =>
      current.map((item) => (item.id === selectedRequest.id ? { ...item, status: 'done' } : item)),
    );
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
    setGoogleChatWebhookInput('');
    setGoogleChatWebhookUrls([]);
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
    'review-result': '선택한 검토 요청의 AI 안내를 확인하고 검토 결과를 작성합니다.',
    'result-log': '검토 과정에서 발생한 상태 변경과 기록을 추적합니다.',
    permissions: '등록된 회원의 권한을 설정하고 서비스명을 관리합니다.',
  }[activeView];

  const addServiceName = (name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setServiceNames((current) => {
      if (current.includes(trimmed)) return current;
      const next = [...current, trimmed];

      if (isSupabaseConfigured && sessionUser) {
        void (async () => {
          const { error } = await supabase.from('lr_service_names').upsert(
            { name: trimmed },
            { onConflict: 'name' },
          );
          if (error) {
            console.error('Failed to save service name:', error.message);
            showSaveNotice('error', '저장 실패');
          } else {
            showSaveNotice('success', '저장 성공');
          }
        })();
      }

      return next;
    });
  };

  const removeServiceName = (name: string) => {
    setServiceNames((current) => {
      const next = current.filter((item) => item !== name);

      if (isSupabaseConfigured && sessionUser) {
        void (async () => {
          const { error } = await supabase.from('lr_service_names').delete().eq('name', name);
          if (error) {
            console.error('Failed to delete service name:', error.message);
            showSaveNotice('error', '저장 실패');
          } else {
            showSaveNotice('success', '저장 성공');
          }
        })();
      }

      return next;
    });
  };

  const updateMemberRole = (memberId: string, role: UserRole) => {
    const previousRole =
      members.find((member) => member.id === memberId)?.role ??
      (memberId === sessionUser?.id ? currentProfileRole : 'requester');

    setMembers((current) => current.map((member) => (member.id === memberId ? { ...member, role } : member)));
    if (sessionUser?.id === memberId) {
      setCurrentProfileRole(role);
    }

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
        setMembers((current) =>
          current.map((member) => (member.id === memberId ? { ...member, role: previousRole } : member)),
        );
        if (sessionUser?.id === memberId) {
          setCurrentProfileRole(previousRole);
        }
        showSaveNotice('error', '저장 실패');
      } else {
        showSaveNotice('success', '저장 성공');
      }
    })();
  };

  const updateMemberUnitName = (memberId: string, unitName: string) => {
    const trimmed = unitName.trim();

    if (!isSupabaseConfigured || !sessionUser) {
      setMembers((current) =>
        current.map((member) => (member.id === memberId ? { ...member, unitName: trimmed } : member)),
      );
      if (sessionUser?.id === memberId) {
        setCurrentUserUnitName(trimmed);
      }
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
        showSaveNotice('error', '저장 실패');
        return;
      }

      setMembers((current) =>
        current.map((member) => (member.id === memberId ? { ...member, unitName: trimmed } : member)),
      );

      if (sessionUser?.id === memberId) {
        setCurrentUserUnitName(trimmed);
      }

      showSaveNotice('success', '저장 성공');
    })();
  };

  const removeSelectedRequests = async () => {
    if (!isReviewerOrAbove(currentUserRole) || selectedRequestIds.length === 0) return;

    const requestIds = [...selectedRequestIds];
    const previousRequests = requests;
    const previousResults = reviewResults;
    const remainingRequests = requests.filter((request) => !requestIds.includes(request.id));
    const remainingResults = reviewResults.filter((result) => !requestIds.includes(result.requestId));

    setRequests(remainingRequests);
    setReviewResults(remainingResults);
    setSelectedRequestIds([]);
    if (selectedRequestId && requestIds.includes(selectedRequestId)) {
      setSelectedRequestId(remainingRequests[0]?.id ?? null);
    }

    if (!isSupabaseConfigured || !sessionUser) {
      showSaveNotice('success', '저장 성공');
      return;
    }

    const storagePaths = previousRequests
      .filter((request) => requestIds.includes(request.id))
      .flatMap(
        (request) =>
          request.file_summaries?.map((file) => file.storagePath).filter((path): path is string => Boolean(path)) ?? [],
      );

    const { data: deletedRequests, error } = await supabase
      .from('lr_review_requests')
      .delete()
      .in('id', requestIds)
      .select('id');
    if (error) {
      console.error('Failed to delete review requests:', error.message);
      setRequests(previousRequests);
      setReviewResults(previousResults);
      showSaveNotice('error', '삭제 실패');
      return;
    }

    if ((deletedRequests ?? []).length !== requestIds.length) {
      console.error('Review request delete affected fewer rows than expected:', {
        expected: requestIds.length,
        deleted: (deletedRequests ?? []).length,
        requestIds,
      });
      setRequests(previousRequests);
      setReviewResults(previousResults);
      showSaveNotice('error', '삭제 권한이 없거나 삭제가 완료되지 않았습니다.');
      return;
    }

    if (storagePaths.length > 0) {
      const { error: storageError } = await supabase.storage.from(reviewUploadBucket).remove(storagePaths);
      if (storageError) {
        console.error('Failed to delete review attachments from storage:', storageError.message);
      }
    }

    showSaveNotice('success', '저장 성공');
  };

  const removeSelectedResults = async () => {
    if (!isAdminRole(currentUserRole) || selectedResultIds.length === 0) return;

    const resultIds = [...selectedResultIds];
    const previousResults = reviewResults;
    setReviewResults((current) => current.filter((result) => !resultIds.includes(result.id)));
    setSelectedResultIds([]);

    if (!isSupabaseConfigured || !sessionUser) {
      showSaveNotice('success', '저장 성공');
      return;
    }

    const { data: deletedResults, error } = await supabase
      .from('lr_review_results')
      .delete()
      .in('id', resultIds)
      .select('id');
    if (error) {
      console.error('Failed to delete review results:', error.message);
      setReviewResults(previousResults);
      showSaveNotice('error', '삭제 실패');
      return;
    }

    if ((deletedResults ?? []).length !== resultIds.length) {
      console.error('Review result delete affected fewer rows than expected:', {
        expected: resultIds.length,
        deleted: (deletedResults ?? []).length,
        resultIds,
      });
      setReviewResults(previousResults);
      showSaveNotice('error', '삭제 권한이 없거나 삭제가 완료되지 않았습니다.');
      return;
    }

    showSaveNotice('success', '저장 성공');
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
          {isAuthenticated && isRoleResolved && availableNavItems.map((item) => (
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
            <h1 className="text-16">{isAuthenticated ? (isRoleResolved ? pageTitle : '권한 확인 중') : '로그인 필요'}</h1>
            <p className="text-14">
              {isAuthenticated
                ? isRoleResolved
                  ? pageDescription
                  : '권한을 확인한 뒤 접근 가능한 메뉴를 한 번에 표시합니다.'
                : '로그인 후 로그 검토 요청, 결과, 설정 화면을 확인할 수 있습니다.'}
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
          isRoleResolved ? (
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
                onShowNotice={showSaveNotice}
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
                requests={requests}
                selectedRequestId={selectedRequestId}
                reviewGuideText={reviewGuideText}
                reviewGuideLoading={reviewGuideLoading}
                reviewGuideProgress={reviewGuideProgress}
                reviewGuideError={reviewGuideError}
                onSelectRequest={setSelectedRequestId}
                onStartReview={startReview}
                onCompleteReview={completeReview}
                currentUserRole={currentUserRole}
                selectedRequestIds={selectedRequestIds}
                onToggleRequestSelection={(requestId, checked) =>
                  setSelectedRequestIds((current) =>
                    checked ? Array.from(new Set([...current, requestId])) : current.filter((id) => id !== requestId),
                  )
                }
                onRemoveSelectedRequests={() => void removeSelectedRequests()}
              />
            )}
            {activeView === 'result-log' && (
              <ResultLogView
                results={reviewResults}
                requests={requests}
                currentUserRole={currentUserRole}
                selectedResultIds={selectedResultIds}
                onToggleResultSelection={(resultId, checked) =>
                  setSelectedResultIds((current) =>
                    checked ? Array.from(new Set([...current, resultId])) : current.filter((id) => id !== resultId),
                  )
                }
                onRemoveSelectedResults={() => void removeSelectedResults()}
              />
            )}
            {activeView === 'permissions' && (
              <PermissionsView
                members={members}
                currentUserRole={currentUserRole}
                currentUserName={sessionUser?.name ?? '미로그인'}
                currentUserEmail={sessionUser?.email ?? ''}
                currentUserUnitName={currentUserUnitName}
                googleChatWebhookInput={googleChatWebhookInput}
                googleChatWebhookUrls={googleChatWebhookUrls}
                openAIApiKeyInput={openAIApiKeyInput}
                onChangeCurrentUserUnitName={setCurrentUserUnitName}
                onChangeGoogleChatWebhookInput={setGoogleChatWebhookInput}
                onChangeOpenAIApiKeyInput={setOpenAIApiKeyInput}
                onAddGoogleChatWebhookUrl={() => void persistGoogleChatWebhookUrl(googleChatWebhookInput)}
                onSaveOpenAISettings={() => void saveOpenAISettings()}
                onRemoveGoogleChatWebhookUrl={(url) => {
                  if (currentUserRole !== 'admin' || !isSupabaseConfigured || !sessionUser) {
                    showSaveNotice('error', '저장 실패');
                    return;
                  }

                  void (async () => {
      const { error } = await supabase.from(googleChatWebhookTable).delete().eq('url', url);
      if (error) {
        console.error('Failed to delete Google Chat webhook URL:', error.message);
        showSaveNotice('error', '저장 실패');
        return;
      }

      setGoogleChatWebhookUrls((current) => {
        const next = current.filter((item) => item !== url);
        googleChatWebhookUrlsSnapshotRef.current = next;
        return next;
      });
                    showSaveNotice('success', '저장 성공');
                  })();
                }}
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
            <div className="hero-banner">
              <div className="hero-row">
                <span className="text-14">권한 확인</span>
                <strong className="text-14">메뉴와 접근 권한을 불러오는 중입니다.</strong>
              </div>
              <p className="text-14">권한 확인이 끝나면 메뉴를 한 번에 표시합니다.</p>
            </div>
          )
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
      {saveNotice && (
        <div className="save-notice-overlay" role="presentation" onClick={() => setSaveNotice(null)}>
          <div
            className={`save-notice-card ${saveNotice.kind}`}
            role="dialog"
            aria-live="polite"
            aria-modal="true"
            onClick={(event) => event.stopPropagation()}
          >
            <strong className="text-14">{saveNotice.message}</strong>
          </div>
        </div>
      )}
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
    <section className="workspace review-result-workspace">
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

      <article className="detail-card permissions-card">
        <div className="table-header split">
          <h3 className="text-14">Recent requests</h3>
          <span className="text-12">{recent.length} items</span>
        </div>
        <div className="table-card dense-table">
          <div className="table">
            <div className="table-row table-head recent-head">
              <span className="text-13">Title</span>
              <span className="text-13">Requester</span>
              <span className="text-13">Status</span>
              <span className="text-13">Created</span>
            </div>
            {recent.map((item) => (
              <div className="table-row" key={item.id}>
                <span className="text-12 table-cell-center">{item.title}</span>
                <span className="text-12 table-cell-center">{item.requester_name}</span>
                <span className={`pill ${item.status} text-12 table-cell-center`}>{item.status}</span>
                <span className="text-12 table-cell-center">{formatKoreaDateTime(item.created_at)}</span>
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
  onShowNotice,
  serviceNames,
  currentRequesterName,
}: {
  onSubmitRequest: (submission: ReviewSubmission) => Promise<ReviewSubmissionResult>;
  onShowNotice: (kind: 'success' | 'error', message: string) => void;
  serviceNames: string[];
  currentRequesterName: string;
}) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [logFiles, setLogFiles] = useState<ReviewUploadFile[]>([]);
  const [requestTitle, setRequestTitle] = useState('');
  const [serviceName, setServiceName] = useState(serviceNames[0] ?? '');
  const [requestError, setRequestError] = useState('');

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

  const canSubmitRequest =
    requestTitle.trim().length > 0 &&
    currentRequesterName.trim().length > 0 &&
    serviceName.trim().length > 0 &&
    logFiles.length > 0;

  const submitRequest = async () => {
    const title = requestTitle.trim();
    const requester = currentRequesterName.trim();
    if (!title || !requester || !serviceName || logFiles.length === 0) {
      setRequestError('요청 제목, 요청자, 서비스명, 로그 파일을 모두 입력하세요.');
      return;
    }

    const result = await onSubmitRequest({
      title: requestTitle,
      requesterName: currentRequesterName,
      serviceName,
      logFiles,
    });
    if (result.ok) {
      setRequestError('');
      onShowNotice('success', '검토 요청이 등록되었습니다.');
    } else {
      const message = result.errorMessage ?? '검토 요청을 저장하지 못했습니다.';
      setRequestError(message);
      onShowNotice('error', message);
    }
  };

  return (
    <section className="workspace">
      <article className="detail-card review-queue-card">
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
              <span className="text-12">로그인한 사용자 이름이 자동으로 들어갑니다</span>
            </div>
            <div className="request-value">
              <input className="text-12" value={currentRequesterName} readOnly disabled placeholder="로그인 사용자 이름" />
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
              <button className="primary-btn text-12" type="button" onClick={() => void submitRequest()} disabled={!canSubmitRequest}>
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
  currentUserName,
  currentUserRole,
  selectedRequestIds,
  onSelectRequest,
  onStartReview,
  onCompleteReview,
  onToggleRequestSelection,
  onRemoveSelectedRequests,
}: {
  requests: ReviewRequest[];
  selectedRequestId: string | null;
  reviewGuideText: string;
  reviewGuideLoading: boolean;
  reviewGuideProgress: number;
  reviewGuideError: string | null;
  currentUserName: string;
  currentUserRole: UserRole;
  selectedRequestIds: string[];
  onSelectRequest: (requestId: string | null) => void;
  onStartReview: (requestId: string) => Promise<void>;
  onCompleteReview: (reviewText: string) => void;
  onToggleRequestSelection: (requestId: string, checked: boolean) => void;
  onRemoveSelectedRequests: () => void;
}) {
  const [reviewResultText, setReviewResultText] = useState('');
  const reviewResultEditorRef = useRef<HTMLDivElement | null>(null);
  const selectedRequest = requests.find((request) => request.id === selectedRequestId) ?? null;
  const canDeleteRequests = isReviewerOrAbove(currentUserRole);
  const parsedReviewGuideRows = useMemo(
    () => (reviewGuideText ? parseReviewGuideTable(reviewGuideText) : null),
    [reviewGuideText],
  );

  useEffect(() => {
    setReviewResultText('');
  }, [selectedRequestId]);

  useEffect(() => {
    if (!reviewResultEditorRef.current) return;
    if (reviewResultEditorRef.current.innerText === reviewResultText) return;
    reviewResultEditorRef.current.innerText = reviewResultText;
  }, [reviewResultText]);

  useEffect(() => {
    if (requests.length === 0) {
      return;
    }

    const selectedExists = selectedRequestId ? requests.some((request) => request.id === selectedRequestId) : false;
    if (!selectedRequestId || !selectedExists) {
      const latestRequest = requests[0];
      if (latestRequest) {
        // Keep the review screen focused on the latest request while still allowing selection.
        onSelectRequest(latestRequest.id);
      }
    }
  }, [onSelectRequest, requests, selectedRequestId]);

  const handleStartReview = () => {
    if (!selectedRequest) return;
    void onStartReview(selectedRequest.id);
  };

  const handleSelectRequest = (requestId: string) => {
    onSelectRequest(requestId);
    void onStartReview(requestId);
  };

  const handleCompleteReview = () => {
    const trimmed = reviewResultText.trim();
    if (!trimmed) return;
    onCompleteReview(trimmed);
    setReviewResultText('');
  };

  const handleReviewEditorInput = (event: React.FormEvent<HTMLDivElement>) => {
    setReviewResultText(event.currentTarget.innerText.replace(/\u00a0/g, ' '));
  };

  const handleReviewEditorPaste = (event: React.ClipboardEvent<HTMLDivElement>) => {
    event.preventDefault();
    const text = event.clipboardData.getData('text/plain');
    document.execCommand('insertText', false, text);
  };

  return (
    <section className="workspace">
      <article className="detail-card">
        <div className="detail-header compact">
          <div>
            <h2 className="text-14">AI 검토 안내</h2>
            <div className="meta-line">
              <span className="status-dot" />
              <span className="text-12">최신 신청 건을 자동으로 바탕으로 요약합니다</span>
            </div>
          </div>
          {canDeleteRequests && (
            <button
              className="secondary-btn text-12 result-log-delete-btn"
              type="button"
              onClick={onRemoveSelectedRequests}
              disabled={selectedRequestIds.length === 0}
            >
              <span className="text-12">선택 삭제</span>
            </button>
          )}
        </div>
        <div className="table-card dense-table request-queue-table">
          <div className="table">
            <div className="table-row table-head result-entry-head">
              <span className="text-14">선택</span>
              <span className="text-14">번호</span>
              <span className="text-14">서비스명</span>
              <span className="text-14">요청 제목</span>
              <span className="text-14">요청자</span>
              <span className="text-14">요청일</span>
              <span className="text-14">로그파일</span>
              <span className="text-14">상태</span>
            </div>
            {requests.length === 0 ? (
              <div className="empty-state">아직 검토 요청이 없습니다.</div>
            ) : (
              requests.slice(0, 6).map((request, index) => (
                <div
                  key={request.id}
                  className={`table-row result-entry-row request-queue-row ${request.id === selectedRequestId ? 'active' : ''}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => handleSelectRequest(request.id)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      handleSelectRequest(request.id);
                    }
                  }}
                >
                  <span className="text-12">
                    {canDeleteRequests ? (
                      <input
                        aria-label={`${request.title} 선택`}
                        className="row-selector"
                        type="checkbox"
                        checked={selectedRequestIds.includes(request.id)}
                        onChange={(event) => onToggleRequestSelection(request.id, event.target.checked)}
                        onClick={(event) => event.stopPropagation()}
                        onKeyDown={(event) => event.stopPropagation()}
                      />
                    ) : (
                      '-'
                    )}
                  </span>
                  <span className="text-12">{index + 1}</span>
                  <span className="text-12">{request.service_name || '-'}</span>
                  <span className="text-12">{request.title}</span>
                  <span className="text-12">{request.requester_name}</span>
                  <span className="text-12">{formatKoreaDateTime(request.request_created_at || request.created_at)}</span>
                  <span className="text-12">{request.log_file_count}</span>
                  <span className={`text-12 queue-status ${request.status}`}>
                    <span className="queue-status-dot" aria-hidden="true" />
                    <span>{request.status === 'done' ? '완료' : request.status === 'in_review' ? '진행' : '대기'}</span>
                  </span>
                </div>
              ))
            )}
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
                {reviewGuideText || '검토할 신청 건이 없으면 최신 요청이 자동 선택됩니다.'}
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
          </div>
        </div>
        <div className="table-card dense-table result-entry-table">
          <div className="table">
            <div className="table-row table-head result-entry-head">
              <span className="text-14">항목</span>
              <span className="text-14">내용</span>
            </div>
            <div className="table-row result-entry-row">
              <span className="text-12 result-entry-label-cell">서비스명</span>
              <span className="text-12 result-entry-value result-entry-readonly">
                {selectedRequest?.service_name || '-'}
              </span>
            </div>
            <div className="table-row result-entry-row result-entry-text-row">
              <span className="text-12 result-entry-label-cell">검토 결과</span>
              <div className="result-entry-editor-shell">
                <div className="result-entry-editor-toolbar">
                  <span className="text-12">텍스트 에디터</span>
                  <button
                    className="secondary-btn text-12 result-entry-editor-clear"
                    type="button"
                    onClick={() => setReviewResultText('')}
                  >
                    <span className="text-12">지우기</span>
                  </button>
                </div>
                <div
                  ref={reviewResultEditorRef}
                  className={`text-12 result-entry-value result-entry-editor ${reviewResultText ? '' : 'is-empty'}`}
                  contentEditable
                  suppressContentEditableWarning
                  data-placeholder="검토 결과를 입력하세요."
                  onInput={handleReviewEditorInput}
                  onPaste={handleReviewEditorPaste}
                />
              </div>
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

function ResultLogView({
  results,
  requests,
  currentUserRole,
  selectedResultIds,
  onToggleResultSelection,
  onRemoveSelectedResults,
}: {
  results: ReviewResultEntry[];
  requests: ReviewRequest[];
  currentUserRole: UserRole;
  selectedResultIds: string[];
  onToggleResultSelection: (resultId: string, checked: boolean) => void;
  onRemoveSelectedResults: () => void;
}) {
  const requestNumberById = useMemo(
    () => new Map(requests.map((request, index) => [request.id, index + 1])),
    [requests],
  );
  const csvRows = useMemo(
    () =>
      results.map((result) => ({
        number: requestNumberById.get(result.requestId) ?? '-',
        requestCreatedAt: result.requestCreatedAt || '-',
        completedAt: result.completedAt,
        serviceName: result.serviceName || '-',
        requesterName: result.requesterName || '-',
        reviewerName: result.reviewerName,
        resultText: result.resultText,
      })),
    [requestNumberById, results],
  );

  const handlePrintPdf = () => {
    const printWindow = window.open('', '_blank', 'noopener,noreferrer,width=1200,height=900');
    if (!printWindow) return;

    const rowsHtml = csvRows
      .map(
        (row) => `
          <tr>
            <td>${row.number}</td>
            <td>${row.requestCreatedAt}</td>
            <td>${row.completedAt}</td>
            <td>${row.serviceName}</td>
            <td>${row.requesterName}</td>
            <td>${row.reviewerName}</td>
            <td>${String(row.resultText)
              .split(/\r?\n/)
              .map((line) => line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'))
              .join('<br />')}</td>
          </tr>
        `,
      )
      .join('');

    printWindow.document.write(`
      <!doctype html>
      <html lang="ko">
        <head>
          <meta charset="utf-8" />
          <title>Result Log PDF</title>
          <style>
            body {
              margin: 24px;
              font-family: 'Korpub돋움체', 'KorPub Dotum', 'Apple SD Gothic Neo', 'Malgun Gothic', sans-serif;
              color: #172033;
            }
            h1 {
              margin: 0 0 16px;
              font-size: 20px;
            }
            table {
              width: 100%;
              border-collapse: collapse;
              table-layout: fixed;
            }
            th, td {
              border: 1px solid #d8dee8;
              padding: 10px 12px;
              vertical-align: top;
              font-size: 12px;
            }
            th {
              background: #f5f7fb;
              text-align: center;
              white-space: nowrap;
            }
            td {
              text-align: center;
              white-space: nowrap;
            }
            td:last-child {
              text-align: left;
              white-space: pre-wrap;
              word-break: break-word;
            }
          </style>
        </head>
        <body>
          <h1>결과 로그</h1>
          <table>
            <thead>
              <tr>
                <th>번호</th>
                <th>검토 요청일</th>
                <th>검토 완료일</th>
                <th>서비스</th>
                <th>요청자</th>
                <th>검토자</th>
                <th>검토 결과</th>
              </tr>
            </thead>
            <tbody>${rowsHtml}</tbody>
          </table>
        </body>
      </html>
    `);
    printWindow.document.close();
    printWindow.focus();
    window.setTimeout(() => {
      printWindow.print();
    }, 250);
  };

  const handleExportCsv = () => {
    const header = ['번호', '검토 요청일', '검토 완료일', '서비스', '요청자', '검토자', '검토 결과'];
    const escapeCell = (value: string | number) => `"${String(value).replace(/"/g, '""')}"`;
    const lines = [
      header.map(escapeCell).join(','),
      ...csvRows.map((row) =>
        [
          row.number,
          row.requestCreatedAt,
          row.completedAt,
          row.serviceName,
          row.requesterName,
          row.reviewerName,
          row.resultText,
        ]
          .map(escapeCell)
          .join(','),
      ),
    ];

    const csvContent = `\uFEFF${lines.join('\n')}`;
    const encoded = `data:text/csv;charset=utf-8,${encodeURIComponent(csvContent)}`;
    const link = document.createElement('a');
    const fileName = `result-log-${new Date().toISOString().slice(0, 10)}.csv`;
    link.href = encoded;
    link.setAttribute('download', fileName);
    link.download = fileName;
    link.rel = 'noopener';
    link.style.display = 'none';
    document.body.appendChild(link);
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    window.setTimeout(() => {
      link.remove();
    }, 1000);
  };

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
          {results.length === 0 ? (
            <div className="empty-state">아직 결과 로그가 없습니다.</div>
          ) : (
            <div className="result-log-table-wrap">
              <div className="result-log-actions">
                <button className="secondary-btn text-12" type="button" onClick={handleExportCsv}>
                  <span className="text-12">CSV 내보내기</span>
                </button>
                <button className="primary-btn text-12" type="button" onClick={handlePrintPdf}>
                  <span className="text-12">PDF 출력</span>
                </button>
                {currentUserRole === 'admin' && (
                  <button
                    className="secondary-btn text-12 result-log-delete-btn"
                    type="button"
                    onClick={onRemoveSelectedResults}
                    disabled={selectedResultIds.length === 0}
                  >
                    <span className="text-12">선택 삭제</span>
                  </button>
                )}
              </div>
              <table className="result-log-table">
                <thead>
                  <tr>
                    {currentUserRole === 'admin' && <th className="text-14 result-log-select-col">선택</th>}
                    <th className="text-14">번호</th>
                    <th className="text-14">검토 요청일</th>
                    <th className="text-14">검토 완료일</th>
                    <th className="text-14">서비스</th>
                    <th className="text-14">요청자</th>
                    <th className="text-14">검토자</th>
                    <th className="text-14">검토 결과</th>
                  </tr>
                </thead>
                <tbody>
                  {results.map((result) => (
                    <tr key={result.id}>
                      {currentUserRole === 'admin' && (
                        <td className="text-12 result-log-id-cell result-log-select-col">
                          <input
                            aria-label={`${result.requestId} 결과 선택`}
                            className="row-selector"
                            type="checkbox"
                            checked={selectedResultIds.includes(result.id)}
                            onChange={(event) => onToggleResultSelection(result.id, event.target.checked)}
                          />
                        </td>
                      )}
                      <td className="text-12 result-log-id-cell">{requestNumberById.get(result.requestId) ?? '-'}</td>
                      <td className="text-12">{result.requestCreatedAt || '-'}</td>
                      <td className="text-12">{result.completedAt}</td>
                      <td className="text-12">{result.serviceName || '-'}</td>
                      <td className="text-12">{result.requesterName || '-'}</td>
                      <td className="text-12">{result.reviewerName}</td>
                      <td className="text-12 result-log-summary">
                        {result.resultText.split(/\r?\n/).map((line, index) => (
                          <Fragment key={`${result.id}-${index}`}>
                            {index > 0 && <br />}
                            {line}
                          </Fragment>
                        ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </article>
    </section>
  );
}

function ReportView({ results, requests }: { results: ReviewResultEntry[]; requests: ReviewRequest[] }) {
  const requestNumberById = useMemo(
    () => new Map(requests.map((request, index) => [request.id, index + 1])),
    [requests],
  );
  const generatedAt = useMemo(() => formatKoreaDateTime(new Date()), []);

  return (
    <section className="workspace report-workspace">
      <article className="detail-card wide-card report-screen-controls">
        <div className="detail-header compact">
          <div>
            <h2 className="text-14">리포트 출력</h2>
            <div className="meta-line">
              <span className="status-dot" />
              <span className="text-12">브라우저 인쇄에서 PDF로 저장할 수 있습니다</span>
            </div>
          </div>
        </div>
        <div className="request-actions">
          <button className="primary-btn text-12" type="button" onClick={() => window.print()}>
            <span className="text-12">PDF 출력</span>
          </button>
        </div>
      </article>

      <article className="detail-card wide-card report-print-area">
        <div className="report-header">
          <div>
            <div className="report-kicker text-12">LOG REVIEW REPORT</div>
            <h2 className="text-16">검토 결과 리포트</h2>
          </div>
          <div className="report-meta">
            <div className="text-12">생성일시</div>
            <strong className="text-14">{generatedAt}</strong>
          </div>
        </div>

        <div className="report-summary-grid">
          <div className="report-summary-card">
            <span className="text-12">총 결과 수</span>
            <strong className="text-16">{results.length}</strong>
          </div>
          <div className="report-summary-card">
            <span className="text-12">총 요청 수</span>
            <strong className="text-16">{requests.length}</strong>
          </div>
        </div>

        {results.length === 0 ? (
          <div className="empty-state">출력할 결과 로그가 없습니다.</div>
        ) : (
          <div className="report-list">
            {results.map((result) => (
              <section className="report-item" key={result.id}>
                <div className="report-item-head">
                  <div className="report-item-title-group">
                    <span className="report-item-number text-12">
                      요청 #{requestNumberById.get(result.requestId) ?? '-'}
                    </span>
                    <strong className="text-14">{result.serviceName || '-'}</strong>
                  </div>
                  <span className="text-12">{result.completedAt}</span>
                </div>
                <div className="report-detail-grid">
                  <div className="report-detail-row">
                    <span className="text-12">검토 요청일</span>
                    <strong className="text-12">{result.requestCreatedAt || '-'}</strong>
                  </div>
                  <div className="report-detail-row">
                    <span className="text-12">요청자</span>
                    <strong className="text-12">{result.requesterName || '-'}</strong>
                  </div>
                  <div className="report-detail-row">
                    <span className="text-12">검토자</span>
                    <strong className="text-12">{result.reviewerName}</strong>
                  </div>
                </div>
                <div className="report-result-box">
                  {result.resultText.split(/\r?\n/).map((line, index) => (
                    <Fragment key={`${result.id}-report-${index}`}>
                      {index > 0 && <br />}
                      {line}
                    </Fragment>
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
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
  googleChatWebhookInput,
  googleChatWebhookUrls,
  openAIApiKeyInput,
  onChangeCurrentUserUnitName,
  onChangeGoogleChatWebhookInput,
  onChangeOpenAIApiKeyInput,
  onAddGoogleChatWebhookUrl,
  onSaveOpenAISettings,
  onRemoveGoogleChatWebhookUrl,
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
  googleChatWebhookInput: string;
  googleChatWebhookUrls: string[];
  openAIApiKeyInput: string;
  onChangeCurrentUserUnitName: (value: string) => void;
  onChangeGoogleChatWebhookInput: (value: string) => void;
  onChangeOpenAIApiKeyInput: (value: string) => void;
  onAddGoogleChatWebhookUrl: () => void;
  onSaveOpenAISettings: () => void;
  onRemoveGoogleChatWebhookUrl: (value: string) => void;
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
  const [selectedSection, setSelectedSection] = useState<PermissionSectionId>('members');
  const [memberUnitDrafts, setMemberUnitDrafts] = useState<Record<string, string>>({});
  const promptTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const memberUnitSaveTimersRef = useRef<Record<string, number>>({});
  const selectedPrompt = reviewPromptSlots[editingReviewPromptIndex] ?? defaultReviewPrompt;

  useEffect(() => {
    if (currentUserRole !== 'admin') return;
    promptTextareaRef.current?.focus();
  }, [currentUserRole, editingReviewPromptIndex]);

  useEffect(() => {
    setMemberUnitDrafts((current) => {
      const next = { ...current };
      for (const member of members) {
        if (next[member.id] === undefined || next[member.id] === member.unitName) {
          next[member.id] = member.unitName || '';
        }
      }
      return next;
    });
  }, [members]);

  useEffect(() => {
    return () => {
      Object.values(memberUnitSaveTimersRef.current).forEach((timer) => window.clearTimeout(timer));
      memberUnitSaveTimersRef.current = {};
    };
  }, []);

  const handleMemberUnitDraftChange = (memberId: string, value: string) => {
    setMemberUnitDrafts((current) => ({ ...current, [memberId]: value }));

    const existingTimer = memberUnitSaveTimersRef.current[memberId];
    if (existingTimer) {
      window.clearTimeout(existingTimer);
    }

    memberUnitSaveTimersRef.current[memberId] = window.setTimeout(() => {
      delete memberUnitSaveTimersRef.current[memberId];
      onUpdateMemberUnitName(memberId, value);
    }, 2000);
  };

  const submitService = () => {
    onAddServiceName(serviceInput);
    setServiceInput('');
  };

  const sectionItems: Array<{ id: PermissionSectionId; label: string; description: string }> = [
    { id: 'members', label: '회원 관리', description: '등록된 사용자와 권한을 확인합니다' },
    { id: 'webhook', label: '웹훅 관리', description: 'Google Chat 알림 URL을 저장합니다' },
    { id: 'prompts', label: '프롬프트 관리', description: '검토용 AI 프롬프트를 편집합니다' },
    { id: 'openai', label: 'OpenAI 설정', description: '검토용 API 키를 저장합니다' },
    { id: 'services', label: '서비스명 관리', description: '서비스명을 등록하고 삭제합니다' },
  ];

  return (
    <section className="workspace">
      <article className="detail-card permissions-card">
        <div className="permissions-layout">
          <aside className="permissions-menu" aria-label="권한 관리 섹션">
            {sectionItems.map((section) => (
              <button
                key={section.id}
                type="button"
                className={`permissions-menu-item ${selectedSection === section.id ? 'active' : ''}`}
                onClick={() => setSelectedSection(section.id)}
              >
                <span className="permissions-menu-label text-14">{section.label}</span>
                <small className="text-12">{section.description}</small>
              </button>
            ))}
          </aside>

          <div className="permissions-panel">
            {selectedSection === 'members' && (
              <div className="table-card dense-table member-table">
                <div className="table">
                  <div className="table-row table-head member-head">
                    <span className="text-14">회원명</span>
                    <span className="text-14">이메일</span>
                    <span className="text-14">유닛명</span>
                    <span className="text-14">권한</span>
                    <span className="text-14">접근 메뉴</span>
                  </div>
                  {members.map((member) => (
                    <div className="table-row member-row" key={member.id}>
                      <span className="text-12">{member.name}</span>
                      <span className="text-12">{member.email}</span>
                      <span>
                        <input
                          className="text-12 member-unit-input"
                          value={memberUnitDrafts[member.id] ?? member.unitName ?? ''}
                          onChange={(event) => handleMemberUnitDraftChange(member.id, event.target.value)}
                          placeholder="유닛명 입력"
                          disabled={currentUserRole !== 'admin'}
                        />
                      </span>
                      <span>
                        <select
                          className="text-12 member-role-select"
                          value={member.role}
                          onChange={(event) => onUpdateMemberRole(member.id, event.target.value as UserRole)}
                          disabled={currentUserRole !== 'admin'}
                        >
                          <option value="requester">requester</option>
                          <option value="reviewer">reviewer</option>
                          <option value="admin">admin</option>
                          </select>
                        </span>
                      <span className="text-12">
                        {member.role === 'requester' && 'dashboard, review-write'}
                        {member.role === 'reviewer' && 'dashboard, review-write, review-result, result-log, report'}
                        {member.role === 'admin' && 'dashboard, review-write, review-result, result-log, report, permissions'}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {selectedSection === 'webhook' && (
              <div className="prompt-card">
                <div className="prompt-card-header">
                  <div>
                    <div className="account-label text-12">Google Chat 웹훅</div>
                    <div className="prompt-card-title text-14">검토 요청이 등록될 때 알림을 보낼 웹훅 URL을 여러 개 저장합니다</div>
                  </div>
                </div>
                <div className="webhook-input-row">
                  <input
                    className="text-12 webhook-input"
                    value={googleChatWebhookInput}
                    onChange={(event) => onChangeGoogleChatWebhookInput(event.target.value)}
                    placeholder="https://chat.googleapis.com/v1/spaces/..."
                    disabled={currentUserRole === 'requester'}
                  />
                  <button
                    className="primary-btn text-12 webhook-save-btn"
                    type="button"
                    onClick={onAddGoogleChatWebhookUrl}
                    disabled={currentUserRole === 'requester' || !googleChatWebhookInput.trim()}
                  >
                    <span className="text-12">저장</span>
                  </button>
                </div>
                <div className="webhook-list">
                  {googleChatWebhookUrls.length === 0 ? (
                    <div className="prompt-card-note text-12">저장된 웹훅이 없습니다.</div>
                  ) : (
                    googleChatWebhookUrls.map((url) => (
                      <div className="webhook-item" key={url}>
                        <span className="text-12 webhook-url">{url}</span>
                        <button
                          className="secondary-btn text-12"
                          type="button"
                          onClick={() => onRemoveGoogleChatWebhookUrl(url)}
                          disabled={currentUserRole === 'requester'}
                        >
                          삭제
                        </button>
                      </div>
                    ))
                  )}
                </div>
                <div className="prompt-card-note text-12">
                  {currentUserRole === 'requester'
                    ? '요청자는 웹훅을 수정할 수 없습니다.'
                    : '저장된 값은 Supabase에 보관되고, 검토 요청이 등록될 때 모두 사용됩니다.'}
                </div>
              </div>
            )}

            {selectedSection === 'prompts' && (
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
                      disabled={currentUserRole !== 'admin'}
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
                    disabled={currentUserRole !== 'admin'}
                  >
                    <span className="text-12">선택</span>
                  </button>
                  <button className="secondary-btn text-12 prompt-default-btn" type="button" onClick={onResetReviewPrompt} disabled={currentUserRole !== 'admin'}>
                    <span className="text-12">기본값</span>
                  </button>
                </div>
                <textarea
                  ref={promptTextareaRef}
                  className="text-12 prompt-textarea"
                  value={selectedPrompt}
                  onChange={(event) => onChangeReviewPrompt(event.target.value)}
                  placeholder="검토 프롬프트를 입력하세요."
                  rows={18}
                  disabled={currentUserRole !== 'admin'}
                />
                <div className="prompt-card-note text-12">
                  {currentUserRole === 'admin'
                    ? '선택한 프롬프트는 자동 저장되며 [검토] 버튼을 눌렀을 때 OpenAI 요청에 반영됩니다.'
                    : '프롬프트는 admin만 수정할 수 있습니다.'}
                </div>
              </div>
            )}

            {selectedSection === 'services' && (
              <div className="prompt-card">
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
              </div>
            )}

            {selectedSection === 'openai' && (
              <div className="prompt-card">
                <div className="prompt-card-header">
                  <div>
                    <div className="account-label text-12">OpenAI API Key</div>
                    <div className="prompt-card-title text-14">Secrets 대신 설정 메뉴에서 검토용 OpenAI 키를 관리합니다</div>
                  </div>
                </div>
                <div className="webhook-input-row">
                  <input
                    className="text-12 webhook-input"
                    type="password"
                    value={openAIApiKeyInput}
                    onChange={(event) => onChangeOpenAIApiKeyInput(event.target.value)}
                    placeholder="sk-..."
                    disabled={currentUserRole !== 'admin'}
                    autoComplete="off"
                  />
                  <button
                    className="primary-btn text-12 webhook-save-btn"
                    type="button"
                    onClick={onSaveOpenAISettings}
                    disabled={currentUserRole !== 'admin'}
                  >
                    <span className="text-12">저장</span>
                  </button>
                </div>
                <div className="prompt-card-note text-12">
                  {currentUserRole === 'admin'
                    ? '저장된 키는 AI 검토 안내 생성에 바로 사용됩니다.'
                    : 'OpenAI 키는 admin만 수정할 수 있습니다.'}
                </div>
              </div>
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
