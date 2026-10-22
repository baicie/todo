import { isDateOnly, isBefore, parseDateOnly, weekdayIso, zonedDateTimeToUtc } from './dates';
import {
  DomainError,
  type DateOnly,
  type NewTask,
  type Recurrence,
  type Task,
  type TaskList,
  type TaskPatch,
  type TaskQuery,
} from './types';
import { normalizeRecurrence } from './recurrence';

export const MAX_TITLE_LENGTH = 1000;
export const MAX_NOTE_LENGTH = 20_000;
export const MAX_LIST_NAME_LENGTH = 120;
export const MAX_TAGS = 20;
export const MAX_TAG_LENGTH = 32;

export function normalizeTags(tags: string[] | undefined): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of tags ?? []) {
    const tag = cleanSingleLine(String(raw), MAX_TAG_LENGTH).replace(/^#+/, '');
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(tag);
    if (result.length >= MAX_TAGS) break;
  }
  return result;
}

export function cleanSingleLine(value: string, maxLength = MAX_TITLE_LENGTH): string {
  return value
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, maxLength);
}

export function cleanNote(value: string): string {
  return value.replace(/\r\n/g, '\n').slice(0, MAX_NOTE_LENGTH);
}

export function assertTitle(title: string): string {
  const cleaned = cleanSingleLine(title);
  if (!cleaned) throw new DomainError('VALIDATION_FAILED', '任务标题不能为空');
  return cleaned;
}

export function validateTaskPatch(patch: TaskPatch): TaskPatch {
  const result: TaskPatch = { ...patch };
  if ('title' in patch) result.title = assertTitle(patch.title ?? '');
  if ('note' in patch) result.note = cleanNote(patch.note ?? '');
  if ('tags' in patch) result.tags = normalizeTags(patch.tags);
  if ('dueOn' in patch && patch.dueOn !== null && !isDateOnly(patch.dueOn)) {
    throw new DomainError('INVALID_DATE', '截止日期格式应为 YYYY-MM-DD');
  }
  if ('remindAt' in patch && patch.remindAt !== null) {
    const date = new Date(patch.remindAt ?? '');
    if (Number.isNaN(date.getTime())) {
      throw new DomainError('INVALID_DATE', '提醒时间无效');
    }
    result.remindAt = date.toISOString();
  }
  if ('recurrence' in patch) {
    result.recurrence = normalizeRecurrence(patch.recurrence);
  }
  if (patch.status === 'completed') {
    result.completedAt = patch.completedAt ?? new Date().toISOString();
  } else if (patch.status === 'open') {
    result.completedAt = null;
  }
  return result;
}

export function normalizeNewTask(input: NewTask): NewTask {
  const title = assertTitle(input.title);
  if (input.dueOn && !isDateOnly(input.dueOn)) {
    throw new DomainError('INVALID_DATE', '截止日期格式应为 YYYY-MM-DD');
  }
  if (input.planDate && !isDateOnly(input.planDate)) {
    throw new DomainError('INVALID_DATE', '计划日期格式应为 YYYY-MM-DD');
  }
  return {
    ...input,
    title,
    note: cleanNote(input.note ?? ''),
    tags: normalizeTags(input.tags),
    important: input.important ?? false,
    dueOn: input.dueOn ?? null,
    remindAt: input.remindAt ?? null,
    remindTimezone: input.remindTimezone ?? null,
    recurrence: normalizeRecurrence(input.recurrence),
  };
}

export function makeTask(id: string, input: NewTask, now: string, fallbackRank = 'a0'): Task {
  return {
    id,
    listId: input.listId ?? null,
    title: input.title,
    note: input.note ?? '',
    tags: normalizeTags(input.tags),
    status: 'open',
    important: input.important ?? false,
    dueOn: input.dueOn ?? null,
    remindAt: input.remindAt ?? null,
    remindTimezone: input.remindTimezone ?? null,
    rank: input.rank ?? fallbackRank,
    seriesId: null,
    occurrenceKey: input.dueOn ?? null,
    recurrence: input.recurrence ?? null,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
}

export function makeList(id: string, name: string, now: string): TaskList {
  const cleaned = cleanSingleLine(name, MAX_LIST_NAME_LENGTH);
  if (!cleaned) throw new DomainError('VALIDATION_FAILED', '清单名称不能为空');
  return {
    id,
    name: cleaned,
    color: null,
    icon: null,
    rank: 'a0',
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
}

export function normalizeSearch(search: string): string {
  return search.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function isTaskVisible(task: Task): boolean {
  return task.deletedAt === null;
}

function taskMatchesTokens(task: Task, tokens: string[]): boolean {
  if (tokens.length === 0) return true;
  const haystack = `${task.title}\n${task.note}\n${(task.tags ?? []).join(' ')}`.toLowerCase();
  return tokens.every((token) => haystack.includes(token));
}

export function taskMatchesSearch(task: Task, search: string): boolean {
  return taskMatchesTokens(task, normalizeSearch(search).split(' ').filter(Boolean));
}

export function sortTasks(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    if (a.status !== b.status) return a.status === 'open' ? -1 : 1;
    if (a.dueOn && b.dueOn && a.dueOn !== b.dueOn) return a.dueOn < b.dueOn ? -1 : 1;
    if (a.dueOn && !b.dueOn) return -1;
    if (!a.dueOn && b.dueOn) return 1;
    if (a.rank !== b.rank) return a.rank < b.rank ? -1 : 1;
    return a.createdAt < b.createdAt ? -1 : 1;
  });
}

export function dueBucket(task: Task, today: DateOnly): 'overdue' | 'today' | 'upcoming' | 'none' {
  if (!task.dueOn) return 'none';
  if (isBefore(task.dueOn, today)) return 'overdue';
  if (task.dueOn === today) return 'today';
  return 'upcoming';
}

export function parseNaturalDate(
  text: string,
  today: DateOnly,
): { title: string; dueOn: DateOnly | null; recurrence: Recurrence | null } {
  let title = text.trim();
  let dueOn: DateOnly | null = null;
  let recurrence: Recurrence | null = null;
  const remove = (pattern: RegExp | string) => {
    title = title
      .replace(pattern, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
  };
  const offsetDate = (offset: number): DateOnly => {
    const date = new Date(`${today}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + offset);
    return date.toISOString().slice(0, 10);
  };
  const weekdayTarget = (value: string): number =>
    ({ 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 })[value] ?? 0;

  const weekdayMatch = /(?:^|\s)(每)?(下)?(?:周|星期|礼拜)([一二三四五六日天])(?:\s|$)/.exec(title);
  if (weekdayMatch) {
    const everyWeek = Boolean(weekdayMatch[1]);
    const target = weekdayTarget(weekdayMatch[3] ?? '');
    if (target) {
      const current = weekdayIso(today);
      let offset = (target - current + 7) % 7;
      if (weekdayMatch[2]) {
        offset = 7 - current + target;
        if (offset <= 0) offset += 7;
      }
      dueOn = offsetDate(offset);
      recurrence = everyWeek ? { frequency: 'weekly', interval: 1, weekdays: [target] } : null;
      remove(weekdayMatch[0]);
      return { title, dueOn, recurrence };
    }
  }

  const monthMatch = /(?:^|\s)下月(\d{1,2})(?:号|日)?(?:\s|$)/.exec(title);
  if (monthMatch) {
    const day = Number.parseInt(monthMatch[1] ?? '', 10);
    if (day >= 1 && day <= 31) {
      const base = new Date(`${today}T00:00:00Z`);
      base.setUTCMonth(base.getUTCMonth() + 1, Math.min(day, 28));
      dueOn = base.toISOString().slice(0, 10);
      recurrence = { frequency: 'monthly', interval: 1, monthDay: day };
      remove(monthMatch[0]);
      return { title, dueOn, recurrence };
    }
  }

  const rules: Array<{ pattern: RegExp; offset: number }> = [
    { pattern: /(?:^|\s)今天(?:\s|$)/, offset: 0 },
    { pattern: /(?:^|\s)明天(?:\s|$)/, offset: 1 },
    { pattern: /(?:^|\s)后天(?:\s|$)/, offset: 2 },
  ];
  for (const rule of rules) {
    if (rule.pattern.test(title)) {
      dueOn = offsetDate(rule.offset);
      remove(rule.pattern);
      return { title, dueOn, recurrence };
    }
  }

  if (/(?:^|\s)每天(?:\s|$)/.test(title)) {
    dueOn = today;
    recurrence = { frequency: 'daily', interval: 1 };
    remove(/(?:^|\s)每天(?:\s|$)/);
  } else if (/(?:^|\s)每个工作日(?:\s|$)/.test(title)) {
    dueOn = today;
    recurrence = { frequency: 'weekdays', interval: 1 };
    remove(/(?:^|\s)每个工作日(?:\s|$)/);
  }

  return { title, dueOn, recurrence };
}

export function parseQuickAdd(
  text: string,
  today: DateOnly,
  lists: TaskList[],
  fallbackListId: string | null,
  timeZone = 'UTC',
): NewTask & { listId: string | null } {
  let title = text;
  let listId = fallbackListId;
  const listMatch = /(?:^|\s)@([^\s@]+)/.exec(title);
  if (listMatch) {
    const list = lists.find((item) => item.name === listMatch[1]);
    if (list) {
      listId = list.id;
      title = title
        .replace(listMatch[0], ' ')
        .replace(/\s{2,}/g, ' ')
        .trim();
    }
  }
  const tags = normalizeTags(
    [...title.matchAll(/(?:^|\s)#([^\s#]+)/g)]
      .map((match) => {
        const value = match[1] ?? '';
        const list = lists.find((item) => item.name === value);
        if (list) {
          listId = list.id;
          return '';
        }
        return value;
      })
      .filter(Boolean),
  );
  title = title.replace(/(?:^|\s)#[^\s#]+/g, ' ');
  const important = /(?:^|\s)!(?:重要)?(?:\s|$)/.test(title);
  title = title
    .replace(/(?:^|\s)!(?:重要)?(?=\s|$)/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  const natural = parseNaturalDate(title, today);
  let dueOn = natural.dueOn;
  let remindAt: string | null = null;
  let reminderTitle = natural.title;
  const timeMatch =
    /(?:^|\s)(凌晨|早上|上午|中午|下午|傍晚|晚上)?\s*(\d{1,2})(?::|点|时)(\d{1,2})?(?:\s|$)/.exec(
      reminderTitle,
    );
  if (timeMatch) {
    const hourValue = Number.parseInt(timeMatch[2] ?? '', 10);
    const minuteValue = Number.parseInt(timeMatch[3] ?? '0', 10);
    let hour = hourValue;
    const period = timeMatch[1];
    if (period === '下午' || period === '傍晚' || period === '晚上') {
      if (hour < 12) hour += 12;
    } else if (period === '中午' && hour < 11) {
      hour += 12;
    } else if (period === '凌晨' && hour === 12) {
      hour = 0;
    }
    if (hour >= 0 && hour <= 23 && minuteValue >= 0 && minuteValue <= 59) {
      dueOn ??= today;
      const localDateTime = `${dueOn}T${hour.toString().padStart(2, '0')}:${minuteValue
        .toString()
        .padStart(2, '0')}`;
      try {
        remindAt = zonedDateTimeToUtc(localDateTime, timeZone);
      } catch {
        remindAt = null;
      }
      reminderTitle = reminderTitle
        .replace(timeMatch[0], ' ')
        .replace(/\s{2,}/g, ' ')
        .trim();
    }
  }
  return {
    title: reminderTitle,
    dueOn,
    remindAt,
    remindTimezone: remindAt ? timeZone : null,
    listId,
    important,
    tags,
    recurrence: natural.recurrence,
  };
}

export function taskQueryPredicate(query: TaskQuery): (task: Task) => boolean {
  const tokens = normalizeSearch(query.search ?? '')
    .split(' ')
    .filter(Boolean);
  return (task) => {
    if (!isTaskVisible(task)) return false;
    if (query.view === 'completed') {
      if (task.status !== 'completed') return false;
    } else if (!query.includeCompleted && task.status !== 'open') {
      return false;
    }
    if (query.view === 'important' && !task.important) return false;
    if (query.view === 'list' && task.listId !== (query.listId ?? null)) return false;
    if ((query.view === 'planned' || query.view === 'calendar') && !task.dueOn) return false;
    if (query.dueFrom && (!task.dueOn || task.dueOn < query.dueFrom)) return false;
    if (query.dueTo && (!task.dueOn || task.dueOn > query.dueTo)) return false;
    if (query.tags && query.tags.length > 0) {
      const taskTags = new Set((task.tags ?? []).map((tag) => tag.toLowerCase()));
      if (!query.tags.every((tag) => taskTags.has(tag.toLowerCase()))) return false;
    }
    return taskMatchesTokens(task, tokens);
  };
}

export function reminderIsPast(remindAt: string | null, now = new Date()): boolean {
  if (!remindAt) return false;
  const date = new Date(remindAt);
  return !Number.isNaN(date.getTime()) && date.getTime() <= now.getTime();
}

export function recurrenceAnchorDate(task: Task): DateOnly | null {
  return task.dueOn;
}

export function ensureValidRecurrence(rule: Recurrence | null, dueOn: DateOnly | null): void {
  if (rule && !dueOn) {
    throw new DomainError('VALIDATION_FAILED', '重复任务需要截止日期');
  }
  if (dueOn) parseDateOnly(dueOn);
}
