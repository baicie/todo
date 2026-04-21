import { useMutation, useQueryClient } from '@tanstack/react-query';
import { getStorage } from './useStorage';
import { taskKeys } from './useTask';
import type { CreateStepInput, UpdateStepInput } from '@baicie/orbit';

// ============================================================================
// useSteps — 步骤管理（附加在任务上）
// ============================================================================

export function useAddStep() {
  const storage = getStorage();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ taskId, input }: { taskId: string; input: CreateStepInput }) =>
      storage.tasks.addStep(taskId, input),

    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: taskKeys.all });
    },
  });
}

export function useUpdateStep() {
  const storage = getStorage();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ stepId, input }: { stepId: string; input: UpdateStepInput }) =>
      storage.tasks.updateStep(stepId, input),

    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: taskKeys.all });
    },
  });
}

export function useDeleteStep() {
  const storage = getStorage();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (stepId: string) => storage.tasks.deleteStep(stepId),

    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: taskKeys.all });
    },
  });
}
