import { todayInTimeZone } from '@todo/domain';

export function useLocalDate(timeZone: () => string): {
  today: () => string;
  refresh: () => void;
} {
  let current = todayInTimeZone(timeZone());
  const subscribers = new Set<() => void>();
  const timer = setInterval(() => {
    const next = todayInTimeZone(timeZone());
    if (next !== current) {
      current = next;
      subscribers.forEach((callback) => callback());
    }
  }, 30_000);
  if (typeof window !== 'undefined') {
    window.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      const next = todayInTimeZone(timeZone());
      if (next !== current) {
        current = next;
        subscribers.forEach((callback) => callback());
      }
    });
    window.addEventListener('beforeunload', () => clearInterval(timer), { once: true });
  }
  return {
    today: () => current,
    refresh: () => {
      current = todayInTimeZone(timeZone());
      subscribers.forEach((callback) => callback());
    },
  };
}

export function formatClock(timeZone: string, now = new Date()): string {
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone,
  }).format(now);
}

export function greeting(now = new Date()): string {
  const hour = now.getHours();
  if (hour < 6) return '夜深了';
  if (hour < 11) return '早上好';
  if (hour < 14) return '中午好';
  if (hour < 18) return '下午好';
  return '晚上好';
}
