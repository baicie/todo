import { DomainError, type DateOnly, type Instant } from './types';

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isDateOnly(value: unknown): value is DateOnly {
  if (typeof value !== 'string') return false;
  const match = DATE_ONLY.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

export function assertDateOnly(value: string): asserts value is DateOnly {
  if (!isDateOnly(value)) {
    throw new DomainError('INVALID_DATE', `Invalid calendar date: ${value}`);
  }
}

export function parseDateOnly(value: DateOnly): Date {
  assertDateOnly(value);
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day));
}

export function toDateOnly(date: Date): DateOnly {
  return `${date.getUTCFullYear().toString().padStart(4, '0')}-${(date.getUTCMonth() + 1)
    .toString()
    .padStart(2, '0')}-${date.getUTCDate().toString().padStart(2, '0')}`;
}

/** Calendar arithmetic deliberately avoids epoch milliseconds (DST safe). */
export function addDays(value: DateOnly, amount: number): DateOnly {
  const date = parseDateOnly(value);
  date.setUTCDate(date.getUTCDate() + amount);
  return toDateOnly(date);
}

export function addMonthsClamped(value: DateOnly, amount: number): DateOnly {
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  const target = new Date(Date.UTC(year, month - 1 + amount, 1));
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return toDateOnly(target);
}

export function todayInTimeZone(timeZone: string, now: Date = new Date()): DateOnly {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(now);
    const part = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((item) => item.type === type)?.value ?? '';
    return `${part('year')}-${part('month')}-${part('day')}`;
  } catch {
    throw new DomainError('INVALID_DATE', `Unknown time zone: ${timeZone}`);
  }
}

export function weekdayIso(value: DateOnly): number {
  const day = parseDateOnly(value).getUTCDay();
  return day === 0 ? 7 : day;
}

export function daysBetween(from: DateOnly, to: DateOnly): number {
  return Math.round((parseDateOnly(to).getTime() - parseDateOnly(from).getTime()) / 86_400_000);
}

export function compareDateOnly(a: DateOnly, b: DateOnly): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function isBefore(a: DateOnly, b: DateOnly): boolean {
  return compareDateOnly(a, b) < 0;
}

export function isAfter(a: DateOnly, b: DateOnly): boolean {
  return compareDateOnly(a, b) > 0;
}

export function formatDateLong(
  value: DateOnly,
  locale = 'zh-CN',
  options: Intl.DateTimeFormatOptions = {},
): string {
  return new Intl.DateTimeFormat(locale, {
    month: 'long',
    day: 'numeric',
    weekday: 'short',
    timeZone: 'UTC',
    ...options,
  }).format(parseDateOnly(value));
}

export function formatDateShort(value: DateOnly, locale = 'zh-CN'): string {
  const now = new Date();
  const today = `${now.getFullYear()}-${(now.getMonth() + 1).toString().padStart(2, '0')}-${now
    .getDate()
    .toString()
    .padStart(2, '0')}`;
  const delta = daysBetween(today, value);
  if (delta === 0) return '今天';
  if (delta === 1) return '明天';
  if (delta === -1) return '昨天';
  const date = parseDateOnly(value);
  const sameYear = date.getUTCFullYear() === now.getFullYear();
  return new Intl.DateTimeFormat(locale, {
    ...(sameYear ? {} : { year: 'numeric' }),
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

export function formatDueDate(
  dueOn: DateOnly | null,
  today: DateOnly,
  locale = 'zh-CN',
): { label: string; tone: 'overdue' | 'today' | 'soon' | 'neutral' } | null {
  if (!dueOn) return null;
  const delta = daysBetween(today, dueOn);
  if (delta < 0) {
    return {
      label: delta === -1 ? '昨天' : `逾期 ${Math.abs(delta)} 天`,
      tone: 'overdue',
    };
  }
  if (delta === 0) return { label: '今天', tone: 'today' };
  if (delta === 1) return { label: '明天', tone: 'soon' };
  if (delta <= 7) {
    return {
      label: new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' }).format(
        parseDateOnly(dueOn),
      ),
      tone: 'soon',
    };
  }
  return {
    label: new Intl.DateTimeFormat(locale, {
      month: 'short',
      day: 'numeric',
      ...(parseDateOnly(dueOn).getUTCFullYear() === Number(today.slice(0, 4))
        ? {}
        : { year: 'numeric' }),
      timeZone: 'UTC',
    }).format(parseDateOnly(dueOn)),
    tone: 'neutral',
  };
}

export function formatReminderTime(instant: Instant, timeZone: string, locale = 'zh-CN'): string {
  const date = new Date(instant);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone,
  })
    .format(date)
    .replace(/\s+/g, ' ');
}

/** Returns a local datetime-input value (`YYYY-MM-DDTHH:mm`) for an instant. */
export function instantToLocalInput(instant: Instant | null, timeZone: string): string {
  if (!instant) return '';
  const date = new Date(instant);
  if (Number.isNaN(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}

/**
 * Convert a wall-clock value in an IANA zone to a UTC instant without relying
 * on the host machine's time zone. Uses the standard two-pass offset method.
 */
export function zonedDateTimeToUtc(localDateTime: string, timeZone: string): Instant {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(localDateTime);
  if (!match) throw new DomainError('INVALID_DATE', 'Expected YYYY-MM-DDTHH:mm');
  const [, y, mo, d, h, mi] = match.map(Number) as [number, number, number, number, number, number];
  const utcGuess = Date.UTC(y, mo - 1, d, h, mi);
  let timestamp = utcGuess;
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(timestamp));
    const get = (type: Intl.DateTimeFormatPartTypes) =>
      Number(parts.find((part) => part.type === type)?.value ?? 0);
    const represented = Date.UTC(
      get('year'),
      get('month') - 1,
      get('day'),
      get('hour'),
      get('minute'),
      get('second'),
    );
    timestamp = utcGuess - (represented - timestamp);
    if (Math.abs(utcGuess - represented) < 1000) break;
  }
  return new Date(timestamp).toISOString();
}

export function defaultReminderForDate(dueOn: DateOnly, hour: number, timeZone: string): Instant {
  return zonedDateTimeToUtc(`${dueOn}T${hour.toString().padStart(2, '0')}:00`, timeZone);
}
