/**
 * Date and time formatting utilities.
 */

const DEFAULT_LOCALE = 'zh-CN';

export function formatDate(date: Date | string | null | undefined): string {
  if (!date) return '';
  const d = typeof date === 'string' ? new Date(date) : date;
  if (isNaN(d.getTime())) return '';

  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function formatDateTime(
  date: Date | string | null | undefined,
  options?: { includeSeconds?: boolean },
): string {
  if (!date) return '';
  const d = typeof date === 'string' ? new Date(date) : date;
  if (isNaN(d.getTime())) return '';

  const dateStr = formatDate(d);
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');

  if (options?.includeSeconds) {
    const seconds = String(d.getSeconds()).padStart(2, '0');
    return `${dateStr} ${hours}:${minutes}:${seconds}`;
  }
  return `${dateStr} ${hours}:${minutes}`;
}

export function formatRelativeTime(
  date: Date | string | null | undefined,
  locale: string = DEFAULT_LOCALE,
): string {
  if (!date) return '';
  const d = typeof date === 'string' ? new Date(date) : date;
  if (isNaN(d.getTime())) return '';

  const now = new Date();
  const diffMs = d.getTime() - now.getTime();
  const absDiffMs = Math.abs(diffMs);
  const diffDays = Math.round(absDiffMs / (1000 * 60 * 60 * 24));

  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });

  if (diffMs < 0) {
    if (diffDays === 0) {
      const diffHours = Math.round(absDiffMs / (1000 * 60 * 60));
      if (diffHours === 0) {
        const diffMinutes = Math.round(absDiffMs / (1000 * 60));
        return rtf.format(-diffMinutes, 'minute');
      }
      return rtf.format(-diffHours, 'hour');
    }
    return rtf.format(-diffDays, 'day');
  } else {
    if (diffDays === 0) {
      const diffHours = Math.round(absDiffMs / (1000 * 60 * 60));
      if (diffHours === 0) {
        const diffMinutes = Math.round(absDiffMs / (1000 * 60));
        return rtf.format(diffMinutes, 'minute');
      }
      return rtf.format(diffHours, 'hour');
    }
    return rtf.format(diffDays, 'day');
  }
}

export function isOverdue(dueDate: string | null | undefined): boolean {
  if (!dueDate) return false;
  const d = new Date(dueDate);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return d < today;
}

export function isDueToday(dueDate: string | null | undefined): boolean {
  if (!dueDate) return false;
  const d = new Date(dueDate);
  const today = new Date();
  return (
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate()
  );
}

export function isDueTomorrow(dueDate: string | null | undefined): boolean {
  if (!dueDate) return false;
  const d = new Date(dueDate);
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  return (
    d.getFullYear() === tomorrow.getFullYear() &&
    d.getMonth() === tomorrow.getMonth() &&
    d.getDate() === tomorrow.getDate()
  );
}

export function isDueThisWeek(dueDate: string | null | undefined): boolean {
  if (!dueDate) return false;
  const d = new Date(dueDate);
  const now = new Date();
  const weekEnd = new Date(now);
  weekEnd.setDate(now.getDate() + 7);
  return d >= now && d <= weekEnd;
}

export function isDuePast(dueDate: string | null | undefined): boolean {
  if (!dueDate) return false;
  return isOverdue(dueDate);
}

export function parseISODate(dateStr: string): Date {
  return new Date(dateStr);
}

export function startOfDay(date: Date = new Date()): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

export function endOfDay(date: Date = new Date()): Date {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d;
}

export function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

export function getWeekdayName(date: Date, locale: string = DEFAULT_LOCALE): string {
  return date.toLocaleDateString(locale, { weekday: 'long' });
}

export function getDayOfWeek(date: Date | string | null | undefined): number {
  if (!date) return -1;
  const d = typeof date === 'string' ? new Date(date) : date;
  return d.getDay();
}

export interface DueDateInfo {
  text: string;
  isOverdue: boolean;
}

export function getDueDateText(dateStr?: string | null): DueDateInfo {
  if (!dateStr) return { text: '-', isOverdue: false };
  const date = new Date(dateStr);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const isToday = date.toDateString() === today.toDateString();
  const isYesterday = date.toDateString() === yesterday.toDateString();
  const isTomorrow = date.toDateString() === tomorrow.toDateString();
  const isOverdue = date < today && !isToday;

  let text = date.toLocaleDateString();
  if (isToday) text = '今天';
  if (isYesterday) text = '昨天';
  if (isTomorrow) text = '明天';

  return { text, isOverdue };
}
