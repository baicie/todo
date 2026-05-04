import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getStorage } from './useStorage';
import { taskKeys } from './useTask';
import type { Task } from '@baicie/orbit';

export function useReorderTasks() {
  const storage = getStorage();
  const queryClient = useQueryClient();

  return useCallback(
    async (taskId: string, newSortOrder: number) => {
      await storage.tasks.updateTask(taskId, { sortOrder: newSortOrder });
      queryClient.invalidateQueries({ queryKey: taskKeys.all });
    },
    [storage, queryClient],
  );
}

export function useReorderTasksOptimistic() {
  const queryClient = useQueryClient();

  return useCallback(
    (activeTask: Task, overTask: Task) => {
      queryClient.setQueryData<Task[]>(taskKeys.all, (old) => {
        if (!old) return old;

        const oldItems = [...old];
        const oldIndex = oldItems.findIndex((t) => t.id === activeTask.id);
        const newIndex = oldItems.findIndex((t) => t.id === overTask.id);

        if (oldIndex === -1 || newIndex === -1) return old;

        const [removed] = oldItems.splice(oldIndex, 1);
        oldItems.splice(newIndex, 0, removed);

        return oldItems.map((task, index) => ({
          ...task,
          sortOrder: index,
        }));
      });
    },
    [queryClient],
  );
}
