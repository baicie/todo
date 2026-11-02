import type { Dexie, EntityTable } from 'dexie';
import type {
  SharedInvitation,
  SharedListSummary,
  SharedMember,
  SharedStep,
  SharedTask,
} from '@todo/contracts';

/**
 * Local storage for shared lists. Shared entities live in their own tables and
 * never touch the personal `tasks/lists/mutations` tables or the personal sync
 * outbox, so personal and shared history cannot collide.
 */

/** `revoked`: the member was removed; `deleted`: the owner deleted the list. */
export type SharedAccess = 'active' | 'revoked' | 'deleted';

/** The verified cloud identity a shared-data space belongs to. */
export interface SharedAccountIdentity {
  email: string;
  apiUrl: string;
}

/** `sharedMeta` key holding the account that owns the local shared data. */
export const SHARED_BINDING_KEY = 'accountBinding';

export function normalizeSharedIdentity(identity: SharedAccountIdentity): SharedAccountIdentity {
  return {
    email: identity.email.trim().toLowerCase(),
    apiUrl: identity.apiUrl.trim().replace(/\/+$/, '').toLowerCase(),
  };
}

export function sameSharedAccount(a: SharedAccountIdentity, b: SharedAccountIdentity): boolean {
  const left = normalizeSharedIdentity(a);
  const right = normalizeSharedIdentity(b);
  return left.email === right.email && left.apiUrl === right.apiUrl;
}

export interface SharedListRecord {
  id: string;
  summary: SharedListSummary;
  /** Last server snapshot ("shadow"); null until the first pull. */
  snapshot: {
    members: SharedMember[];
    invitations: SharedInvitation[];
    tasks: SharedTask[];
    steps: SharedStep[];
  } | null;
  /** List revision of `snapshot`; 0 before the first pull. */
  revision: number;
  access: SharedAccess;
  syncedAt: string | null;
  error: string | null;
}

export interface SharedTaskRecord extends SharedTask {
  /** Server order of the shadow, local creations appended. */
  position: number;
  /** True while a local edit of this task waits in the outbox. */
  pending: boolean;
}

export type SharedTaskField = 'title' | 'note' | 'status' | 'important' | 'due_on';
export type SharedTaskPatch = Partial<Pick<SharedTask, SharedTaskField>>;

export interface SharedOpRecord {
  opId: string;
  listId: string;
  seq: number;
  kind: 'create' | 'patch' | 'delete';
  taskId: string;
  patch: SharedTaskPatch;
  /** Field values the edit was made against, used to detect same-field conflicts. */
  base: SharedTaskPatch;
  status: 'pending' | 'rejected';
  errorCode: string | null;
  createdAt: string;
}

export interface SharedMetaRow {
  key: string;
  value: string;
}

/** Operations available inside one atomic store transaction. */
export interface SharedTx {
  getMeta(key: string): Promise<string | undefined>;
  setMeta(key: string, value: string): Promise<void>;
  getList(id: string): Promise<SharedListRecord | undefined>;
  allLists(): Promise<SharedListRecord[]>;
  putList(record: SharedListRecord): Promise<void>;
  /** Removes the list together with its materialized tasks and outbox. */
  deleteList(id: string): Promise<void>;
  /** Materialized tasks ordered by `position`. */
  tasks(listId: string): Promise<SharedTaskRecord[]>;
  getTask(id: string): Promise<SharedTaskRecord | undefined>;
  putTask(row: SharedTaskRecord): Promise<void>;
  deleteTask(id: string): Promise<void>;
  replaceTasks(listId: string, rows: SharedTaskRecord[]): Promise<void>;
  /** Outbox rows of every status, ordered by `seq`. */
  ops(listId: string): Promise<SharedOpRecord[]>;
  putOp(op: SharedOpRecord): Promise<void>;
  deleteOp(opId: string): Promise<void>;
}

export interface SharedStore {
  /** Runs `fn` atomically. `fn` must not await network or timers. */
  transact<T>(fn: (tx: SharedTx) => Promise<T>): Promise<T>;
  clear(): Promise<void>;
  /** The account this space belongs to, or null while nothing is queued. */
  boundAccount?(): Promise<SharedAccountIdentity | null>;
  /**
   * Claim an unbound space for `identity`, or confirm it already belongs to it.
   * Returns false when another account owns the data; nothing is erased.
   * `ownerHint` is the personal `boundAccount` of the same data space, used
   * only to adopt shared data written before bindings existed.
   */
  bindAccount?(identity: SharedAccountIdentity, ownerHint?: string | null): Promise<boolean>;
}

export const SHARED_DB_STORES = {
  sharedLists: 'id',
  sharedTasks: 'id, list_id',
  sharedOutbox: 'opId, listId, [listId+seq], status',
  sharedMeta: 'key',
} as const;

export interface SharedTables {
  sharedLists: EntityTable<SharedListRecord, 'id'>;
  sharedTasks: EntityTable<SharedTaskRecord, 'id'>;
  sharedOutbox: EntityTable<SharedOpRecord, 'opId'>;
  sharedMeta: EntityTable<SharedMetaRow, 'key'>;
}

const byPosition = (a: SharedTaskRecord, b: SharedTaskRecord) => a.position - b.position;

function parseBinding(raw: string | undefined): SharedAccountIdentity | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<SharedAccountIdentity>;
    if (typeof parsed.email !== 'string' || typeof parsed.apiUrl !== 'string') return null;
    if (!parsed.email.trim() || !parsed.apiUrl.trim()) return null;
    return normalizeSharedIdentity({ email: parsed.email, apiUrl: parsed.apiUrl });
  } catch {
    return null;
  }
}

/**
 * Claim or confirm the shared space inside one transaction.
 *
 * The space holds one account's shadow and outbox. Handing it to a different
 * account would replay A's queued ops with B's token and show A's lists to B,
 * so a mismatching binding is refused instead of overwritten. A space with no
 * lists holds nothing to protect and is claimed by the signed-in account. Data
 * written before bindings existed is adopted only when the personal data space
 * is already bound to the same email — shared data can only have been created
 * through a cloud login, which is what sets that personal binding.
 */
async function claimBinding(
  tx: SharedTx,
  identity: SharedAccountIdentity,
  ownerHint?: string | null,
): Promise<boolean> {
  const next = normalizeSharedIdentity(identity);
  const bound = parseBinding(await tx.getMeta(SHARED_BINDING_KEY));
  if (bound) return sameSharedAccount(bound, next);
  if ((await tx.allLists()).length > 0) {
    const hint = ownerHint?.trim().toLowerCase() ?? '';
    if (!hint || hint !== next.email) return false;
  }
  await tx.setMeta(SHARED_BINDING_KEY, JSON.stringify({ email: next.email, apiUrl: next.apiUrl }));
  return true;
}

export class DexieSharedStore implements SharedStore {
  constructor(private readonly db: Dexie & SharedTables) {}

  private tables() {
    return [this.db.sharedLists, this.db.sharedTasks, this.db.sharedOutbox, this.db.sharedMeta];
  }

  private readonly tx: SharedTx = {
    getMeta: async (key) => (await this.db.sharedMeta.get(key))?.value,
    setMeta: async (key, value) => {
      await this.db.sharedMeta.put({ key, value });
    },
    getList: (id) => this.db.sharedLists.get(id),
    allLists: () => this.db.sharedLists.toArray(),
    putList: async (record) => {
      await this.db.sharedLists.put(record);
    },
    deleteList: async (id) => {
      await this.db.sharedLists.delete(id);
      await this.db.sharedTasks.where('list_id').equals(id).delete();
      await this.db.sharedOutbox.where('listId').equals(id).delete();
    },
    tasks: async (listId) =>
      (await this.db.sharedTasks.where('list_id').equals(listId).toArray()).sort(byPosition),
    getTask: (id) => this.db.sharedTasks.get(id),
    putTask: async (row) => {
      await this.db.sharedTasks.put(row);
    },
    deleteTask: async (id) => {
      await this.db.sharedTasks.delete(id);
    },
    replaceTasks: async (listId, rows) => {
      await this.db.sharedTasks.where('list_id').equals(listId).delete();
      await this.db.sharedTasks.bulkPut(rows);
    },
    ops: (listId) =>
      this.db.sharedOutbox
        .where('[listId+seq]')
        .between([listId, -Infinity], [listId, Infinity])
        .toArray(),
    putOp: async (op) => {
      await this.db.sharedOutbox.put(op);
    },
    deleteOp: async (opId) => {
      await this.db.sharedOutbox.delete(opId);
    },
  };

  transact<T>(fn: (tx: SharedTx) => Promise<T>): Promise<T> {
    return this.db.transaction('rw', this.tables(), () => fn(this.tx));
  }

  async boundAccount(): Promise<SharedAccountIdentity | null> {
    return this.transact(async (tx) => parseBinding(await tx.getMeta(SHARED_BINDING_KEY)));
  }

  bindAccount(identity: SharedAccountIdentity, ownerHint?: string | null): Promise<boolean> {
    return this.transact((tx) => claimBinding(tx, identity, ownerHint));
  }

  async clear(): Promise<void> {
    await this.db.transaction('rw', this.tables(), async () => {
      await Promise.all(this.tables().map((table) => table.clear()));
    });
  }
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/**
 * Process-local store used by the native shell. Native keeps shared lists
 * online-only: nothing is persisted into the webview's IndexedDB, which is not
 * isolated per native account.
 */
export class MemorySharedStore implements SharedStore {
  private readonly meta = new Map<string, string>();
  private readonly lists = new Map<string, SharedListRecord>();
  private readonly taskRows = new Map<string, SharedTaskRecord>();
  private readonly outbox = new Map<string, SharedOpRecord>();
  private lock: Promise<unknown> = Promise.resolve();

  private readonly tx: SharedTx = {
    getMeta: async (key) => this.meta.get(key),
    setMeta: async (key, value) => {
      this.meta.set(key, value);
    },
    getList: async (id) => {
      const record = this.lists.get(id);
      return record ? clone(record) : undefined;
    },
    allLists: async () => [...this.lists.values()].map(clone),
    putList: async (record) => {
      this.lists.set(record.id, clone(record));
    },
    deleteList: async (id) => {
      this.lists.delete(id);
      for (const [key, row] of this.taskRows) if (row.list_id === id) this.taskRows.delete(key);
      for (const [key, op] of this.outbox) if (op.listId === id) this.outbox.delete(key);
    },
    tasks: async (listId) =>
      [...this.taskRows.values()]
        .filter((row) => row.list_id === listId)
        .map(clone)
        .sort(byPosition),
    getTask: async (id) => {
      const row = this.taskRows.get(id);
      return row ? clone(row) : undefined;
    },
    putTask: async (row) => {
      this.taskRows.set(row.id, clone(row));
    },
    deleteTask: async (id) => {
      this.taskRows.delete(id);
    },
    replaceTasks: async (listId, rows) => {
      for (const [key, row] of this.taskRows) if (row.list_id === listId) this.taskRows.delete(key);
      for (const row of rows) this.taskRows.set(row.id, clone(row));
    },
    ops: async (listId) =>
      [...this.outbox.values()]
        .filter((op) => op.listId === listId)
        .map(clone)
        .sort((a, b) => a.seq - b.seq),
    putOp: async (op) => {
      this.outbox.set(op.opId, clone(op));
    },
    deleteOp: async (opId) => {
      this.outbox.delete(opId);
    },
  };

  transact<T>(fn: (tx: SharedTx) => Promise<T>): Promise<T> {
    const run = this.lock.then(() => fn(this.tx));
    this.lock = run.catch(() => undefined);
    return run;
  }

  boundAccount(): Promise<SharedAccountIdentity | null> {
    return this.transact(async (tx) => parseBinding(await tx.getMeta(SHARED_BINDING_KEY)));
  }

  bindAccount(identity: SharedAccountIdentity, ownerHint?: string | null): Promise<boolean> {
    return this.transact((tx) => claimBinding(tx, identity, ownerHint));
  }

  clear(): Promise<void> {
    return this.transact(async () => {
      this.meta.clear();
      this.lists.clear();
      this.taskRows.clear();
      this.outbox.clear();
    });
  }
}
