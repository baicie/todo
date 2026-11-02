import { beforeEach, describe, expect, it } from 'vitest';
import { SyncHttpError } from '@todo/sync';
import type {
  SharedListSummary,
  SharedMember,
  SharedSnapshot,
  SharedTask,
} from '@todo/contracts';
import { DexieTaskRepository } from '../adapters/web-repository';
import { SharedSyncEngine, type SharedSession } from './shared-sync';
import type { SharedStore } from './shared-store';

/**
 * Account isolation for shared lists (RC1 Phase C).
 *
 * Two accounts share one browser profile, as the account switcher does: the
 * personal data space is per account (`shishi-todo` vs `shishi-todo:<id>`),
 * while these tests pin down what a *shared* space must guarantee. Account A's
 * shadow and unsent outbox must never be rendered for B nor replayed with B's
 * session, and A's offline edits must survive B's session untouched.
 *
 * The API double is per account: each token sees only that account's lists,
 * and every write is attributed to the token that carried it.
 */

const NOW = '2026-11-01T00:00:00.000Z';
const OWNER_ID = '019a0000-0000-7000-8000-000000000001';
const ACCOUNT_A: SharedSession = {
  token: 'session-a',
  account: { email: 'a@example.com', apiUrl: 'https://api.example' },
};
const ACCOUNT_B: SharedSession = {
  token: 'session-b',
  account: { email: 'b@example.com', apiUrl: 'https://api.example' },
};

let ids = 0;
const nextId = (prefix: 'list' | 'task'): string => {
  ids += 1;
  const head = prefix === 'list' ? '019b1000' : '019b2000';
  return `${head}-0000-7000-8000-${String(ids).padStart(12, '0')}`;
};

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

interface ApiCall {
  account: string;
  method: string;
  path: string;
  revision: string | null;
  body: unknown;
  /** False when the transport failed before the server saw the request. */
  reached: boolean;
}

/**
 * One server, two accounts. Every request is authenticated by the session the
 * engine was started under, so a replay with the wrong token is visible both in
 * `calls` and in the resulting state.
 */
class DualAccountApi {
  readonly lists = new Map<string, SharedListSummary>();
  readonly tasks = new Map<string, SharedTask>();
  readonly calls: ApiCall[] = [];
  private readonly revision = new Map<string, number>();
  private readonly receipts = new Map<string, SharedTask | null>();
  /** Account that owns each list; only members can read or write it. */
  private readonly owners = new Map<string, string>();
  private readonly members = new Map<string, Set<string>>();
  failWith: (() => Error) | null = null;
  current: SharedSession | null = null;

  reset(): void {
    this.lists.clear();
    this.tasks.clear();
    this.calls.length = 0;
    this.revision.clear();
    this.receipts.clear();
    this.owners.clear();
    this.members.clear();
    this.failWith = null;
    this.current = null;
  }

  /** A list owned by `email`, optionally shared with another account. */
  addList(name: string, owner: string, sharedWith: string[] = []): SharedListSummary {
    const summary = listSummary(name);
    this.lists.set(summary.id, summary);
    this.revision.set(summary.id, 1);
    this.owners.set(summary.id, owner);
    this.members.set(summary.id, new Set([owner, ...sharedWith]));
    return summary;
  }

  addTask(listId: string, title: string): SharedTask {
    const task: SharedTask = {
      id: nextId('task'),
      list_id: listId,
      title,
      note: '',
      status: 'open',
      important: false,
      due_on: null,
      rank: 'a0',
      revision: 1,
      created_at: NOW,
      updated_at: NOW,
    };
    this.tasks.set(task.id, task);
    return task;
  }

  /** Summary of what each account may see; used to assert server truth. */
  visibleTo(email: string): string[] {
    return [...this.lists.values()]
      .filter((list) => this.members.get(list.id)?.has(email))
      .map((list) => list.name)
      .sort();
  }

  writesBy(email: string): ApiCall[] {
    return this.calls.filter(
      (call) => call.account === email && call.method !== 'GET' && call.reached,
    );
  }

  /** Every attempt, including ones the network failed before delivery. */
  attemptsBy(email: string): ApiCall[] {
    return this.calls.filter((call) => call.account === email && call.method !== 'GET');
  }

  readonly request = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const account = this.current?.account.email ?? 'none';
    const method = (init.method ?? 'GET').toUpperCase();
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    const raw = new Headers(init.headers).get('If-Match');
    const call: ApiCall = {
      account,
      method,
      path,
      revision: raw ? raw.replaceAll('"', '') : null,
      body,
      reached: false,
    };
    this.calls.push(call);
    if (this.failWith) throw this.failWith();
    call.reached = true;
    return (await this.route(account, method, path, body, raw)) as T;
  };

  private requireMember(listId: string, account: string): void {
    if (!this.members.get(listId)?.has(account)) {
      throw new SyncHttpError(403, 'SHARED_LIST_ACCESS_REVOKED', 'removed');
    }
    if (!this.lists.has(listId)) {
      throw new SyncHttpError(404, 'SHARED_LIST_NOT_FOUND', 'missing');
    }
  }

  private snapshot(listId: string, account: string): SharedSnapshot {
    const list = this.lists.get(listId)!;
    const members: SharedMember[] = [...(this.members.get(listId) ?? [])].map((email) => ({
      user_id: OWNER_ID,
      email,
      role: email === this.owners.get(listId) ? 'owner' : 'editor',
      created_at: NOW,
    }));
    return {
      list: { ...list, ...(list.role === undefined ? {} : {}), role: list.role },
      members,
      invitations: [],
      tasks: [...this.tasks.values()].filter((task) => task.list_id === listId),
      steps: [],
      revision: this.revision.get(listId) ?? 1,
    };
  }

  private bump(listId: string): number {
    const next = (this.revision.get(listId) ?? 1) + 1;
    this.revision.set(listId, next);
    const list = this.lists.get(listId);
    if (list) this.lists.set(listId, { ...list, revision: next });
    return next;
  }

  private async route(
    account: string,
    method: string,
    path: string,
    body: Record<string, unknown>,
    rawRevision: string | null,
  ): Promise<unknown> {
    if (path === '/lists' && method === 'GET') {
      return [...this.lists.values()]
        .filter((list) => this.members.get(list.id)?.has(account))
        .map((list) => ({
          ...list,
          role: this.owners.get(list.id) === account ? 'owner' : ('editor' as const),
        }));
    }
    if (path === '/invitations' && method === 'GET') return [];
    const snapshot = /^\/lists\/([^/]+)$/.exec(path);
    if (snapshot && method === 'GET') {
      this.requireMember(snapshot[1]!, account);
      return this.snapshot(snapshot[1]!, account);
    }
    const collection = /^\/lists\/([^/]+)\/tasks$/.exec(path);
    if (collection && method === 'POST') {
      const listId = collection[1]!;
      this.requireMember(listId, account);
      const opId = String(body.op_id);
      const replay = this.receipts.get(opId);
      if (replay) return replay;
      const expected = rawRevision === null ? null : Number(rawRevision.replaceAll('"', ''));
      if (expected !== null && expected !== (this.revision.get(listId) ?? 1)) {
        throw Object.assign(new TypeError('conflict'), { code: 'x' });
      }
      const revision = this.bump(listId);
      const task: SharedTask = {
        id: String(body.id),
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
      this.tasks.set(task.id, task);
      this.receipts.set(opId, task);
      return task;
    }
    const single = /^\/lists\/([^/]+)\/tasks\/([^/]+)$/.exec(path);
    if (single && method === 'PATCH') {
      const listId = single[1]!;
      this.requireMember(listId, account);
      const opId = String(body.op_id);
      const replayed = this.receipts.get(opId);
      const taskId = single[2]!;
      if (replayed) return this.tasks.get(replayed.id)!;
      const task = this.tasks.get(taskId);
      if (!task) throw new SyncHttpError(404, 'SHARED_TASK_NOT_FOUND', 'missing');
      const expected = rawRevision === null ? null : Number(rawRevision.replaceAll('"', ''));
      if (expected !== null && expected !== (this.revision.get(listId) ?? 1)) {
        throw new SyncHttpError(409, 'REVISION_CONFLICT', 'stale');
      }
      const revision = this.bump(listId);
      const next: SharedTask = {
        ...task,
        ...(body.title !== undefined ? { title: String(body.title) } : {}),
        ...(body.note !== undefined ? { note: String(body.note) } : {}),
        ...(body.status !== undefined ? { status: body.status as SharedTask['status'] } : {}),
        ...(body.important !== undefined ? { important: Boolean(body.important) } : {}),
        ...(body.due_on !== undefined ? { due_on: body.due_on as string | null } : {}),
        revision,
      };
      this.tasks.set(taskId, next);
      this.receipts.set(opId, next);
      return next;
    }
    if (single && method === 'DELETE') {
      const listId = single[1]!;
      this.requireMember(listId, account);
      const taskId = single[2]!;
      if (this.receipts.has(String(body.op_id))) return null;
      const expected = rawRevision === null ? null : Number(rawRevision.replaceAll('"', ''));
      if (expected !== null && expected !== (this.revision.get(listId) ?? 1)) {
        throw new SyncHttpError(409, 'REVISION_CONFLICT', 'stale');
      }
      this.bump(listId);
      this.tasks.delete(taskId);
      this.receipts.set(String(body.op_id), null);
      return null;
    }
    throw new TypeError(`Failed to fetch ${method} ${path}`);
  }
}

let databaseCounter = 0;
function newRepository(): DexieTaskRepository {
  databaseCounter += 1;
  return new DexieTaskRepository(`shared-isolation-${databaseCounter}`);
}

/**
 * An engine wired the way `App.tsx` wires it: one store, a mutable session
 * accessor (the cloud controller), and the personal binding as the owner hint.
 */
function engineFor(
  api: DualAccountApi,
  store: SharedStore,
  repository: DexieTaskRepository,
  session: { current: SharedSession | null },
): SharedSyncEngine {
  return new SharedSyncEngine({
    request: (path, init) => {
      api.current = session.current;
      return api.request(path, init);
    },
    store,
    session: () => session.current,
    ownerHint: async () => (await repository.syncGetDiagnostics()).boundAccount,
  });
}

async function startAs(engine: SharedSyncEngine, session: SharedSession): Promise<void> {
  engine.start();
  await engine.syncNow();
}

describe('shared-list account isolation', () => {
  beforeEach(() => {
    ids = 0;
  });

  it('keeps account A shadow and outbox invisible to B and never replays them with B', async () => {
    const api = new DualAccountApi();
    const shared = api.addList('共同清单', ACCOUNT_A.account.email, [ACCOUNT_B.account.email]);
    // The list exists for both accounts, but only A holds a local copy.
    api.addTask(shared.id, 'A 的旧任务');
    const repository = newRepository();
    await repository.initialize();
    const store = repository.sharedStore();

    // 1. A signs in and pulls the shared list.
    const session: { current: SharedSession | null } = { current: ACCOUNT_A };
    const a = engineFor(api, store, repository, session);
    await startAs(a, ACCOUNT_A);
    expect(api.calls.every((call) => call.account === ACCOUNT_A.account.email)).toBe(true);
    expect((await a.read()).lists.map((item) => item.record.summary.name)).toEqual(['共同清单']);
    const boundAfterA = await store.boundAccount!();
    expect(boundAfterA).toEqual({ email: ACCOUNT_A.account.email, apiUrl: ACCOUNT_A.account.apiUrl });

    // 2. A goes offline and edits twice: one create, one patch of the old task.
    const originalRequest = api.request;
    api.failWith = () => new TypeError('Failed to fetch');
    await a.createTask(shared.id, { title: '地铁上写的' });
    const oldTask = (await a.read()).lists[0]!.tasks.find((task) => task.title === 'A 的旧任务')!;
    await a.updateTask(shared.id, oldTask.id, { note: '离线备注' });
    await a.syncNow();
    api.failWith = null;
    void originalRequest;
    expect(a.getState().status).toBe('offline');
    const offline = await store.transact(async (tx) => ({
      tasks: await tx.tasks(shared.id),
      ops: await tx.ops(shared.id),
    }));
    expect(offline.ops).toHaveLength(2);
    expect(offline.tasks.map((task) => task.title).sort()).toEqual([
      'A 的旧任务',
      '地铁上写的',
    ]);

    // 3. A signs out without clearing local data (web keeps it, per the UI copy).
    a.stop();

    // 4. B signs in to the same browser profile and storage.
    session.current = ACCOUNT_B;
    const b = engineFor(api, store, repository, session);
    expect(await b.read()).toEqual({ lists: [], invitations: [] });
    await startAs(b, ACCOUNT_B);
    expect(await b.read()).toEqual({ lists: [], invitations: [] });
    expect(b.getState().status).toBe('error');

    // 5. Opening/refreshing shared lists before B's first successful request
    //    must not render A's copy either; no request reached the API as B.
    b.stop();
    session.current = null;
    expect(await b.read()).toEqual({ lists: [], invitations: [] });
    session.current = ACCOUNT_B;
    expect(await b.read()).toEqual({ lists: [], invitations: [] });
    void b.syncNow();

    // 6. Reconnect as B: no queued op of A may be sent under B's session, and
    //    the shared space itself is untouched (still A's).
    api.current = ACCOUNT_B;
    await b.syncNow();
    expect(api.writesBy(ACCOUNT_B.account.email)).toHaveLength(0);
    expect([...api.tasks.values()].map((task) => task.title).sort()).toEqual(['A 的旧任务']);
    expect((await store.transact((tx) => tx.ops(shared.id))).map((op) => op.status)).toEqual([
      'pending',
      'pending',
    ]);

    // 7. B cannot queue shared edits into A's space.
    await expect(b.createTask(shared.id, { title: 'B 写的' })).rejects.toThrow('另一个账号');
    expect(api.writesBy(ACCOUNT_B.account.email)).toHaveLength(0);
    expect((await store.transact((tx) => tx.ops(shared.id))).every((op) => op.status === 'pending'))
      .toBe(true);

    // 8. B signs out, A signs back in: the offline edits are intact and replay.
    b.stop();
    session.current = ACCOUNT_A;
    const aAgain = engineFor(api, store, repository, session);
    expect((await aAgain.read()).lists.map((item) => item.record.summary.name)).toEqual([
      '共同清单',
    ]);
    await startAs(aAgain, ACCOUNT_A);
    const replayed = api.writesBy(ACCOUNT_A.account.email);
    // The create goes first; the patch that follows is the deliberate
    // post-receipt refresh (the engine re-pulls after a non-adjacent revision),
    // never a second delivery of a queued op.
    expect(replayed.map((call) => call.method)).toEqual(['POST', 'PATCH']);
    expect(replayed[0]!.body).toMatchObject({ title: '地铁上写的' });
    expect(replayed[1]!.body).toMatchObject({ note: '离线备注' });
    // Concurrent runs may attempt the same queued create more than once, but
    // every attempt carries the same op_id, so the server stores it once.
    const creates = api
      .attemptsBy(ACCOUNT_A.account.email)
      .filter((call) => call.method === 'POST');
    expect(
      new Set(creates.map((call) => (call.body as { op_id?: string }).op_id)).size,
    ).toBe(1);
    const settled = await store.transact(async (tx) => ({
      tasks: await tx.tasks(shared.id),
      ops: await tx.ops(shared.id),
    }));
    expect(settled.ops).toHaveLength(0);
    expect(settled.tasks.map((task) => task.title).sort()).toEqual([
      'A 的旧任务',
      '地铁上写的',
    ]);
    expect(settled.tasks.find((task) => task.title === 'A 的旧任务')?.note).toBe('离线备注');
    // The server saw both writes exactly once and only as A.
    expect(
      [...api.tasks.values()].filter((task) => task.list_id === shared.id).map((task) => task.title)
        .sort(),
    ).toEqual(['A 的旧任务', '地铁上写的']);
    aAgain.stop();
  });

  it('adopts a shared space written before the binding existed only for its own account', async () => {
    const api = new DualAccountApi();
    const shared = api.addList('历史数据', ACCOUNT_A.account.email);
    const repository = newRepository();
    await repository.initialize();
    const store = repository.sharedStore();
    const session: { current: SharedSession | null } = { current: ACCOUNT_A };

    // Simulate the previous release: a list record already stored, but no
    // account binding was ever written.
    await store.transact(async (tx) => {
      await tx.setMeta('invitations', '[]');
      await tx.putList({
        id: shared.id,
        summary: shared,
        snapshot: null,
        revision: 0,
        access: 'active',
        syncedAt: null,
        error: null,
      });
    });
    expect(await store.boundAccount!()).toBeNull();

    // The personal database is not yet bound (A has not finished login), so a
    // shared space holding data cannot be claimed blindly.
    const a = engineFor(api, store, repository, session);
    await startAs(a, ACCOUNT_A);
    expect(await store.boundAccount!()).toBeNull();
    expect(a.getState().status).toBe('error');
    a.stop();

    // Once the personal database is bound by a completed login, the same
    // account adopts the legacy shared data and syncs it normally.
    await repository.syncSetSession('session-a');
    await repository.syncSetEnabled(true);
    await repository.syncInitializeCloud(
      { cursor: '0', lists: [], tasks: [], steps: [], dayPlans: [] },
      'cloud',
      ACCOUNT_A.account.email,
      'session-a',
    );
    expect((await repository.syncGetDiagnostics()).boundAccount).toBe(ACCOUNT_A.account.email);
    const adopted = engineFor(api, store, repository, session);
    await startAs(adopted, ACCOUNT_A);
    expect(await store.boundAccount!()).toEqual({
      email: ACCOUNT_A.account.email,
      apiUrl: ACCOUNT_A.account.apiUrl,
    });
    expect((await adopted.read()).lists.map((item) => item.record.summary.name)).toEqual([
      '历史数据',
    ]);
    adopted.stop();
  });

  it('ignores a shared snapshot that resolves after the session changed', async () => {
    const api = new DualAccountApi();
    const shared = api.addList('慢响应', ACCOUNT_A.account.email);
    api.addTask(shared.id, '服务器上的任务');
    const repository = newRepository();
    await repository.initialize();
    const store = repository.sharedStore();
    const session: { current: SharedSession | null } = { current: ACCOUNT_A };

    const engine = engineFor(api, store, repository, session);
    // First pull learns the list, then the snapshot request is held.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let snapshotStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      snapshotStarted = resolve;
    });
    const original = api.request;
    const slow = (async <T,>(path: string, init?: RequestInit): Promise<T> => {
      api.current = session.current;
      if (path === `/lists/${shared.id}`) {
        snapshotStarted();
        await gate;
      }
      return original<T>(path, init);
    }) as typeof api.request;
    const gated = new SharedSyncEngine({
      request: slow,
      store,
      session: () => session.current,
      ownerHint: async () => (await repository.syncGetDiagnostics()).boundAccount,
    });
    gated.start();
    const running = gated.syncNow();
    await started;

    // The session ends while the snapshot is in flight; reconcile as B before
    // the slow response is released.
    gated.stop();
    session.current = ACCOUNT_B;
    release();
    await running;
    expect(gated.getState().status).toBe('idle');

    // Nothing of A's snapshot landed: the list record created by the index
    // refresh still has no snapshot, so no tasks are visible.
    expect(await store.transact((tx) => tx.getList(shared.id))).toMatchObject({ snapshot: null });
    expect(await gated.read()).toEqual({ lists: [], invitations: [] });
    expect(api.writesBy(ACCOUNT_B.account.email)).toHaveLength(0);
    void engine;
  });

  it('does not replay a queued op when the same account re-logs in with a new session', async () => {
    const api = new DualAccountApi();
    const shared = api.addList('重新登录', ACCOUNT_A.account.email);
    const repository = newRepository();
    await repository.initialize();
    const store = repository.sharedStore();
    const session: { current: SharedSession | null } = { current: ACCOUNT_A };
    const first = engineFor(api, store, repository, session);
    await startAs(first, ACCOUNT_A);

    // Offline edit queued under A's first session.
    api.failWith = () => new TypeError('Failed to fetch');
    await first.createTask(shared.id, { title: '第一次会话写的' });
    await first.syncNow();
    api.failWith = null;
    first.stop();

    // Same account, new session token (logout/login). The op must still be
    // owned by the account, not by the session that authored it, and replay
    // once the account reconnects.
    const secondSession: SharedSession = {
      token: 'session-a-2',
      account: ACCOUNT_A.account,
    };
    session.current = secondSession;
    const second = engineFor(api, store, repository, session);
    await startAs(second, secondSession);
    const replayed = api.writesBy(ACCOUNT_A.account.email);
    expect(replayed).toHaveLength(1);
    expect(replayed[0]!.body).toMatchObject({ title: '第一次会话写的' });
    expect(await store.transact((tx) => tx.ops(shared.id))).toHaveLength(0);
    second.stop();
  });

  it('stops pushing after the membership was revoked while offline', async () => {
    const api = new DualAccountApi();
    const shared = api.addList('被移除', ACCOUNT_A.account.email);
    const repository = newRepository();
    await repository.initialize();
    const store = repository.sharedStore();
    const session: { current: SharedSession | null } = { current: ACCOUNT_A };
    const engine = engineFor(api, store, repository, session);
    await startAs(engine, ACCOUNT_A);

    api.failWith = () => new TypeError('Failed to fetch');
    await engine.createTask(shared.id, { title: '离线期间写的' });
    await engine.syncNow();
    api.failWith = null;
    // The owner removes A while A was offline: the list is gone for A now.
    api.lists.delete(shared.id);
    await engine.syncNow();

    const after = await store.transact(async (tx) => ({
      record: await tx.getList(shared.id),
      ops: await tx.ops(shared.id),
    }));
    expect(after.record?.access).toBe('deleted');
    expect(after.ops.every((op) => op.status === 'rejected')).toBe(true);
    expect(api.writesBy(ACCOUNT_A.account.email)).toHaveLength(0);
    engine.stop();
  });
});
