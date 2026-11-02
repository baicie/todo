import {
  sharedInvitationSchema,
  sharedListSummarySchema,
  sharedSnapshotSchema,
  sharedTaskSchema,
  type SharedInvitation,
  type SharedInviteRole,
  type SharedListSummary,
  type SharedSnapshot,
  type SharedTask,
} from '@todo/contracts';
import type { AppLifecycle } from '@todo/application';
import { cleanNote, cleanSingleLine, isDateOnly, newUuidV7 } from '@todo/domain';
import { SyncHttpError } from '@todo/sync';
import type {
  SharedAccountIdentity,
  SharedListRecord,
  SharedOpRecord,
  SharedStore,
  SharedTaskField,
  SharedTaskPatch,
  SharedTaskRecord,
  SharedTx,
} from './shared-store';
import { sameSharedAccount } from './shared-store';

/**
 * Offline-capable client for shared lists.
 *
 * Local edits are written to the materialized `sharedTasks` table and to
 * `sharedOutbox` in one transaction. While the session is connected, pending
 * ops are replayed in order through the existing REST routes with `op_id`
 * (idempotent receipts) and `If-Match` (list revision). A 409 revision conflict
 * pulls a fresh snapshot and rebases the pending ops on top of it. An op whose
 * field was changed by another member in the meantime is marked rejected
 * instead of overwriting the collaborator; the user retries or discards it.
 */

export type SharedRequest = <T>(path: string, init?: RequestInit) => Promise<T>;

export const SHARED_POLL_MS = 15_000;
export const SHARED_PUSH_BATCH = 50;
const MAX_PULLS_PER_LIST = 5;
const TASK_FIELDS: readonly SharedTaskField[] = ['title', 'note', 'status', 'important', 'due_on'];
const INVITATIONS_KEY = 'invitations';
const SEQ_KEY = 'outboxSeq';
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const FOREIGN_SPACE_MESSAGE = '本机共享数据属于另一个账号，请先清除本机数据或切换回该账号';

export type SharedSyncStatus = 'idle' | 'syncing' | 'offline' | 'error';

export interface SharedEngineState {
  status: SharedSyncStatus;
  error: string | null;
  lastSyncedAt: string | null;
}

export interface SharedListView {
  record: SharedListRecord;
  tasks: SharedTaskRecord[];
  pending: number;
  rejected: SharedOpRecord[];
  editable: boolean;
}

export interface SharedViewState {
  lists: SharedListView[];
  invitations: SharedInvitation[];
}

export interface NewSharedTask {
  title: string;
  note?: string;
  important?: boolean;
  due_on?: string | null;
}

export interface SharedSyncEngineOptions {
  request: SharedRequest;
  store: SharedStore;
  now?: () => Date;
  newId?: () => string;
  pollMs?: number;
  /**
   * Resolves the session the caller is now in, or null when there is none.
   * Every network exchange is checked against it so a response or a flush that
   * belongs to a previous account can never land in the current store.
   */
  session?: () => SharedSession | null;
  /** The personal `boundAccount` of the same data space, for adopting legacy shared data. */
  ownerHint?: () => Promise<string | null>;
}

/** One authenticated client identity, as seen by the shared engine. */
export interface SharedSession {
  token: string;
  account: SharedAccountIdentity;
}

export class SharedSessionChangedError extends Error {
  readonly code = 'SHARED_SESSION_CHANGED';

  constructor() {
    super('云服务会话已切换，已丢弃旧账号的共享同步结果');
    this.name = 'SharedSessionChangedError';
  }
}

type Failure =
  | { kind: 'offline'; message: string }
  | { kind: 'http'; status: number; code: string; message: string }
  | { kind: 'error'; message: string };

/** Network, expired-login and server-unavailable failures are retried later. */
export function sharedFailure(error: unknown): Failure {
  if (error instanceof SyncHttpError) {
    if (error.status === 401) {
      return { kind: 'offline', message: '云端登录已失效，重新登录后继续同步' };
    }
    if (error.status === 429 || error.status >= 500) {
      return { kind: 'offline', message: '云端暂时不可用，稍后自动重试' };
    }
    return { kind: 'http', status: error.status, code: error.code, message: error.message };
  }
  if (error instanceof TypeError) {
    return { kind: 'offline', message: '网络不可用，修改已保存在本机，联网后自动同步' };
  }
  return { kind: 'error', message: error instanceof Error ? error.message : '共享清单同步失败' };
}

const CODE_MESSAGES: Record<string, string> = {
  REVISION_CONFLICT: '清单刚被其他成员更新，请重试',
  SHARED_EDIT_CONFLICT: '其他成员同时修改了这个任务',
  SHARED_INVITATION_NOT_FOUND: '邀请不存在或不属于当前账号',
  SHARED_INVITATION_NOT_PENDING: '这个邀请已经处理过',
  SHARED_LIST_ACCESS_REVOKED: '你已被移出这个共享清单',
  SHARED_LIST_FORBIDDEN: '当前角色没有权限执行此操作',
  SHARED_LIST_NOT_FOUND: '共享清单不存在或已被删除',
  SHARED_MEMBER_EXISTS: '该邮箱已经是清单成员',
  SHARED_TASK_NOT_FOUND: '任务已被其他成员删除',
};

export function sharedErrorMessage(error: unknown, fallback: string): string {
  const failure = sharedFailure(error);
  if (failure.kind === 'http') return CODE_MESSAGES[failure.code] ?? failure.message ?? fallback;
  return failure.message || fallback;
}

export function sharedRejectionReason(code: string | null): string {
  return (code && CODE_MESSAGES[code]) || code || '服务端拒绝了这项修改';
}

function pick(task: SharedTask, fields: readonly string[]): SharedTaskPatch {
  const result: Record<string, unknown> = {};
  for (const field of fields) result[field] = task[field as SharedTaskField];
  return result as SharedTaskPatch;
}

function createdRecord(listId: string, op: SharedOpRecord, offset: number): SharedTaskRecord {
  return {
    id: op.taskId,
    list_id: listId,
    title: op.patch.title ?? '',
    note: op.patch.note ?? '',
    status: 'open',
    important: op.patch.important ?? false,
    due_on: op.patch.due_on ?? null,
    rank: 'a0',
    revision: 0,
    created_at: op.createdAt,
    updated_at: op.createdAt,
    position: offset + op.seq,
    pending: true,
  };
}

/** True when another member changed a field this op was based on. */
function conflicts(current: SharedTask, op: SharedOpRecord): boolean {
  return (Object.keys(op.base) as SharedTaskField[]).some((field) => {
    const remote = current[field];
    if (remote === op.base[field]) return false;
    // A patch that already matches the server (for example an applied op whose
    // response was lost) is not a conflict.
    return op.kind === 'delete' || remote !== op.patch[field];
  });
}

export interface RebaseResult {
  tasks: SharedTaskRecord[];
  rejected: Array<{ opId: string; code: string }>;
  /** Deletes whose task is already gone on the server. */
  dropped: string[];
}

/** Materialize `shadow` + pending ops in outbox order. Pure; exported for tests. */
export function rebaseSharedTasks(
  listId: string,
  shadow: SharedTask[],
  ops: SharedOpRecord[],
): RebaseResult {
  const working = new Map<string, SharedTaskRecord>();
  shadow.forEach((task, index) =>
    working.set(task.id, { ...task, position: index, pending: false }),
  );
  const rejected: RebaseResult['rejected'] = [];
  const dropped: string[] = [];
  for (const op of [...ops].sort((a, b) => a.seq - b.seq)) {
    if (op.status !== 'pending') continue;
    const current = working.get(op.taskId);
    if (op.kind === 'create') {
      working.set(
        op.taskId,
        current ? { ...current, pending: true } : createdRecord(listId, op, shadow.length),
      );
      continue;
    }
    if (!current) {
      if (op.kind === 'delete') dropped.push(op.opId);
      else rejected.push({ opId: op.opId, code: 'SHARED_TASK_NOT_FOUND' });
      continue;
    }
    if (conflicts(current, op)) {
      rejected.push({ opId: op.opId, code: 'SHARED_EDIT_CONFLICT' });
      continue;
    }
    if (op.kind === 'delete') working.delete(op.taskId);
    else working.set(op.taskId, { ...current, ...op.patch, pending: true });
  }
  return {
    tasks: [...working.values()].sort((a, b) => a.position - b.position),
    rejected,
    dropped,
  };
}

async function applyRebase(tx: SharedTx, record: SharedListRecord): Promise<void> {
  if (!record.snapshot) return;
  const ops = await tx.ops(record.id);
  const result = rebaseSharedTasks(record.id, record.snapshot.tasks, ops);
  for (const { opId, code } of result.rejected) {
    const op = ops.find((item) => item.opId === opId);
    if (op) await tx.putOp({ ...op, status: 'rejected', errorCode: code });
  }
  for (const opId of result.dropped) await tx.deleteOp(opId);
  await tx.replaceTasks(record.id, result.tasks);
}

function isEditable(record: SharedListRecord): boolean {
  return record.access === 'active' && record.snapshot !== null && record.summary.role !== 'viewer';
}

function emptyRecord(summary: SharedListSummary): SharedListRecord {
  return {
    id: summary.id,
    summary,
    snapshot: null,
    revision: 0,
    access: 'active',
    syncedAt: null,
    error: null,
  };
}

function accessLoss(error: unknown): { access: 'revoked' | 'deleted'; code: string } | null {
  if (!(error instanceof SyncHttpError)) return null;
  if (error.status === 403 && error.code === 'SHARED_LIST_ACCESS_REVOKED') {
    return { access: 'revoked', code: error.code };
  }
  if (error.status === 404 && error.code === 'SHARED_LIST_NOT_FOUND') {
    return { access: 'deleted', code: error.code };
  }
  return null;
}

function parseInvitations(raw: string | undefined): SharedInvitation[] {
  if (!raw) return [];
  try {
    const parsed = sharedInvitationSchema.array().safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

function normalizePatch(patch: SharedTaskPatch): SharedTaskPatch {
  const clean: SharedTaskPatch = {};
  if (patch.title !== undefined) {
    const title = cleanSingleLine(patch.title);
    if (!title) throw new Error('任务标题不能为空');
    clean.title = title;
  }
  if (patch.note !== undefined) clean.note = cleanNote(patch.note);
  if (patch.status !== undefined) {
    if (patch.status !== 'open' && patch.status !== 'completed') throw new Error('任务状态无效');
    clean.status = patch.status;
  }
  if (patch.important !== undefined) clean.important = Boolean(patch.important);
  if (patch.due_on !== undefined) {
    if (patch.due_on !== null && !isDateOnly(patch.due_on)) throw new Error('截止日期无效');
    clean.due_on = patch.due_on;
  }
  return clean;
}

function opRequest(
  listId: string,
  op: SharedOpRecord,
  revision: number,
): { path: string; init: RequestInit } {
  const tasks = `/lists/${encodeURIComponent(listId)}/tasks`;
  const headers = { 'If-Match': `"${revision}"` };
  if (op.kind === 'create') {
    return {
      path: tasks,
      init: {
        method: 'POST',
        headers,
        body: JSON.stringify({ id: op.taskId, ...op.patch, op_id: op.opId }),
      },
    };
  }
  const path = `${tasks}/${encodeURIComponent(op.taskId)}`;
  if (op.kind === 'patch') {
    return {
      path,
      init: { method: 'PATCH', headers, body: JSON.stringify({ ...op.patch, op_id: op.opId }) },
    };
  }
  return { path, init: { method: 'DELETE', headers, body: JSON.stringify({ op_id: op.opId }) } };
}

type PushOutcome = 'next' | 'pull' | 'stop';
type OpDraft = Pick<SharedOpRecord, 'kind' | 'taskId' | 'patch' | 'base'>;

export class SharedSyncEngine {
  private readonly listeners = new Set<() => void>();
  private state: SharedEngineState = { status: 'idle', error: null, lastSyncedAt: null };
  private running: Promise<void> | null = null;
  private queued: { index: boolean } | null = null;
  private generation = 0;
  private active = false;
  private stopTimers: (() => void) | null = null;
  /** Session token the current run was started under; see `fence`. */
  private runToken: string | null = null;
  /** Resolved owner of the store for the current run. */
  private runOwner: SharedAccountIdentity | null = null;
  /** True when the store's binding must be (re)claimed before writing. */
  private bindingDirty = true;

  constructor(private readonly options: SharedSyncEngineOptions) {}

  private get store(): SharedStore {
    return this.options.store;
  }

  private now(): string {
    return (this.options.now?.() ?? new Date()).toISOString();
  }

  private newId(): string {
    return this.options.newId?.() ?? newUuidV7();
  }

  getState(): SharedEngineState {
    return { ...this.state };
  }

  isActive(): boolean {
    return this.active;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  private setState(patch: Partial<SharedEngineState>): void {
    this.state = { ...this.state, ...patch };
    this.emit();
  }

  private isCurrent(generation: number): boolean {
    return this.active && generation === this.generation;
  }

  /**
   * Throws when the session changed since this run started. Local writes and
   * remote sends both go through it, so a logout, an account switch or an
   * expired login cannot let account A's work land while account B is active.
   */
  private fence(generation: number): void {
    if (!this.isCurrent(generation)) throw new SharedSessionChangedError();
    if (!this.options.session) return;
    const session = this.options.session();
    if (session === null || session.token !== this.runToken) {
      throw new SharedSessionChangedError();
    }
    if (this.runOwner && !sameSharedAccount(session.account, this.runOwner)) {
      throw new SharedSessionChangedError();
    }
  }

  /**
   * Decide whether this run may touch the store and talk to the API. False
   * when there is no session or the space belongs to another account; the run
   * then does no network work at all, so nothing is shown or replayed across
   * accounts. An unbound space is claimed only for the signed-in account.
   */
  private async ownerFor(generation: number): Promise<boolean> {
    if (!this.options.session) {
      // No session provider (standalone engine or tests): the store is the only
      // scope and there is nothing to fence against.
      this.runOwner = null;
      return true;
    }
    const session = this.sessionNow();
    if (!session) return false;
    this.runOwner = session.account;
    if (!this.isCurrent(generation)) return false;
    if (!this.store.bindAccount) return true;
    if (this.bindingDirty) {
      const ownerHint = (await this.options.ownerHint?.()) ?? null;
      const claimed = await this.store.bindAccount(session.account, ownerHint);
      if (!this.isCurrent(generation)) return false;
      if (!claimed) {
        if (this.isCurrent(generation)) {
          this.setState({ status: 'error', error: FOREIGN_SPACE_MESSAGE });
        }
        return false;
      }
      this.bindingDirty = false;
    }
    return true;
  }

  /** Mark the store's account binding for re-verification (after a clear). */
  rebind(): void {
    this.bindingDirty = true;
  }

  private sessionNow(): SharedSession | null {
    return this.options.session?.() ?? null;
  }

  /** Throws when the signed-in account ended or changed since `started`. */
  private assertSameSession(started: SharedSession | null): void {
    if (!this.options.session) return;
    const now = this.sessionNow();
    if (!now || !started || now.token !== started.token) throw new SharedSessionChangedError();
    if (!sameSharedAccount(now.account, started.account)) throw new SharedSessionChangedError();
  }

  /**
   * Refuse to write local shared data for an account that does not own the
   * space. Binding is idempotent; the check is repeated on every offline edit so
   * local writes cannot cross accounts even when no network work happens.
   */
  private async ensureStoreOwner(): Promise<void> {
    if (!this.options.session) return;
    const session = this.sessionNow();
    if (!session) throw new Error('请先登录云端账号再编辑共享清单');
    if (!this.store.bindAccount) return;
    const ownerHint = (await this.options.ownerHint?.()) ?? null;
    const claimed = await this.store.bindAccount(session.account, ownerHint);
    if (!claimed) {
      // Kept in Chinese to match the rest of the shared-list UI copy.
      throw new Error(FOREIGN_SPACE_MESSAGE);
    }
    if (this.sessionNow()?.token !== session.token) throw new SharedSessionChangedError();
  }

  /**
   * Adopt a newly connected session without ever reusing the previous one's
   * run identity. Called when the cloud session becomes connected, including a
   * second connect without an intervening stop.
   */
  start(lifecycle?: Pick<AppLifecycle, 'onResume' | 'onOnline'>): void {
    const token = this.options.session?.()?.token ?? null;
    if (this.active && token === this.runToken) return;
    if (this.active) {
      this.active = false;
      this.generation += 1;
      this.stopTimers?.();
      this.stopTimers = null;
      this.queued = null;
    }
    this.active = true;
    this.generation += 1;
    this.runToken = token;
    this.runOwner = null;
    this.bindingDirty = true;
    const poll = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') {
        void this.sync({ index: true });
      }
    }, this.options.pollMs ?? SHARED_POLL_MS);
    const stopResume = lifecycle?.onResume(() => void this.sync({ index: true }));
    const stopOnline = lifecycle?.onOnline(() => void this.sync({ index: true }));
    this.stopTimers = () => {
      clearInterval(poll);
      stopResume?.();
      stopOnline?.();
    };
    void this.sync({ index: true });
  }

  /** Stop network work. Local data and the outbox are kept. */
  stop(): void {
    if (!this.active) return;
    this.active = false;
    this.generation += 1;
    this.runToken = null;
    this.runOwner = null;
    this.bindingDirty = true;
    this.stopTimers?.();
    this.stopTimers = null;
    this.queued = null;
    this.setState({ status: 'idle', error: null });
  }

  syncNow(): Promise<void> {
    return this.sync({ index: true });
  }

  /**
   * Runs are serialized; a request made during a run is coalesced into one
   * follow-up run. `index` also refreshes the list index and invitations.
   */
  sync(options: { index?: boolean } = {}): Promise<void> {
    if (!this.active) return Promise.resolve();
    const index = options.index ?? true;
    if (this.running) {
      this.queued = { index: index || (this.queued?.index ?? false) };
      return this.running;
    }
    const tracked = (async () => {
      let next: { index: boolean } | null = { index };
      while (next && this.active) {
        this.queued = null;
        await this.runOnce(next.index, this.generation);
        next = this.queued;
      }
    })().finally(() => {
      if (this.running === tracked) this.running = null;
    });
    this.running = tracked;
    return tracked;
  }

  private async runOnce(index: boolean, generation: number): Promise<void> {
    this.setState({ status: 'syncing' });
    try {
      const owner = await this.ownerFor(generation);
      if (!owner) {
        // Another account owns the local shared data, or there is no session:
        // do no network work and do not render anything. However, if the
        // session is present but mismatched, surface an error so users know why
        // their shared lists are unavailable.
        if (this.isCurrent(generation)) {
          const session = this.sessionNow();
          this.setState({
            status: session ? 'error' : 'idle',
            error: session ? FOREIGN_SPACE_MESSAGE : null,
            lastSyncedAt: this.now(),
          });
        }
        return;
      }
      if (index) await this.refreshIndex(generation);
      const records = await this.store.transact((tx) => tx.allLists());
      for (const record of records) {
        if (!this.isCurrent(generation)) return;
        if (record.access === 'active') await this.syncList(record.id, generation);
      }
      if (this.isCurrent(generation)) {
        this.setState({ status: 'idle', error: null, lastSyncedAt: this.now() });
      }
    } catch (error) {
      if (!this.isCurrent(generation)) return;
      const failure = sharedFailure(error);
      this.setState({
        status: failure.kind === 'offline' ? 'offline' : 'error',
        error: sharedErrorMessage(error, '共享清单同步失败'),
      });
    }
  }

  private async refreshIndex(generation: number): Promise<void> {
    this.fence(generation);
    const [rawLists, rawInvitations] = await Promise.all([
      this.options.request<unknown>('/lists'),
      this.options.request<unknown>('/invitations'),
    ]);
    const summaries = sharedListSummarySchema.array().parse(rawLists);
    const invitations = sharedInvitationSchema.array().parse(rawInvitations);
    if (!this.isCurrent(generation)) return;
    this.fence(generation);
    const missing = await this.store.transact(async (tx) => {
      await tx.setMeta(INVITATIONS_KEY, JSON.stringify(invitations));
      const local = await tx.allLists();
      const seen = new Set<string>();
      for (const summary of summaries) {
        seen.add(summary.id);
        const existing = local.find((record) => record.id === summary.id);
        await tx.putList(
          existing ? { ...existing, summary, access: 'active' } : emptyRecord(summary),
        );
      }
      return local
        .filter((record) => record.access === 'active' && !seen.has(record.id))
        .map((record) => record.id);
    });
    this.emit();
    // A list that vanished from the index was deleted or our membership was
    // removed; the snapshot request tells the two apart.
    for (const listId of missing) {
      if (!this.isCurrent(generation)) return;
      await this.pull(listId, generation);
    }
  }

  private async syncList(listId: string, generation: number): Promise<void> {
    const initial = await this.readList(listId);
    if (!initial || initial.access !== 'active') return;
    let needsPull = !initial.snapshot || initial.summary.revision > initial.revision;
    let pulls = 0;
    let pushed = 0;
    while (this.isCurrent(generation)) {
      if (needsPull) {
        if (pulls >= MAX_PULLS_PER_LIST) {
          await this.setListError(listId, '清单持续被其他成员更新，稍后自动重试');
          return;
        }
        pulls += 1;
        needsPull = false;
        if (!(await this.pull(listId, generation))) return;
        continue;
      }
      const op = await this.nextPending(listId);
      if (!op) return;
      if (pushed >= SHARED_PUSH_BATCH) {
        this.queued = { index: this.queued?.index ?? false };
        return;
      }
      pushed += 1;
      const outcome = await this.push(listId, op, generation);
      if (outcome === 'stop') return;
      if (outcome === 'pull') needsPull = true;
    }
  }

  private readList(listId: string): Promise<SharedListRecord | undefined> {
    return this.store.transact((tx) => tx.getList(listId));
  }

  private async nextPending(listId: string): Promise<SharedOpRecord | undefined> {
    const ops = await this.store.transact((tx) => tx.ops(listId));
    return ops.find((op) => op.status === 'pending');
  }

  private async setListError(listId: string, error: string | null): Promise<void> {
    await this.store.transact(async (tx) => {
      const record = await tx.getList(listId);
      if (record) await tx.putList({ ...record, error });
    });
    this.emit();
  }

  /**
   * Fetch a snapshot and rebase pending ops on it. False once access is gone.
   * With `generation`, a response that arrives after `stop()` is dropped.
   */
  private async pull(listId: string, generation?: number): Promise<boolean> {
    const stale = () => generation !== undefined && !this.isCurrent(generation);
    if (generation !== undefined) this.fence(generation);
    let snapshot: SharedSnapshot;
    try {
      snapshot = sharedSnapshotSchema.parse(
        await this.options.request<unknown>(`/lists/${encodeURIComponent(listId)}`),
      );
    } catch (error) {
      if (stale()) return false;
      const lost = accessLoss(error);
      if (!lost) throw error;
      await this.loseAccess(listId, lost.access, lost.code, generation);
      return false;
    }
    if (stale()) return false;
    if (generation !== undefined) this.fence(generation);
    const syncedAt = this.now();
    await this.store.transact(async (tx) => {
      const current = await tx.getList(listId);
      // A slower, older response must not roll the shadow back.
      if (current?.snapshot && snapshot.revision < current.revision) return;
      const next: SharedListRecord = {
        id: listId,
        summary: snapshot.list,
        snapshot: {
          members: snapshot.members,
          invitations: snapshot.invitations,
          tasks: snapshot.tasks,
          steps: snapshot.steps,
        },
        revision: snapshot.revision,
        access: 'active',
        syncedAt,
        error: null,
      };
      await tx.putList(next);
      await applyRebase(tx, next);
    });
    this.emit();
    return true;
  }

  /** Keep the last server copy read-only and reject everything still queued. */
  private async loseAccess(
    listId: string,
    access: 'revoked' | 'deleted',
    code: string,
    generation?: number,
  ): Promise<void> {
    if (generation !== undefined) this.fence(generation);
    await this.store.transact(async (tx) => {
      const record = await tx.getList(listId);
      if (!record) return;
      for (const op of await tx.ops(listId)) {
        if (op.status === 'pending') await tx.putOp({ ...op, status: 'rejected', errorCode: code });
      }
      const next: SharedListRecord = { ...record, access, error: null };
      await tx.putList(next);
      await applyRebase(tx, next);
    });
    this.emit();
  }

  private async rejectOps(
    listId: string,
    code: string,
    opId?: string,
    generation?: number,
  ): Promise<void> {
    if (generation !== undefined) this.fence(generation);
    await this.store.transact(async (tx) => {
      const record = await tx.getList(listId);
      if (!record) return;
      for (const op of await tx.ops(listId)) {
        if (op.status === 'pending' && (opId === undefined || op.opId === opId)) {
          await tx.putOp({ ...op, status: 'rejected', errorCode: code });
        }
      }
      await applyRebase(tx, record);
    });
    this.emit();
  }

  private async push(listId: string, op: SharedOpRecord, generation: number): Promise<PushOutcome> {
    this.fence(generation);
    const record = await this.readList(listId);
    if (!record || record.access !== 'active' || !record.snapshot) return 'stop';
    const expected = record.revision;
    const { path, init } = opRequest(listId, op, expected);
    let response: unknown;
    try {
      response = await this.options.request<unknown>(path, init);
    } catch (error) {
      // The op stays pending; its op_id makes the later replay idempotent.
      if (!this.isCurrent(generation)) return 'stop';
      const lost = accessLoss(error);
      if (lost) {
        await this.loseAccess(listId, lost.access, lost.code, generation);
        return 'stop';
      }
      this.fence(generation);
      const failure = sharedFailure(error);
      if (failure.kind !== 'http') throw error;
      if (failure.code === 'REVISION_CONFLICT') return 'pull';
      if (failure.code === 'SHARED_LIST_FORBIDDEN') {
        // Demoted to viewer: nothing queued can be applied any more.
        await this.rejectOps(listId, failure.code, undefined, generation);
        return 'pull';
      }
      if (failure.code === 'SHARED_TASK_NOT_FOUND' && op.kind === 'delete') {
        await this.settle(listId, op, expected, null, generation);
        return 'pull';
      }
      await this.rejectOps(listId, failure.code, op.opId, generation);
      return 'next';
    }

    if (!this.isCurrent(generation)) return 'stop';
    this.fence(generation);
    // Only a task response exactly one revision later is known to be "our shadow
    // plus this op". A delete answers 204 without a revision and a replayed
    // receipt answers with the current revision, so both refresh the snapshot.
    const parsed = op.kind === 'delete' ? null : sharedTaskSchema.safeParse(response);
    const task = parsed?.success && parsed.data.revision === expected + 1 ? parsed.data : null;
    await this.settle(listId, op, expected, task, generation);
    return task ? 'next' : 'pull';
  }

  /** Drop a delivered op; fold its server result into the shadow when it is known. */
  private async settle(
    listId: string,
    op: SharedOpRecord,
    expected: number,
    applied: SharedTask | null,
    generation?: number,
  ): Promise<void> {
    if (generation !== undefined) this.fence(generation);
    const syncedAt = this.now();
    await this.store.transact(async (tx) => {
      await tx.deleteOp(op.opId);
      const record = await tx.getList(listId);
      if (!record) return;
      let next = record;
      if (applied && record.snapshot && record.revision === expected) {
        const tasks = record.snapshot.tasks.slice();
        const index = tasks.findIndex((task) => task.id === op.taskId);
        if (index >= 0) tasks[index] = applied;
        else tasks.push(applied);
        next = {
          ...record,
          revision: applied.revision,
          summary: {
            ...record.summary,
            revision: Math.max(record.summary.revision, applied.revision),
          },
          snapshot: { ...record.snapshot, tasks },
          syncedAt,
          error: null,
        };
        await tx.putList(next);
      }
      await applyRebase(tx, next);
    });
    this.emit();
  }

  private async enqueue(listId: string, build: (tx: SharedTx) => Promise<OpDraft>): Promise<void> {
    const session = this.sessionNow();
    await this.ensureStoreOwner();
    await this.store.transact(async (tx) => {
      const record = await tx.getList(listId);
      if (!record || !isEditable(record)) throw new Error('这个共享清单当前只读，无法编辑');
      const draft = await build(tx);
      const seq = Number((await tx.getMeta(SEQ_KEY)) ?? '0') + 1;
      await tx.setMeta(SEQ_KEY, String(seq));
      await tx.putOp({
        ...draft,
        opId: this.newId(),
        listId,
        seq,
        status: 'pending',
        errorCode: null,
        createdAt: this.now(),
      });
      await applyRebase(tx, record);
    });
    if (this.options.session) {
      const now = this.sessionNow();
      if (!session || !now || now.token !== session.token) return;
    }
    this.emit();
    if (this.active) void this.sync({ index: false });
  }

  async createTask(listId: string, input: NewSharedTask): Promise<string> {
    const title = cleanSingleLine(input.title);
    if (!title) throw new Error('任务标题不能为空');
    const dueOn = input.due_on ?? null;
    if (dueOn !== null && !isDateOnly(dueOn)) throw new Error('截止日期无效');
    const taskId = this.newId();
    const patch: SharedTaskPatch = {
      title,
      note: cleanNote(input.note ?? ''),
      important: input.important ?? false,
      due_on: dueOn,
    };
    await this.enqueue(listId, async () => ({ kind: 'create', taskId, patch, base: {} }));
    return taskId;
  }

  async updateTask(listId: string, taskId: string, patch: SharedTaskPatch): Promise<void> {
    const clean = normalizePatch(patch);
    if (Object.keys(clean).length === 0) return;
    await this.enqueue(listId, async (tx) => {
      const task = await tx.getTask(taskId);
      if (!task || task.list_id !== listId) throw new Error('任务不存在');
      return { kind: 'patch', taskId, patch: clean, base: pick(task, Object.keys(clean)) };
    });
  }

  async deleteTask(listId: string, taskId: string): Promise<void> {
    await this.enqueue(listId, async (tx) => {
      const task = await tx.getTask(taskId);
      if (!task || task.list_id !== listId) throw new Error('任务不存在');
      return { kind: 'delete', taskId, patch: {}, base: pick(task, TASK_FIELDS) };
    });
  }

  /** Drop a rejected (or still pending) local edit and show the server copy. */
  async discardOp(listId: string, opId: string): Promise<void> {
    await this.ensureStoreOwner();
    await this.store.transact(async (tx) => {
      await tx.deleteOp(opId);
      const record = await tx.getList(listId);
      if (record) await applyRebase(tx, record);
    });
    this.emit();
  }

  /** Re-apply an edit-conflict op on top of the current server values. */
  async retryOp(listId: string, opId: string): Promise<void> {
    await this.ensureStoreOwner();
    await this.store.transact(async (tx) => {
      const record = await tx.getList(listId);
      if (!record || !isEditable(record)) throw new Error('这个共享清单当前只读，无法编辑');
      const op = (await tx.ops(listId)).find((item) => item.opId === opId);
      if (!op || op.status !== 'rejected' || op.errorCode !== 'SHARED_EDIT_CONFLICT') {
        throw new Error('这项修改无法重试');
      }
      const task = await tx.getTask(op.taskId);
      if (!task) throw new Error('任务已不存在');
      const seq = Number((await tx.getMeta(SEQ_KEY)) ?? '0') + 1;
      await tx.setMeta(SEQ_KEY, String(seq));
      await tx.putOp({
        ...op,
        seq,
        base: pick(task, Object.keys(op.base)),
        status: 'pending',
        errorCode: null,
      });
      await applyRebase(tx, record);
    });
    this.emit();
    if (this.active) void this.sync({ index: false });
  }

  /**
   * Gate a user-initiated shared action on the current account. Returns the
   * session to re-check after the network round trip.
   */
  private async beginAction(): Promise<SharedSession | null> {
    if (!this.options.session) return null;
    const session = this.sessionNow();
    if (!session) throw new Error('请先登录云端账号再使用共享清单');
    await this.ensureStoreOwner();
    return session;
  }

  /** Remove the local read-only copy of a list we no longer have access to. */
  async removeLocalCopy(listId: string): Promise<void> {
    await this.ensureStoreOwner();
    await this.store.transact(async (tx) => {
      const record = await tx.getList(listId);
      if (record?.access === 'active') throw new Error('仍是成员的清单不能只删除本机副本');
      await tx.deleteList(listId);
    });
    this.emit();
  }

  async createList(name: string): Promise<string> {
    const clean = cleanSingleLine(name, 120);
    if (!clean) throw new Error('清单名称不能为空');
    const session = await this.beginAction();
    const summary = sharedListSummarySchema.parse(
      await this.options.request<unknown>('/lists', {
        method: 'POST',
        body: JSON.stringify({ name: clean, op_id: this.newId() }),
      }),
    );
    this.assertSameSession(session);
    await this.store.transact((tx) => tx.putList(emptyRecord(summary)));
    this.emit();
    await this.pull(summary.id).catch(() => false);
    return summary.id;
  }

  private async dropInvitation(invitationId: string): Promise<void> {
    await this.store.transact(async (tx) => {
      const remaining = parseInvitations(await tx.getMeta(INVITATIONS_KEY)).filter(
        (invitation) => invitation.id !== invitationId,
      );
      await tx.setMeta(INVITATIONS_KEY, JSON.stringify(remaining));
    });
    this.emit();
  }

  private async answerInvitation(invitationId: string, action: 'accept' | 'decline') {
    try {
      return await this.options.request<unknown>(
        `/invitations/${encodeURIComponent(invitationId)}/${action}`,
        { method: 'POST', body: JSON.stringify({ op_id: this.newId() }) },
      );
    } catch (error) {
      if (
        error instanceof SyncHttpError &&
        (error.code === 'SHARED_INVITATION_NOT_FOUND' ||
          error.code === 'SHARED_INVITATION_NOT_PENDING')
      ) {
        await this.dropInvitation(invitationId);
      }
      throw error;
    }
  }

  async acceptInvitation(invitationId: string): Promise<string> {
    const session = await this.beginAction();
    const summary = sharedListSummarySchema.parse(
      await this.answerInvitation(invitationId, 'accept'),
    );
    this.assertSameSession(session);
    await this.dropInvitation(invitationId);
    await this.store.transact(async (tx) => {
      const existing = await tx.getList(summary.id);
      await tx.putList(
        existing ? { ...existing, summary, access: 'active' } : emptyRecord(summary),
      );
    });
    this.emit();
    await this.pull(summary.id).catch(() => false);
    return summary.id;
  }

  async declineInvitation(invitationId: string): Promise<void> {
    const session = await this.beginAction();
    await this.answerInvitation(invitationId, 'decline');
    this.assertSameSession(session);
    await this.dropInvitation(invitationId);
  }

  async invite(listId: string, email: string, role: SharedInviteRole): Promise<SharedInvitation> {
    const address = email.trim().toLowerCase();
    if (!EMAIL.test(address)) throw new Error('请输入有效的邮箱地址');
    const session = await this.beginAction();
    const opId = this.newId();
    for (let attempt = 0; ; attempt += 1) {
      let record = await this.readList(listId);
      if (record?.access === 'active' && !record.snapshot) {
        await this.pull(listId);
        record = await this.readList(listId);
      }
      if (!record || record.access !== 'active' || record.summary.role !== 'owner') {
        throw new Error('只有所有者可以邀请成员');
      }
      try {
        const invitation = sharedInvitationSchema.parse(
          await this.options.request<unknown>(`/lists/${encodeURIComponent(listId)}/members`, {
            method: 'POST',
            headers: { 'If-Match': `"${record.revision}"` },
            body: JSON.stringify({ email: address, role, op_id: opId }),
          }),
        );
        this.assertSameSession(session);
        await this.pull(listId).catch(() => false);
        return invitation;
      } catch (error) {
        this.assertSameSession(session);
        if (attempt === 0 && error instanceof SyncHttpError && error.code === 'REVISION_CONFLICT') {
          await this.pull(listId);
          continue;
        }
        throw error;
      }
    }
  }

  async read(): Promise<SharedViewState> {
    // Never render a store that belongs to another account. The owner is the
    // engine's verified run identity when it has one, otherwise the signed-in
    // session's account; nothing here writes or clears data.
    const allowed = await this.isStoreReadable();
    if (!allowed) return { lists: [], invitations: [] };
    return this.store.transact(async (tx) => {
      const lists: SharedListView[] = [];
      for (const record of await tx.allLists()) {
        const tasks = await tx.tasks(record.id);
        const ops = await tx.ops(record.id);
        lists.push({
          record,
          tasks,
          pending: ops.filter((op) => op.status === 'pending').length,
          rejected: ops.filter((op) => op.status === 'rejected'),
          editable: isEditable(record),
        });
      }
      lists.sort(
        (a, b) =>
          a.record.summary.created_at.localeCompare(b.record.summary.created_at) ||
          a.record.id.localeCompare(b.record.id),
      );
      return { lists, invitations: parseInvitations(await tx.getMeta(INVITATIONS_KEY)) };
    });
  }

  /**
   * Local shared data is only readable while its binding matches the signed-in
   * account. With no session (signed out) the last copy stays visible only
   * while the same personal data space is still bound to the account that owns
   * it, so signing out keeps offline edits readable but switching to another
   * account never shows them.
   */
  private async isStoreReadable(): Promise<boolean> {
    if (!this.store.boundAccount) return true;
    const bound = await this.store.boundAccount();
    if (!bound) return true;
    const session = this.sessionNow();
    if (session) return sameSharedAccount(session.account, bound);
    const hint = (await this.options.ownerHint?.())?.trim().toLowerCase() ?? '';
    return hint !== '' && hint === bound.email;
  }
}
