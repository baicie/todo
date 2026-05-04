import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { getStorage } from './useStorage';
import type { CreateTaskInput, Task, TaskFilter, UpdateTaskInput } from '@baicie/orbit';

// ============================================================================
// Query Keys
// ============================================================================

export const taskKeys = {
  all: ['tasks'] as const,
  lists: (filter?: TaskFilter) => ['tasks', filter] as const,
  detail: (id: string) => ['tasks', id] as const,
};

// ============================================================================
// useTask — 获取任务列表
// ============================================================================

export function useTask(filter?: TaskFilter) {
  const storage = getStorage();

  return useQuery({
    queryKey: taskKeys.lists(filter),
    queryFn: () => storage.tasks.getTasks(filter),
  });
}

// ============================================================================
// useTaskDetail — 获取单个任务详情
// ============================================================================

export function useTaskDetail(id: string | null) {
  const storage = getStorage();

  return useQuery({
    queryKey: taskKeys.detail(id ?? ''),
    queryFn: () => (id ? storage.tasks.getTask(id) : null),
    enabled: !!id,
  });
}

// ============================================================================
// useCreateTask — 创建任务（乐观更新）
// ============================================================================

export function useCreateTask() {
  const storage = getStorage();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: CreateTaskInput) => storage.tasks.createTask(input),

    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: taskKeys.all });

      const previousTasks = queryClient.getQueryData<Task[]>(taskKeys.all);

      const optimisticTask: Task = {
        id: `temp-${Date.now()}`,
        title: input.title,
        description: input.description ?? null,
        isCompleted: input.isCompleted ?? false,
        isImportant: input.isImportant ?? false,
        addToMyDay: input.addToMyDay ?? false,
        dueDate: input.dueDate ?? null,
        reminderDate: input.reminderDate ?? null,
        repeatPattern: input.repeatPattern ?? null,
        category: input.category ?? null,
        files: [],
        listId: input.listId ?? null,
        userId: null,
        steps: [],
        sortOrder: input.sortOrder ?? Date.now(),
        tagIds: input.tagIds ?? [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      queryClient.setQueryData<Task[]>(taskKeys.all, (old) =>
        old ? [optimisticTask, ...old] : [optimisticTask],
      );

      return { previousTasks };
    },

    onError: (_err, _input, context) => {
      if (context?.previousTasks) {
        queryClient.setQueryData(taskKeys.all, context.previousTasks);
      }
    },

    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: taskKeys.all });
    },
  });
}

// ============================================================================
// useUpdateTask — 更新任务（乐观更新）
// ============================================================================

export function useUpdateTask() {
  const storage = getStorage();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateTaskInput }) =>
      storage.tasks.updateTask(id, input),

    onMutate: async ({ id, input }) => {
      await queryClient.cancelQueries({ queryKey: taskKeys.all });

      const previousTasks = queryClient.getQueryData<Task[]>(taskKeys.all);

      queryClient.setQueryData<Task[]>(taskKeys.all, (old) =>
        old?.map((task) =>
          task.id === id ? { ...task, ...input, updatedAt: new Date().toISOString() } : task,
        ),
      );

      return { previousTasks };
    },

    onError: (_err, _vars, context) => {
      if (context?.previousTasks) {
        queryClient.setQueryData(taskKeys.all, context.previousTasks);
      }
    },

    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: taskKeys.all });
    },
  });
}

// ============================================================================
// useDeleteTask — 删除任务
// ============================================================================

export function useDeleteTask() {
  const storage = getStorage();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => storage.tasks.deleteTask(id),

    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: taskKeys.all });

      const previousTasks = queryClient.getQueryData<Task[]>(taskKeys.all);

      queryClient.setQueryData<Task[]>(taskKeys.all, (old) =>
        old?.filter((task) => task.id !== id),
      );

      return { previousTasks };
    },

    onError: (_err, _id, context) => {
      if (context?.previousTasks) {
        queryClient.setQueryData(taskKeys.all, context.previousTasks);
      }
    },

    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: taskKeys.all });
    },
  });
}

// ============================================================================
// useToggleComplete — 快捷完成/取消完成任务
// ============================================================================

export function useToggleComplete() {
  const updateTask = useUpdateTask();

  return useCallback(
    (task: Task) => {
      return updateTask.mutateAsync({
        id: task.id,
        input: { isCompleted: !task.isCompleted },
      });
    },
    [updateTask],
  );
}

// ============================================================================
// useToggleImportant — 快捷标记/取消重要
// ============================================================================

export function useToggleImportant() {
  const updateTask = useUpdateTask();

  return useCallback(
    (task: Task) => {
      return updateTask.mutateAsync({
        id: task.id,
        input: { isImportant: !task.isImportant },
      });
    },
    [updateTask],
  );
}

// ============================================================================
// useToggleMyDay — 快捷添加/移除"我的一天"
// ============================================================================

export function useToggleMyDay() {
  const updateTask = useUpdateTask();

  return useCallback(
    (task: Task) => {
      return updateTask.mutateAsync({
        id: task.id,
        input: { addToMyDay: !task.addToMyDay },
      });
    },
    [updateTask],
  );
}
