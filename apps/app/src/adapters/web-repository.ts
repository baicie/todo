import Dexie, { type EntityTable } from 'dexie';
import type { Ack, Change } from '@todo/contracts';
import type { StoredMutation as SyncMutation } from '@todo/sync';
import {
  cleanSingleLine,
  isDateOnly,
  isTaskVisible,
  makeList,
  makeTask,
  newUuidV7,
  normalizeNewTask,
  sortTasks,
  taskQueryPredicate,
  validateTaskPatch,
  type DateOnly,
  type DayPlan,
  type Id,
  type ListPatch,
  type NewList,
  type NewStep,
  type NewTask,
  type Page,
  type Step,
  type StepPatch,
  type Task,
  type TaskList,
  type TaskPatch,
  type TaskQuery,
  type TaskWithSteps,
} from '@todo/domain';
import type {
  CompletionCommit,
  CompleteResult,
  ExportBundle,
  TaskRepository,
  ViewCounts,
} from '@todo/application';
import type {
  CloudDiagnostics,
  CloudInitializeResult,
  CloudMergeMode,
  CloudSyncStorage,
  RejectedMutation,
} from '../sync/storage';
import { StaleSyncSessionError } from '../sync/storage';
import type { CloudSnapshot } from '../sync/snapshot';

interface MetaRow {
  key: string;
  value: string;
}

interface ShadowRow {
  key: string;
  entity: 'task' | 'list' | 'step' | 'day_plan';
  entityId: string;
  serverSeq: number;
  data: Record<string, unknown>;
}

export interface StoredMutation {
  opId: string;
  deviceId: string;
  clientSeq: number;
  entity: 'task' | 'list' | 'step' | 'day_plan';
  entityId: string;
  kind: 'create' | 'patch' | 'delete' | 'restore';
  patch: Record<string, unknown>;
  createdAt: string;
  status: 'local' | 'pending' | 'rejected';
  errorCode?: string;
}

const DB_STORES = {
  tasks: 'id, listId, status, important, dueOn, updatedAt, deletedAt, [listId+status]',
  lists: 'id, rank, deletedAt',
  steps: 'id, taskId, [taskId+rank], deletedAt',
  dayPlans: 'id, taskId, localDate, [localDate+rank], [taskId+localDate], deletedAt',
  mutations: 'opId, [deviceId+clientSeq], status, entityId',
  meta: 'key',
} as const;

class ShishiDatabase extends Dexie {
  tasks!: EntityTable<Task, 'id'>;
  lists!: EntityTable<TaskList, 'id'>;
  steps!: EntityTable<Step, 'id'>;
  dayPlans!: EntityTable<DayPlan, 'id'>;
  mutations!: EntityTable<StoredMutation, 'opId'>;
  meta!: EntityTable<MetaRow, 'key'>;
  shadow!: EntityTable<ShadowRow, 'key'>;

  constructor(name = 'shishi-todo') {
    super(name);
    this.version(1).stores(DB_STORES);
    this.version(2).stores({
      ...DB_STORES,
      shadow: 'key, entity, entityId',
    });
    this.version(3).stores({
      ...DB_STORES,
      tasks: 'id, listId, status, important, dueOn, updatedAt, deletedAt, *tags, [listId+status]',
      shadow: 'key, entity, entityId',
    });
    this.version(4).stores({
      ...DB_STORES,
      tasks:
        'id, listId, status, important, dueOn, updatedAt, deletedAt, remindAt, *tags, [listId+status]',
      shadow: 'key, entity, entityId',
    });
  }
}

const DEFAULT_LISTS = [
  { name: '工作', color: '#4f6ed0' },
  { name: '生活', color: '#b27142' },
];

function nextRank(rows: Array<{ rank: string }>): string {
  const max = rows.reduce((current, row) => (row.rank > current ? row.rank : current), '');
  const numeric = Number.parseInt(max || '0', 36);
  const next = Number.isFinite(numeric) ? numeric + 1 : rows.length + 1;
  return next.toString(36).padStart(6, '0');
}

function planRank(rows: Array<{ rank: string }>): string {
  return nextRank(rows);
}

type EntityName = StoredMutation['entity'];

const MUTABLE_FIELDS: Record<EntityName, readonly string[]> = {
  task: [
    'listId',
    'title',
    'note',
    'status',
    'important',
    'dueOn',
    'remindAt',
    'remindTimezone',
    'rank',
    'seriesId',
    'occurrenceKey',
    'recurrence',
    'completedAt',
  ],
  list: ['name', 'color', 'icon', 'rank'],
  step: ['taskId', 'title', 'isCompleted', 'rank'],
  day_plan: ['taskId', 'localDate', 'rank'],
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function requiredString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function shadowKey(entity: EntityName, entityId: string): string {
  return `${entity}:${entityId}`;
}

function mutablePatch(entity: EntityName, value: unknown): Record<string, unknown> {
  const source = asRecord(value);
  return Object.fromEntries(
    MUTABLE_FIELDS[entity]
      .filter((field) => Object.prototype.hasOwnProperty.call(source, field))
      .map((field) => [field, source[field]]),
  );
}

function taskFromData(id: string, value: unknown): Task {
  const data = asRecord(value);
  const now = new Date().toISOString();
  const recurrence =
    data.recurrence && typeof data.recurrence === 'object' && !Array.isArray(data.recurrence)
      ? (data.recurrence as Task['recurrence'])
      : null;
  return {
    id,
    listId: optionalString(data.listId),
    title: requiredString(data.title),
    note: requiredString(data.note),
    status: data.status === 'completed' ? 'completed' : 'open',
    important: data.important === true,
    dueOn: isDateOnly(data.dueOn) ? data.dueOn : null,
    remindAt: optionalString(data.remindAt),
    remindTimezone: optionalString(data.remindTimezone),
    rank: requiredString(data.rank, 'a0'),
    seriesId: optionalString(data.seriesId),
    occurrenceKey: optionalString(data.occurrenceKey),
    recurrence,
    completedAt: optionalString(data.completedAt),
    createdAt: optionalString(data.createdAt) ?? now,
    updatedAt: optionalString(data.updatedAt) ?? now,
    deletedAt: optionalString(data.deletedAt),
  };
}

function listFromData(id: string, value: unknown): TaskList {
  const data = asRecord(value);
  const now = new Date().toISOString();
  return {
    id,
    name: requiredString(data.name),
    color: optionalString(data.color),
    icon: optionalString(data.icon),
    rank: requiredString(data.rank, 'a0'),
    createdAt: optionalString(data.createdAt) ?? now,
    updatedAt: optionalString(data.updatedAt) ?? now,
    deletedAt: optionalString(data.deletedAt),
  };
}

function stepFromData(id: string, value: unknown): Step {
  const data = asRecord(value);
  const now = new Date().toISOString();
  return {
    id,
    taskId: requiredString(data.taskId),
    title: requiredString(data.title),
    isCompleted: data.isCompleted === true,
    rank: requiredString(data.rank, 'a0'),
    createdAt: optionalString(data.createdAt) ?? now,
    updatedAt: optionalString(data.updatedAt) ?? now,
    deletedAt: optionalString(data.deletedAt),
  };
}

function dayPlanFromData(id: string, value: unknown): DayPlan {
  const data = asRecord(value);
  const now = new Date().toISOString();
  return {
    id,
    taskId: requiredString(data.taskId),
    localDate: isDateOnly(data.localDate) ? data.localDate : '1970-01-01',
    rank: requiredString(data.rank, 'a0'),
    createdAt: optionalString(data.createdAt) ?? now,
    updatedAt: optionalString(data.updatedAt) ?? now,
    deletedAt: optionalString(data.deletedAt),
  };
}

function materialize(entity: EntityName, id: string, data: Record<string, unknown>): unknown {
  switch (entity) {
    case 'task':
      return taskFromData(id, data);
    case 'list':
      return listFromData(id, data);
    case 'step':
      return stepFromData(id, data);
    case 'day_plan':
      return dayPlanFromData(id, data);
  }
}

function applyMutationToData(
  entity: EntityName,
  base: Record<string, unknown>,
  mutation: StoredMutation,
  now: string,
): Record<string, unknown> {
  let data: Record<string, unknown> =
    mutation.kind === 'create'
      ? { id: mutation.entityId, createdAt: now }
      : { ...base, id: mutation.entityId };
  if (mutation.kind === 'delete') {
    return { ...data, deletedAt: now, updatedAt: now };
  }
  if (mutation.kind === 'restore') {
    data = { ...data, deletedAt: null };
  }
  for (const field of MUTABLE_FIELDS[entity]) {
    if (Object.prototype.hasOwnProperty.call(mutation.patch, field)) {
      data[field] = mutation.patch[field];
    }
  }
  data.updatedAt = now;
  return data;
}

function applyServerChange(
  entity: EntityName,
  base: Record<string, unknown>,
  change: { kind: string; patch: Record<string, unknown> },
  now: string,
): Record<string, unknown> {
  let data: Record<string, unknown> =
    change.kind === 'create' ? { id: base.id, createdAt: now } : { ...base, id: base.id };
  if (change.kind === 'delete') {
    return { ...data, deletedAt: now, updatedAt: now };
  }
  if (change.kind === 'restore') {
    data.deletedAt = null;
  }
  for (const field of MUTABLE_FIELDS[entity]) {
    if (Object.prototype.hasOwnProperty.call(change.patch, field)) {
      data[field] = change.patch[field];
    }
  }
  data.updatedAt = now;
  return data;
}

function later(local: string | undefined, remote: string | undefined): boolean {
  if (!local) return false;
  if (!remote) return true;
  return local > remote;
}

function fullPatch(entity: EntityName, value: unknown): Record<string, unknown> {
  return mutablePatch(entity, value);
}

function inTransaction<T>(promise: Promise<T>): Promise<T> {
  return promise;
}

export class DexieTaskRepository implements CloudSyncStorage {
  private readonly db: ShishiDatabase;
  private readonly subscribers = new Set<(ids: string[]) => void>();
  private initialized = false;
  private seedPromise: Promise<void> | null = null;
  private allTasksCache: Task[] | null = null;
  private allTasksPromise: Promise<Task[]> | null = null;

  constructor(databaseName = 'shishi-todo') {
    this.db = new ShishiDatabase(databaseName);
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.db.open();
    let deviceId = await this.getMeta('deviceId');
    if (!deviceId) {
      deviceId = newUuidV7();
      await this.db.meta.put({ key: 'deviceId', value: deviceId });
    }
    if (!(await this.getMeta('clientSeq'))) {
      await this.db.meta.put({ key: 'clientSeq', value: '0' });
    }
    if ((await this.getMeta('syncEnabled')) === null) {
      await this.db.meta.put({ key: 'syncEnabled', value: 'false' });
    }
    await this.seedIfNeeded();
    this.initialized = true;
  }

  close(): void {
    this.db.close();
  }

  async createTask(input: NewTask): Promise<Task> {
    await this.initialize();
    const normalized = normalizeNewTask(input);
    const now = new Date().toISOString();
    const taskId = newUuidV7();
    return this.db
      .transaction(
        'rw',
        this.db.tasks,
        this.db.lists,
        this.db.dayPlans,
        this.db.mutations,
        this.db.meta,
        async () => {
          const tasks = await this.db.tasks.toArray();
          if (normalized.listId) {
            const list = await this.db.lists.get(normalized.listId);
            if (!list || list.deletedAt) throw new Error('清单不存在');
          }
          const task = makeTask(taskId, normalized, now, nextRank(tasks));
          await this.db.tasks.put(task);
          await this.appendMutation('task', task.id, 'create', { ...task }, now);
          if (normalized.planDate) {
            const plans = await this.db.dayPlans
              .where('localDate')
              .equals(normalized.planDate)
              .toArray();
            const plan: DayPlan = {
              id: newUuidV7(),
              taskId: task.id,
              localDate: normalized.planDate,
              rank: planRank(plans),
              createdAt: now,
              updatedAt: now,
              deletedAt: null,
            };
            await this.db.dayPlans.put(plan);
            await this.appendMutation('day_plan', plan.id, 'create', { ...plan }, now);
          }
          return task;
        },
      )
      .then((task) => {
        this.notify([task.id]);
        return task;
      });
  }

  async patchTask(id: Id, patch: TaskPatch): Promise<Task> {
    await this.initialize();
    const validated = validateTaskPatch(patch);
    let changed: Task | null = null;
    await this.db.transaction(
      'rw',
      this.db.tasks,
      this.db.lists,
      this.db.mutations,
      this.db.meta,
      async () => {
        const current = await this.db.tasks.get(id);
        if (!current || current.deletedAt) throw new Error('任务不存在');
        if (validated.listId) {
          const list = await this.db.lists.get(validated.listId);
          if (!list || list.deletedAt) throw new Error('清单不存在');
        }
        changed = {
          ...current,
          ...validated,
          updatedAt: new Date().toISOString(),
        };
        await this.db.tasks.put(changed);
        await this.appendMutation('task', id, 'patch', { ...validated }, changed.updatedAt);
      },
    );
    if (changed) this.notify([id]);
    return changed!;
  }

  async getTask(id: Id): Promise<TaskWithSteps | null> {
    await this.initialize();
    const task = await this.db.tasks.get(id);
    if (!task || task.deletedAt) return null;
    return this.attachDetails(task);
  }

  async listTasks(query: TaskQuery): Promise<Page<TaskWithSteps>> {
    await this.initialize();
    const predicate = taskQueryPredicate(query);
    let tasks: Task[] = [];

    if (query.view === 'my-day' && query.localDate) {
      const plans = await this.db.dayPlans
        .where('localDate')
        .equals(query.localDate)
        .filter((plan) => !plan.deletedAt)
        .sortBy('rank');
      const ids = plans.map((plan) => plan.taskId);
      if (ids.length === 0) return { items: [], nextCursor: null };
      const rows = await this.db.tasks.bulkGet(ids);
      const planOrder = new Map(ids.map((id, index) => [id, index]));
      tasks = rows
        .filter((task): task is Task => Boolean(task))
        .filter((task) => !task!.deletedAt)
        .filter(predicate)
        .sort((a, b) => (planOrder.get(a.id) ?? 0) - (planOrder.get(b.id) ?? 0));
    } else {
      tasks = await this.allTasksSnapshot();
      tasks = tasks.filter(predicate);
      if (query.view === 'list') {
        tasks.sort((a, b) => {
          if (a.status !== b.status) return a.status === 'open' ? -1 : 1;
          if (a.rank !== b.rank) return a.rank < b.rank ? -1 : 1;
          return a.createdAt < b.createdAt ? -1 : 1;
        });
      } else if (query.view === 'completed') {
        tasks.sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''));
      } else {
        tasks = sortTasks(tasks);
      }
    }

    const limited = tasks.slice(0, query.limit ?? 500);
    return {
      items: await this.attachDetailsBatch(limited),
      nextCursor: null,
    };
  }

  async listReminderCandidates(): Promise<Task[]> {
    await this.initialize();
    const tasks = await this.db.tasks.where('remindAt').above('').toArray();
    return tasks
      .filter((task) => !task.deletedAt && task.status === 'open' && Boolean(task.remindAt))
      .sort((a, b) => (a.remindAt ?? '').localeCompare(b.remindAt ?? ''));
  }

  async getCounts(localDate: DateOnly): Promise<ViewCounts> {
    await this.initialize();
    const [tasks, lists, plans] = await Promise.all([
      this.allTasksSnapshot(),
      this.db.lists.toArray(),
      this.db.dayPlans
        .where('localDate')
        .equals(localDate)
        .filter((plan) => !plan.deletedAt)
        .toArray(),
    ]);
    const open = tasks.filter((task) => isTaskVisible(task) && task.status === 'open');
    const counts: ViewCounts = {
      myDay: 0,
      important: 0,
      planned: 0,
      completed: 0,
      all: open.length,
      lists: {},
    };
    const planIds = new Set(plans.map((plan) => plan.taskId));
    for (const task of open) {
      if (planIds.has(task.id)) counts.myDay += 1;
      if (task.important) counts.important += 1;
      if (task.dueOn) counts.planned += 1;
      if (task.listId) counts.lists[task.listId] = (counts.lists[task.listId] ?? 0) + 1;
    }
    counts.completed = tasks.filter(
      (task) => isTaskVisible(task) && task.status === 'completed',
    ).length;
    for (const list of lists) {
      if (!counts.lists[list.id]) counts.lists[list.id] = 0;
    }
    return counts;
  }

  async commitCompletion(commit: CompletionCommit): Promise<CompleteResult> {
    await this.initialize();
    let result: CompleteResult | null = null;
    await this.db.transaction('rw', this.db.tasks, this.db.mutations, this.db.meta, async () => {
      const current = await this.db.tasks.get(commit.taskId);
      if (!current || current.deletedAt) throw new Error('任务不存在');
      const completed: Task = {
        ...current,
        status: 'completed',
        completedAt: commit.completedAt,
        updatedAt: new Date().toISOString(),
      };
      await this.db.tasks.put(completed);
      await this.appendMutation(
        'task',
        completed.id,
        'patch',
        { status: 'completed', completedAt: commit.completedAt },
        completed.updatedAt,
      );
      if (commit.nextTask) {
        await this.db.tasks.put(commit.nextTask);
        await this.appendMutation(
          'task',
          commit.nextTask.id,
          'create',
          { ...commit.nextTask },
          commit.nextTask.updatedAt,
        );
      }
      result = { task: completed, nextTask: commit.nextTask ?? null };
    });
    this.notify([commit.taskId, ...(commit.nextTask ? [commit.nextTask.id] : [])]);
    return result!;
  }

  async deleteTask(id: Id): Promise<void> {
    await this.initialize();
    await this.db.transaction('rw', this.db.tasks, this.db.mutations, this.db.meta, async () => {
      const task = await this.db.tasks.get(id);
      if (!task || task.deletedAt) return;
      const now = new Date().toISOString();
      await this.db.tasks.put({ ...task, deletedAt: now, updatedAt: now });
      await this.appendMutation('task', id, 'delete', {}, now);
    });
    this.notify([id]);
  }

  async restoreTask(id: Id): Promise<void> {
    await this.initialize();
    await this.db.transaction('rw', this.db.tasks, this.db.mutations, this.db.meta, async () => {
      const task = await this.db.tasks.get(id);
      if (!task) return;
      const now = new Date().toISOString();
      await this.db.tasks.put({ ...task, deletedAt: null, updatedAt: now });
      await this.appendMutation('task', id, 'restore', {}, now);
    });
    this.notify([id]);
  }

  async reorderTask(id: Id, direction: 'up' | 'down'): Promise<void> {
    await this.initialize();
    await this.db.transaction('rw', this.db.tasks, this.db.mutations, this.db.meta, async () => {
      const task = await this.db.tasks.get(id);
      if (!task || task.deletedAt) return;
      const siblings = (await this.db.tasks.toArray())
        .filter(
          (candidate) =>
            !candidate.deletedAt &&
            candidate.status === task.status &&
            candidate.listId === task.listId,
        )
        .sort((a, b) => {
          if (a.rank !== b.rank) return a.rank < b.rank ? -1 : 1;
          return a.createdAt < b.createdAt ? -1 : 1;
        });
      const index = siblings.findIndex((candidate) => candidate.id === id);
      const swapWith = direction === 'up' ? index - 1 : index + 1;
      if (index < 0 || swapWith < 0 || swapWith >= siblings.length) return;
      const other = siblings[swapWith]!;
      const now = new Date().toISOString();
      await this.db.tasks.put({ ...task, rank: other.rank, updatedAt: now });
      await this.db.tasks.put({ ...other, rank: task.rank, updatedAt: now });
      await this.appendMutation('task', task.id, 'patch', { rank: other.rank }, now);
      await this.appendMutation('task', other.id, 'patch', { rank: task.rank }, now);
    });
    this.notify([id]);
  }

  async listLists(): Promise<TaskList[]> {
    await this.initialize();
    return (await this.db.lists.toArray())
      .filter((list) => !list.deletedAt)
      .sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0));
  }

  async createList(input: NewList): Promise<TaskList> {
    await this.initialize();
    const now = new Date().toISOString();
    const id = newUuidV7();
    const list = makeList(id, input.name, now);
    list.color = input.color ?? null;
    list.icon = input.icon ?? null;
    list.rank = nextRank(await this.db.lists.toArray());
    await this.db.transaction('rw', this.db.lists, this.db.mutations, this.db.meta, async () => {
      await this.db.lists.put(list);
      await this.appendMutation('list', id, 'create', { ...list }, now);
    });
    this.notify([id]);
    return list;
  }

  async patchList(id: Id, patch: ListPatch): Promise<TaskList> {
    await this.initialize();
    let updated: TaskList | null = null;
    await this.db.transaction('rw', this.db.lists, this.db.mutations, this.db.meta, async () => {
      const current = await this.db.lists.get(id);
      if (!current || current.deletedAt) throw new Error('清单不存在');
      const next: TaskList = {
        ...current,
        ...patch,
        name:
          patch.name === undefined
            ? current.name
            : cleanSingleLine(patch.name, 120) || current.name,
        updatedAt: new Date().toISOString(),
      };
      await this.db.lists.put(next);
      await this.appendMutation('list', id, 'patch', { ...patch }, next.updatedAt);
      updated = next;
    });
    this.notify([id]);
    return updated!;
  }

  async deleteList(id: Id): Promise<void> {
    await this.initialize();
    await this.db.transaction(
      'rw',
      this.db.lists,
      this.db.tasks,
      this.db.mutations,
      this.db.meta,
      async () => {
        const list = await this.db.lists.get(id);
        if (!list || list.deletedAt) return;
        const now = new Date().toISOString();
        await this.db.lists.put({ ...list, deletedAt: now, updatedAt: now });
        await this.appendMutation('list', id, 'delete', {}, now);
        const tasks = await this.db.tasks.where('listId').equals(id).toArray();
        for (const task of tasks) {
          if (!task.deletedAt) {
            await this.db.tasks.put({ ...task, listId: null, updatedAt: now });
            await this.appendMutation('task', task.id, 'patch', { listId: null }, now);
          }
        }
      },
    );
    this.notify([id]);
  }

  async restoreList(id: Id): Promise<void> {
    await this.initialize();
    await this.db.transaction('rw', this.db.lists, this.db.mutations, this.db.meta, async () => {
      const list = await this.db.lists.get(id);
      if (!list) return;
      const now = new Date().toISOString();
      await this.db.lists.put({ ...list, deletedAt: null, updatedAt: now });
      await this.appendMutation('list', id, 'restore', {}, now);
    });
    this.notify([id]);
  }

  async listDayPlan(date: DateOnly): Promise<TaskWithSteps[]> {
    await this.initialize();
    const plans = await this.db.dayPlans
      .where('localDate')
      .equals(date)
      .filter((plan) => !plan.deletedAt)
      .sortBy('rank');
    if (plans.length === 0) return [];
    const rows = await this.db.tasks.bulkGet(plans.map((plan) => plan.taskId));
    const ordered = rows.filter((task): task is Task => Boolean(task) && !task!.deletedAt);
    return this.attachDetailsBatch(ordered);
  }

  async addToDay(taskId: Id, date: DateOnly): Promise<void> {
    await this.initialize();
    let planId = '';
    await this.db.transaction(
      'rw',
      this.db.tasks,
      this.db.dayPlans,
      this.db.mutations,
      this.db.meta,
      async () => {
        const task = await this.db.tasks.get(taskId);
        if (!task || task.deletedAt) throw new Error('任务不存在');
        const existing = await this.db.dayPlans
          .where('[taskId+localDate]')
          .equals([taskId, date])
          .first();
        const now = new Date().toISOString();
        if (existing) {
          planId = existing.id;
          if (existing.deletedAt) {
            await this.db.dayPlans.put({ ...existing, deletedAt: null, updatedAt: now });
            await this.appendMutation('day_plan', existing.id, 'restore', {}, now);
          }
          return;
        }
        const plans = await this.db.dayPlans.where('localDate').equals(date).toArray();
        const plan: DayPlan = {
          id: newUuidV7(),
          taskId,
          localDate: date,
          rank: planRank(plans),
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        };
        planId = plan.id;
        await this.db.dayPlans.put(plan);
        await this.appendMutation('day_plan', plan.id, 'create', { ...plan }, now);
      },
    );
    this.notify([taskId, planId]);
  }

  async removeFromDay(taskId: Id, date: DateOnly): Promise<void> {
    await this.initialize();
    await this.db.transaction('rw', this.db.dayPlans, this.db.mutations, this.db.meta, async () => {
      const plan = await this.db.dayPlans
        .where('[taskId+localDate]')
        .equals([taskId, date])
        .first();
      if (!plan || plan.deletedAt) return;
      const now = new Date().toISOString();
      await this.db.dayPlans.put({ ...plan, deletedAt: now, updatedAt: now });
      await this.appendMutation('day_plan', plan.id, 'delete', {}, now);
    });
    this.notify([taskId]);
  }

  async createStep(input: NewStep): Promise<Step> {
    await this.initialize();
    const title = cleanSingleLine(input.title);
    if (!title) throw new Error('子步骤不能为空');
    const now = new Date().toISOString();
    const step: Step = {
      id: newUuidV7(),
      taskId: input.taskId,
      title,
      isCompleted: false,
      rank: '000001',
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    await this.db.transaction(
      'rw',
      this.db.tasks,
      this.db.steps,
      this.db.mutations,
      this.db.meta,
      async () => {
        const task = await this.db.tasks.get(input.taskId);
        if (!task || task.deletedAt) throw new Error('任务不存在');
        const steps = await this.db.steps.where('taskId').equals(input.taskId).toArray();
        step.rank = nextRank(steps.filter((item) => !item.deletedAt));
        await this.db.steps.put(step);
        await this.appendMutation('step', step.id, 'create', { ...step }, now);
      },
    );
    this.notify([input.taskId]);
    return step;
  }

  async patchStep(id: Id, patch: StepPatch): Promise<Step> {
    await this.initialize();
    let updated: Step | null = null;
    await this.db.transaction('rw', this.db.steps, this.db.mutations, this.db.meta, async () => {
      const current = await this.db.steps.get(id);
      if (!current || current.deletedAt) throw new Error('子步骤不存在');
      updated = {
        ...current,
        ...patch,
        title:
          patch.title === undefined ? current.title : cleanSingleLine(patch.title) || current.title,
        updatedAt: new Date().toISOString(),
      };
      await this.db.steps.put(updated);
      await this.appendMutation('step', id, 'patch', { ...patch }, updated.updatedAt);
    });
    this.notify([updated!.taskId]);
    return updated!;
  }

  async deleteStep(id: Id): Promise<void> {
    await this.initialize();
    let taskId = '';
    await this.db.transaction('rw', this.db.steps, this.db.mutations, this.db.meta, async () => {
      const step = await this.db.steps.get(id);
      if (!step || step.deletedAt) return;
      taskId = step.taskId;
      const now = new Date().toISOString();
      await this.db.steps.put({ ...step, deletedAt: now, updatedAt: now });
      await this.appendMutation('step', id, 'delete', {}, now);
    });
    this.notify([taskId]);
  }

  async exportData(): Promise<ExportBundle> {
    await this.initialize();
    const [tasks, lists, steps, dayPlans] = await Promise.all([
      this.db.tasks.toArray(),
      this.db.lists.toArray(),
      this.db.steps.toArray(),
      this.db.dayPlans.toArray(),
    ]);
    return {
      format: 'todo-export',
      version: 1,
      exportedAt: new Date().toISOString(),
      appVersion: '1.0.0',
      tasks,
      lists,
      steps,
      dayPlans,
    };
  }

  async importData(bundle: ExportBundle, mode: 'merge' | 'replace'): Promise<void> {
    await this.initialize();
    if (bundle.format !== 'todo-export' || bundle.version !== 1) {
      throw new Error('备份格式不受支持');
    }
    const readRows = <T extends { id: string }>(rows: unknown, label: string): T[] => {
      if (!Array.isArray(rows) || rows.some((row) => !row || typeof row.id !== 'string')) {
        throw new Error(`${label}数据损坏`);
      }
      return rows as T[];
    };
    const taskRows = readRows<Task>(bundle.tasks, '任务');
    const listRows = readRows<TaskList>(bundle.lists, '清单');
    const stepRows = readRows<Step>(bundle.steps, '子步骤');
    const dayPlanRows = readRows<DayPlan>(bundle.dayPlans, '我的一天');
    for (const task of taskRows) {
      if (
        typeof task.title !== 'string' ||
        !task.title.trim() ||
        (task.status !== 'open' && task.status !== 'completed') ||
        (task.dueOn !== null && !isDateOnly(task.dueOn)) ||
        (task.createdAt !== undefined && typeof task.createdAt !== 'string')
      ) {
        throw new Error('备份中存在无效任务');
      }
    }
    for (const list of listRows) {
      if (typeof list.name !== 'string' || !list.name.trim()) {
        throw new Error('备份中存在无效清单');
      }
    }
    for (const step of stepRows) {
      if (typeof step.title !== 'string' || typeof step.taskId !== 'string') {
        throw new Error('备份中存在无效子步骤');
      }
    }
    for (const plan of dayPlanRows) {
      if (typeof plan.taskId !== 'string' || !isDateOnly(plan.localDate)) {
        throw new Error('备份中存在无效计划记录');
      }
    }
    await this.db.transaction(
      'rw',
      [
        this.db.tasks,
        this.db.lists,
        this.db.steps,
        this.db.dayPlans,
        this.db.mutations,
        this.db.meta,
        this.db.shadow,
      ],
      async () => {
        if (mode === 'replace') {
          await Promise.all([
            this.db.tasks.clear(),
            this.db.lists.clear(),
            this.db.steps.clear(),
            this.db.dayPlans.clear(),
          ]);
        }
        await this.db.mutations.clear();
        await this.db.shadow.clear();
        await this.db.lists.bulkPut(listRows);
        await this.db.tasks.bulkPut(taskRows);
        await this.db.steps.bulkPut(stepRows);
        await this.db.dayPlans.bulkPut(dayPlanRows);
        await this.db.meta.bulkPut([
          { key: 'seedVersion', value: '1' },
          { key: 'syncEnabled', value: 'false' },
          { key: 'boundAccount', value: '' },
          { key: 'syncCursor', value: '0' },
          { key: 'clientSeq', value: '0' },
          { key: 'bootstrapRequired', value: '0' },
        ]);
      },
    );
    this.notify(bundle.tasks.map((task) => task.id));
  }

  async clearAll(): Promise<void> {
    await this.initialize();
    await this.db.transaction(
      'rw',
      [
        this.db.tasks,
        this.db.lists,
        this.db.steps,
        this.db.dayPlans,
        this.db.mutations,
        this.db.meta,
        this.db.shadow,
      ],
      async () => {
        await Promise.all([
          this.db.tasks.clear(),
          this.db.lists.clear(),
          this.db.steps.clear(),
          this.db.dayPlans.clear(),
          this.db.mutations.clear(),
          this.db.shadow.clear(),
        ]);
        await this.db.meta.bulkPut([
          { key: 'seedVersion', value: '1' },
          { key: 'syncEnabled', value: 'false' },
          { key: 'boundAccount', value: '' },
          { key: 'syncCursor', value: '0' },
          { key: 'clientSeq', value: '0' },
          { key: 'bootstrapRequired', value: '0' },
        ]);
        await this.db.meta.delete('syncSession');
      },
    );
    this.notify([]);
  }

  subscribeChanges(callback: (entityIds: string[]) => void): () => void {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  async getMeta(key: string): Promise<string | null> {
    const row = await this.db.meta.get(key);
    return row?.value ?? null;
  }

  async setMeta(key: string, value: string): Promise<void> {
    await this.db.meta.put({ key, value });
  }

  async syncSetSession(sessionId: string | null): Promise<void> {
    await this.initialize();
    if (sessionId === null) await this.db.meta.delete('syncSession');
    else await this.db.meta.put({ key: 'syncSession', value: sessionId });
  }

  private async assertSyncSession(expected?: string): Promise<void> {
    if (!expected) return;
    const current = await this.db.meta.get('syncSession');
    if (current?.value !== expected) throw new StaleSyncSessionError();
  }

  async syncGetDeviceId(): Promise<string> {
    await this.initialize();
    return (await this.getMeta('deviceId')) ?? '';
  }

  async syncRotateDevice(): Promise<string> {
    await this.initialize();
    const deviceId = newUuidV7();
    await this.db.transaction('rw', this.db.mutations, this.db.meta, async () => {
      await this.db.meta.put({ key: 'deviceId', value: deviceId });
      await this.db.meta.put({ key: 'clientSeq', value: '0' });
      await this.db.meta.put({ key: 'syncCursor', value: '0' });
      await this.db.meta.put({ key: 'syncEnabled', value: 'false' });
      await this.db.mutations.toCollection().modify({ deviceId, status: 'local' });
    });
    return deviceId;
  }

  async syncGetCursor(): Promise<string> {
    await this.initialize();
    return (await this.getMeta('syncCursor')) ?? '0';
  }

  async syncGetPending(limit: number): Promise<SyncMutation[]> {
    await this.initialize();
    const rows = await this.db.mutations.where('status').equals('pending').sortBy('clientSeq');
    return rows.slice(0, Math.max(1, limit)).map((row) => ({
      opId: row.opId,
      deviceId: row.deviceId,
      clientSeq: row.clientSeq,
      entity: row.entity,
      entityId: row.entityId,
      kind: row.kind,
      patch: row.patch,
    }));
  }

  async syncGetPendingCount(): Promise<number> {
    await this.initialize();
    return this.db.mutations.where('status').equals('pending').count();
  }

  async syncGetRejectedCount(): Promise<number> {
    await this.initialize();
    return this.db.mutations.where('status').equals('rejected').count();
  }

  async syncListRejected(limit: number): Promise<RejectedMutation[]> {
    await this.initialize();
    const rows = await this.db.mutations
      .where('status')
      .equals('rejected')
      .limit(Math.max(1, Math.min(100, limit)))
      .toArray();
    return rows.map((mutation) => {
      const row = mutation as StoredMutation & {
        errorCode?: string | null;
        createdAt?: string;
      };
      return {
        opId: mutation.opId,
        entity: mutation.entity,
        entityId: mutation.entityId,
        kind: mutation.kind,
        patch: mutation.patch,
        errorCode: row.errorCode ?? null,
        createdAt: row.createdAt ?? null,
      };
    });
  }

  async syncDiscardRejected(opId: string): Promise<void> {
    await this.initialize();
    const mutation = await this.db.mutations.get(opId);
    if (!mutation) return;
    const row = mutation as StoredMutation & { status?: string };
    if (row.status !== 'rejected') {
      throw new Error('该操作不是失败状态，无法回滚');
    }
    await this.db.transaction(
      'rw',
      [this.db.tasks, this.db.lists, this.db.steps, this.db.dayPlans, this.db.mutations],
      async () => {
        await this.db.mutations.delete(opId);
        await this.reprojectEntity(mutation.entity, mutation.entityId);
      },
    );
    this.notify([mutation.entityId]);
  }

  async syncGetDiagnostics(): Promise<CloudDiagnostics> {
    await this.initialize();
    const [deviceId, cursor, pending, rejected, enabled, boundAccount] = await Promise.all([
      this.getMeta('deviceId'),
      this.getMeta('syncCursor'),
      this.syncGetPendingCount(),
      this.syncGetRejectedCount(),
      this.getMeta('syncEnabled'),
      this.getMeta('boundAccount'),
    ]);
    return {
      enabled: enabled === 'true',
      deviceId: deviceId ?? '',
      cursor: cursor ?? '0',
      pending,
      rejected,
      boundAccount,
    };
  }

  async syncSetEnabled(enabled: boolean): Promise<void> {
    await this.initialize();
    await this.db.transaction('rw', this.db.mutations, this.db.meta, async () => {
      if (enabled) {
        await this.db.mutations.where('status').equals('local').modify({ status: 'pending' });
      } else {
        await this.db.mutations.where('status').equals('pending').modify({ status: 'local' });
      }
      await this.db.meta.put({ key: 'syncEnabled', value: enabled ? 'true' : 'false' });
    });
  }

  async syncMarkBootstrapRequired(): Promise<void> {
    await this.initialize();
    await this.db.meta.put({ key: 'bootstrapRequired', value: '1' });
  }

  async syncClearAccountBinding(): Promise<void> {
    await this.initialize();
    await this.db.transaction('rw', this.db.mutations, this.db.meta, async () => {
      await this.db.meta.put({ key: 'boundAccount', value: '' });
      await this.db.meta.put({ key: 'syncEnabled', value: 'false' });
      await this.db.meta.put({ key: 'syncCursor', value: '0' });
      await this.db.meta.put({ key: 'clientSeq', value: '0' });
      await this.db.mutations.clear();
    });
  }

  async syncClearRejected(): Promise<void> {
    await this.initialize();
    const rejected = await this.db.mutations.where('status').equals('rejected').toArray();
    if (rejected.length === 0) return;
    const affected = new Map<string, { entity: EntityName; entityId: string }>();
    for (const mutation of rejected) {
      affected.set(shadowKey(mutation.entity, mutation.entityId), {
        entity: mutation.entity,
        entityId: mutation.entityId,
      });
    }
    await this.db.transaction(
      'rw',
      [
        this.db.tasks,
        this.db.lists,
        this.db.steps,
        this.db.dayPlans,
        this.db.mutations,
        this.db.shadow,
      ],
      async () => {
        await this.db.mutations.bulkDelete(rejected.map((mutation) => mutation.opId));
        for (const item of affected.values()) {
          await this.reprojectEntity(item.entity, item.entityId);
        }
      },
    );
  }

  async syncApplyResult(
    result: {
      acks: Ack[];
      changes: Change[];
      nextCursor: string;
    },
    sessionId?: string,
  ): Promise<void> {
    await this.initialize();
    const now = new Date().toISOString();
    const affected = new Map<string, { entity: EntityName; entityId: string }>();
    const ackIds = result.acks.map((ack) => ack.op_id);
    const acknowledged = await this.db.mutations.bulkGet(ackIds);

    await this.db.transaction(
      'rw',
      [
        this.db.tasks,
        this.db.lists,
        this.db.steps,
        this.db.dayPlans,
        this.db.mutations,
        this.db.meta,
        this.db.shadow,
      ],
      async () => {
        await this.assertSyncSession(sessionId);
        for (const ack of result.acks) {
          const mutation = acknowledged.find((row) => row?.opId === ack.op_id);
          if (!mutation) continue;
          affected.set(shadowKey(mutation.entity, mutation.entityId), {
            entity: mutation.entity,
            entityId: mutation.entityId,
          });
          if (ack.status === 'rejected') {
            await this.db.mutations.update(ack.op_id, {
              status: 'rejected',
              errorCode: ack.error_code ?? 'UNKNOWN',
            });
          } else {
            await this.db.mutations.delete(ack.op_id);
          }
        }

        for (const change of result.changes) {
          if (
            change.entity !== 'task' &&
            change.entity !== 'list' &&
            change.entity !== 'step' &&
            change.entity !== 'day_plan'
          ) {
            continue;
          }
          const entity = change.entity as EntityName;
          const key = shadowKey(entity, change.entity_id);
          affected.set(key, { entity, entityId: change.entity_id });
          const previous = await this.db.shadow.get(key);
          const base = previous?.data ?? { id: change.entity_id };
          const data = applyServerChange(
            entity,
            base,
            { kind: change.kind, patch: change.patch },
            now,
          );
          await this.db.shadow.put({
            key,
            entity,
            entityId: change.entity_id,
            serverSeq: change.server_seq,
            data,
          });
        }

        for (const item of affected.values()) {
          await this.reprojectEntity(item.entity, item.entityId);
        }

        await this.db.meta.put({ key: 'syncCursor', value: result.nextCursor });
        await this.db.meta.put({ key: 'bootstrapRequired', value: '0' });
      },
    );

    this.notify([...affected.values()].map((item) => item.entityId));
  }

  async syncInitializeCloud(
    snapshot: CloudSnapshot,
    mode: CloudMergeMode,
    accountEmail: string,
    sessionId?: string,
  ): Promise<CloudInitializeResult> {
    await this.initialize();
    const now = new Date().toISOString();
    let preparedOps = 0;
    await this.db.transaction(
      'rw',
      [
        this.db.tasks,
        this.db.lists,
        this.db.steps,
        this.db.dayPlans,
        this.db.mutations,
        this.db.meta,
        this.db.shadow,
      ],
      async () => {
        await this.assertSyncSession(sessionId);
        const shadowRows: ShadowRow[] = [
          ...snapshot.lists.map((list) => ({
            key: shadowKey('list', list.id),
            entity: 'list' as const,
            entityId: list.id,
            serverSeq: 0,
            data: { ...list },
          })),
          ...snapshot.tasks.map((task) => ({
            key: shadowKey('task', task.id),
            entity: 'task' as const,
            entityId: task.id,
            serverSeq: 0,
            data: { ...task },
          })),
          ...snapshot.steps.map((step) => ({
            key: shadowKey('step', step.id),
            entity: 'step' as const,
            entityId: step.id,
            serverSeq: 0,
            data: { ...step },
          })),
          ...snapshot.dayPlans.map((plan) => ({
            key: shadowKey('day_plan', plan.id),
            entity: 'day_plan' as const,
            entityId: plan.id,
            serverSeq: 0,
            data: { ...plan },
          })),
        ];

        await this.db.mutations.clear();
        await this.db.shadow.clear();

        if (mode === 'cloud') {
          await Promise.all([
            this.db.tasks.clear(),
            this.db.lists.clear(),
            this.db.steps.clear(),
            this.db.dayPlans.clear(),
          ]);
          await this.db.lists.bulkPut(snapshot.lists);
          await this.db.tasks.bulkPut(snapshot.tasks);
          await this.db.steps.bulkPut(snapshot.steps);
          await this.db.dayPlans.bulkPut(snapshot.dayPlans);
          await this.db.shadow.bulkPut(shadowRows);
          await this.db.meta.put({ key: 'clientSeq', value: '0' });
          await this.db.meta.put({ key: 'syncCursor', value: snapshot.cursor });
          await this.db.meta.put({ key: 'syncEnabled', value: 'true' });
          await this.db.meta.put({ key: 'boundAccount', value: accountEmail });
          await this.db.meta.put({ key: 'bootstrapRequired', value: '0' });
          return;
        }

        const local = {
          lists: await this.db.lists.toArray(),
          tasks: await this.db.tasks.toArray(),
          steps: await this.db.steps.toArray(),
          dayPlans: await this.db.dayPlans.toArray(),
        };
        const remote = {
          lists: new Map(snapshot.lists.map((item) => [item.id, item])),
          tasks: new Map(snapshot.tasks.map((item) => [item.id, item])),
          steps: new Map(snapshot.steps.map((item) => [item.id, item])),
          dayPlans: new Map(snapshot.dayPlans.map((item) => [item.id, item])),
        };
        const localMaps = {
          lists: new Map(local.lists.map((item) => [item.id, item])),
          tasks: new Map(local.tasks.map((item) => [item.id, item])),
          steps: new Map(local.steps.map((item) => [item.id, item])),
          dayPlans: new Map(local.dayPlans.map((item) => [item.id, item])),
        };
        const ops: Array<{
          entity: EntityName;
          entityId: string;
          kind: StoredMutation['kind'];
          patch: Record<string, unknown>;
        }> = [];
        const addOp = (
          entity: EntityName,
          entityId: string,
          kind: StoredMutation['kind'],
          patch: Record<string, unknown>,
        ) => ops.push({ entity, entityId, kind, patch });

        const mergedLists = new Map<string, TaskList>();
        for (const [id, list] of remote.lists) mergedLists.set(id, list);
        for (const list of local.lists) {
          const server = remote.lists.get(list.id);
          if (!server) {
            if (!list.deletedAt) {
              mergedLists.set(list.id, list);
              addOp('list', list.id, 'create', fullPatch('list', list));
            }
            continue;
          }
          if (list.deletedAt) {
            mergedLists.set(list.id, list);
            if (!server.deletedAt) addOp('list', list.id, 'delete', {});
            continue;
          }
          if (server.deletedAt) {
            if (later(list.updatedAt, server.updatedAt)) {
              mergedLists.set(list.id, list);
              addOp('list', list.id, 'restore', fullPatch('list', list));
            } else {
              mergedLists.set(list.id, server);
            }
            continue;
          }
          if (later(list.updatedAt, server.updatedAt)) {
            mergedLists.set(list.id, list);
            addOp('list', list.id, 'patch', fullPatch('list', list));
          }
        }

        const mergedTasks = new Map<string, Task>();
        for (const [id, task] of remote.tasks) mergedTasks.set(id, task);
        for (const task of local.tasks) {
          const server = remote.tasks.get(task.id);
          if (!server) {
            if (!task.deletedAt) {
              mergedTasks.set(task.id, task);
              addOp('task', task.id, 'create', fullPatch('task', task));
            }
            continue;
          }
          if (task.deletedAt) {
            mergedTasks.set(task.id, task);
            if (!server.deletedAt) addOp('task', task.id, 'delete', {});
            continue;
          }
          if (server.deletedAt) {
            if (later(task.updatedAt, server.updatedAt)) {
              mergedTasks.set(task.id, task);
              addOp('task', task.id, 'restore', fullPatch('task', task));
            } else {
              mergedTasks.set(task.id, server);
            }
            continue;
          }
          if (later(task.updatedAt, server.updatedAt)) {
            mergedTasks.set(task.id, task);
            addOp('task', task.id, 'patch', fullPatch('task', task));
          }
        }

        const mergedSteps = new Map<string, Step>();
        for (const [id, step] of remote.steps) mergedSteps.set(id, step);
        for (const step of local.steps) {
          const server = remote.steps.get(step.id);
          if (!server) {
            if (!step.deletedAt) {
              mergedSteps.set(step.id, step);
              addOp('step', step.id, 'create', fullPatch('step', step));
            }
            continue;
          }
          if (step.deletedAt) {
            mergedSteps.set(step.id, step);
            if (!server.deletedAt) addOp('step', step.id, 'delete', {});
            continue;
          }
          if (server.deletedAt) {
            if (later(step.updatedAt, server.updatedAt)) {
              mergedSteps.set(step.id, step);
              addOp('step', step.id, 'restore', fullPatch('step', step));
            } else {
              mergedSteps.set(step.id, server);
            }
            continue;
          }
          if (later(step.updatedAt, server.updatedAt)) {
            mergedSteps.set(step.id, step);
            addOp('step', step.id, 'patch', fullPatch('step', step));
          }
        }

        const remotePlanKeys = new Map(
          snapshot.dayPlans.map((plan) => [`${plan.taskId}:${plan.localDate}`, plan]),
        );
        const mergedPlans = new Map<string, DayPlan>();
        for (const [id, plan] of remote.dayPlans) mergedPlans.set(id, plan);
        for (const plan of local.dayPlans) {
          const server = remote.dayPlans.get(plan.id);
          const key = `${plan.taskId}:${plan.localDate}`;
          const remoteSameSlot = remotePlanKeys.get(key);
          if (!server) {
            if (!plan.deletedAt && (!remoteSameSlot || remoteSameSlot.id === plan.id)) {
              mergedPlans.set(plan.id, plan);
              addOp('day_plan', plan.id, 'create', fullPatch('day_plan', plan));
            }
            continue;
          }
          if (plan.deletedAt) {
            mergedPlans.set(plan.id, plan);
            if (!server.deletedAt) addOp('day_plan', plan.id, 'delete', {});
            continue;
          }
          if (server.deletedAt) {
            if (later(plan.updatedAt, server.updatedAt)) {
              mergedPlans.set(plan.id, plan);
              addOp('day_plan', plan.id, 'restore', fullPatch('day_plan', plan));
            } else {
              mergedPlans.set(plan.id, server);
            }
            continue;
          }
          if (later(plan.updatedAt, server.updatedAt)) {
            mergedPlans.set(plan.id, plan);
            addOp('day_plan', plan.id, 'patch', fullPatch('day_plan', plan));
          }
        }

        // Creates first, then updates/deletes. Lists resolve before tasks, and
        // parent tasks before steps/day plans.
        const order: EntityName[] = ['list', 'task', 'step', 'day_plan'];
        const orderedOps = order.flatMap((entity) => ops.filter((op) => op.entity === entity));
        const deviceId = (await this.getMeta('deviceId')) ?? 'local-device';
        let clientSeq = 0;
        const mutations: StoredMutation[] = orderedOps.map((op) => {
          clientSeq += 1;
          return {
            opId: newUuidV7(),
            deviceId,
            clientSeq,
            entity: op.entity,
            entityId: op.entityId,
            kind: op.kind,
            patch: op.patch,
            createdAt: now,
            status: 'pending',
          };
        });

        await Promise.all([
          this.db.tasks.clear(),
          this.db.lists.clear(),
          this.db.steps.clear(),
          this.db.dayPlans.clear(),
        ]);
        await this.db.lists.bulkPut([...mergedLists.values()]);
        await this.db.tasks.bulkPut([...mergedTasks.values()]);
        await this.db.steps.bulkPut([...mergedSteps.values()]);
        await this.db.dayPlans.bulkPut([...mergedPlans.values()]);
        await this.db.shadow.bulkPut(shadowRows);
        await this.db.mutations.bulkPut(mutations);
        await this.db.meta.put({ key: 'clientSeq', value: String(clientSeq) });
        await this.db.meta.put({ key: 'syncCursor', value: snapshot.cursor });
        await this.db.meta.put({ key: 'syncEnabled', value: 'true' });
        await this.db.meta.put({ key: 'boundAccount', value: accountEmail });
        await this.db.meta.put({ key: 'bootstrapRequired', value: '0' });
        preparedOps = mutations.length;
      },
    );

    this.notify([
      ...snapshot.lists.map((item) => item.id),
      ...snapshot.tasks.map((item) => item.id),
    ]);
    return { preparedOps };
  }

  async syncReplaceSnapshot(snapshot: CloudSnapshot, sessionId?: string): Promise<void> {
    await this.initialize();
    const now = new Date().toISOString();
    await this.db.transaction(
      'rw',
      [
        this.db.tasks,
        this.db.lists,
        this.db.steps,
        this.db.dayPlans,
        this.db.mutations,
        this.db.meta,
        this.db.shadow,
      ],
      async () => {
        await this.assertSyncSession(sessionId);
        const pending = await this.db.mutations.where('status').equals('pending').toArray();
        const local = {
          lists: await this.db.lists.toArray(),
          tasks: await this.db.tasks.toArray(),
          steps: await this.db.steps.toArray(),
          dayPlans: await this.db.dayPlans.toArray(),
        };
        const grouped = new Map<string, StoredMutation[]>();
        for (const mutation of pending.sort((a, b) => a.clientSeq - b.clientSeq)) {
          const key = shadowKey(mutation.entity, mutation.entityId);
          grouped.set(key, [...(grouped.get(key) ?? []), mutation]);
        }

        const shadowRows: ShadowRow[] = [
          ...snapshot.lists.map((list) => ({
            key: shadowKey('list', list.id),
            entity: 'list' as const,
            entityId: list.id,
            serverSeq: 0,
            data: { ...list },
          })),
          ...snapshot.tasks.map((task) => ({
            key: shadowKey('task', task.id),
            entity: 'task' as const,
            entityId: task.id,
            serverSeq: 0,
            data: { ...task },
          })),
          ...snapshot.steps.map((step) => ({
            key: shadowKey('step', step.id),
            entity: 'step' as const,
            entityId: step.id,
            serverSeq: 0,
            data: { ...step },
          })),
          ...snapshot.dayPlans.map((plan) => ({
            key: shadowKey('day_plan', plan.id),
            entity: 'day_plan' as const,
            entityId: plan.id,
            serverSeq: 0,
            data: { ...plan },
          })),
        ];

        const merged = {
          lists: new Map(snapshot.lists.map((item) => [item.id, item])),
          tasks: new Map(snapshot.tasks.map((item) => [item.id, item])),
          steps: new Map(snapshot.steps.map((item) => [item.id, item])),
          dayPlans: new Map(snapshot.dayPlans.map((item) => [item.id, item])),
        };
        const localMaps = {
          lists: new Map(local.lists.map((item) => [item.id, item])),
          tasks: new Map(local.tasks.map((item) => [item.id, item])),
          steps: new Map(local.steps.map((item) => [item.id, item])),
          dayPlans: new Map(local.dayPlans.map((item) => [item.id, item])),
        };
        const shadowMap = new Map(shadowRows.map((row) => [row.key, row]));

        for (const [key, mutations] of grouped) {
          const entity = mutations[0]!.entity;
          const entityId = mutations[0]!.entityId;
          const shadow = shadowMap.get(key);
          const localValue =
            entity === 'task'
              ? localMaps.tasks.get(entityId)
              : entity === 'list'
                ? localMaps.lists.get(entityId)
                : entity === 'step'
                  ? localMaps.steps.get(entityId)
                  : localMaps.dayPlans.get(entityId);
          let data = shadow?.data ?? asRecord(localValue);
          for (const mutation of mutations) {
            data = applyMutationToData(entity, data, mutation, now);
          }
          const value = materialize(entity, entityId, data);
          if (entity === 'task') merged.tasks.set(entityId, value as Task);
          else if (entity === 'list') merged.lists.set(entityId, value as TaskList);
          else if (entity === 'step') merged.steps.set(entityId, value as Step);
          else merged.dayPlans.set(entityId, value as DayPlan);
        }

        await Promise.all([
          this.db.tasks.clear(),
          this.db.lists.clear(),
          this.db.steps.clear(),
          this.db.dayPlans.clear(),
        ]);
        await this.db.lists.bulkPut([...merged.lists.values()]);
        await this.db.tasks.bulkPut([...merged.tasks.values()]);
        await this.db.steps.bulkPut([...merged.steps.values()]);
        await this.db.dayPlans.bulkPut([...merged.dayPlans.values()]);
        await this.db.shadow.clear();
        await this.db.shadow.bulkPut(shadowRows);
        await this.db.meta.put({ key: 'syncCursor', value: snapshot.cursor });
        await this.db.meta.put({ key: 'bootstrapRequired', value: '0' });
      },
    );
    this.notify([...snapshot.tasks.map((item) => item.id)]);
  }

  private async reprojectEntity(entity: EntityName, entityId: string): Promise<void> {
    const shadow = await this.db.shadow.get(shadowKey(entity, entityId));
    if (!shadow) return;
    const now = new Date().toISOString();
    const pending = (await this.db.mutations.where('entityId').equals(entityId).toArray())
      .filter((mutation) => mutation.entity === entity && mutation.status === 'pending')
      .sort((a, b) => a.clientSeq - b.clientSeq);
    let data: Record<string, unknown> = { ...shadow.data, id: entityId };
    for (const mutation of pending) {
      data = applyMutationToData(entity, data, mutation, now);
    }
    const value = materialize(entity, entityId, data);
    if (entity === 'task') {
      await this.db.tasks.put(value as Task);
    } else if (entity === 'list') {
      await this.db.lists.put(value as TaskList);
    } else if (entity === 'step') {
      await this.db.steps.put(value as Step);
    } else {
      const plan = value as DayPlan;
      const duplicate = await this.db.dayPlans
        .where('[taskId+localDate]')
        .equals([plan.taskId, plan.localDate])
        .first();
      if (duplicate && duplicate.id !== plan.id) {
        await this.db.dayPlans.delete(duplicate.id);
      }
      await this.db.dayPlans.put(plan);
    }
  }

  private async attachDetails(task: Task): Promise<TaskWithSteps> {
    const [steps, plans] = await Promise.all([
      this.db.steps.where('taskId').equals(task.id).toArray(),
      this.db.dayPlans.where('taskId').equals(task.id).toArray(),
    ]);
    return {
      ...task,
      steps: steps.filter((step) => !step.deletedAt).sort((a, b) => (a.rank < b.rank ? -1 : 1)),
      dayPlanDates: plans.filter((plan) => !plan.deletedAt).map((plan) => plan.localDate),
    };
  }

  private async attachDetailsBatch(tasks: Task[]): Promise<TaskWithSteps[]> {
    if (tasks.length === 0) return [];
    const [allSteps, allPlans] = await Promise.all([
      this.db.steps.toArray(),
      this.db.dayPlans.toArray(),
    ]);
    const stepsByTask = new Map<string, Step[]>();
    for (const step of allSteps) {
      if (step.deletedAt) continue;
      const list = stepsByTask.get(step.taskId) ?? [];
      list.push(step);
      stepsByTask.set(step.taskId, list);
    }
    for (const list of stepsByTask.values()) {
      list.sort((a, b) => (a.rank < b.rank ? -1 : 1));
    }
    const plansByTask = new Map<string, DateOnly[]>();
    for (const plan of allPlans) {
      if (plan.deletedAt) continue;
      const list = plansByTask.get(plan.taskId) ?? [];
      list.push(plan.localDate);
      plansByTask.set(plan.taskId, list);
    }
    return tasks.map((task) => ({
      ...task,
      steps: stepsByTask.get(task.id) ?? [],
      dayPlanDates: plansByTask.get(task.id) ?? [],
    }));
  }

  private async appendMutation(
    entity: StoredMutation['entity'],
    entityId: string,
    kind: StoredMutation['kind'],
    patch: Record<string, unknown>,
    now: string,
  ): Promise<void> {
    const deviceId = (await this.getMeta('deviceId')) ?? 'local-device';
    const current = Number((await this.getMeta('clientSeq')) ?? '0');
    const clientSeq = current + 1;
    const syncEnabled = (await this.getMeta('syncEnabled')) === 'true';
    await this.db.meta.put({ key: 'clientSeq', value: String(clientSeq) });
    const mutation: StoredMutation = {
      opId: newUuidV7(),
      deviceId,
      clientSeq,
      entity,
      entityId,
      kind,
      patch,
      createdAt: now,
      status: syncEnabled ? 'pending' : 'local',
    };
    await this.db.mutations.put(mutation);
  }

  private async allTasksSnapshot(): Promise<Task[]> {
    if (this.allTasksCache) return this.allTasksCache;
    if (!this.allTasksPromise) {
      this.allTasksPromise = this.db.tasks.toArray().then((tasks) => {
        this.allTasksCache = tasks;
        this.allTasksPromise = null;
        return tasks;
      });
    }
    return this.allTasksPromise;
  }

  private notify(ids: string[]): void {
    this.allTasksCache = null;
    this.allTasksPromise = null;
    for (const subscriber of this.subscribers) {
      queueMicrotask(() => subscriber(ids));
    }
  }

  private async seedIfNeeded(): Promise<void> {
    if (this.seedPromise) return this.seedPromise;
    this.seedPromise = inTransaction(this.seed());
    return this.seedPromise;
  }

  private async seed(): Promise<void> {
    const existing = await this.getMeta('seedVersion');
    if (existing) return;
    await this.db.transaction(
      'rw',
      this.db.tasks,
      this.db.lists,
      this.db.steps,
      this.db.dayPlans,
      this.db.meta,
      async () => {
        if ((await this.db.tasks.count()) > 0) return;
        const now = new Date().toISOString();
        const today = new Date();
        const localDate = `${today.getFullYear()}-${(today.getMonth() + 1)
          .toString()
          .padStart(2, '0')}-${today.getDate().toString().padStart(2, '0')}`;
        const dateOffset = (days: number): DateOnly => {
          const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() + days);
          return `${date.getFullYear()}-${(date.getMonth() + 1)
            .toString()
            .padStart(2, '0')}-${date.getDate().toString().padStart(2, '0')}`;
        };
        const lists = DEFAULT_LISTS.map((definition, index) => {
          const list = makeList(newUuidV7(), definition.name, now);
          list.color = definition.color;
          list.rank = (index + 1).toString(36).padStart(6, '0');
          return list;
        });
        await this.db.lists.bulkPut(lists);
        const work = lists[0]!;
        const life = lists[1]!;
        const taskSeed: Array<{
          title: string;
          listId: string | null;
          note?: string;
          important?: boolean;
          dueOn?: string | null;
          steps?: string[];
          plan?: boolean;
        }> = [
          {
            title: '欢迎使用拾事',
            listId: null,
            note: '这是一个本地优先的小工具。你的任务会先保存在本机，无需登录，也不需要等待网络。\n\n快捷键：Ctrl/⌘ + N 快速添加，Ctrl/⌘ + K 搜索，空格键完成当前任务。',
            dueOn: null,
            plan: true,
            steps: [
              '把今天想做的事写下来',
              '从收件箱里挑 1–3 件加入「我的一天」',
              '完成第一个任务',
            ],
          },
          {
            title: '准备周会材料',
            listId: work.id,
            important: true,
            dueOn: localDate,
            plan: true,
            steps: ['整理上周进展', '列出需要讨论的两个问题'],
          },
          {
            title: '预约周末的牙医',
            listId: life.id,
            dueOn: dateOffset(1),
          },
          {
            title: '读完手边的书',
            listId: life.id,
            dueOn: dateOffset(7),
          },
          {
            title: '收件箱清空',
            listId: null,
            dueOn: localDate,
          },
        ];
        let order = 1;
        for (const definition of taskSeed) {
          const id = newUuidV7();
          const task = makeTask(
            id,
            {
              title: definition.title,
              listId: definition.listId,
              note: definition.note ?? '',
              important: definition.important,
              dueOn: definition.dueOn ?? null,
            },
            now,
            order.toString(36).padStart(6, '0'),
          );
          order += 1;
          await this.db.tasks.put(task);
          if (definition.steps) {
            let stepOrder = 1;
            for (const title of definition.steps) {
              await this.db.steps.put({
                id: newUuidV7(),
                taskId: id,
                title,
                isCompleted: false,
                rank: stepOrder.toString(36).padStart(6, '0'),
                createdAt: now,
                updatedAt: now,
                deletedAt: null,
              });
              stepOrder += 1;
            }
          }
          if (definition.plan) {
            await this.db.dayPlans.put({
              id: newUuidV7(),
              taskId: id,
              localDate,
              rank: order.toString(36).padStart(6, '0'),
              createdAt: now,
              updatedAt: now,
              deletedAt: null,
            });
          }
        }
        await this.db.meta.put({ key: 'seedVersion', value: '1' });
      },
    );
  }
}
