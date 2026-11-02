import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SyncHttpError } from '@todo/sync';
import type {
  SharedInvitation,
  SharedListSummary,
  SharedMember,
  SharedSnapshot,
  SharedStep,
  SharedTask,
} from '@todo/contracts';
import { DexieTaskRepository } from '../adapters/web-repository';
import { rebaseSharedTasks, SharedSyncEngine } from './shared-sync';
import type { SharedOpRecord, SharedStore } from './shared-store';

/**
 * In-memory stand-in for the shared REST surface. It applies the same rules as
 * `apps/api/src/shared.rs`: `If-Match` revision checks, `op_id` receipts,
 * editor-only writes and the revoked-member 403.
 */

interface Server {
  lists: Map<string, SharedListSummary>;
  members: Map<string, SharedMember[]>;
  invitations: SharedInvitation[];
  tasks: Map<string, SharedTask>;
  steps: SharedStep[];
  revision: Map<string, number>;
  receipts: Map<string, { key: string; revision: number; taskId: string | null }>;
}

const NOW = '2026-11-01T00:00:00.000Z';
const OWNER_ID = '019a0000-0000-7000-8000-000000000001';
const USER_ID = '019a0000-0000-7000-8000-000000000002';
let ids = 0;
/** Deterministic UUIDv7-shaped id; the contracts require valid UUIDs. */
const nextId = (prefix: string) => {
  ids += 1;
  const suffix = String(ids).padStart(12, '0');
  const head = prefix === 'list' ? '019a1000' : prefix === 'task' ? '019a2000' : '019a3000';
  return `${head}-0000-7000-8000-${suffix}`;
};
const TASK_INVITE = '019a3000-0000-7000-8000-000000000900';
const TASK_INVITE_2 = '019a3000-0000-7000-8000-000000000901';

function listSummary(name: string, role: SharedListSummary['role'] = 'owner'): SharedListSummary {
  return {
    id: nextId('list'),
    owner_id: OWNER_ID,
    name,
    color: null,
    icon: null,
    rank: 'a0',
    revision: 1,
    role,
    created_at: NOW,
    updated_at: NOW,
  };
}

export class SharedApi {
  server: Server = {
    lists: new Map(),
    members: new Map(),
    invitations: [],
    tasks: new Map(),
    steps: [],
    revision: new Map(),
    receipts: new Map(),
  };

  calls: Array<{ method: string; path: string; revision: string | null; body: unknown }> = [];
  /** Lists whose membership was removed: read/scanned as gone, writes answer 403. */
  revoked = new Set<string>();
  /** When set, every request rejects with this error before reaching the server. */
  failWith: (() => Error) | null = null;
  /**
   * Mutating calls whose response is lost after the server applied them: the
   * write lands, the client only sees a network error. Used for lost-ACK tests.
   */
  dropResponse = new Set<string>();
  /** Lists whose revision check always fails, as a member writing in a loop would. */
  alwaysStale = new Set<string>();

  reset(): void {
    this.calls = [];
    this.failWith = null;
    this.dropResponse.clear();
    this.alwaysStale.clear();
    this.server = {
      lists: new Map(),
      members: new Map(),
      invitations: [],
      tasks: new Map(),
      steps: [],
      revision: new Map(),
      receipts: new Map(),
    };
  }

  addList(name: string, role: SharedListSummary['role'] = 'owner'): SharedListSummary {
    const summary = listSummary(name, role);
    this.server.lists.set(summary.id, summary);
    this.server.revision.set(summary.id, summary.revision);
    this.server.members.set(summary.id, [
      { user_id: OWNER_ID, email: 'owner@example.com', role: 'owner', created_at: NOW },
    ]);
    return summary;
  }

  addTask(listId: string, title: string, patch: Partial<SharedTask> = {}): SharedTask {
    const list = this.server.lists.get(listId)!;
    const task: SharedTask = {
      id: nextId('task'),
      list_id: listId,
      title,
      note: '',
      status: 'open',
      important: false,
      due_on: null,
      rank: 'a0',
      revision: list.revision,
      created_at: NOW,
      updated_at: NOW,
      ...patch,
    };
    this.server.tasks.set(task.id, task);
    return task;
  }

  snapshot(listId: string): SharedSnapshot {
    const list = this.server.lists.get(listId);
    if (!list) throw new SyncHttpError(404, 'SHARED_LIST_NOT_FOUND', 'missing');
    return {
      list,
      members: this.server.members.get(listId) ?? [],
      invitations:
        list.role === 'owner'
          ? this.server.invitations.filter((item) => item.list_id === listId)
          : [],
      tasks: [...this.server.tasks.values()].filter((task) => task.list_id === listId),
      steps: this.server.steps.filter((step) =>
        [...this.server.tasks.values()].some((task) => task.id === step.task_id),
      ),
      revision: list.revision,
    };
  }

  /** Bumps the list revision as another member's write would. */
  remoteEdit(taskId: string, patch: Partial<SharedTask>): void {
    const task = this.server.tasks.get(taskId);
    if (!task) return;
    this.bump(task.list_id);
    this.server.tasks.set(taskId, { ...task, ...patch, revision: this.listRevision(task.list_id) });
  }

  removeMember(listId: string): void {
    this.server.members.set(listId, [
      { user_id: OWNER_ID, email: 'owner@example.com', role: 'owner', created_at: NOW },
    ]);
    // The server stops listing the list for this account; direct requests now
    // answer 403 SHARED_LIST_ACCESS_REVOKED, like `lock_access` does.
    this.server.lists.delete(listId);
    this.revoked.add(listId);
  }

  deleteList(listId: string): void {
    this.server.lists.delete(listId);
    this.server.revision.delete(listId);
    for (const [id, task] of this.server.tasks)
      if (task.list_id === listId) this.server.tasks.delete(id);
  }

  private listRevision(listId: string): number {
    return this.server.revision.get(listId) ?? 1;
  }

  private bump(listId: string): number {
    const next = this.listRevision(listId) + 1;
    this.server.revision.set(listId, next);
    const list = this.server.lists.get(listId);
    if (list) this.server.lists.set(listId, { ...list, revision: next });
    return next;
  }

  private expected(init: RequestInit): number | null {
    const raw = new Headers(init.headers).get('If-Match');
    if (!raw) return null;
    const parsed = Number(raw.replaceAll('"', ''));
    return Number.isFinite(parsed) ? parsed : null;
  }

  private checkRevision(listId: string, init: RequestInit): void {
    const expected = this.expected(init);
    // Simulates a list that keeps moving: every attempt sees a newer revision.
    if (this.alwaysStale.has(listId)) this.bump(listId);
    const actual = this.listRevision(listId);
    if (expected !== null && expected !== actual) {
      throw new SyncHttpError(409, 'REVISION_CONFLICT', `expected ${actual}`);
    }
  }

  private requireEditor(listId: string): void {
    const list = this.server.lists.get(listId);
    if (!list) throw new SyncHttpError(404, 'SHARED_LIST_NOT_FOUND', 'missing');
    if (list.role === 'viewer') {
      throw new SyncHttpError(403, 'SHARED_LIST_FORBIDDEN', 'viewer');
    }
  }

  readonly request = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const method = (init.method ?? 'GET').toUpperCase();
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    this.calls.push({ method, path, revision: this.expected(init)?.toString() ?? null, body });
    if (this.failWith) throw this.failWith();
    const response = (await this.route(method, path, body, init)) as T;
    // The server applied the write, but the reply never reaches the client.
    if (this.dropResponse.has(`${method} ${path}`)) {
      throw new TypeError('Failed to fetch');
    }
    return response;
  };

  private checkAccess(listId: string, method: string): void {
    if (!this.revoked.has(listId)) return;
    if (method === 'GET') throw new SyncHttpError(403, 'SHARED_LIST_ACCESS_REVOKED', 'removed');
    throw new SyncHttpError(403, 'SHARED_LIST_ACCESS_REVOKED', 'removed');
  }

  private async route(
    method: string,
    path: string,
    body: Record<string, unknown>,
    init: RequestInit,
  ): Promise<unknown> {
    if (path === '/lists' && method === 'GET') {
      return [...this.server.lists.values()];
    }
    if (path === '/lists' && method === 'POST') {
      const list = this.addList(String(body.name));
      return list;
    }
    if (path === '/invitations' && method === 'GET') {
      return this.server.invitations;
    }
    const invitation = /^\/invitations\/([^/]+)\/(accept|decline)$/.exec(path);
    if (invitation) return this.answer(invitation[1]!, invitation[2] as 'accept' | 'decline');
    const snapshot = /^\/lists\/([^/]+)$/.exec(path);
    if (snapshot && method === 'GET') {
      this.checkAccess(snapshot[1]!, method);
      return this.snapshot(snapshot[1]!);
    }
    const collection = /^\/lists\/([^/]+)\/tasks$/.exec(path);
    if (collection && method === 'POST') {
      this.checkAccess(collection[1]!, method);
      return this.createTask(collection[1]!, body, init);
    }
    const single = /^\/lists\/([^/]+)\/tasks\/([^/]+)$/.exec(path);
    if (single && method === 'PATCH') {
      this.checkAccess(single[1]!, method);
      return this.patchTask(single[1]!, single[2]!, body, init);
    }
    if (single && method === 'DELETE') {
      this.checkAccess(single[1]!, method);
      return this.deleteTask(single[1]!, single[2]!, body, init);
    }
    const members = /^\/lists\/([^/]+)\/members$/.exec(path);
    if (members && method === 'POST') {
      this.checkAccess(members[1]!, method);
      return this.addMember(members[1]!, body, init);
    }
    throw new SyncHttpError(404, 'NOT_FOUND', path);
  }

  private createTask(listId: string, body: Record<string, unknown>, init: RequestInit): SharedTask {
    if (!this.server.lists.has(listId)) {
      throw new SyncHttpError(404, 'SHARED_LIST_NOT_FOUND', 'missing');
    }
    this.requireEditor(listId);
    const opId = String(body.op_id);
    const receipt = this.server.receipts.get(opId);
    if (receipt?.taskId) return this.server.tasks.get(receipt.taskId)!;
    this.checkRevision(listId, init);
    const revision = this.bump(listId);
    const task: SharedTask = {
      id: String(body.id ?? nextId('task')),
      list_id: listId,
      title: String(body.title),
      note: String(body.note ?? ''),
      status: 'open',
      important: Boolean(body.important),
      due_on: (body.due_on as string | null) ?? null,
      rank: 'a0',
      revision,
      created_at: NOW,
      updated_at: NOW,
    };
    this.server.tasks.set(task.id, task);
    this.server.receipts.set(opId, { key: opId, revision, taskId: task.id });
    return task;
  }

  private patchTask(
    listId: string,
    taskId: string,
    body: Record<string, unknown>,
    init: RequestInit,
  ): SharedTask {
    if (!this.server.lists.has(listId)) {
      throw new SyncHttpError(404, 'SHARED_LIST_NOT_FOUND', 'missing');
    }
    this.requireEditor(listId);
    const opId = String(body.op_id);
    if (this.server.receipts.has(opId)) return this.server.tasks.get(taskId)!;
    const task = this.server.tasks.get(taskId);
    if (!task) throw new SyncHttpError(404, 'SHARED_TASK_NOT_FOUND', 'missing');
    this.checkRevision(listId, init);
    const revision = this.bump(listId);
    const patch: Partial<SharedTask> = {};
    if (body.title !== undefined) patch.title = String(body.title);
    if (body.note !== undefined) patch.note = String(body.note);
    if (body.status !== undefined) patch.status = body.status as SharedTask['status'];
    if (body.important !== undefined) patch.important = Boolean(body.important);
    if (body.due_on !== undefined) patch.due_on = body.due_on as string | null;
    const next = { ...task, ...patch, revision };
    this.server.tasks.set(taskId, next);
    this.server.receipts.set(opId, { key: opId, revision, taskId });
    return next;
  }

  private deleteTask(
    listId: string,
    taskId: string,
    body: Record<string, unknown>,
    init: RequestInit,
  ): null {
    if (!this.server.lists.has(listId)) {
      throw new SyncHttpError(404, 'SHARED_LIST_NOT_FOUND', 'missing');
    }
    this.requireEditor(listId);
    if (this.server.receipts.has(String(body.op_id))) return null;
    const task = this.server.tasks.get(taskId);
    if (!task) throw new SyncHttpError(404, 'SHARED_TASK_NOT_FOUND', 'missing');
    this.checkRevision(listId, init);
    const revision = this.bump(listId);
    this.server.tasks.delete(taskId);
    this.server.receipts.set(String(body.op_id), { key: String(body.op_id), revision, taskId });
    return null;
  }

  private addMember(
    listId: string,
    body: Record<string, unknown>,
    init: RequestInit,
  ): SharedInvitation {
    const list = this.server.lists.get(listId);
    if (!list) throw new SyncHttpError(404, 'SHARED_LIST_NOT_FOUND', 'missing');
    if (list.role !== 'owner') throw new SyncHttpError(403, 'SHARED_LIST_FORBIDDEN', 'owner only');
    this.checkRevision(listId, init);
    const revision = this.bump(listId);
    const invitation: SharedInvitation = {
      id: nextId('invitation'),
      list_id: listId,
      list_name: list.name,
      email: String(body.email),
      role: body.role as SharedInvitation['role'],
      status: 'pending',
      invited_by: OWNER_ID,
      invited_by_email: 'owner@example.com',
      revision,
      created_at: NOW,
      updated_at: NOW,
    };
    this.server.invitations.push(invitation);
    return invitation;
  }

  private answer(invitationId: string, action: 'accept' | 'decline'): unknown {
    const invitation = this.server.invitations.find((item) => item.id === invitationId);
    if (!invitation) throw new SyncHttpError(404, 'SHARED_INVITATION_NOT_FOUND', 'missing');
    if (invitation.status !== 'pending') {
      throw new SyncHttpError(409, 'SHARED_INVITATION_NOT_PENDING', 'answered');
    }
    invitation.status = action === 'accept' ? 'accepted' : 'declined';
    this.server.invitations = this.server.invitations.filter((item) => item.id !== invitationId);
    const list = this.server.lists.get(invitation.list_id);
    if (!list) throw new SyncHttpError(404, 'SHARED_LIST_NOT_FOUND', 'missing');
    if (action === 'decline') return null;
    const summary = { ...list, role: invitation.role, revision: this.bump(list.id) };
    this.server.lists.set(list.id, summary);
    return summary;
  }
}

const listTaskSnapshot = (store: SharedStore, listId: string) =>
  store.transact(async (tx) => ({
    list: await tx.getList(listId),
    tasks: await tx.tasks(listId),
    ops: await tx.ops(listId),
  }));

let databaseCounter = 0;
function newStore(): { store: SharedStore; repository: DexieTaskRepository } {
  databaseCounter += 1;
  const repository = new DexieTaskRepository(`shared-sync-${databaseCounter}`);
  return { store: repository.sharedStore(), repository };
}

function engineFor(
  api: SharedApi,
  store: SharedStore,
  overrides: { id?: () => string } = {},
): SharedSyncEngine {
  return new SharedSyncEngine({
    request: api.request,
    store,
    ...overrides,
  });
}

/** One pull, so the engine has a shadow to push against. */
async function pulled(engine: SharedSyncEngine): Promise<void> {
  engine.start();
  await engine.syncNow();
}

describe('SharedSyncEngine', () => {
  beforeEach(() => {
    ids = 0;
  });

  it('replays queued edits in order with op_id and the current If-Match revision', async () => {
    const api = new SharedApi();
    const list = api.addList('团队');
    const first = api.addTask(list.id, '已有任务');
    const { store } = newStore();
    const engine = engineFor(api, store);
    await pulled(engine);

    await engine.createTask(list.id, { title: '本地新任务' });
    await engine.updateTask(list.id, first.id, { status: 'completed' });
    await engine.updateTask(list.id, first.id, { important: true });
    await engine.syncNow();

    const taskWrites = api.calls.filter((call) => call.method !== 'GET');
    expect(taskWrites.map((call) => call.method)).toEqual(['POST', 'PATCH', 'PATCH']);
    expect(taskWrites[0]!.body).toMatchObject({ title: '本地新任务' });
    expect(typeof (taskWrites[0]!.body as { op_id?: string }).op_id).toBe('string');
    expect((taskWrites[0]!.body as { id?: string }).id).toBeTruthy();
    // Each write carries the revision the previous one produced.
    expect(taskWrites.map((call) => call.revision)).toEqual(['1', '2', '3']);
    expect(taskWrites[1]!.body).toMatchObject({ status: 'completed' });
    expect(taskWrites[2]!.body).toMatchObject({ important: true });

    const after = await listTaskSnapshot(store, list.id);
    expect(after.ops).toHaveLength(0);
    expect(after.list?.revision).toBe(4);
    expect(after.tasks.map((task) => task.title)).toEqual(['已有任务', '本地新任务']);
  });

  it('keeps edits offline and replays them once the network returns', async () => {
    const api = new SharedApi();
    const list = api.addList('离线');
    const { store } = newStore();
    const engine = engineFor(api, store);
    await pulled(engine);

    api.failWith = () => new TypeError('Failed to fetch');
    await engine.createTask(list.id, { title: '地铁上写的' });
    await engine.syncNow();

    const offline = await listTaskSnapshot(store, list.id);
    expect(engine.getState().status).toBe('offline');
    expect(offline.tasks.map((task) => task.title)).toEqual(['地铁上写的']);
    expect(offline.tasks[0]!.pending).toBe(true);
    expect(offline.ops).toHaveLength(1);
    expect(api.server.tasks.size).toBe(0);

    api.failWith = null;
    await engine.syncNow();

    const online = await listTaskSnapshot(store, list.id);
    expect(engine.getState().status).toBe('idle');
    expect(online.ops).toHaveLength(0);
    expect(online.tasks[0]!.pending).toBe(false);
    expect([...api.server.tasks.values()].map((task) => task.title)).toEqual(['地铁上写的']);
  });

  it('pulls and rebases a pending edit after a 409 revision conflict', async () => {
    const api = new SharedApi();
    const list = api.addList('冲突');
    const mine = api.addTask(list.id, '同一项');
    api.addTask(list.id, '别人的');
    const { store } = newStore();
    const engine = engineFor(api, store);
    await pulled(engine);

    await engine.updateTask(list.id, mine.id, { title: '我改的标题' });
    // Another member writes first, so our If-Match is stale.
    api.remoteEdit(
      [...api.server.tasks.values()].find(
        (task) => task.list_id === list.id && task.id !== mine.id,
      )!.id,
      { title: '别人改的标题' },
    );
    await engine.syncNow();

    // The conflict is resolved by pulling the newer snapshot and replaying.
    const conflicts = api.calls.filter((call) => call.method === 'PATCH');
    expect(conflicts).toHaveLength(2);
    // The first patch used the stale revision and was rejected with 409; the
    // replay after the pull carries the newer one.
    expect(Number(conflicts[0]!.revision)).toBeLessThan(Number(conflicts[1]!.revision));
    const after = await listTaskSnapshot(store, list.id);
    expect(after.ops).toHaveLength(0);
    expect(after.tasks.find((task) => task.id === mine.id)?.title).toBe('我改的标题');
    expect(api.server.tasks.get(mine.id)?.title).toBe('我改的标题');
    expect(after.tasks.map((task) => task.title)).toContain('别人改的标题');
  });

  it('rejects rather than overwrites a field another member changed, and can retry it', async () => {
    const api = new SharedApi();
    const list = api.addList('同字段');
    const task = api.addTask(list.id, '原标题');
    const { store } = newStore();
    const engine = engineFor(api, store);
    await pulled(engine);

    await engine.updateTask(list.id, task.id, { title: '本地标题' });
    api.remoteEdit(task.id, { title: '远端标题' });
    await engine.syncNow();

    const rejected = await listTaskSnapshot(store, list.id);
    expect(rejected.ops).toHaveLength(1);
    expect(rejected.ops[0]).toMatchObject({
      status: 'rejected',
      errorCode: 'SHARED_EDIT_CONFLICT',
    });
    // The server keeps the other member's value; the local copy shows it too.
    expect(api.server.tasks.get(task.id)?.title).toBe('远端标题');
    expect(rejected.tasks.find((item) => item.id === task.id)?.title).toBe('远端标题');
    expect(rejected.tasks.find((item) => item.id === task.id)?.pending).toBe(false);

    await engine.retryOp(list.id, rejected.ops[0]!.opId);
    await engine.syncNow();
    expect(api.server.tasks.get(task.id)?.title).toBe('本地标题');
    const resolved = await listTaskSnapshot(store, list.id);
    expect(resolved.ops).toHaveLength(0);
    expect(resolved.tasks.find((item) => item.id === task.id)?.title).toBe('本地标题');
  });

  it('turns local data read-only when the member was removed', async () => {
    const api = new SharedApi();
    const list = api.addList('被移除');
    api.addTask(list.id, '保留可见');
    api.server.lists.set(list.id, { ...api.server.lists.get(list.id)!, role: 'editor' });
    const { store } = newStore();
    const engine = engineFor(api, store);
    await pulled(engine);

    api.removeMember(list.id);
    api.server.members.set(list.id, []);
    await engine.syncNow();

    const after = await listTaskSnapshot(store, list.id);
    expect(after.list?.access).toBe('revoked');
    expect(after.tasks.map((task) => task.title)).toEqual(['保留可见']);
    const view = await engine.read();
    expect(view.lists[0]?.editable).toBe(false);

    await expect(engine.createTask(list.id, { title: '不能再写' })).rejects.toThrow('只读');

    await engine.removeLocalCopy(list.id);
    expect(await engine.read()).toMatchObject({ lists: [] });
  });

  it('marks a deleted list without dropping the last local copy', async () => {
    const api = new SharedApi();
    const list = api.addList('会删掉');
    api.addTask(list.id, '旧任务');
    const { store } = newStore();
    const engine = engineFor(api, store);
    await pulled(engine);

    api.deleteList(list.id);
    await engine.syncNow();

    const after = await listTaskSnapshot(store, list.id);
    expect(after.list?.access).toBe('deleted');
    expect(after.tasks.map((task) => task.title)).toEqual(['旧任务']);
  });

  it('refuses to queue edits for viewers and for lists without a shadow', async () => {
    const api = new SharedApi();
    const list = api.addList('只读', 'viewer');
    const { store } = newStore();
    const engine = engineFor(api, store);
    await pulled(engine);

    await expect(engine.createTask(list.id, { title: 'x' })).rejects.toThrow('只读');
    await expect(engine.createTask('list-unknown', { title: 'x' })).rejects.toThrow('只读');
    expect(api.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
  });

  it('rejects queued edits and pulls the new role when an editor is demoted', async () => {
    const api = new SharedApi();
    const list = api.addList('降级');
    api.addTask(list.id, '任务');
    api.server.lists.set(list.id, { ...api.server.lists.get(list.id)!, role: 'editor' });
    const { store } = newStore();
    const engine = engineFor(api, store);
    await pulled(engine);

    await engine.createTask(list.id, { title: '还没发出去' });
    // The owner demotes this member before the queued create reaches the API.
    api.server.lists.set(list.id, { ...api.server.lists.get(list.id)!, role: 'viewer' });
    await engine.syncNow();

    const after = await listTaskSnapshot(store, list.id);
    expect(after.ops).toHaveLength(1);
    expect(after.ops[0]).toMatchObject({ status: 'rejected', errorCode: 'SHARED_LIST_FORBIDDEN' });
    // The rejected create is gone from the materialized tasks.
    expect(after.tasks.some((task) => task.title === '还没发出去')).toBe(false);
    const view = await engine.read();
    expect(view.lists[0]?.editable).toBe(false);
    expect(api.server.tasks.size).toBe(1);
  });

  it('accepts and declines invitations, and drops answered ones', async () => {
    const api = new SharedApi();
    const list = api.addList('被邀请的');
    api.server.lists.set(list.id, { ...api.server.lists.get(list.id)!, role: 'viewer' });
    api.server.invitations.push({
      id: TASK_INVITE,
      list_id: list.id,
      list_name: list.name,
      email: 'me@example.com',
      role: 'editor',
      status: 'pending',
      invited_by: OWNER_ID,
      invited_by_email: 'owner@example.com',
      revision: 1,
      created_at: NOW,
      updated_at: NOW,
    });
    const { store } = newStore();
    const engine = engineFor(api, store);
    await pulled(engine);

    expect((await engine.read()).invitations.map((item) => item.id)).toEqual([TASK_INVITE]);
    const listId = await engine.acceptInvitation(TASK_INVITE);
    expect(listId).toBe(list.id);
    const accepted = await engine.read();
    expect(accepted.invitations).toHaveLength(0);
    expect(accepted.lists.map((item) => item.record.id)).toEqual([list.id]);
    expect(api.server.lists.get(list.id)?.role).toBe('editor');

    // Declining removes it from the local index too.
    api.server.invitations.push({
      id: TASK_INVITE_2,
      list_id: list.id,
      list_name: list.name,
      email: 'me@example.com',
      role: 'viewer',
      status: 'pending',
      invited_by: OWNER_ID,
      invited_by_email: 'owner@example.com',
      revision: 1,
      created_at: NOW,
      updated_at: NOW,
    });
    await engine.syncNow();
    expect((await engine.read()).invitations).toHaveLength(1);
    await engine.declineInvitation(TASK_INVITE_2);
    expect((await engine.read()).invitations).toHaveLength(0);
  });

  it('creates lists and invites members with a role', async () => {
    const api = new SharedApi();
    const { store } = newStore();
    const engine = engineFor(api, store);
    await pulled(engine);

    const listId = await engine.createList('新的共享');
    await engine.invite(listId, ' Teammate@Example.com ', 'viewer');

    const invite = api.calls.find((call) => call.path === `/lists/${listId}/members`);
    expect(invite?.method).toBe('POST');
    expect(invite?.body).toMatchObject({ email: 'teammate@example.com', role: 'viewer' });
    expect(typeof (invite?.body as { op_id?: string }).op_id).toBe('string');
    const view = await engine.read();
    expect(view.lists[0]?.record.snapshot?.invitations[0]?.email).toBe('teammate@example.com');
  });

  it('ignores a snapshot that resolves after stop()', async () => {
    const api = new SharedApi();
    const list = api.addList('慢请求');
    api.addTask(list.id, '远端任务');
    const { store } = newStore();
    const engine = engineFor(api, store);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = api.request;
    const slow = (async <T>(path: string, init?: RequestInit): Promise<T> => {
      if (path === `/lists/${list.id}`) {
        await gate;
        return original<T>(path, init);
      }
      return original<T>(path, init);
    }) as typeof api.request;

    const pending = new SharedSyncEngine({ request: slow, store });
    pending.start();
    const run = pending.syncNow();
    pending.stop();
    release();
    await run;

    // Nothing from the stopped run lands: no record, or one still without snapshot.
    const record = await store.transact((tx) => tx.getList(list.id));
    expect(record?.snapshot ?? null).toBeNull();
  });

  it('settles a create whose acknowledgement was lost without duplicating the task', async () => {
    const api = new SharedApi();
    const list = api.addList('丢回执');
    const { store } = newStore();
    const engine = engineFor(api, store);
    await pulled(engine);

    // The server applies the create, then the reply is lost on the way back.
    api.dropResponse.add(`POST /lists/${list.id}/tasks`);
    await engine.createTask(list.id, { title: '只应出现一次' });
    await engine.syncNow();
    expect(engine.getState().status).toBe('offline');
    expect((await listTaskSnapshot(store, list.id)).ops).toHaveLength(1);

    // The retry reuses the op_id; the receipt answers with the applied task and
    // the queued op is dropped. Exactly one task exists, locally and remotely.
    api.dropResponse.clear();
    await engine.syncNow();

    const after = await listTaskSnapshot(store, list.id);
    expect(after.ops).toHaveLength(0);
    expect(after.tasks.map((task) => task.title)).toEqual(['只应出现一次']);
    expect(after.tasks[0]!.pending).toBe(false);
    expect([...api.server.tasks.values()].map((task) => task.title)).toEqual(['只应出现一次']);
    expect(after.list?.revision).toBe(api.server.revision.get(list.id));
  });

  it('reconciles a replayed receipt whose revision is not the adjacent one', async () => {
    const api = new SharedApi();
    const list = api.addList('丢回执又有人改');
    const other = api.addTask(list.id, '别人的任务');
    const { store } = newStore();
    const engine = engineFor(api, store);
    await pulled(engine);

    // The create is applied, its acknowledgement is lost, and another member
    // writes afterwards, so the replayed receipt answers with revision+2.
    api.dropResponse.add(`POST /lists/${list.id}/tasks`);
    await engine.createTask(list.id, { title: '只应出现一次' });
    await engine.syncNow();
    api.dropResponse.clear();
    api.remoteEdit(other.id, { title: '别人改过的任务' });
    await engine.syncNow();

    const after = await listTaskSnapshot(store, list.id);
    expect(after.ops).toHaveLength(0);
    expect(after.tasks.map((task) => task.title).sort()).toEqual(
      ['只应出现一次', '别人改过的任务'].sort(),
    );
    expect(after.tasks.find((task) => task.title === '只应出现一次')?.pending).toBe(false);
    expect([...api.server.tasks.values()].map((task) => task.title).sort()).toEqual(
      ['只应出现一次', '别人改过的任务'].sort(),
    );
    expect(after.list?.revision).toBe(api.server.revision.get(list.id));
    // The queued op is cleared: no further POST is attempted on later syncs.
    api.calls.length = 0;
    await engine.syncNow();
    expect(api.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
  });

  it('settles a patch whose acknowledgement was lost instead of rejecting it', async () => {
    const api = new SharedApi();
    const list = api.addList('丢回执改');
    const task = api.addTask(list.id, '原标题');
    const { store } = newStore();
    const engine = engineFor(api, store);
    await pulled(engine);

    api.dropResponse.add(`PATCH /lists/${list.id}/tasks/${task.id}`);
    await engine.updateTask(list.id, task.id, { title: '新标题' });
    await engine.syncNow();
    expect((await listTaskSnapshot(store, list.id)).ops).toHaveLength(1);
    expect(api.server.tasks.get(task.id)?.title).toBe('新标题');

    // Pull + rebase sees the field already equal to the patch, so the op is not
    // treated as a conflict; replaying it clears the outbox.
    api.dropResponse.clear();
    await engine.syncNow();

    const after = await listTaskSnapshot(store, list.id);
    expect(after.ops).toHaveLength(0);
    expect(after.tasks.find((item) => item.id === task.id)?.title).toBe('新标题');
    expect(after.tasks.find((item) => item.id === task.id)?.pending).toBe(false);
  });

  it('bounds a revision-conflict loop and keeps the queued edit', async () => {
    const api = new SharedApi();
    const list = api.addList('一直在变');
    const task = api.addTask(list.id, '标题');
    const { store } = newStore();
    const engine = engineFor(api, store);
    await pulled(engine);

    await engine.updateTask(list.id, task.id, { title: '我的修改' });
    // Another member keeps writing, so every replay is one revision stale.
    api.alwaysStale.add(list.id);
    await engine.syncNow();
    // Measure one bounded run: a run retries at most MAX_PULLS_PER_LIST times.
    api.calls.length = 0;
    await engine.syncNow();

    const stuck = await listTaskSnapshot(store, list.id);
    expect(stuck.ops).toHaveLength(1);
    expect(stuck.ops[0]).toMatchObject({ status: 'pending' });
    expect(stuck.list?.error).toBe('清单持续被其他成员更新，稍后自动重试');
    const attempts = api.calls.filter((call) => call.method === 'PATCH').length;
    expect(attempts).toBeGreaterThan(0);
    expect(attempts).toBeLessThanOrEqual(5);
    const pulls = api.calls.filter(
      (call) => call.method === 'GET' && call.path === `/lists/${list.id}`,
    ).length;
    expect(pulls).toBeLessThanOrEqual(5);

    // The edit is not lost: once the list settles, it is applied.
    api.alwaysStale.delete(list.id);
    await engine.syncNow();
    const resolved = await listTaskSnapshot(store, list.id);
    expect(resolved.ops).toHaveLength(0);
    expect(api.server.tasks.get(task.id)?.title).toBe('我的修改');
  });

  it('keeps queued edits as rejected, never silently discards, after access is revoked', async () => {
    const api = new SharedApi();
    const list = api.addList('被移除时离线');
    api.server.lists.set(list.id, { ...api.server.lists.get(list.id)!, role: 'editor' });
    const { store } = newStore();
    const engine = engineFor(api, store);
    await pulled(engine);

    api.failWith = () => new TypeError('Failed to fetch');
    await engine.createTask(list.id, { title: '还没发出去' });
    await engine.syncNow();
    api.failWith = null;

    api.removeMember(list.id);
    // Count only what the reconnect tries: the offline attempt is the one that
    // already happened and is expected to have reached the transport.
    api.calls.length = 0;
    await engine.syncNow();

    const after = await listTaskSnapshot(store, list.id);
    expect(after.list?.access).toBe('revoked');
    expect(after.ops).toHaveLength(1);
    expect(after.ops[0]).toMatchObject({
      status: 'rejected',
      errorCode: 'SHARED_LIST_ACCESS_REVOKED',
    });
    // Nothing is pushed after the membership is gone.
    expect(api.calls.filter((call) => call.method !== 'GET')).toHaveLength(0);
    const view = await engine.read();
    expect(view.lists[0]?.rejected.map((op) => op.opId)).toEqual([after.ops[0]!.opId]);
  });

  it('rejects queued edits when the list is deleted instead of retrying forever', async () => {
    const api = new SharedApi();
    const list = api.addList('被删除时离线');
    const { store } = newStore();
    const engine = engineFor(api, store);
    await pulled(engine);

    api.failWith = () => new TypeError('Failed to fetch');
    await engine.createTask(list.id, { title: '发不出去' });
    await engine.syncNow();
    api.failWith = null;

    api.deleteList(list.id);
    api.calls.length = 0;
    await engine.syncNow();

    const after = await listTaskSnapshot(store, list.id);
    expect(after.list?.access).toBe('deleted');
    expect(after.ops).toHaveLength(1);
    expect(after.ops[0]).toMatchObject({ status: 'rejected', errorCode: 'SHARED_LIST_NOT_FOUND' });
    expect(api.calls.filter((call) => call.method !== 'GET')).toHaveLength(0);
  });

  it('allows edits after a viewer is promoted to editor', async () => {
    const api = new SharedApi();
    const list = api.addList('升职', 'viewer');
    api.addTask(list.id, '已有');
    const { store } = newStore();
    const engine = engineFor(api, store);
    await pulled(engine);

    await expect(engine.createTask(list.id, { title: '只读时' })).rejects.toThrow('只读');

    // The owner promotes this member; the next index refresh carries the role.
    api.server.lists.set(list.id, { ...api.server.lists.get(list.id)!, role: 'editor' });
    await engine.syncNow();
    expect((await engine.read()).lists[0]?.editable).toBe(true);

    await engine.createTask(list.id, { title: '升职后' });
    await engine.syncNow();
    expect([...api.server.tasks.values()].map((task) => task.title)).toEqual(['已有', '升职后']);
  });

  it('never writes shared entities into personal tables or the personal outbox', async () => {
    const api = new SharedApi();
    const list = api.addList('隔离');
    const { store, repository } = newStore();
    await repository.initialize();
    const engine = engineFor(api, store);
    await pulled(engine);

    await engine.createTask(list.id, { title: '共享任务' });
    await engine.updateTask(list.id, (await engine.read()).lists[0]!.tasks[0]!.id, {
      note: '备注',
    });
    await engine.syncNow();

    // First-run onboarding seeds a few personal tasks; shared tables must not add any.
    const seeded = (await repository.listTasks({ view: 'all', includeCompleted: true })).items;
    expect(seeded).toHaveLength(5);
    expect(seeded.map((task) => task.title)).not.toContain('共享任务');
    expect(await repository.syncGetPendingCount()).toBe(0);
    // The bundle only carries the seeded personal tasks, never the shared ones.
    const bundle = await repository.exportData();
    expect(bundle.tasks.map((task) => task.title)).not.toContain('共享任务');
  });
});

describe('rebaseSharedTasks', () => {
  const base = (overrides: Partial<SharedOpRecord> = {}): SharedOpRecord => ({
    opId: 'op-1',
    listId: 'list-1',
    seq: 1,
    kind: 'patch',
    taskId: 'task-1',
    patch: { title: '新标题' },
    base: { title: '旧标题' },
    status: 'pending',
    errorCode: null,
    createdAt: NOW,
    ...overrides,
  });
  const shadow = (title: string): SharedTask => ({
    id: 'task-1',
    list_id: 'list-1',
    title,
    note: '',
    status: 'open',
    important: false,
    due_on: null,
    rank: 'a0',
    revision: 2,
    created_at: NOW,
    updated_at: NOW,
  });

  it('applies ops on top of the shadow in seq order', () => {
    const result = rebaseSharedTasks(
      'list-1',
      [shadow('旧标题')],
      [base({ seq: 2, patch: { important: true }, base: { important: false } }), base()],
    );
    expect(result.rejected).toEqual([]);
    expect(result.tasks[0]).toMatchObject({ title: '新标题', important: true, pending: true });
  });

  it('reports a same-field conflict instead of overwriting the shadow', () => {
    const result = rebaseSharedTasks('list-1', [shadow('远端标题')], [base()]);
    expect(result.rejected).toEqual([{ opId: 'op-1', code: 'SHARED_EDIT_CONFLICT' }]);
    expect(result.tasks[0]!.title).toBe('远端标题');
  });

  it('treats a patch that already matches the server as applied', () => {
    const result = rebaseSharedTasks('list-1', [shadow('新标题')], [base()]);
    expect(result.rejected).toEqual([]);
    expect(result.tasks[0]!.pending).toBe(true);
  });

  it('drops a delete whose task is already gone and rejects a patch for one', () => {
    const deleted = rebaseSharedTasks('list-1', [], [base({ kind: 'delete', base: {} })]);
    expect(deleted.dropped).toEqual(['op-1']);
    const patched = rebaseSharedTasks('list-1', [], [base()]);
    expect(patched.rejected).toEqual([{ opId: 'op-1', code: 'SHARED_TASK_NOT_FOUND' }]);
  });

  it('skips ops that were already rejected', () => {
    const result = rebaseSharedTasks(
      'list-1',
      [shadow('旧标题')],
      [base({ status: 'rejected', errorCode: 'SHARED_LIST_FORBIDDEN' })],
    );
    expect(result.rejected).toEqual([]);
    expect(result.tasks[0]!.title).toBe('旧标题');
  });
});
