import { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getStorage } from './useStorage';
import { taskKeys } from './useTask';
import type { Task } from '@baicie/orbit';

export function useBatchOperations() {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const storage = getStorage();
  const queryClient = useQueryClient();

  const toggleSelection = useCallback((taskId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) {
        next.delete(taskId);
      } else {
        next.add(taskId);
      }
      return next;
    });
  }, []);

  const selectAll = useCallback((taskIds: string[]) => {
    setSelectedIds(new Set(taskIds));
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  const batchUpdate = useCallback(
    async (updates: Partial<Task>) => {
      const promises = Array.from(selectedIds).map((id) => storage.tasks.updateTask(id, updates));
      await Promise.all(promises);
      queryClient.invalidateQueries({ queryKey: taskKeys.all });
      clearSelection();
    },
    [selectedIds, storage, queryClient, clearSelection],
  );

  const batchDelete = useCallback(async () => {
    const promises = Array.from(selectedIds).map((id) => storage.tasks.deleteTask(id));
    await Promise.all(promises);
    queryClient.invalidateQueries({ queryKey: taskKeys.all });
    clearSelection();
  }, [selectedIds, storage, queryClient, clearSelection]);

  const batchMarkComplete = useCallback(
    (isCompleted: boolean = true) => batchUpdate({ isCompleted }),
    [batchUpdate],
  );

  const batchMarkImportant = useCallback(
    (isImportant: boolean = true) => batchUpdate({ isImportant }),
    [batchUpdate],
  );

  const batchAddToMyDay = useCallback(
    (addToMyDay: boolean = true) => batchUpdate({ addToMyDay }),
    [batchUpdate],
  );

  return {
    selectedIds,
    selectedCount: selectedIds.size,
    isSelected: (id: string) => selectedIds.has(id),
    toggleSelection,
    selectAll,
    clearSelection,
    batchMarkComplete,
    batchMarkImportant,
    batchAddToMyDay,
    batchDelete,
  };
}
