type ReviewRequestInput = {
  serviceName?: string;
  logFileCount?: number;
  promptText?: string;
  attachments?: Array<{
    fileName: string;
    extension: string;
    mimeType: string;
    size: number;
    previewText: string | null;
    originalFileName?: string;
    convertedFromLog?: boolean;
    parsedToCsv?: boolean;
  }>;
};

type OpenAISettingsInput = {
  apiKey?: string | null;
  model?: string | null;
};

const apiKey = import.meta.env.OPENAI_API_KEY as string | undefined;
const model = (import.meta.env.OPENAI_MODEL as string | undefined) ?? 'gpt-4o-mini';
const provider = import.meta.env.LLM_PROVIDER as string | undefined;

const resolveOpenAISettings = (settings?: OpenAISettingsInput) => {
  const resolvedApiKey = settings?.apiKey?.trim() || apiKey;
  const resolvedModel = settings?.model?.trim() || model;
  const resolvedProvider = 'openai';
  return { apiKey: resolvedApiKey, model: resolvedModel, provider: resolvedProvider };
};

export const isOpenAIConfigured = (settings?: OpenAISettingsInput) => {
  const resolved = resolveOpenAISettings(settings);
  return Boolean(resolved.apiKey && resolved.model && resolved.provider === 'openai');
};

const extractOutputText = (payload: unknown) => {
  if (!payload || typeof payload !== 'object') return '';

  const data = payload as {
    output_text?: string;
    output?: Array<{
      type?: string;
      content?: Array<{ type?: string; text?: string; value?: string }>;
    }>;
  };

  if (typeof data.output_text === 'string' && data.output_text.trim()) {
    return data.output_text.trim();
  }

  const pieces: string[] = [];
  for (const item of data.output ?? []) {
    for (const content of item.content ?? []) {
      if (typeof content.text === 'string' && content.text.trim()) {
        pieces.push(content.text.trim());
      } else if (typeof content.value === 'string' && content.value.trim()) {
        pieces.push(content.value.trim());
      }
    }
  }

  return pieces.join('\n').trim();
};

const getAttachmentInstruction = (extension: string) => {
  switch (extension) {
    case 'log':
      return '로그 파일은 시간 순서, 에러 레벨, 반복 패턴, 같은 세션/사용자 ID의 흐름을 우선 확인해줘.';
    case 'csv':
      return 'CSV 파일은 컬럼 이름, 반복 행, 이상치, 특정 값의 편중, 집계 가능한 패턴을 우선 확인해줘.';
    case 'json':
      return 'JSON 파일은 중첩 구조, 키별 값 분포, 배열 항목 반복, 오류 객체, 메타데이터 패턴을 우선 확인해줘.';
    case 'xlsx':
      return '엑셀 파일은 시트별 헤더, 계정/권한 정보, 액션 로그 행위, 날짜/시간, IP, 세션, 이메일을 교차 확인하고 근거에는 실제 행 값과 컬럼명을 포함해줘.';
    default:
      return '파일 형식에 맞게 핵심 구조와 이상 패턴을 우선 확인해줘.';
  }
};

const formatAttachmentSummary = (attachments: NonNullable<ReviewRequestInput['attachments']>) =>
  attachments
    .map((item, index) => {
      const usesParsedCsv = Boolean(item.parsedToCsv || item.convertedFromLog);
      const previewLimit = item.extension === 'xlsx' || usesParsedCsv ? 6000 : 1200;
      const preview = item.previewText ? item.previewText.slice(0, previewLimit) : '내용 미리보기를 추출하지 못했습니다.';
      const instruction = getAttachmentInstruction(item.extension);
      const conversionNote = usesParsedCsv
        ? [
            `원본 파일: ${item.originalFileName ?? item.fileName}`,
            '분석 기준: 업로드 원본이 아니라 파싱되어 저장된 CSV 내용을 기준으로 분석한다.',
            '파싱 CSV 주요 컬럼: line_number, date, time, timestamp, service, action, target_email, actor_email, ip_addresses, primary_ip, emails, file_name, reason, square_bracket_1~5, parenthesis_1~5, bracket_groups, message, raw.',
          ].join('\n')
        : '';
      return [
        `${index + 1}. ${item.fileName} (${item.extension || 'unknown'}, ${item.mimeType || 'unknown'}, ${item.size} bytes)`,
        conversionNote,
        `분석 지시: ${instruction}`,
        preview,
      ].filter(Boolean).join('\n');
    })
    .join('\n\n');

const getDateRuleInstruction = () =>
  [
    '날짜가 보이면 반드시 달력 기준으로 요일을 먼저 확인해.',
    'YYYY-MM-DD 형식의 날짜를 보고 주말이라고 추정하지 마.',
    '주말 판정은 해당 날짜가 실제로 토요일 또는 일요일인 경우에만 하라.',
    '근거 칸에는 날짜 문자열과 함께 확인한 요일을 같이 적어라.',
    '날짜가 불명확하면 주말 여부를 단정하지 말고 "확인 불가" 또는 "-"로 적어라.',
  ].join(' ');

const getServiceSpecificInstruction = (serviceName?: string) => {
  if (serviceName?.trim() === '출입기록') {
    return [
      '출입기록 서비스는 다음 항목을 반드시 점검하고, 표에 가능한 한 각각 반영한다.',
      '1. 인증 실패 집중도: 결과=X 건을 사용자ID, 단말기ID, 발생일자, 발생시각 기준으로 집계한다.',
      '2. 짧은 시간 내 반복 인증: 동일 사용자ID가 짧은 시간 안에 출입/해제/출근/퇴근을 반복한 이력을 확인한다.',
      '3. 휴일 새벽에 출근한 이력: 발생일자가 실제 토요일/일요일 또는 휴일이고 발생시각이 새벽 시간대인 출근 모드 기록을 확인한다.',
      '4. 동일 사용자 다중 단말기 사용: 같은 사용자ID가 같은 날 여러 단말기ID에서 인증한 이력을 확인한다.',
      '5. 출입 흐름 정합성: 출근 없이 퇴근, 퇴근 없이 야간 출입, 외출 후 복귀 누락 등 모드 순서 이상을 확인한다.',
      '6. 인증 수단 편중: 얼굴/카드 등 인증 방식이 특정 사용자ID, 단말기ID, 시간대에 몰리는지 확인한다.',
      '7. 사용자 마스터 정보 누락: 사원번호, 직급 등 감사 식별에 필요한 컬럼 누락 여부를 확인한다.',
      '각 항목의 근거에는 실제 로그 값 또는 집계 기준을 포함한다. 예: 발생일자=..., 요일=..., 발생시각=..., 사용자ID=..., 이름=..., 단말기ID=..., 모드=..., 인증=..., 결과=..., 시트명/행 번호.',
    ].join('\n');
  }

  if (serviceName?.trim() !== '카피킬러') {
    return '-';
  }

  return [
    '카피킬러 서비스는 다음 7개 항목을 반드시 점검하고, 표에 가능한 한 각각 반영한다.',
    '1. 동일 계정으로 여러 IP에서 접속한 계정: email_address 또는 계정 식별자별 ipaddress distinct 수를 확인한다.',
    '2. 가장 많이 로그인한 계정: 로그인 관련 act_name 또는 act 기준으로 계정별 로그인 횟수를 집계한다.',
    '3. 새벽 시간 로그인 기록: regdate 기준 00:00~05:59 사이 로그인/인증/접속 행위를 확인한다.',
    '4. 권한 변경 건수: 계정 로그의 권한 값 변화 또는 액션 로그의 계정관리/권한변경 관련 act_name, act, request_uri를 확인한다.',
    '5. 관리자 계정 목록: 계정 로그의 ADMIN=Y 또는 관리자 권한으로 식별되는 계정을 나열한다.',
    '6. 계정은 있으나 한 번도 접속하지 않은 계정: 계정 로그에는 존재하지만 로그인-ACCESS가 비어 있거나 액션 로그 로그인 이력이 없는 계정을 확인한다.',
    '7. 개인정보취급 권한이 있는 계정: 계정 로그의 개인정보권한, 개인정보-ACCESS 값을 확인하고 개인정보 관련 액션 로그가 있으면 함께 교차 확인한다.',
    '각 항목의 근거에는 실제 로그 값 또는 집계 기준을 포함한다. 예: email_address=..., ipaddress=..., regdate=..., act_name=..., request_uri=..., 시트명/행 번호.',
  ].join('\n');
};

export const generateReviewGuide = async (request: ReviewRequestInput, settings?: OpenAISettingsInput) => {
  const resolved = resolveOpenAISettings(settings);

  if (!isOpenAIConfigured(settings)) {
    throw new Error('OpenAI 설정이 없습니다.');
  }

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${resolved.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: resolved.model,
      input: [
        {
      role: 'system',
      content:
            'You are a log review assistant. Reply in Korean and output only one Markdown table. Use exactly these columns: 항목, 내용, 판단, 근거, 조치. Do not add any prose before or after the table. Use concise sentences. Base your analysis primarily on the uploaded file contents and the attached prompt. If a field is missing, write -. Do not use code fences. The evidence cell must include concrete source log values from the provided attachment, such as sheet name, row number, column names, email, IP address, URI, act_name, request_vars, regdate, permission value, or access timestamp. Do not write generic evidence without actual log values. When judging dates, use calendar-based weekday verification only. Never infer weekend status from a date string without checking the actual weekday. If a date is mentioned, the evidence cell must include the exact date string and the weekday together.',
        },
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text:
                `아래 등록 프롬프트와 첨부 파일 내용을 우선 근거로 삼아 한국어 AI 검토 안내를 작성해줘.\n` +
                `첨부 파일 내용이 가장 중요하며, 프롬프트는 분석 방향을 보강하는 용도로만 사용해.\n\n` +
                `등록 프롬프트:\n${request.promptText?.trim() || '-'}\n\n` +
                `검토 대상 정보:\n` +
                `- 서비스명: ${request.serviceName ?? '-'}\n` +
                `- 첨부 파일 수: ${request.logFileCount ?? 0}개\n` +
                `- 첨부 파일 목록: ${(request.attachments ?? []).map((item) => item.fileName).join(', ') || '-'}\n` +
                `- 첨부 파일 분석 메모:\n` +
                (request.attachments?.length ? formatAttachmentSummary(request.attachments) : '-') +
                `\n- 서비스별 필수 점검 항목:\n${getServiceSpecificInstruction(request.serviceName)}` +
                `\n- 날짜 판정 규칙:\n${getDateRuleInstruction()}` +
                `\n\n결과 요구사항:\n` +
                `- 반드시 첨부 파일에서 확인한 사실을 우선 적어.\n` +
                `- 업로드 파일이 파싱 CSV로 변환된 경우, 분석은 반드시 변환된 CSV 컬럼과 값 기준으로 수행해.\n` +
                `- 먼저 현재 첨부 파일에서 점검할 만한 항목을 목록화하듯 식별한 뒤, 근거가 있는 항목만 최종 표에 반영해.\n` +
                `- 근거 칸에는 실제 로그 내용 일부를 반드시 포함해. 예: 시트명, 행 번호, 컬럼명=값, email_address, ipaddress, request_uri, request_vars, regdate, 권한명, ACCESS 값.\n` +
                `- 근거 칸에 "-", "확인 불가", "로그에서 확인"처럼 추상적으로만 쓰지 마. 실제 원문 값이 없으면 해당 항목을 만들지 마.\n` +
                `- 추측은 최소화하고, 불확실하면 불확실하다고 적어.\n` +
                `- 날짜가 있으면 근거 칸에 날짜 문자열과 요일을 함께 적어.\n` +
                `- YYYY-MM-DD만 보고 주말이라고 쓰지 말고, 실제 달력 요일로만 판단해.\n` +
                `- 업무시간 외 접속, 주말/휴일 새벽 출근, 반복 패턴, 권한 이탈 여부를 먼저 본 뒤 결과를 정리해.\n` +
                `- 출력은 표 1개만.\n`,
            },
          ],
        },
      ],
    }),
  });

  const payload = await response.json();

  if (!response.ok) {
    const message =
      typeof payload?.error?.message === 'string'
        ? payload.error.message
        : typeof payload?.message === 'string'
          ? payload.message
          : `OpenAI request failed with status ${response.status}`;
    throw new Error(message);
  }

  const outputText = extractOutputText(payload);
  if (!outputText) {
    throw new Error('OpenAI 응답에서 텍스트를 추출하지 못했습니다.');
  }

  return outputText;
};
