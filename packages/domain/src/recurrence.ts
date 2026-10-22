import { addDays, addMonthsClamped, parseDateOnly, toDateOnly, weekdayIso } from './dates';
import {
  DomainError,
  type DateOnly,
  type Recurrence,
  type RecurrenceFrequency,
  type Task,
} from './types';

export const RECURRENCE_LABELS: Record<RecurrenceFrequency, string> = {
  daily: '每天',
  weekdays: '每个工作日',
  weekly: '每周',
  monthly: '每月',
  yearly: '每年',
};

export function normalizeRecurrence(input: Recurrence | null | undefined): Recurrence | null {
  if (!input) return null;
  const interval = Math.max(1, Math.min(365, Math.floor(input.interval ?? 1)));
  const recurrence: Recurrence = {
    frequency: input.frequency,
    interval,
    anchorMode: input.anchorMode ?? 'calendar',
  };
  if (input.frequency === 'weekly') {
    const weekdays = [...new Set(input.weekdays ?? [])]
      .filter((day) => Number.isInteger(day) && day >= 1 && day <= 7)
      .sort((a, b) => a - b);
    if (weekdays.length === 0) {
      throw new DomainError('INVALID_RECURRENCE', 'Weekly rules need at least one weekday');
    }
    recurrence.weekdays = weekdays;
  }
  if (input.frequency === 'monthly') {
    const day = input.monthDay ?? 1;
    if (!Number.isInteger(day) || day < 1 || day > 31) {
      throw new DomainError('INVALID_RECURRENCE', 'Month day must be between 1 and 31');
    }
    recurrence.monthDay = day;
  }
  if (input.frequency === 'yearly') {
    const day = input.monthDay ?? 1;
    const month = input.month ?? 1;
    if (!Number.isInteger(day) || day < 1 || day > 31) {
      throw new DomainError('INVALID_RECURRENCE', 'Month day must be between 1 and 31');
    }
    if (!Number.isInteger(month) || month < 1 || month > 12) {
      throw new DomainError('INVALID_RECURRENCE', 'Month must be between 1 and 12');
    }
    recurrence.monthDay = day;
    recurrence.month = month;
  }
  return recurrence;
}

/**
 * Find the next calendar occurrence strictly after `fromDate`. All arithmetic
 * is done on calendar dates, so daylight-saving transitions cannot shift a
 * daily rule by an hour or skip a day.
 */
export function nextOccurrence(
  rawRule: Recurrence,
  fromDate: DateOnly,
  completionDate?: DateOnly,
): DateOnly {
  const rule = normalizeRecurrence(rawRule);
  if (!rule) throw new DomainError('INVALID_RECURRENCE', 'Missing recurrence rule');
  const interval = rule.interval ?? 1;
  const base = rule.anchorMode === 'completion' && completionDate ? completionDate : fromDate;

  switch (rule.frequency) {
    case 'daily':
      return addDays(base, interval);
    case 'weekdays': {
      let candidate = addDays(base, 1);
      for (let index = 0; index < 366; index += 1) {
        if (weekdayIso(candidate) <= 5) return candidate;
        candidate = addDays(candidate, 1);
      }
      throw new DomainError('INVALID_RECURRENCE', 'Unable to find a weekday');
    }
    case 'weekly': {
      const weekdays = rule.weekdays ?? [weekdayIso(base)];
      const current = weekdayIso(base);
      const next = weekdays.find((day) => day > current);
      if (next) return addDays(base, next - current);
      const first = weekdays[0]!;
      return addDays(base, 7 * interval - current + first);
    }
    case 'monthly': {
      const day = rule.monthDay ?? Number(base.slice(8, 10));
      let candidate = base;
      for (let index = 0; index < 120; index += 1) {
        candidate = addMonthsClamped(candidate, interval);
        const [year, month] = candidate.split('-').map(Number) as [number, number];
        const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
        if (day <= lastDay) {
          candidate = `${year.toString().padStart(4, '0')}-${month
            .toString()
            .padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
          return candidate;
        }
      }
      throw new DomainError('INVALID_RECURRENCE', 'Unable to find a monthly occurrence');
    }
    case 'yearly': {
      const month = rule.month ?? Number(base.slice(5, 7));
      const day = rule.monthDay ?? Number(base.slice(8, 10));
      let year = Number(base.slice(0, 4)) + interval;
      for (let index = 0; index < 400; index += 1) {
        const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
        if (day <= lastDay) {
          return `${year.toString().padStart(4, '0')}-${month
            .toString()
            .padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
        }
        year += interval;
      }
      throw new DomainError('INVALID_RECURRENCE', 'Unable to find a yearly occurrence');
    }
  }
}

export function describeRecurrence(rule: Recurrence | null): string {
  if (!rule) return '不重复';
  const interval = rule.interval ?? 1;
  switch (rule.frequency) {
    case 'daily':
      return interval === 1 ? '每天' : `每 ${interval} 天`;
    case 'weekdays':
      return '每个工作日';
    case 'weekly': {
      const labels = ['一', '二', '三', '四', '五', '六', '日'];
      const days = (rule.weekdays ?? []).map((day) => `周${labels[day - 1]}`).join('、');
      return interval === 1 ? `每${days || '周'}` : `每 ${interval} 周（${days}）`;
    }
    case 'monthly':
      return interval === 1 ? `每月 ${rule.monthDay ?? 1} 日` : `每 ${interval} 个月`;
    case 'yearly':
      return interval === 1
        ? `每年 ${rule.month ?? 1} 月 ${rule.monthDay ?? 1} 日`
        : `每 ${interval} 年`;
  }
}

/** Occurrence key is stable across devices and based on the scheduled date. */
export function occurrenceKeyFor(dueOn: DateOnly): string {
  parseDateOnly(dueOn);
  return dueOn;
}

/**
 * Build the next instance of a completed repeating task. The caller inserts it
 * in the same local transaction and relies on `(series_id, occurrence_key)` for
 * idempotency.
 */
export function nextRecurringTask(
  task: Task,
  completedAt: DateOnly,
  id: string,
  now: string,
): Task | null {
  if (!task.recurrence || !task.dueOn || task.status !== 'completed') return null;
  const anchor = task.recurrence.anchorMode === 'completion' ? completedAt : task.dueOn;
  const dueOn = nextOccurrence(task.recurrence, anchor, completedAt);
  return {
    ...task,
    id,
    status: 'open',
    completedAt: null,
    dueOn,
    remindAt: null,
    occurrenceKey: occurrenceKeyFor(dueOn),
    seriesId: task.seriesId ?? task.id,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
}
