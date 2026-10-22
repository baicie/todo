import type { BootstrapEntity, BootstrapPage } from '@todo/contracts';
import type { SyncTransport } from '@todo/sync';
import {
  isDateOnly,
  type DateOnly,
  type DayPlan,
  type Recurrence,
  type Step,
  type Task,
  type TaskList,
} from '@todo/domain';

export interface CloudSnapshot {
  cursor: string;
  lists: TaskList[];
  tasks: Task[];
  steps: Step[];
  dayPlans: DayPlan[];
}

export interface SnapshotCounts {
  tasks: number;
  lists: number;
  steps: number;
  dayPlans: number;
  visibleTasks: number;
}

const nowIso = () => new Date().toISOString();

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function nullableText(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function boolean(value: unknown): boolean {
  return value === true;
}

function dateOrNull(value: unknown): DateOnly | null {
  return typeof value === 'string' && isDateOnly(value) ? value : null;
}

function recurrenceOrNull(value: unknown): Recurrence | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Recurrence;
}

function stepFromEntity(entity: BootstrapEntity): Step {
  const data = asRecord(entity.data);
  const now = nowIso();
  return {
    id: text(data.id) || entity.entity_id,
    taskId: text(data.taskId) || text(data.task_id),
    title: text(data.title),
    isCompleted: boolean(data.isCompleted ?? data.is_completed),
    rank: text(data.rank) || 'a0',
    createdAt: text(data.createdAt ?? data.created_at) || now,
    updatedAt: text(data.updatedAt ?? data.updated_at) || now,
    deletedAt: nullableText(data.deletedAt ?? data.deleted_at),
  };
}

function planFromEntity(entity: BootstrapEntity): DayPlan {
  const data = asRecord(entity.data);
  const now = nowIso();
  return {
    id: text(data.id) || entity.entity_id,
    taskId: text(data.taskId) || text(data.task_id),
    localDate: dateOrNull(data.localDate ?? data.local_date) ?? '1970-01-01',
    rank: text(data.rank) || 'a0',
    createdAt: text(data.createdAt ?? data.created_at) || now,
    updatedAt: text(data.updatedAt ?? data.updated_at) || now,
    deletedAt: nullableText(data.deletedAt ?? data.deleted_at),
  };
}

function listFromEntity(entity: BootstrapEntity): TaskList {
  const data = asRecord(entity.data);
  const now = nowIso();
  return {
    id: text(data.id) || entity.entity_id,
    name: text(data.name),
    color: nullableText(data.color),
    icon: nullableText(data.icon),
    rank: text(data.rank) || 'a0',
    createdAt: text(data.createdAt ?? data.created_at) || now,
    updatedAt: text(data.updatedAt ?? data.updated_at) || now,
    deletedAt: nullableText(data.deletedAt ?? data.deleted_at),
  };
}

function taskFromEntity(entity: BootstrapEntity): Task {
  const data = asRecord(entity.data);
  const now = nowIso();
  const status = data.status === 'completed' ? 'completed' : 'open';
  return {
    id: text(data.id) || entity.entity_id,
    listId: nullableText(data.listId ?? data.list_id),
    title: text(data.title),
    note: text(data.note),
    status,
    important: boolean(data.important),
    dueOn: dateOrNull(data.dueOn ?? data.due_on),
    remindAt: nullableText(data.remindAt ?? data.remind_at),
    remindTimezone: nullableText(data.remindTimezone ?? data.remind_timezone),
    rank: text(data.rank) || 'a0',
    seriesId: nullableText(data.seriesId ?? data.series_id),
    occurrenceKey: nullableText(data.occurrenceKey ?? data.occurrence_key),
    recurrence: recurrenceOrNull(data.recurrence),
    completedAt: nullableText(data.completedAt ?? data.completed_at),
    createdAt: text(data.createdAt ?? data.created_at) || now,
    updatedAt: text(data.updatedAt ?? data.updated_at) || now,
    deletedAt: nullableText(data.deletedAt ?? data.deleted_at),
  };
}

export function normalizeBootstrap(entities: BootstrapEntity[], cursor: string): CloudSnapshot {
  const snapshot: CloudSnapshot = { cursor, lists: [], tasks: [], steps: [], dayPlans: [] };
  for (const entity of entities) {
    try {
      switch (entity.entity) {
        case 'list':
          snapshot.lists.push(listFromEntity(entity));
          break;
        case 'task':
          snapshot.tasks.push(taskFromEntity(entity));
          break;
        case 'step':
          snapshot.steps.push(stepFromEntity(entity));
          break;
        case 'day_plan':
          snapshot.dayPlans.push(planFromEntity(entity));
          break;
      }
    } catch {
      // A malformed server row is ignored rather than crashing the whole sync.
    }
  }
  return snapshot;
}

export async function readFullBootstrap(transport: SyncTransport): Promise<CloudSnapshot> {
  let page: BootstrapPage = await transport.bootstrap();
  const cursor = page.snapshot_cursor;
  const entities = [...page.entities];
  let guard = 0;
  while (page.has_more && page.next_page && guard < 10_000) {
    page = await transport.bootstrap(page.next_page);
    entities.push(...page.entities);
    guard += 1;
  }
  return normalizeBootstrap(entities, cursor);
}

export function snapshotCounts(snapshot: CloudSnapshot): SnapshotCounts {
  return {
    tasks: snapshot.tasks.length,
    lists: snapshot.lists.length,
    steps: snapshot.steps.length,
    dayPlans: snapshot.dayPlans.length,
    visibleTasks: snapshot.tasks.filter((task) => !task.deletedAt).length,
  };
}
