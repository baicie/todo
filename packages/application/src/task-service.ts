import {
  DomainError,
  newUuidV7,
  nextRecurringTask,
  normalizeNewTask,
  parseQuickAdd,
  todayInTimeZone,
  validateTaskPatch,
  type DateOnly,
  type ListPatch,
  type NewList,
  type NewStep,
  type NewTask,
  type Step,
  type StepPatch,
  type Task,
  type TaskList,
  type TaskPatch,
  type TaskQuery,
  type TaskWithSteps,
} from '@todo/domain';
import type {
  Clock,
  CompletionCommit,
  CompleteResult,
  ExportBundle,
  TaskRepository,
} from './ports';
import { systemClock } from './ports';

export interface QuickAddContext {
  localDate: DateOnly;
  listId: string | null;
  lists: TaskList[];
  /** When adding from My Day, select the new task for that day in the same transaction. */
  planDate?: DateOnly | null;
}

export class TaskService {
  constructor(
    private readonly repository: TaskRepository,
    private readonly timeZone: () => string,
    private readonly clock: Clock = systemClock,
  ) {}

  async createTask(input: NewTask): Promise<Task> {
    return this.repository.createTask(normalizeNewTask(input));
  }

  async quickAdd(text: string, context: QuickAddContext): Promise<Task> {
    const parsed = parseQuickAdd(
      text,
      context.localDate,
      context.lists,
      context.listId,
      this.timeZone(),
    );
    return this.createTask({
      ...parsed,
      planDate: context.planDate ?? null,
    });
  }

  async patchTask(id: string, patch: TaskPatch): Promise<Task> {
    const task = await this.requireTask(id);
    const validated = validateTaskPatch(patch);
    if (validated.recurrence !== undefined && validated.recurrence && !validated.dueOn) {
      if (!task.dueOn) throw new DomainError('VALIDATION_FAILED', '重复任务需要截止日期');
    }
    return this.repository.patchTask(id, validated);
  }

  async completeTask(id: string): Promise<CompleteResult> {
    const task = await this.requireTask(id);
    if (task.status === 'completed') {
      return { task, nextTask: null };
    }
    const nowDate = this.clock.now();
    const now = nowDate.toISOString();
    const completionDate = todayInTimeZone(this.timeZone(), nowDate);
    const next = nextRecurringTask(
      { ...task, status: 'completed' },
      completionDate,
      newUuidV7(nowDate.getTime()),
      now,
    );
    const commit: CompletionCommit = {
      taskId: id,
      completedAt: now,
      nextTask: next,
    };
    return this.repository.commitCompletion(commit);
  }

  async uncompleteTask(id: string): Promise<Task> {
    const task = await this.requireTask(id);
    if (task.status === 'open') return task;
    return this.repository.patchTask(id, { status: 'open', completedAt: null });
  }

  async toggleTask(id: string): Promise<CompleteResult | { task: Task; nextTask: null }> {
    const task = await this.requireTask(id);
    if (task.status === 'completed') {
      const updated = await this.uncompleteTask(id);
      return { task: updated, nextTask: null };
    }
    return this.completeTask(id);
  }

  async deleteTask(id: string): Promise<void> {
    await this.requireTask(id);
    await this.repository.deleteTask(id);
  }

  async restoreTask(id: string): Promise<void> {
    await this.repository.restoreTask(id);
  }

  async reorderTask(id: string, direction: 'up' | 'down'): Promise<void> {
    await this.repository.reorderTask(id, direction);
  }

  async planTask(taskId: string, date: DateOnly, plan = true): Promise<void> {
    if (plan) await this.repository.addToDay(taskId, date);
    else await this.repository.removeFromDay(taskId, date);
  }

  async createList(input: NewList): Promise<TaskList> {
    return this.repository.createList(input);
  }

  async patchList(id: string, patch: ListPatch): Promise<TaskList> {
    return this.repository.patchList(id, patch);
  }

  async deleteList(id: string): Promise<void> {
    await this.repository.deleteList(id);
  }

  async restoreList(id: string): Promise<void> {
    await this.repository.restoreList(id);
  }

  async addStep(input: NewStep): Promise<Step> {
    return this.repository.createStep(input);
  }

  async patchStep(id: string, patch: StepPatch): Promise<Step> {
    return this.repository.patchStep(id, patch);
  }

  async deleteStep(id: string): Promise<void> {
    await this.repository.deleteStep(id);
  }

  async suggestions(date: DateOnly): Promise<TaskWithSteps[]> {
    const [planned, overdue, all] = await Promise.all([
      this.repository.listDayPlan(date),
      this.repository.listTasks({ view: 'planned', dueTo: date, includeCompleted: false }),
      this.repository.listTasks({ view: 'all', includeCompleted: false }),
    ]);
    const plannedIds = new Set(planned.map((task) => task.id));
    const candidates = [
      ...overdue.items,
      ...all.items.filter((task) => task.important),
      ...all.items.filter((task) => task.listId === null),
    ];
    const seen = new Set<string>();
    return candidates
      .filter((task) => {
        if (plannedIds.has(task.id) || seen.has(task.id)) return false;
        seen.add(task.id);
        return true;
      })
      .slice(0, 6);
  }

  async exportBundle(): Promise<ExportBundle> {
    return this.repository.exportData();
  }

  async importBundle(bundle: ExportBundle, mode: 'merge' | 'replace' = 'merge'): Promise<void> {
    if (bundle.format !== 'todo-export' || bundle.version !== 1) {
      throw new DomainError('VALIDATION_FAILED', '不是有效的拾事备份文件');
    }
    if (!Array.isArray(bundle.tasks) || !Array.isArray(bundle.lists)) {
      throw new DomainError('VALIDATION_FAILED', '备份文件缺少任务或清单');
    }
    await this.repository.importData(bundle, mode);
  }

  async clearAll(): Promise<void> {
    await this.repository.clearAll();
  }

  private async requireTask(id: string): Promise<TaskWithSteps> {
    const task = await this.repository.getTask(id);
    if (!task || task.deletedAt) throw new DomainError('NOT_FOUND', '任务不存在');
    return task;
  }

  async query(query: TaskQuery): Promise<TaskWithSteps[]> {
    return (await this.repository.listTasks(query)).items;
  }
}
