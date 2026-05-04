import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getStorage } from './useStorage';
import { taskKeys } from './useTask';
import type { Task } from '@baicie/orbit';

export function useReorderTasks() {
  const storage = getStorage();
  const queryClient = useQueryClient();

  return useCallback(
    async (updatedTasks: Task[]) => {
      const updatePromises = updatedTasks.map((task) =>
        storage.tasks.updateTask(task.id, { sortOrder: task.sortOrder }),
      );
      await Promise.all(updatePromises);
      queryClient.invalidateQueries({ queryKey: taskKeys.all });
    },
    [storage, queryClient],
  );
}

export function useReorderTasksOptimistic() {
  const queryClient = useQueryClient();

  return useCallback(
    (activeTask: Task, overTask: Task) => {
      const updatedTasks = queryClient.getQueryData<Task[]>(taskKeys.all);
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

      queryClient.setQueryData<Task[]>(taskKeys.all, newTasks);
      return newTasks;
    },
    [queryClient],
  );
}
