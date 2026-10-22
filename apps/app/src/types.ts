import type { SmartView } from '@todo/domain';

export type AppView = { kind: 'smart'; id: SmartView } | { kind: 'list'; id: string };

export interface TaskFilter {
  tags: string[];
  status: 'all' | 'open' | 'completed';
  due: 'all' | 'today' | 'overdue' | 'none';
}

export const EMPTY_FILTER: TaskFilter = {
  tags: [],
  status: 'all',
  due: 'all',
};

export interface SavedView {
  id: string;
  name: string;
  view: AppView;
  filter: TaskFilter;
}

export const SMART_TITLES: Record<SmartView, string> = {
  'my-day': '我的一天',
  important: '重要',
  planned: '计划内',
  calendar: '日历',
  all: '全部任务',
  completed: '已完成',
};

export function isSmartView(view: AppView): view is { kind: 'smart'; id: SmartView } {
  return view.kind === 'smart';
}

export function viewKey(view: AppView): string {
  return `${view.kind}:${view.id}`;
}
