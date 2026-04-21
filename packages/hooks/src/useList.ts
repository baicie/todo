import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getStorage } from './useStorage';
import type { CreateListInput, List, UpdateListInput } from '@baicie/orbit';

// ============================================================================
// Query Keys
// ============================================================================

export const listKeys = {
  all: ['lists'] as const,
  detail: (id: string) => ['lists', id] as const,
};

// ============================================================================
// useList — 获取清单列表
// ============================================================================

export function useList() {
  const storage = getStorage();

  return useQuery({
    queryKey: listKeys.all,
    queryFn: () => storage.lists.getLists(),
  });
}

// ============================================================================
// useCreateList — 创建清单
// ============================================================================

export function useCreateList() {
  const storage = getStorage();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: CreateListInput) => storage.lists.createList(input),

    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: listKeys.all });

      const previousLists = queryClient.getQueryData<List[]>(listKeys.all);

      const optimisticList: List = {
        id: `temp-${Date.now()}`,
        title: input.title,
        icon: input.icon ?? null,
        theme: input.theme ?? null,
        isSmart: false,
        userId: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      queryClient.setQueryData<List[]>(listKeys.all, (old) =>
        old ? [...old, optimisticList] : [optimisticList],
      );

      return { previousLists };
    },

    onError: (_err, _input, context) => {
      if (context?.previousLists) {
        queryClient.setQueryData(listKeys.all, context.previousLists);
      }
    },

    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: listKeys.all });
    },
  });
}

// ============================================================================
// useUpdateList — 更新清单
// ============================================================================

export function useUpdateList() {
  const storage = getStorage();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateListInput }) =>
      storage.lists.updateList(id, input),

    onMutate: async ({ id, input }) => {
      await queryClient.cancelQueries({ queryKey: listKeys.all });

      const previousLists = queryClient.getQueryData<List[]>(listKeys.all);

      queryClient.setQueryData<List[]>(listKeys.all, (old) =>
        old?.map((list) =>
          list.id === id ? { ...list, ...input, updatedAt: new Date().toISOString() } : list,
        ),
      );

      return { previousLists };
    },

    onError: (_err, _vars, context) => {
      if (context?.previousLists) {
        queryClient.setQueryData(listKeys.all, context.previousLists);
      }
    },

    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: listKeys.all });
    },
  });
}

// ============================================================================
// useDeleteList — 删除清单
// ============================================================================

export function useDeleteList() {
  const storage = getStorage();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => storage.lists.deleteList(id),

    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: listKeys.all });

      const previousLists = queryClient.getQueryData<List[]>(listKeys.all);

      queryClient.setQueryData<List[]>(listKeys.all, (old) =>
        old?.filter((list) => list.id !== id),
      );

      return { previousLists };
    },

    onError: (_err, _id, context) => {
      if (context?.previousLists) {
        queryClient.setQueryData(listKeys.all, context.previousLists);
      }
    },

    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: listKeys.all });
    },
  });
}
