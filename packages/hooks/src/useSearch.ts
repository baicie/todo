import { useCallback, useMemo, useState } from 'react';
import { useTask } from './useTask';
import type { Task, TaskFilter } from '@baicie/orbit';
import { fuzzyMatch } from '@baicie/orbit-utils';

// ============================================================================
// Search State
// ============================================================================

export interface SearchState {
  query: string;
  filters: TaskFilter;
  sortBy: SortOption;
  sortOrder: 'asc' | 'desc';
}

export type SortOption = 'createdAt' | 'updatedAt' | 'dueDate' | 'title' | 'importance';

// ============================================================================
// useSearch — 本地搜索 + 过滤器 + 排序
// ============================================================================

export function useSearch(initialFilter?: TaskFilter) {
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState<TaskFilter>(initialFilter ?? {});
  const [sortBy, setSortBy] = useState<SortOption>('createdAt');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');

  const { data: tasks = [], isLoading, error } = useTask(filters);

  const searchResults = useMemo(() => {
    let results = tasks;

    // Local text search
    if (query.trim()) {
      results = results.filter(
        (task) =>
          fuzzyMatch(task.title, query) ||
          (task.description && fuzzyMatch(task.description, query)) ||
          task.steps.some((step) => fuzzyMatch(step.title, query)),
      );
    }

    // Sort
    results = [...results].sort((a, b) => {
      let cmp = 0;
      switch (sortBy) {
        case 'title':
          cmp = a.title.localeCompare(b.title);
          break;
        case 'dueDate':
          if (!a.dueDate && !b.dueDate) cmp = 0;
          else if (!a.dueDate) cmp = 1;
          else if (!b.dueDate) cmp = -1;
          else cmp = new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime();
          break;
        case 'importance':
          if (a.isImportant === b.isImportant) cmp = 0;
          else cmp = a.isImportant ? -1 : 1;
          break;
        case 'createdAt':
        case 'updatedAt':
        default:
          cmp = new Date(a[sortBy]).getTime() - new Date(b[sortBy]).getTime();
          break;
      }
      return sortOrder === 'asc' ? cmp : -cmp;
    });

    return results;
  }, [tasks, query, sortBy, sortOrder]);

  const updateFilters = useCallback((newFilters: Partial<TaskFilter>) => {
    setFilters((prev) => ({ ...prev, ...newFilters }));
  }, []);

  const resetFilters = useCallback(() => {
    setFilters({});
    setQuery('');
  }, []);

  const toggleSortOrder = useCallback(() => {
    setSortOrder((prev) => (prev === 'asc' ? 'desc' : 'asc'));
  }, []);

  const setSort = useCallback((option: SortOption) => {
    setSortBy(option);
  }, []);

  const isTaskMatched = useCallback(
    (task: Task): boolean => {
      if (!query.trim()) return true;
      return (
        fuzzyMatch(task.title, query) ||
        (task.description && fuzzyMatch(task.description, query)) ||
        task.steps.some((step) => fuzzyMatch(step.title, query))
      );
    },
    [query],
  );

  return {
    // State
    query,
    setQuery,
    filters,
    updateFilters,
    resetFilters,
    sortBy,
    setSort,
    sortOrder,
    toggleSortOrder,
    // Results
    tasks: searchResults,
    totalTasks: tasks,
    isLoading,
    error,
    isTaskMatched,
    // Counts
    matchedCount: searchResults.length,
    totalCount: tasks.length,
  };
}

// ============================================================================
// useSmartFilters — 快捷筛选
// ============================================================================

export function useSmartFilter() {
  const [activeFilter, setActiveFilter] = useState<SmartFilterType>('all');

  const getFilterParams = useCallback((filter: SmartFilterType): TaskFilter => {
    switch (filter) {
      case 'myDay':
        return { addToMyDay: true, isCompleted: false };
      case 'important':
        return { isImportant: true, isCompleted: false };
      case 'planned':
        return { hasDueDate: true };
      case 'completed':
        return { isCompleted: true };
      case 'all':
      default:
        return {};
    }
  }, []);

  const filter = getFilterParams(activeFilter);

  return {
    activeFilter,
    setActiveFilter,
    filter,
    getFilterParams,
  };
}

export type SmartFilterType = 'all' | 'myDay' | 'important' | 'planned' | 'completed';

// ============================================================================
// useQuickFilter — 快速筛选状态管理
// ============================================================================

export function useQuickFilter() {
  const [filterType, setFilterType] = useState<SmartFilterType>('all');
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  const [hasDueDateFilter, setHasDueDateFilter] = useState<boolean | null>(null);

  const combinedFilter = useMemo((): TaskFilter => {
    const smartFilter = getSmartFilterParams(filterType);
    return {
      ...smartFilter,
      category: categoryFilter as TaskFilter['category'],
      hasDueDate: hasDueDateFilter ?? undefined,
    };
  }, [filterType, categoryFilter, hasDueDateFilter]);

  const clearAll = useCallback(() => {
    setFilterType('all');
    setCategoryFilter(null);
    setHasDueDateFilter(null);
  }, []);

  return {
    filterType,
    setFilterType,
    categoryFilter,
    setCategoryFilter,
    hasDueDateFilter,
    setHasDueDateFilter,
    combinedFilter,
    clearAll,
  };
}

function getSmartFilterParams(filter: SmartFilterType): TaskFilter {
  switch (filter) {
    case 'myDay':
      return { addToMyDay: true, isCompleted: false };
    case 'important':
      return { isImportant: true, isCompleted: false };
    case 'planned':
      return { hasDueDate: true };
    case 'completed':
      return { isCompleted: true };
    default:
      return {};
  }
}
