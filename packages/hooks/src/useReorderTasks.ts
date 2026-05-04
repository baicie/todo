import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getStorage } from './useStorage';
import { taskKeys } from './useTask';
import type { Task, TaskFilter } from '@baicie/orbit';

// ============================================================================
// useReorderTasks — 持久化排序到服务器
// ============================================================================

export function useReorderTasks() {
  const storage = getStorage();
  const queryClient = useQueryClient();

  return useCallback(
    async (updatedTasks: Task[], filter?: TaskFilter) => {
      const updatePromises = updatedTasks.map((task) =>
        storage.tasks.updateTask(task.id, { sortOrder: task.sortOrder }),
      );
      await Promise.all(updatePromises);
      // 刷新相关查询
      queryClient.invalidateQueries({ queryKey: taskKeys.lists(filter) });
      queryClient.invalidateQueries({ queryKey: taskKeys.all });
    },
    [storage, queryClient],
  );
}

// ============================================================================
// useReorderTasksOptimistic — 乐观更新排序
// ============================================================================

export function useReorderTasksOptimistic() {
  const queryClient = useQueryClient();

  return useCallback(
    (activeTask: Task, overTask: Task, filter?: TaskFilter) => {
      const queryKey = filter ? taskKeys.lists(filter) : taskKeys.all;
      const updatedTasks = queryClient.getQueryData<Task[]>(queryKey);
      if (!updatedTasks) return [];

      const oldItems = [...updatedTasks];
      const oldIndex = oldItems.findIndex((t) => t.id === activeTask.id);
      const newIndex = oldItems.findIndex((t) => t.id === overTask.id);

      if (oldIndex === -1 || newIndex === -1) return [];

      const [removed] = oldItems.splice(oldIndex, 1);
      oldItems.splice(newIndex, 0, removed);

      const newTasks = oldItems.map((task, index) => ({
        ...task,
        sortOrder: index,
      }));

      queryClient.setQueryData<Task[]>(queryKey, newTasks);
      return newTasks;
    },
    [queryClient],
  );
}
