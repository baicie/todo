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

  clear(): Promise<void> {
    return this.transact(async () => {
      this.meta.clear();
      this.lists.clear();
      this.taskRows.clear();
      this.outbox.clear();
    });
  }
}
