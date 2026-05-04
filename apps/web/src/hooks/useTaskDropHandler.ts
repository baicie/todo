import { useEffect } from 'react';
import { useUpdateTask } from '@baicie/orbit-hooks';

export function useTaskDropHandler() {
  const updateTask = useUpdateTask();

  useEffect(() => {
    const handler = (e: Event) => {
      const custom = e as CustomEvent<{ taskId: string; listId: string }>;
      const { taskId, listId } = custom.detail;

      // Smart lists - just navigate, don't update listId
      const smartLists = ['my-day', 'important', 'planned', 'tasks'];
      if (smartLists.includes(listId)) {
        return;
      }

      // Move task to the selected list
      updateTask.mutate({ id: taskId, input: { listId } });
    };

    window.addEventListener('task-drop-to-list', handler);
    return () => window.removeEventListener('task-drop-to-list', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [updateTask.mutate]);
}
