type ReviewRequestInput = {
  title: string;
  requesterName: string;
  serviceName?: string;
  logFileCount?: number;
  promptText?: string;
  attachments?: Array<{
    fileName: string;
    extension: string;
    mimeType: string;
    size: number;
    previewText: string | null;
  }>;
};

const apiKey = import.meta.env.OPENAI_API_KEY as string | undefined;
const model = (import.meta.env.OPENAI_MODEL as string | undefined) ?? 'gpt-4o-mini';
const provider = import.meta.env.LLM_PROVIDER as string | undefined;

export const isOpenAIConfigured = Boolean(apiKey && model && provider === 'openai');

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
    default:
      return '파일 형식에 맞게 핵심 구조와 이상 패턴을 우선 확인해줘.';
  }
};

const formatAttachmentSummary = (attachments: NonNullable<ReviewRequestInput['attachments']>) =>
  attachments
    .map((item, index) => {
      const preview = item.previewText ? item.previewText.slice(0, 1200) : '내용 미리보기를 추출하지 못했습니다.';
      const instruction = getAttachmentInstruction(item.extension);
      return [
        `${index + 1}. ${item.fileName} (${item.extension || 'unknown'}, ${item.mimeType || 'unknown'}, ${item.size} bytes)`,
        `분석 지시: ${instruction}`,
        preview,
      ].join('\n');
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

export const generateReviewGuide = async (request: ReviewRequestInput) => {
  if (!isOpenAIConfigured) {
    throw new Error('OpenAI 설정이 없습니다.');
  }

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      input: [
        {
          role: 'system',
          content:
            'You are a log review assistant. Reply in Korean and output only one Markdown table. Use exactly these columns: 항목, 내용, 판단, 근거, 조치. Do not add any prose before or after the table. Use concise sentences. Base your analysis primarily on the uploaded file contents and the attached prompt. If a field is missing, write -. Do not use code fences. When judging dates, use calendar-based weekday verification only. Never infer weekend status from a date string without checking the actual weekday. If a date is mentioned, the evidence cell must include the exact date string and the weekday together.',
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
                `- 요청 제목: ${request.title}\n` +
                `- 요청자: ${request.requesterName}\n` +
                `- 서비스명: ${request.serviceName ?? '-'}\n` +
                `- 첨부 파일 수: ${request.logFileCount ?? 0}개\n` +
                `- 첨부 파일 목록: ${(request.attachments ?? []).map((item) => item.fileName).join(', ') || '-'}\n` +
                `- 첨부 파일 분석 메모:\n` +
                (request.attachments?.length ? formatAttachmentSummary(request.attachments) : '-') +
                `\n- 날짜 판정 규칙:\n${getDateRuleInstruction()}` +
                `\n\n결과 요구사항:\n` +
                `- 반드시 첨부 파일에서 확인한 사실을 우선 적어.\n` +
                `- 추측은 최소화하고, 불확실하면 불확실하다고 적어.\n` +
                `- 날짜가 있으면 근거 칸에 날짜 문자열과 요일을 함께 적어.\n` +
                `- YYYY-MM-DD만 보고 주말이라고 쓰지 말고, 실제 달력 요일로만 판단해.\n` +
                `- 업무시간 외 접속, 주말 접속, 반복 패턴, 권한 이탈 여부를 먼저 본 뒤 결과를 정리해.\n` +
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
