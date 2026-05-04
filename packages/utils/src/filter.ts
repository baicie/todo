import type { TaskFilter } from '@baicie/orbit';

export const SMART_LISTS = ['my-day', 'important', 'planned', 'tasks'] as const;
export type SmartListId = (typeof SMART_LISTS)[number];

export function buildFilter(listId: string): TaskFilter | undefined {
  if (SMART_LISTS.includes(listId as SmartListId)) {
    if (listId === 'my-day') return { addToMyDay: true };
    if (listId === 'important') return { isImportant: true };
    if (listId === 'planned') return { hasDueDate: true };
    return {};
  }
  if (listId.startsWith('tag:')) {
    const tagId = listId.slice(4);
    return { tagIds: [tagId] };
  }
  return { listId };
}

export interface GetListTitleOptions {
  allTags?: Array<{ id: string; name: string }>;
  tFn?: (key: string) => string;
}

export function getListTitle(listId: string, options: GetListTitleOptions = {}): string {
  const { allTags, tFn } = options;

  if (listId === 'my-day') return tFn ? tFn('sidebar.myDay') : '我的一天';
  if (listId === 'important') return tFn ? tFn('sidebar.important') : '重要';
  if (listId === 'planned') return tFn ? tFn('sidebar.planned') : '计划内';
  if (listId === 'tasks') return tFn ? tFn('sidebar.tasks') : '所有任务';
  if (listId.startsWith('tag:')) {
    const tagId = listId.slice(4);
    const tag = allTags?.find((t) => t.id === tagId);
    return tag ? `${tag.name}` : '标签';
  }
  return '任务';
}
