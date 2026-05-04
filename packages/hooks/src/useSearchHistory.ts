/**
 * 搜索历史管理
 * 搜索历史存储在 localStorage 中，最多保留 10 条记录。
 */

import { useCallback, useEffect, useState } from 'react';

const HISTORY_KEY = 'orbit_search_history';
const MAX_HISTORY = 10;

export function getSearchHistory(): string[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    // ignore
  }
  return [];
}

export function addSearchHistory(query: string): void {
  if (!query.trim()) return;
  const history = getSearchHistory().filter((q) => q !== query);
  history.unshift(query.trim());
  const trimmed = history.slice(0, MAX_HISTORY);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(trimmed));
}

export function removeSearchHistory(query: string): void {
  const history = getSearchHistory().filter((q) => q !== query);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
}

export function clearSearchHistory(): void {
  localStorage.removeItem(HISTORY_KEY);
}

export function useSearchHistory() {
  const [history, setHistory] = useState<string[]>(() => getSearchHistory());

  useEffect(() => {
    const load = () => setHistory(getSearchHistory());
    window.addEventListener('storage', load);
    const interval = setInterval(load, 1000);
    return () => {
      window.removeEventListener('storage', load);
      clearInterval(interval);
    };
  }, []);

  const removeHistory = useCallback((query: string) => {
    removeSearchHistory(query);
    setHistory(getSearchHistory());
  }, []);

  const clearHist = useCallback(() => {
    clearSearchHistory();
    setHistory([]);
  }, []);

  return {
    history,
    removeHistory,
    clearHistory: clearHist,
  };
}
