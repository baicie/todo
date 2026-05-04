import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getStorage } from './useStorage';
import type { CreateGroupInput, UpdateGroupInput } from '@baicie/orbit';

export const groupKeys = {
  all: ['groups'] as const,
  detail: (id: string) => ['groups', id] as const,
};

export function useGroup() {
  const storage = getStorage();

  return useQuery({
    queryKey: groupKeys.all,
    queryFn: () => storage.groups.getGroups(),
  });
}

export function useGroupDetail(id: string | null) {
  const storage = getStorage();

  return useQuery({
    queryKey: groupKeys.detail(id ?? ''),
    queryFn: () => (id ? storage.groups.getGroup(id) : null),
    enabled: !!id,
  });
}

export function useCreateGroup() {
  const storage = getStorage();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: CreateGroupInput) => storage.groups.createGroup(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: groupKeys.all });
    },
  });
}

export function useUpdateGroup() {
  const storage = getStorage();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateGroupInput }) =>
      storage.groups.updateGroup(id, input),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: groupKeys.all });
      queryClient.invalidateQueries({ queryKey: groupKeys.detail(variables.id) });
    },
  });
}

export function useDeleteGroup() {
  const storage = getStorage();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => storage.groups.deleteGroup(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: groupKeys.all });
    },
  });
}
