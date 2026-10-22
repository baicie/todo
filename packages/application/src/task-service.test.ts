import { describe, expect, it, vi } from 'vitest';
import { TaskService } from '../src';
import type { CompletionCommit, CompleteResult, TaskRepository } from '../src';
import type { Task, TaskWithSteps } from '@todo/domain';

function makeTask(overrides: Partial<Task> = {}): TaskWithSteps {
  return {
    id: '019a0000-0000-7000-8000-000000000001',
    listId: null,
    title: '准备周报',
    note: '',
    status: 'open',
    important: false,
    dueOn: '2026-10-21',
    remindAt: null,
    remindTimezone: null,
    rank: '000001',
    seriesId: null,
    occurrenceKey: '2026-10-21',
    recurrence: { frequency: 'daily', interval: 1, anchorMode: 'calendar' },
    completedAt: null,
    createdAt: '2026-10-20T00:00:00.000Z',
    updatedAt: '2026-10-20T00:00:00.000Z',
    deletedAt: null,
    steps: [],
    dayPlanDates: [],
    ...overrides,
  };
}

describe('TaskService', () => {
  it('creates the next occurrence in the same completion commit', async () => {
    const task = makeTask();
    let commit: CompletionCommit | null = null;
    const repository = {
      getTask: vi.fn(async () => task),
      commitCompletion: vi.fn(async (input: CompletionCommit): Promise<CompleteResult> => {
        commit = input;
        return {
          task: { ...task, status: 'completed', completedAt: input.completedAt },
          nextTask: input.nextTask,
        };
      }),
      createTask: vi.fn(),
    } as unknown as TaskRepository;
    const service = new TaskService(repository, () => 'Asia/Shanghai', {
      now: () => new Date('2026-10-21T02:00:00.000Z'),
    });

    const result = await service.completeTask(task.id);
    expect(commit).not.toBeNull();
    expect(commit!.nextTask?.dueOn).toBe('2026-10-22');
    expect(commit!.nextTask?.status).toBe('open');
    expect(commit!.nextTask?.seriesId).toBe(task.id);
    expect(commit!.nextTask?.occurrenceKey).toBe('2026-10-22');
    expect(result.task.status).toBe('completed');
  });

  it('does not generate another recurrence instance for an already completed task', async () => {
    const task = makeTask({ status: 'completed', completedAt: '2026-10-20T00:00:00Z' });
    const commitCompletion = vi.fn();
    const repository = { getTask: async () => task, commitCompletion } as unknown as TaskRepository;
    const service = new TaskService(repository, () => 'Asia/Shanghai');
    const result = await service.completeTask(task.id);
    expect(result.nextTask).toBeNull();
    expect(commitCompletion).not.toHaveBeenCalled();
  });

  it('normalizes quick-add input before creating a task', async () => {
    const createTask = vi.fn(async (input) => makeTask({ title: input.title }));
    const repository = { createTask } as unknown as TaskRepository;
    const service = new TaskService(repository, () => 'Asia/Shanghai');
    await service.quickAdd('明天  给妈妈打电话 #生活', {
      localDate: '2026-10-21',
      listId: null,
      lists: [
        {
          id: 'life',
          name: '生活',
          color: null,
          icon: null,
          rank: '2',
          createdAt: '',
          updatedAt: '',
          deletedAt: null,
        },
      ],
    });
    expect(createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        title: '给妈妈打电话',
        dueOn: '2026-10-22',
        listId: 'life',
      }),
    );
  });
});
