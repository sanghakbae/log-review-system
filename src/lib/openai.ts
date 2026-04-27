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

const parseCsvRows = (text: string, maxRows = 25000) => {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const csvText = text.replace(/^\uFEFF/, '');

  for (let index = 0; index < csvText.length; index += 1) {
    const char = csvText[index];
    const nextChar = csvText[index + 1];

    if (quoted) {
      if (char === '"' && nextChar === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n') {
      row.push(cell);
      rows.push(row);
      if (rows.length >= maxRows) return rows;
      row = [];
      cell = '';
    } else if (char !== '\r') {
      cell += char;
    }
  }

  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }

  return rows;
};

const normalizeColumnKey = (value: string) => value.replace(/\s+/g, '').toLowerCase();

const findColumnIndex = (headers: string[], aliases: string[]) => {
  const normalizedAliases = aliases.map(normalizeColumnKey);
  return headers.findIndex((header) => normalizedAliases.includes(normalizeColumnKey(header)));
};

const getCsvCell = (row: string[], headers: string[], aliases: string[]) => {
  const index = findColumnIndex(headers, aliases);
  return index >= 0 ? row[index]?.trim() ?? '' : '';
};

const koreanWeekdays = ['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일'];

const koreanPublicHolidayNamesByDate: Record<string, string> = {
  '2025-01-01': '신정',
  '2025-01-27': '임시공휴일',
  '2025-01-28': '설날 연휴',
  '2025-01-29': '설날',
  '2025-01-30': '설날 연휴',
  '2025-03-01': '삼일절',
  '2025-03-03': '삼일절 대체공휴일',
  '2025-05-05': '어린이날/부처님오신날',
  '2025-05-06': '어린이날/부처님오신날 대체공휴일',
  '2025-06-03': '대통령 선거일 임시공휴일',
  '2025-06-06': '현충일',
  '2025-08-15': '광복절',
  '2025-10-03': '개천절',
  '2025-10-05': '추석 연휴',
  '2025-10-06': '추석',
  '2025-10-07': '추석 연휴',
  '2025-10-08': '추석 대체공휴일',
  '2025-10-09': '한글날',
  '2025-12-25': '성탄절',
  '2026-01-01': '신정',
  '2026-02-16': '설날 연휴',
  '2026-02-17': '설날',
  '2026-02-18': '설날 연휴',
  '2026-03-01': '삼일절',
  '2026-03-02': '삼일절 대체공휴일',
  '2026-05-05': '어린이날',
  '2026-05-24': '부처님오신날',
  '2026-05-25': '부처님오신날 대체공휴일',
  '2026-06-03': '전국동시지방선거일',
  '2026-06-06': '현충일',
  '2026-07-17': '제헌절',
  '2026-08-15': '광복절',
  '2026-08-17': '광복절 대체공휴일',
  '2026-09-24': '추석 연휴',
  '2026-09-25': '추석',
  '2026-09-26': '추석 연휴',
  '2026-10-03': '개천절',
  '2026-10-05': '개천절 대체공휴일',
  '2026-10-09': '한글날',
  '2026-12-25': '성탄절',
  '2027-01-01': '신정',
  '2027-02-06': '설날 연휴',
  '2027-02-07': '설날',
  '2027-02-08': '설날 연휴',
  '2027-03-01': '삼일절',
  '2027-05-05': '어린이날',
  '2027-05-13': '부처님오신날',
  '2027-06-06': '현충일',
  '2027-07-17': '제헌절',
  '2027-08-15': '광복절',
  '2027-08-16': '광복절 대체공휴일',
  '2027-09-14': '추석 연휴',
  '2027-09-15': '추석',
  '2027-09-16': '추석 연휴',
  '2027-10-03': '개천절',
  '2027-10-04': '개천절 대체공휴일',
  '2027-10-09': '한글날',
  '2027-10-11': '한글날 대체공휴일',
  '2027-12-25': '성탄절',
  '2027-12-27': '성탄절 대체공휴일',
  '2028-01-01': '신정',
  '2028-01-26': '설날 연휴',
  '2028-01-27': '설날',
  '2028-01-28': '설날 연휴',
  '2028-03-01': '삼일절',
  '2028-05-02': '부처님오신날',
  '2028-05-05': '어린이날',
  '2028-06-06': '현충일',
  '2028-07-17': '제헌절',
  '2028-08-15': '광복절',
  '2028-10-02': '추석 연휴',
  '2028-10-03': '추석/개천절',
  '2028-10-04': '추석 연휴',
  '2028-10-05': '추석 대체공휴일',
  '2028-10-09': '한글날',
  '2028-12-25': '성탄절',
  '2029-01-01': '신정',
  '2029-02-12': '설날 연휴',
  '2029-02-13': '설날',
  '2029-02-14': '설날 연휴',
  '2029-03-01': '삼일절',
  '2029-05-05': '어린이날',
  '2029-05-07': '어린이날 대체공휴일',
  '2029-05-20': '부처님오신날',
  '2029-05-21': '부처님오신날 대체공휴일',
  '2029-06-06': '현충일',
  '2029-07-17': '제헌절',
  '2029-08-15': '광복절',
  '2029-09-21': '추석 연휴',
  '2029-09-22': '추석',
  '2029-09-23': '추석 연휴',
  '2029-09-24': '추석 대체공휴일',
  '2029-10-03': '개천절',
  '2029-10-09': '한글날',
  '2029-12-25': '성탄절',
  '2030-01-01': '신정',
  '2030-02-02': '설날 연휴',
  '2030-02-03': '설날',
  '2030-02-04': '설날 연휴',
  '2030-02-05': '설날 대체공휴일',
  '2030-03-01': '삼일절',
  '2030-05-05': '어린이날',
  '2030-05-06': '어린이날 대체공휴일',
  '2030-05-09': '부처님오신날',
  '2030-06-06': '현충일',
  '2030-07-17': '제헌절',
  '2030-08-15': '광복절',
  '2030-09-11': '추석 연휴',
  '2030-09-12': '추석',
  '2030-09-13': '추석 연휴',
  '2030-10-03': '개천절',
  '2030-10-09': '한글날',
  '2030-12-25': '성탄절',
};

const getIsoDateText = (dateText: string) => {
  const match = dateText.match(/(\d{4})[-/.]\s?(\d{1,2})[-/.]\s?(\d{1,2})/);
  if (!match) return '';
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!year || !month || !day) return '';
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
};

const getKoreanWeekday = (dateText: string) => {
  const isoDate = getIsoDateText(dateText);
  if (!isoDate) return '';
  const [year, month, day] = isoDate.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(date.getTime())) return '';
  return koreanWeekdays[date.getUTCDay()] ?? '';
};

const getKoreanHolidayInfo = (dateText: string, declaredHolidayText = '') => {
  const isoDate = getIsoDateText(dateText);
  const weekday = getKoreanWeekday(dateText);
  const publicHolidayName = isoDate ? koreanPublicHolidayNamesByDate[isoDate] ?? '' : '';
  const isWeekend = weekday === '토요일' || weekday === '일요일';
  const isDeclaredHoliday = /휴일|공휴일|대체|holiday|true|y|yes|1/i.test(declaredHolidayText);
  const reasons = [
    isWeekend ? weekday : '',
    publicHolidayName ? `대한민국 공휴일(${publicHolidayName})` : '',
    isDeclaredHoliday ? 'CSV 휴일 표시' : '',
  ].filter(Boolean);

  return {
    isoDate,
    weekday,
    isHoliday: reasons.length > 0,
    reason: reasons.join(', '),
  };
};

const getTimeMinutes = (timeText: string) => {
  const match = timeText.match(/(\d{1,2}):(\d{2})(?::\d{2})?/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
};

const summarizeRowsByDate = (
  rows: Array<{
    date: string;
    time: string;
    userId: string;
    name: string;
    terminalId: string;
    mode: string;
    result: string;
  }>,
  limit = 20,
) => {
  const byDate = new Map<
    string,
    {
      count: number;
      weekday: string;
      reason: string;
      users: Map<string, number>;
      times: string[];
      modes: Set<string>;
      terminals: Set<string>;
      examples: string[];
    }
  >();

  for (const row of rows) {
    const holidayInfo = getKoreanHolidayInfo(row.date);
    const key = getIsoDateText(row.date) || row.date || '-';
    const userKey = `${row.userId || '-'} ${row.name || ''}`.trim();
    const current =
      byDate.get(key) ??
      {
        count: 0,
        weekday: holidayInfo.weekday,
        reason: holidayInfo.reason,
        users: new Map<string, number>(),
        times: [],
        modes: new Set<string>(),
        terminals: new Set<string>(),
        examples: [],
      };

    current.count += 1;
    current.users.set(userKey, (current.users.get(userKey) ?? 0) + 1);
    if (row.time) current.times.push(row.time);
    if (row.mode) current.modes.add(row.mode);
    if (row.terminalId) current.terminals.add(row.terminalId);
    if (current.examples.length < 3) {
      current.examples.push(
        `발생시각=${row.time}, 사용자ID=${row.userId}, 이름=${row.name}, 단말기ID=${row.terminalId}, 모드=${row.mode}, 결과=${row.result || '-'}`,
      );
    }
    byDate.set(key, current);
  }

  return Array.from(byDate.entries())
    .sort(([firstDate], [secondDate]) => firstDate.localeCompare(secondDate))
    .slice(0, limit)
    .map(([date, value]) => {
      const userSummary = Array.from(value.users.entries())
        .sort((first, second) => second[1] - first[1])
        .slice(0, 5)
        .map(([user, count]) => `${user} ${count}건`)
        .join(', ');
      const sortedTimes = value.times.sort();
      const timeRange = sortedTimes.length
        ? `${sortedTimes[0]}~${sortedTimes[sortedTimes.length - 1]}`
        : '-';
      return `${date}(${value.weekday || '-'}) ${value.reason ? `[${value.reason}] ` : ''}${value.count}건, 시간대=${timeRange}, 사용자=${userSummary || '-'}, 모드=${Array.from(value.modes).join('/') || '-'}, 단말기=${Array.from(value.terminals).join('/') || '-'}, 예시=(${value.examples.join(' | ')})`;
    });
};

const summarizeCountMap = (items: Map<string, number>, limit = 5, unit = '건') =>
  Array.from(items.entries())
    .sort((first, second) => second[1] - first[1] || first[0].localeCompare(second[0], 'ko'))
    .slice(0, limit)
    .map(([name, count]) => `${name}(${count}${unit})`)
    .join(', ');

const addToCountMap = (items: Map<string, number>, key: string, amount = 1) => {
  const normalizedKey = key.trim() || '미확인';
  items.set(normalizedKey, (items.get(normalizedKey) ?? 0) + amount);
};

const toAccessRecordRows = (previewText: string) => {
  const rows = parseCsvRows(previewText, 25000);
  const headers = rows[0] ?? [];
  return rows.slice(1).map((row, index) => ({
    sourceRow: index + 2,
    date: getCsvCell(row, headers, ['발생일자', '일자', 'date']),
    weekday: getCsvCell(row, headers, ['요일', 'weekday', 'day']),
    holidayFlag: getCsvCell(row, headers, ['휴일', '공휴일', 'holiday', 'isHoliday', 'is_holiday']),
    time: getCsvCell(row, headers, ['발생시각', '시각', '시간', 'time']),
    userId: getCsvCell(row, headers, ['사용자ID', '사용자 ID', 'userId', 'user_id']),
    name: getCsvCell(row, headers, ['이름', '성명', 'name']),
    terminalId: getCsvCell(row, headers, ['단말기ID', '단말기 ID', 'terminalId', 'terminal_id']),
    mode: getCsvCell(row, headers, ['모드', 'mode']),
    auth: getCsvCell(row, headers, ['인증', '인증방식', 'auth']),
    result: getCsvCell(row, headers, ['결과', 'result']),
    employeeNumber: getCsvCell(row, headers, ['사원번호', 'employeeNumber', 'employee_number']),
    position: getCsvCell(row, headers, ['직급', 'position']),
  }));
};

const summarizeAccessRecordCsv = (attachments: NonNullable<ReviewRequestInput['attachments']>) => {
  const rows = attachments.flatMap((attachment) =>
    attachment.previewText ? toAccessRecordRows(attachment.previewText) : [],
  );

  if (rows.length === 0) return '';

  const failureRows = rows.filter((row) => /^(x|fail|failed|실패)$/i.test(row.result.trim()));
  const failureCountByUser = new Map<string, number>();
  for (const row of failureRows) {
    addToCountMap(failureCountByUser, row.name || row.userId || '미확인');
  }
  const byUserDate = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = `${row.userId || row.name || '-'}|${row.date || '-'}`;
    byUserDate.set(key, [...(byUserDate.get(key) ?? []), row]);
  }

  const weekendRows: typeof rows = [];
  const publicHolidayRows: typeof rows = [];
  const allHolidayRows: typeof rows = [];
  const weekendEarlyClockIn: string[] = [];
  const flowIssues: string[] = [];
  const weekendWorkDatesByUser = new Map<string, Set<string>>();
  const publicHolidayWorkDatesByUser = new Map<string, Set<string>>();
  const midnightAccessDatesByUser = new Map<string, Set<string>>();

  for (const [key, group] of byUserDate.entries()) {
    const sorted = [...group].sort((first, second) => (getTimeMinutes(first.time) ?? 0) - (getTimeMinutes(second.time) ?? 0));
    const firstMode = sorted[0]?.mode ?? '';
    if (/퇴근/.test(firstMode) && !sorted.some((row) => /출근/.test(row.mode))) {
      flowIssues.push(`${key}: 출근 없이 퇴근 기록만 존재`);
    }
  }

  for (const row of rows) {
    const holidayInfo = getKoreanHolidayInfo(row.date, `${row.weekday} ${row.holidayFlag}`);
    const minutes = getTimeMinutes(row.time);
    const userKey = row.name || row.userId || '미확인';
    const dateKey = getIsoDateText(row.date) || row.date || '-';
    const isWorkMode = /출근/.test(row.mode);
    if (holidayInfo.weekday === '토요일' || holidayInfo.weekday === '일요일') {
      weekendRows.push(row);
      if (isWorkMode) {
        const dates = weekendWorkDatesByUser.get(userKey) ?? new Set<string>();
        dates.add(dateKey);
        weekendWorkDatesByUser.set(userKey, dates);
      }
    }
    if (holidayInfo.isHoliday) {
      allHolidayRows.push(row);
    }
    if (holidayInfo.isHoliday && !(holidayInfo.weekday === '토요일' || holidayInfo.weekday === '일요일')) {
      publicHolidayRows.push(row);
      if (isWorkMode) {
        const dates = publicHolidayWorkDatesByUser.get(userKey) ?? new Set<string>();
        dates.add(dateKey);
        publicHolidayWorkDatesByUser.set(userKey, dates);
      }
    }
    if (minutes !== null && minutes >= 0 && minutes <= 5 * 60) {
      const dates = midnightAccessDatesByUser.get(userKey) ?? new Set<string>();
      dates.add(dateKey);
      midnightAccessDatesByUser.set(userKey, dates);
    }
    if (holidayInfo.isHoliday && minutes !== null && minutes < 8 * 60 && /출근/.test(row.mode)) {
      weekendEarlyClockIn.push(
        `발생일자=${row.date}, 요일=${holidayInfo.weekday || row.weekday || '-'}, 휴일근거=${holidayInfo.reason || '-'}, 발생시각=${row.time}, 사용자ID=${row.userId}, 이름=${row.name}, 모드=${row.mode}`,
      );
    }
  }
  const weekendWorkers = new Map(Array.from(weekendWorkDatesByUser.entries()).map(([name, dates]) => [name, dates.size]));
  const publicHolidayWorkers = new Map(Array.from(publicHolidayWorkDatesByUser.entries()).map(([name, dates]) => [name, dates.size]));
  const midnightAccessUsers = new Map(Array.from(midnightAccessDatesByUser.entries()).map(([name, dates]) => [name, dates.size]));

  return [
    '출입기록 CSV 사전 계산 요약:',
    `- 분석 가능한 샘플 행 수: ${rows.length}건`,
    `- 주말 출근자(상위 5명, 사용자별 출근 날짜 수): ${weekendWorkers.size ? summarizeCountMap(weekendWorkers, 5, '일') : '확인된 항목 없음'}`,
    `- 공휴일 출근자(상위 5명, 사용자별 출근 날짜 수): ${publicHolidayWorkers.size ? summarizeCountMap(publicHolidayWorkers, 5, '일') : '확인된 항목 없음'}`,
    `- 00시~05시 출입자(상위 5명, 사용자별 출입 날짜 수): ${midnightAccessUsers.size ? summarizeCountMap(midnightAccessUsers, 5, '일') : '확인된 항목 없음'}`,
    `- 인증실패(상위 5명, 사용자별 실패 건수): ${failureCountByUser.size ? summarizeCountMap(failureCountByUser, 5, '건') : '확인된 항목 없음'}`,
    `- 주말 출입 기록(검증용 날짜별 요약): ${weekendRows.length ? summarizeRowsByDate(weekendRows, 8).join(' / ') : '확인된 항목 없음'}`,
    `- 한국 기준 공휴일 출입 기록(검증용 날짜별 요약): ${publicHolidayRows.length ? summarizeRowsByDate(publicHolidayRows, 8).join(' / ') : '확인된 항목 없음'}`,
    `- 한국 기준 전체 휴일 출입 기록(주말+공휴일 합산): ${allHolidayRows.length}건, 날짜=${Array.from(new Set(allHolidayRows.map((row) => getIsoDateText(row.date) || row.date).filter(Boolean))).sort().join(', ') || '-'}`,
    `- 한국 기준 휴일 새벽 출근: ${weekendEarlyClockIn.length ? weekendEarlyClockIn.slice(0, 5).join(' / ') : '확인된 항목 없음'}`,
    `- 출입 흐름 정합성 후보: ${flowIssues.length ? flowIssues.slice(0, 5).join(' / ') : '확인된 항목 없음'}`,
    '- 제외 기준: 동일 사용자 다중 단말기 사용, 짧은 시간 내 반복 인증, 사용자 마스터 정보 누락은 별도 요청이 없으면 결과 항목으로 만들지 말 것.',
    '- 주의: 위 사전 계산 요약과 모순되는 요일/휴일 판단을 쓰지 말 것. 예를 들어 실제 요일이 금요일이면 일요일로 쓰면 안 된다.',
  ].join('\n');
};

const formatAttachmentSummary = (attachments: NonNullable<ReviewRequestInput['attachments']>, serviceName?: string) =>
  attachments
    .map((item, index) => {
      const usesParsedCsv = Boolean(item.parsedToCsv || item.convertedFromLog);
      const isAccessRecord = serviceName?.trim() === '출입기록';
      const previewLimit = isAccessRecord ? 120000 : item.extension === 'xlsx' || usesParsedCsv ? 80000 : 60000;
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
        '첨부 파일에서 분석용으로 읽은 내용:',
        preview,
      ].filter(Boolean).join('\n');
    })
    .join('\n\n');

const getDateRuleInstruction = () =>
  [
    '날짜가 보이면 반드시 달력 기준으로 요일을 먼저 확인해.',
    'YYYY-MM-DD 형식의 날짜를 보고 주말이라고 추정하지 마.',
    '주말 판정은 해당 날짜가 실제로 토요일 또는 일요일인 경우에만 하라.',
    '휴일 판정은 대한민국 기준 주말, 법정 공휴일, 대체공휴일, 임시공휴일, CSV 내 휴일 표시를 포함한다.',
    '근거에는 휴일 여부를 판단한 근거를 함께 적어라. 예: 휴일근거=대한민국 공휴일(삼일절 대체공휴일), 휴일근거=토요일.',
    '근거에는 날짜 문자열과 함께 확인한 요일을 같이 적어라.',
    '날짜가 불명확하면 주말 여부를 단정하지 말고 "확인 불가" 또는 "-"로 적어라.',
  ].join(' ');

const getServiceSpecificInstruction = (serviceName?: string) => {
  if (serviceName?.trim() === '출입기록') {
    return [
      '출입기록 서비스는 다음 항목을 반드시 점검하고, 표가 아니라 요약 문단과 불릿으로 작성한다.',
      '1. 인증 실패 집중도: 결과=X 또는 실패 건을 사용자ID와 이름 기준으로 집계해 누가 몇 번 실패했는지 적는다.',
      '2. 주말 출근자는 건수가 아니라 사용자별 출근 날짜 수로 계산한다. 예: 홍길동(2일), 김흥국(3일).',
      '3. 공휴일 출근자는 건수가 아니라 사용자별 출근 날짜 수로 계산한다. 예: 김말숙(1일).',
      '4. 00시~05시 출입자는 건수가 아니라 사용자별 출입 날짜 수로 계산한다. 예: 신동호(4일).',
      '5. 휴일 새벽 출근 이력: 주말 또는 공휴일 출입 중 발생시각이 새벽 시간대인 출근 모드 기록을 별도 위험 후보로 확인한다.',
      '6. 출입 흐름 정합성: 출근 없이 퇴근, 퇴근 없이 야간 출입, 외출 후 복귀 누락 등 모드 순서 이상을 확인한다.',
      '7. 인증 수단 편중: 얼굴/카드 등 인증 방식이 특정 사용자ID, 단말기ID, 시간대에 몰리는지 확인한다.',
      '출력은 각 항목별 최대 5명까지만 요약한다.',
      '출력 예시는 다음 형식을 따른다: 주말 출근자: 홍길동(2일), 김흥국(3일) / 공휴일 출근자: 김말숙(1일) / 00시~05시 출입자: 신동호(4일) / 인증실패: 백승화(100건), ####(50건).',
      '동일 사용자 다중 단말기 사용, 짧은 시간 내 반복 인증, 사용자 마스터 정보 누락은 별도 요청이 없으면 결과 항목으로 만들지 않는다.',
      '각 항목의 근거에는 실제 로그 값 또는 집계 기준을 포함한다. 예: 발생일자=..., 요일=..., 발생시각=..., 사용자ID=..., 이름=..., 단말기ID=..., 모드=..., 인증=..., 결과=..., 시트명/행 번호.',
    ].join('\n');
  }

  if (serviceName?.trim() !== '카피킬러') {
    return '-';
  }

  return [
    '카피킬러 서비스는 다음 7개 항목을 반드시 점검하고, 표가 아니라 SUMMARY 형식으로 요약한다.',
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
  const isAccessRecordService = request.serviceName?.trim() === '출입기록';
  const attachmentAnalysisMemo =
    isAccessRecordService && request.attachments?.length
      ? summarizeAccessRecordCsv(request.attachments)
      : '';
  const systemOutputInstruction =
    'You are a log review assistant. Reply in Korean. Do not output a Markdown table for any service. Output SUMMARY only, using concise sections and bullet points. Include concrete evidence values from the attached file such as sheet name, row number, column names, date, weekday, time range, account, email, IP address, URI, action, filename, user ID, name, terminal ID, mode, result, and counts. Do not use code fences. Do not add unsupported findings. When judging dates, use calendar-based weekday verification only. Never infer weekend status from a date string without checking the actual weekday.';

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
      content: systemOutputInstruction,
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
                (request.attachments?.length ? formatAttachmentSummary(request.attachments, request.serviceName) : '-') +
                `\n\n- 파일 사전 계산 요약:\n${attachmentAnalysisMemo || '-'}\n` +
                `\n- 서비스별 필수 점검 항목:\n${getServiceSpecificInstruction(request.serviceName)}` +
                `\n- 날짜 판정 규칙:\n${getDateRuleInstruction()}` +
                `\n\n결과 요구사항:\n` +
                `- 반드시 첨부 파일에서 확인한 사실을 우선 적어.\n` +
                `- 분석 기준은 UI의 파싱 CSV 미리보기가 아니라 실제 첨부 파일을 다시 읽어 추출한 분석용 내용이다.\n` +
                `- 업로드 파일이 파싱 CSV로 변환된 경우, 분석은 반드시 변환된 CSV 컬럼과 값 기준으로 수행해.\n` +
                `- 파일 사전 계산 요약이 있으면 그 요약과 모순되는 결과를 쓰지 마.\n` +
                `- 출입기록 CSV는 발생일자, 발생시각, 사용자ID, 이름, 단말기ID, 모드, 인증, 결과, 사원번호, 직급 컬럼을 우선 근거로 사용해.\n` +
                `- 먼저 현재 첨부 파일에서 점검할 만한 항목을 목록화하듯 식별한 뒤, 근거가 있는 항목만 SUMMARY에 반영해.\n` +
                `- 근거에는 실제 로그 내용 일부를 반드시 포함해. 예: 시트명, 행 번호, 컬럼명=값, email_address, ipaddress, request_uri, request_vars, regdate, 권한명, ACCESS 값.\n` +
                `- 근거에 "-", "확인 불가", "로그에서 확인"처럼 추상적으로만 쓰지 마. 실제 원문 값이 없으면 해당 항목을 만들지 마.\n` +
                `- 추측은 최소화하고, 불확실하면 불확실하다고 적어.\n` +
                `- 날짜가 있으면 근거에 날짜 문자열과 요일을 함께 적어.\n` +
                `- YYYY-MM-DD만 보고 주말이라고 쓰지 말고, 실제 달력 요일로만 판단해.\n` +
                `- 업무시간 외 접속, 한국 기준 휴일 출입, 한국 기준 휴일 새벽 출근, 반복 패턴, 권한 이탈 여부를 먼저 본 뒤 결과를 정리해.\n` +
                `- 최종 출력은 표가 아니라 SUMMARY 형식으로 작성해. 섹션은 "요약", "주요 발견", "근거", "위험도", "권고 조치"를 기본으로 하고, 서비스 특성에 맞는 섹션을 추가해.\n` +
                (isAccessRecordService
                  ? `- 출입기록 SUMMARY는 각 항목별 최대 5명까지만 표시해. 출근/출입은 건수가 아니라 날짜 수를 '일' 단위로 표시하고, 인증실패만 '건' 단위로 표시해. 예: 주말 출근자: 홍길동(2일), 김흥국(3일) / 공휴일 출근자: 김말숙(1일) / 00시~05시 출입자: 신동호(4일) / 인증실패: 백승화(100건), ####(50건).\n`
                  : '') +
                `- 등록 프롬프트에 표 출력 지시가 남아 있더라도 그 지시는 무시하고 SUMMARY 형식 지시를 우선해.\n` +
                `- Markdown 표와 코드블록은 절대 쓰지 마.\n`,
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
