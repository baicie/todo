import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskService } from '@todo/application';
import type { CloudSnapshot } from '../sync/snapshot';
import { StaleSyncSessionError } from '../sync/storage';
import { DexieTaskRepository } from './web-repository';

let repository: DexieTaskRepository;
let service: TaskService;
let databaseCounter = 0;

beforeEach(async () => {
  databaseCounter += 1;
  repository = new DexieTaskRepository(`shishi-test-${databaseCounter}-${Date.now()}`);
  await repository.initialize();
  await repository.clearAll();
  service = new TaskService(repository, () => 'Asia/Shanghai', {
    now: () => new Date('2026-10-21T04:00:00.000Z'),
  });
});

describe('DexieTaskRepository', () => {
  it('creates, filters, patches and completes a task in a local transaction', async () => {
    const list = await repository.createList({ name: '工作', color: '#4f6ed0' });
    const task = await service.createTask({
      title: '提交报销单',
      listId: list.id,
      dueOn: '2026-10-21',
      planDate: '2026-10-21',
    });

    expect(task.id).toMatch(/^[0-9a-f-]{36}$/i);
    const loaded = await repository.getTask(task.id);
    expect(loaded?.title).toBe('提交报销单');
    expect(loaded?.listId).toBe(list.id);

    const day = await repository.listDayPlan('2026-10-21');
    expect(day.map((item) => item.id)).toContain(task.id);
    const counts = await repository.getCounts('2026-10-21');
    expect(counts.myDay).toBe(1);
    expect(counts.lists[list.id]).toBe(1);

    await service.patchTask(task.id, { important: true, note: '保留票据' });
    const patched = await repository.getTask(task.id);
    expect(patched?.important).toBe(true);
    expect(patched?.note).toBe('保留票据');

    const completed = await service.completeTask(task.id);
    expect(completed.task.status).toBe('completed');
    expect(completed.task.completedAt).toBe('2026-10-21T04:00:00.000Z');
    const open = await repository.listTasks({ view: 'all' });
    expect(open.items.map((item) => item.id)).not.toContain(task.id);
    const completedView = await repository.listTasks({ view: 'completed' });
    expect(completedView.items.map((item) => item.id)).toContain(task.id);
  });

  it('generates the next recurring occurrence and keeps unique day plans idempotent', async () => {
    const task = await service.createTask({
      title: '每日复盘',
      dueOn: '2026-10-21',
      recurrence: { frequency: 'daily', interval: 1, anchorMode: 'calendar' },
    });
    await repository.addToDay(task.id, '2026-10-21');
    await repository.addToDay(task.id, '2026-10-21');
    expect(await repository.listDayPlan('2026-10-21')).toHaveLength(1);

    const result = await service.completeTask(task.id);
    expect(result.nextTask).not.toBeNull();
    expect(result.nextTask?.dueOn).toBe('2026-10-22');
    expect(result.nextTask?.status).toBe('open');
    const all = await repository.listTasks({ view: 'all' });
    expect(all.items.some((item) => item.id === result.nextTask?.id)).toBe(true);
  });

  it('soft deletes with restorable data and exports a portable snapshot', async () => {
    const list = await repository.createList({ name: '生活' });
    const task = await service.createTask({ title: '预约牙医', listId: list.id });
    await service.addStep({ taskId: task.id, title: '选择周日时间' });
    await service.deleteTask(task.id);
    expect(await repository.getTask(task.id)).toBeNull();

    await service.restoreTask(task.id);
    const restored = await repository.getTask(task.id);
    expect(restored?.deletedAt).toBeNull();
    expect(restored?.steps[0]?.title).toBe('选择周日时间');

    const bundle = await service.exportBundle();
    expect(bundle.format).toBe('todo-export');
    expect(bundle.tasks).toHaveLength(1);
    expect(bundle.steps).toHaveLength(1);
  });

  it('reorders tasks inside a list using stable ranks', async () => {
    const list = await repository.createList({ name: '排队' });
    const first = await service.createTask({ title: '第一项', listId: list.id });
    const second = await service.createTask({ title: '第二项', listId: list.id });
    let page = await repository.listTasks({ view: 'list', listId: list.id });
    expect(page.items.map((item) => item.id)).toEqual([first.id, second.id]);

    await service.reorderTask(second.id, 'up');
    page = await repository.listTasks({ view: 'list', listId: list.id });
    expect(page.items.map((item) => item.id)).toEqual([second.id, first.id]);
  });

  it('imports a snapshot in replace mode', async () => {
    const source = await service.exportBundle();
    await service.clearAll();
    const replacement = await service.createTask({ title: '旧任务' });
    const imported = {
      ...source,
      tasks: [
        ...source.tasks,
        {
          ...(await repository.getTask(replacement.id))!,
          title: '导入任务',
          steps: undefined,
          dayPlanDates: undefined,
        },
      ],
    } as unknown as typeof source;
    await service.importBundle(imported, 'replace');
    const all = await repository.listTasks({ view: 'all' });
    expect(all.items).toHaveLength(1);
    expect(all.items[0]?.title).toBe('导入任务');
  });

  it('builds a pending outbox for explicit first-login merge', async () => {
    const list = await repository.createList({ name: '本机清单' });
    const task = await service.createTask({ title: '本机任务', listId: list.id });
    await service.addStep({ taskId: task.id, title: '本机步骤' });
    await repository.addToDay(task.id, '2026-10-21');

    const result = await repository.syncInitializeCloud(
      { cursor: '12', lists: [], tasks: [], steps: [], dayPlans: [] },
      'merge',
      'user@example.com',
    );
    expect(result.preparedOps).toBeGreaterThanOrEqual(4);
    const pending = await repository.syncGetPending(100);
    expect(pending[0]?.entity).toBe('list');
    expect(pending.some((op) => op.entity === 'task')).toBe(true);
    expect(pending.some((op) => op.entity === 'step')).toBe(true);
    expect(pending.some((op) => op.entity === 'day_plan')).toBe(true);

    const diagnostics = await repository.syncGetDiagnostics();
    expect(diagnostics.enabled).toBe(true);
    expect(diagnostics.boundAccount).toBe('user@example.com');
    expect(diagnostics.cursor).toBe('12');
    expect((await repository.getTask(task.id))?.title).toBe('本机任务');
  });

  it('reprojects shadow plus pending local patches after a remote change', async () => {
    const snapshot = cloudSnapshot('task-remote', 'server title', 'base note');
    await repository.syncInitializeCloud(snapshot, 'cloud', 'user@example.com');
    await service.patchTask('task-remote', { title: 'local title' });

    await repository.syncApplyResult({
      acks: [],
      changes: [
        {
          server_seq: 4,
          op_id: '019a0000-0000-7000-8000-000000000201',
          entity: 'task',
          entity_id: 'task-remote',
          kind: 'patch',
          patch: { note: 'remote note' },
        },
      ],
      nextCursor: '4',
    });

    const task = await repository.getTask('task-remote');
    expect(task?.title).toBe('local title');
    expect(task?.note).toBe('remote note');
    expect((await repository.syncGetDiagnostics()).cursor).toBe('4');
  });

  it('rolls back a rejected local patch to the server shadow', async () => {
    const snapshot = cloudSnapshot('task-remote', 'server title', 'base note');
    await repository.syncInitializeCloud(snapshot, 'cloud', 'user@example.com');
    await service.patchTask('task-remote', { title: 'rejected title' });
    const pending = await repository.syncGetPending(10);
    const op = pending.find((item) => item.entity === 'task');
    expect(op).toBeTruthy();

    await repository.syncApplyResult({
      acks: [
        {
          op_id: op!.opId,
          server_seq: null,
          status: 'rejected',
          error_code: 'VALIDATION_FAILED',
        },
      ],
      changes: [],
      nextCursor: '2',
    });

    expect((await repository.getTask('task-remote'))?.title).toBe('server title');
    const diagnostics = await repository.syncGetDiagnostics();
    expect(diagnostics.rejected).toBe(1);
    expect(diagnostics.pending).toBe(0);

    await repository.syncClearRejected();
    expect((await repository.syncGetDiagnostics()).rejected).toBe(0);
  });

  it('preserves pending local edits during a cursor-expired snapshot rebase', async () => {
    const snapshot = cloudSnapshot('task-remote', 'version 1', 'base note');
    await repository.syncInitializeCloud(snapshot, 'cloud', 'user@example.com');
    await service.patchTask('task-remote', { note: 'local unsynced note' });

    await repository.syncReplaceSnapshot({
      ...snapshot,
      cursor: '30',
      tasks: snapshot.tasks.map((task) => ({
        ...task,
        title: 'version 2',
        updatedAt: '2026-10-22T00:00:00.000Z',
      })),
    });

    const task = await repository.getTask('task-remote');
    expect(task?.title).toBe('version 2');
    expect(task?.note).toBe('local unsynced note');
    expect((await repository.syncGetDiagnostics()).pending).toBe(1);
    expect((await repository.syncGetDiagnostics()).cursor).toBe('30');
  });

  it('converts pending operations back to local when cloud sync is disabled', async () => {
    const snapshot = cloudSnapshot('task-remote', 'server title', 'base note');
    await repository.syncInitializeCloud(snapshot, 'cloud', 'user@example.com');
    await service.patchTask('task-remote', { title: 'offline edit' });
    expect(await repository.syncGetPendingCount()).toBe(1);
    await repository.syncSetEnabled(false);
    expect(await repository.syncGetPendingCount()).toBe(0);
    expect((await repository.syncGetDiagnostics()).enabled).toBe(false);
    expect((await repository.getTask('task-remote'))?.title).toBe('offline edit');
  });

  it('rejects stale server results at the DB transaction boundary', async () => {
    await repository.syncSetEnabled(true);
    const first = await service.createTask({ title: 'session a task' });
    const firstPending = await repository.syncGetPending(10);
    const firstOp = firstPending[0]!;
    await repository.syncSetSession('session-a');
    await repository.syncApplyResult(
      {
        acks: [{ op_id: firstOp.opId, status: 'applied', server_seq: 1 }],
        changes: [],
        nextCursor: '1',
      },
      'session-a',
    );

    const second = await service.createTask({ title: 'session b task' });
    const secondPending = await repository.syncGetPending(10);
    const secondOp = secondPending.find((item) => item.entityId === second.id)!;
    await repository.syncSetSession('session-b');
    await expect(
      repository.syncApplyResult(
        {
          acks: [{ op_id: secondOp.opId, status: 'applied', server_seq: 2 }],
          changes: [],
          nextCursor: '2',
        },
        'session-a',
      ),
    ).rejects.toBeInstanceOf(StaleSyncSessionError);

    expect(await repository.syncGetCursor()).toBe('1');
    expect((await repository.syncGetPending(10)).some((item) => item.opId === secondOp.opId)).toBe(
      true,
    );
    expect((await repository.getTask(first.id))?.title).toBe('session a task');
  });

  it('rejects a stale bootstrap snapshot after the session changes', async () => {
    await repository.syncSetSession('session-a');
    await repository.syncSetSession('session-b');
    await expect(
      repository.syncReplaceSnapshot(
        cloudSnapshot('stale-task', 'stale snapshot', 'must not land'),
        'session-a',
      ),
    ).rejects.toBeInstanceOf(StaleSyncSessionError);
    expect(await repository.getTask('stale-task')).toBeNull();
  });

  it('deletes the session fence before an old apply can run after clearAll', async () => {
    await repository.syncSetEnabled(true);
    const task = await service.createTask({ title: 'old session' });
    const pending = await repository.syncGetPending(10);
    const op = pending.find((item) => item.entityId === task.id)!;
    await repository.syncSetSession('session-a');
    await repository.clearAll();
    await expect(
      repository.syncApplyResult(
        {
          acks: [{ op_id: op.opId, status: 'applied', server_seq: 1 }],
          changes: [],
          nextCursor: '1',
        },
        'session-a',
      ),
    ).rejects.toBeInstanceOf(StaleSyncSessionError);
    expect(await repository.listTasks({ view: 'all' })).toMatchObject({ items: [] });
  });

  it('keeps the previous database intact when an import is rejected', async () => {
    await service.createTask({ title: '保留任务' });
    const before = await repository.listTasks({ view: 'all', limit: 1000 });
    const bundle = await repository.exportData();
    const invalid = {
      ...bundle,
      tasks: [{ ...bundle.tasks[0]!, title: '   ' }],
    };
    await expect(repository.importData(invalid, 'replace')).rejects.toThrow('无效任务');
    const after = await repository.listTasks({ view: 'all', limit: 1000 });
    expect(after.items.map((task) => task.id)).toEqual(before.items.map((task) => task.id));
  });

  it('restores 100 offline tasks through a new repository instance', async () => {
    const databaseName = `shishi-restart-${Date.now()}`;
    const first = new DexieTaskRepository(databaseName);
    await first.initialize();
    for (let index = 0; index < 100; index += 1) {
      await first.createTask({ title: `离线任务 ${index}` });
    }
    const second = new DexieTaskRepository(databaseName);
    await second.initialize();
    const page = await second.listTasks({ view: 'all', limit: 1000 });
    expect(page.items.filter((task) => task.title.startsWith('离线任务'))).toHaveLength(100);
  });

  it('lists every open reminder without the old task-list limit', async () => {
    const base = Date.now() + 60_000;
    for (let index = 0; index < 1001; index += 1) {
      await repository.createTask({
        title: `提醒 ${index}`,
        remindAt: new Date(base + index * 60_000).toISOString(),
      });
    }
    const hidden = await repository.createTask({
      title: '已完成提醒',
      remindAt: new Date(base + 2_000_000).toISOString(),
    });
    await repository.commitCompletion({
      taskId: hidden.id,
      completedAt: new Date().toISOString(),
      nextTask: null,
    });

    const candidates = await repository.listReminderCandidates();
    expect(candidates).toHaveLength(1001);
    expect(candidates.every((task) => task.status === 'open')).toBe(true);
    expect(candidates[0]!.remindAt! <= candidates[1]!.remindAt!).toBe(true);
  });
});

function cloudSnapshot(id: string, title: string, note: string): CloudSnapshot {
  const now = '2026-10-21T00:00:00.000Z';
  return {
    cursor: '1',
    lists: [
      {
        id: 'list-remote',
        name: '云端清单',
        color: '#3d66d9',
        icon: null,
        rank: '000001',
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      },
    ],
    tasks: [
      {
        id,
        listId: 'list-remote',
        title,
        note,
        status: 'open',
        important: false,
        dueOn: '2026-10-21',
        remindAt: null,
        remindTimezone: null,
        rank: '000001',
        seriesId: null,
        occurrenceKey: '2026-10-21',
        recurrence: null,
        completedAt: null,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      },
    ],
    steps: [],
    dayPlans: [],
  };
}
