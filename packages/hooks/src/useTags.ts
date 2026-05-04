import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getStorage } from './useStorage';
import type { CreateTagInput, Tag, UpdateTagInput } from '@baicie/orbit';

// ============================================================================
// Query Keys
// ============================================================================

export const tagKeys = {
  all: ['tags'] as const,
  detail: (id: string) => ['tags', id] as const,
};

// ============================================================================
// useTag — 获取标签列表
// ============================================================================

export function useTag() {
  const storage = getStorage();

  return useQuery({
    queryKey: tagKeys.all,
    queryFn: () => storage.tags.getTags(),
  });
}

// ============================================================================
// useCreateTag — 创建标签
// ============================================================================

export function useCreateTag() {
  const storage = getStorage();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: CreateTagInput) => storage.tags.createTag(input),

    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: tagKeys.all });

      const previousTags = queryClient.getQueryData<Tag[]>(tagKeys.all);

      const optimisticTag: Tag = {
        id: `temp-${Date.now()}`,
        name: input.name,
        color: input.color,
        userId: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      queryClient.setQueryData<Tag[]>(tagKeys.all, (old) =>
        old ? [...old, optimisticTag] : [optimisticTag],
      );

      return { previousTags };
    },

    onError: (_err, _input, context) => {
      if (context?.previousTags) {
        queryClient.setQueryData(tagKeys.all, context.previousTags);
      }
    },

    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: tagKeys.all });
    },
  });
}

// ============================================================================
// useUpdateTag — 更新标签
// ============================================================================

export function useUpdateTag() {
  const storage = getStorage();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateTagInput }) =>
      storage.tags.updateTag(id, input),

    onMutate: async ({ id, input }) => {
      await queryClient.cancelQueries({ queryKey: tagKeys.all });

      const previousTags = queryClient.getQueryData<Tag[]>(tagKeys.all);

      queryClient.setQueryData<Tag[]>(tagKeys.all, (old) =>
        old?.map((tag) =>
          tag.id === id ? { ...tag, ...input, updatedAt: new Date().toISOString() } : tag,
        ),
      );

      return { previousTags };
    },

    onError: (_err, _vars, context) => {
      if (context?.previousTags) {
        queryClient.setQueryData(tagKeys.all, context.previousTags);
      }
    },

    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: tagKeys.all });
    },
  });
}

// ============================================================================
// useDeleteTag — 删除标签
// ============================================================================

export function useDeleteTag() {
  const storage = getStorage();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => storage.tags.deleteTag(id),

    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: tagKeys.all });

      const previousTags = queryClient.getQueryData<Tag[]>(tagKeys.all);

      queryClient.setQueryData<Tag[]>(tagKeys.all, (old) => old?.filter((tag) => tag.id !== id));

      return { previousTags };
    },

    onError: (_err, _id, context) => {
      if (context?.previousTags) {
        queryClient.setQueryData(tagKeys.all, context.previousTags);
      }
    },

    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: tagKeys.all });
    },
  });
}
