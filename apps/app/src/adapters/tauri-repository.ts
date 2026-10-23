import type { CompletionCommit, CompleteResult, ExportBundle, ViewCounts } from '@todo/application';
import type { Ack, Change } from '@todo/contracts';
import type { StoredMutation as SyncMutation } from '@todo/sync';
import type {
  CloudDiagnostics,
  CloudInitializeResult,
  CloudMergeMode,
  CloudSyncStorage,
} from '../sync/storage';
import { StaleSyncSessionError } from '../sync/storage';
import type { CloudSnapshot } from '../sync/snapshot';
import type {
  DateOnly,
  Id,
  ListPatch,
  NewList,
  NewStep,
  NewTask,
  Page,
  Step,
  StepPatch,
  Task,
  TaskList,
  TaskPatch,
  TaskQuery,
  TaskWithSteps,
} from '@todo/domain';

interface StorageRequest {
  action: string;
  payload?: Record<string, unknown>;
}

async function call<T>(action: string, payload?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  const request: StorageRequest = { action, ...(payload ? { payload } : {}) };
  return invoke<T>('todo_storage', { request });
}

async function callFenced<T>(action: string, payload?: Record<string, unknown>): Promise<T> {
  try {
    return await call<T>(action, payload);
  } catch (error) {
    const text =
      typeof error === 'string'
        ? error
        : error instanceof Error
          ? error.message
          : JSON.stringify(error);
    if (text.includes('STALE_SYNC_SESSION')) throw new StaleSyncSessionError();
    throw error;
  }
}

/**
 * The Tauri adapter talks to a narrow, domain-level command surface. The
 * WebView never receives arbitrary SQL, filesystem or shell permissions.
 */
export class TauriTaskRepository implements CloudSyncStorage {
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private readonly subscribers = new Set<(ids: Id[]) => void>();

  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (!this.initPromise) {
      this.initPromise = call<void>('initialize').then(() => {
        this.initialized = true;
      });
    }
    return this.initPromise;
  }

  async createTask(input: NewTask): Promise<Task> {
    await this.initialize();
    const task = await call<Task>('create_task', { input });
    this.notify([task.id]);
    return task;
  }

  async patchTask(id: Id, patch: TaskPatch): Promise<Task> {
    await this.initialize();
    const task = await call<Task>('patch_task', { id, patch });
    this.notify([id]);
    return task;
  }

  async getTask(id: Id): Promise<TaskWithSteps | null> {
    await this.initialize();
    return call<TaskWithSteps | null>('get_task', { id });
  }

  async listTasks(query: TaskQuery): Promise<Page<TaskWithSteps>> {
    await this.initialize();
    return call<Page<TaskWithSteps>>('list_tasks', { query });
  }

  async listReminderCandidates(): Promise<Task[]> {
    await this.initialize();
    return call<Task[]>('list_reminder_candidates');
  }

  async getCounts(localDate: DateOnly): Promise<ViewCounts> {
    await this.initialize();
    return call<ViewCounts>('get_counts', { localDate });
  }

  async commitCompletion(commit: CompletionCommit): Promise<CompleteResult> {
    await this.initialize();
    const result = await call<CompleteResult>('commit_completion', {
      taskId: commit.taskId,
      completedAt: commit.completedAt,
      nextTask: commit.nextTask,
    });
    this.notify([commit.taskId, ...(commit.nextTask ? [commit.nextTask.id] : [])]);
    return result;
  }

  async deleteTask(id: Id): Promise<void> {
    await this.initialize();
    await call<void>('delete_task', { id });
    this.notify([id]);
  }

  async restoreTask(id: Id): Promise<void> {
    await this.initialize();
    await call<void>('restore_task', { id });
    this.notify([id]);
  }

  async reorderTask(id: Id, direction: 'up' | 'down'): Promise<void> {
    await this.initialize();
    await call<void>('reorder_task', { id, direction });
    this.notify([id]);
  }

  async listLists(): Promise<TaskList[]> {
    await this.initialize();
    return call<TaskList[]>('list_lists');
  }

  async createList(input: NewList): Promise<TaskList> {
    await this.initialize();
    const list = await call<TaskList>('create_list', { input });
    this.notify([list.id]);
    return list;
  }

  async patchList(id: Id, patch: ListPatch): Promise<TaskList> {
    await this.initialize();
    const list = await call<TaskList>('patch_list', { id, patch });
    this.notify([id]);
    return list;
  }

  async deleteList(id: Id): Promise<void> {
    await this.initialize();
    await call<void>('delete_list', { id });
    this.notify([id]);
  }

  async restoreList(id: Id): Promise<void> {
    await this.initialize();
    await call<void>('restore_list', { id });
    this.notify([id]);
  }

  async listDayPlan(date: DateOnly): Promise<TaskWithSteps[]> {
    await this.initialize();
    return call<TaskWithSteps[]>('list_day_plan', { date });
  }

  async addToDay(taskId: Id, date: DateOnly): Promise<void> {
    await this.initialize();
    await call<void>('add_to_day', { taskId, date });
    this.notify([taskId]);
  }

  async removeFromDay(taskId: Id, date: DateOnly): Promise<void> {
    await this.initialize();
    await call<void>('remove_from_day', { taskId, date });
    this.notify([taskId]);
  }

  async createStep(input: NewStep): Promise<Step> {
    await this.initialize();
    const step = await call<Step>('create_step', { taskId: input.taskId, title: input.title });
    this.notify([input.taskId]);
    return step;
  }

  async patchStep(id: Id, patch: StepPatch): Promise<Step> {
    await this.initialize();
    const step = await call<Step>('patch_step', { id, patch });
    this.notify([step.taskId]);
    return step;
  }

  async deleteStep(id: Id): Promise<void> {
    await this.initialize();
    await call<void>('delete_step', { id });
    this.notify([]);
  }

  async exportData(): Promise<ExportBundle> {
    await this.initialize();
    return call<ExportBundle>('export_data');
  }

  async importData(bundle: ExportBundle, mode: 'merge' | 'replace'): Promise<void> {
    await this.initialize();
    await call<void>('import_data', { bundle, mode });
    this.notify(bundle.tasks.map((task) => task.id));
  }

  async clearAll(): Promise<void> {
    await this.initialize();
    await call<void>('clear_all');
    this.notify([]);
  }

  subscribeChanges(callback: (entityIds: Id[]) => void): () => void {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  async getDeviceId(): Promise<string> {
    await this.initialize();
    return call<string>('get_device_id');
  }

  async syncGetDeviceId(): Promise<string> {
    await this.initialize();
    return call<string>('get_device_id');
  }

  async syncRotateDevice(): Promise<string> {
    await this.initialize();
    return call<string>('rotate_device_id');
  }

  async syncGetCursor(): Promise<string> {
    await this.initialize();
    return call<string>('get_sync_cursor');
  }

  async syncGetPending(limit: number): Promise<SyncMutation[]> {
    await this.initialize();
    const rows = await call<
      Array<{
        opId: string;
        deviceId: string;
        clientSeq: number;
        entity: SyncMutation['entity'];
        entityId: string;
        kind: SyncMutation['kind'];
        patch: Record<string, unknown>;
      }>
    >('pending_mutations', { limit });
    return rows.map((row) => ({
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
    const diagnostics = await this.syncGetDiagnostics();
    return diagnostics.pending;
  }

  async syncGetRejectedCount(): Promise<number> {
    const diagnostics = await this.syncGetDiagnostics();
    return diagnostics.rejected;
  }

  async syncGetDiagnostics(): Promise<CloudDiagnostics> {
    await this.initialize();
    return call<CloudDiagnostics>('sync_diagnostics');
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
    await callFenced<void>('apply_server_result', {
      acks: result.acks,
      changes: result.changes,
      nextCursor: result.nextCursor,
      sessionId,
    });
    this.notify(result.changes.map((change) => change.entity_id));
  }

  async syncSetSession(sessionId: string): Promise<void> {
    await this.initialize();
    await call<void>('sync_set_session', { sessionId });
  }

  async syncClearSession(expectedToken: string | null): Promise<void> {
    await this.initialize();
    await call<void>('sync_clear_session', { expectedSessionId: expectedToken });
  }

  async syncInitializeCloud(
    snapshot: CloudSnapshot,
    mode: CloudMergeMode,
    accountEmail: string,
    sessionId?: string,
  ): Promise<CloudInitializeResult> {
    await this.initialize();
    const result = await call<CloudInitializeResult>('sync_initialize_cloud', {
      snapshot,
      mode,
      accountEmail,
      sessionId,
    });
    this.notify(snapshot.tasks.map((task) => task.id));
    return result;
  }

  async syncReplaceSnapshot(snapshot: CloudSnapshot, sessionId?: string): Promise<void> {
    await this.initialize();
    await callFenced<void>('sync_replace_snapshot', { snapshot, sessionId });
    this.notify(snapshot.tasks.map((task) => task.id));
  }

  async syncSetEnabled(enabled: boolean): Promise<void> {
    await this.initialize();
    await call<void>('sync_set_enabled', { enabled });
  }

  async syncClearRejected(): Promise<void> {
    await this.initialize();
    await call<void>('sync_clear_rejected');
    this.notify([]);
  }

  async syncMarkBootstrapRequired(): Promise<void> {
    await this.initialize();
    await call<void>('bootstrap_required');
  }

  async syncClearAccountBinding(): Promise<void> {
    await this.initialize();
    await call<void>('sync_clear_account_binding');
  }

  private notify(ids: Id[]): void {
    for (const subscriber of this.subscribers) {
      queueMicrotask(() => subscriber(ids));
    }
  }
}
