import type { SyncEntityType, SyncOperation, SyncOperationType, SyncStatus } from './index';

// ============================================================================
// Sync Queue Manager
// Manages the offline sync queue stored in IndexedDB.
// When in remote mode, local mutations are queued for background sync.
// ============================================================================

const MAX_RETRIES = 5;
const RETRY_DELAYS = [1000, 2000, 4000, 8000, 16000]; // ms, exponential backoff

export interface SyncQueueListener {
  onQueueChange: (pending: number) => void;
  onSyncStart: () => void;
  onSyncComplete: (success: number, failed: number) => void;
  onOnlineStatusChange: (online: boolean) => void;
}

export class SyncQueueManager {
  private listeners: Set<SyncQueueListener> = new Set();
  private isProcessing = false;
  private isOnline = typeof navigator !== 'undefined' ? navigator.onLine : true;
  private syncTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimers: Map<number, ReturnType<typeof setTimeout>> = new Map();
  private apiBaseUrl: string | null = null;
  private getToken: (() => string | null) | null = null;
  private db: DexieType | null = null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private syncQueueTable: any = null;

  constructor() {
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => this.handleOnline(true));
      window.addEventListener('offline', () => this.handleOnline(false));
    }
  }

  // -------------------------------------------------------------------------
  // Setup — called after Dexie DB is ready
  // -------------------------------------------------------------------------

  initialize(db: DexieType) {
    this.db = db;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.syncQueueTable = (db as any).syncQueue;
    if (this.syncQueueTable) {
      this.syncQueueTable.owner = this;
    }
  }

  setApiConfig(baseUrl: string, getToken: () => string | null) {
    this.apiBaseUrl = baseUrl;
    this.getToken = getToken;
  }

  // -------------------------------------------------------------------------
  // Queue Operations
  // -------------------------------------------------------------------------

  async enqueue(
    entityType: SyncEntityType,
    entityId: string,
    operation: SyncOperationType,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    payload: Record<string, any>,
  ): Promise<void> {
    if (!this.syncQueueTable) return;

    const op: SyncOperation = {
      entityType,
      entityId,
      operation,
      payload,
      createdAt: new Date().toISOString(),
      retryCount: 0,
      status: 'pending',
    };

    await this.syncQueueTable.add(op);
    this.notifyQueueChange();
    this.scheduleSync();
  }

  async dequeue(id: number): Promise<void> {
    if (!this.syncQueueTable) return;
    await this.syncQueueTable.delete(id);
    this.notifyQueueChange();
  }

  async updateStatus(id: number, status: SyncStatus, retryCount?: number): Promise<void> {
    if (!this.syncQueueTable) return;
    await this.syncQueueTable.update(id, { status, retryCount });
    this.notifyQueueChange();
  }

  async getPending(): Promise<SyncOperation[]> {
    if (!this.syncQueueTable) return [];
    return this.syncQueueTable.where('status').equals('pending').sortBy('createdAt');
  }

  async getFailed(): Promise<SyncOperation[]> {
    if (!this.syncQueueTable) return [];
    return this.syncQueueTable.where('status').equals('failed').toArray();
  }

  async getQueueSize(): Promise<number> {
    if (!this.syncQueueTable) return 0;
    return this.syncQueueTable.count();
  }

  async clearQueue(): Promise<void> {
    if (!this.syncQueueTable) return;
    await this.syncQueueTable.clear();
    this.notifyQueueChange();
  }

  async retryFailed(): Promise<void> {
    if (!this.syncQueueTable) return;
    const failed = await this.syncQueueTable.where('status').equals('failed').toArray();
    for (const op of failed) {
      await this.syncQueueTable.update(op.id, { status: 'pending', retryCount: 0 });
    }
    this.notifyQueueChange();
    this.scheduleSync();
  }

  // -------------------------------------------------------------------------
  // Sync Processing
  // -------------------------------------------------------------------------

  async processQueue(): Promise<void> {
    if (this.isProcessing || !this.isOnline || !this.apiBaseUrl || !this.getToken) return;

    this.isProcessing = true;
    this.notifySyncStart();

    let success = 0;
    let failed = 0;

    try {
      const pending = await this.getPending();

      for (const op of pending) {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (!this.isOnline) break;

        try {
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          await this.updateStatus(op.id!, 'syncing');
          await this.executeOp(op);
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          await this.dequeue(op.id!);
          success++;
        } catch {
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
          const newRetry = (op.retryCount ?? 0) + 1;
          if (newRetry >= MAX_RETRIES) {
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            await this.updateStatus(op.id!, 'failed', newRetry);
            failed++;
          } else {
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            await this.updateStatus(op.id!, 'pending', newRetry);
            const delay = RETRY_DELAYS[Math.min(newRetry - 1, RETRY_DELAYS.length - 1)];
            const timer = setTimeout(() => {
              this.scheduleSync();
              // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
              this.retryTimers.delete(op.id!);
            }, delay);
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            this.retryTimers.set(op.id!, timer);
          }
        }
      }
    } finally {
      this.isProcessing = false;
      this.notifySyncComplete(success, failed);
      this.notifyQueueChange();
    }
  }

  private async executeOp(op: SyncOperation): Promise<void> {
    const token = this.getToken?.();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const endpoint = this.getEndpoint(op);
    const method = this.getMethod(op.operation);
    const url = `${this.apiBaseUrl}${endpoint}`;

    const response = await fetch(url, {
      method,
      headers,
      body: method !== 'DELETE' ? JSON.stringify(op.payload) : undefined,
    });

    if (!response.ok) {
      throw new Error(`Sync failed: ${response.status} ${response.statusText}`);
    }
  }

  private getEndpoint(op: SyncOperation): string {
    switch (op.entityType) {
      case 'task':
        if (op.operation === 'delete') return `/tasks/${op.entityId}`;
        if (op.operation === 'create') return '/tasks';
        return `/tasks/${op.entityId}`;
      case 'list':
        if (op.operation === 'delete') return `/lists/${op.entityId}`;
        if (op.operation === 'create') return '/lists';
        return `/lists/${op.entityId}`;
      case 'step':
        if (op.operation === 'update') return `/tasks/steps/${op.entityId}`;
        if (op.operation === 'delete') return `/tasks/steps/${op.entityId}`;
        return `/tasks/${op.payload.taskId as string}/steps`;
      case 'tag':
        if (op.operation === 'delete') return `/tags/${op.entityId}`;
        if (op.operation === 'create') return '/tags';
        return `/tags/${op.entityId}`;
      default:
        return `/tasks/${op.entityId}`;
    }
  }

  private getMethod(operation: SyncOperationType): string {
    switch (operation) {
      case 'create':
        return 'POST';
      case 'update':
        return 'PATCH';
      case 'delete':
        return 'DELETE';
      default:
        return 'PATCH';
    }
  }

  // -------------------------------------------------------------------------
  // Scheduling
  // -------------------------------------------------------------------------

  private scheduleSync(immediate = false): void {
    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
      this.syncTimer = null;
    }

    const delay = immediate ? 0 : 500; // debounce
    this.syncTimer = setTimeout(() => {
      this.processQueue();
    }, delay);
  }

  private handleOnline(online: boolean): void {
    this.isOnline = online;
    this.notifyOnlineStatusChange(online);
    if (online) {
      this.scheduleSync(true);
    }
  }

  // -------------------------------------------------------------------------
  // Listeners
  // -------------------------------------------------------------------------

  addListener(listener: SyncQueueListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notifyQueueChange(): void {
    this.getQueueSize().then((size) => {
      this.listeners.forEach((l) => l.onQueueChange(size));
    });
  }

  private notifySyncStart(): void {
    this.listeners.forEach((l) => l.onSyncStart());
  }

  private notifySyncComplete(success: number, failed: number): void {
    this.listeners.forEach((l) => l.onSyncComplete(success, failed));
  }

  private notifyOnlineStatusChange(online: boolean): void {
    this.listeners.forEach((l) => l.onOnlineStatusChange(online));
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  destroy(): void {
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', () => this.handleOnline(true));
      window.removeEventListener('offline', () => this.handleOnline(false));
    }
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.retryTimers.forEach((t) => clearTimeout(t));
    this.retryTimers.clear();
    this.listeners.clear();
  }
}

// Minimal Dexie type for initialization
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DexieType = { syncQueue: any };

// Singleton instance
export const syncQueue = new SyncQueueManager();
