import type { Ack, BootstrapPage, Change, SyncRequest, SyncResponse } from '@todo/contracts';

export type SyncStatus = 'idle' | 'syncing' | 'offline' | 'error' | 'auth-required' | 'synced';

export interface SyncState {
  status: SyncStatus;
  pendingCount: number;
  lastSyncedAt: string | null;
  lastError: string | null;
  needsBootstrap: boolean;
}

export interface StoredMutation {
  opId: string;
  deviceId: string;
  clientSeq: number;
  entity: 'task' | 'list' | 'step' | 'day_plan';
  entityId: string;
  kind: 'create' | 'patch' | 'delete' | 'restore';
  patch: Record<string, unknown>;
}

export interface SyncStore {
  getDeviceId(): Promise<string>;
  getCursor(): Promise<string>;
  getPendingMutations(limit: number): Promise<StoredMutation[]>;
  getPendingCount(): Promise<number>;
  /**
   * Persist shadow changes, acknowledgements, cursor and reproject affected
   * entities in one local transaction. Implementations must not clear an
   * unacknowledged mutation.
   */
  applyServerResult(result: { acks: Ack[]; changes: Change[]; nextCursor: string }): Promise<void>;
  replaceFromBootstrap(page: BootstrapPage): Promise<void>;
  markBootstrapRequired(): Promise<void>;
}

export interface SyncTransport {
  sync(batch: SyncRequest): Promise<SyncResponse>;
  bootstrap(cursor?: string): Promise<BootstrapPage>;
}

export class SyncHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SyncHttpError';
  }
}

export class SyncEngine {
  private inFlight: Promise<SyncState> | null = null;
  private state: SyncState = {
    status: 'idle',
    pendingCount: 0,
    lastSyncedAt: null,
    lastError: null,
    needsBootstrap: false,
  };

  constructor(
    private readonly transport: SyncTransport,
    private readonly store: SyncStore,
    private readonly onState: (state: SyncState) => void = () => {},
    private readonly batchSize = 100,
  ) {}

  getState(): SyncState {
    return { ...this.state };
  }

  async syncNow(): Promise<SyncState> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.run().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async run(): Promise<SyncState> {
    this.setState({ status: 'syncing', lastError: null });
    try {
      const deviceId = await this.store.getDeviceId();
      const pending = await this.store.getPendingMutations(this.batchSize);
      const cursor = await this.store.getCursor();
      const response = await this.transport.sync({
        device_id: deviceId,
        cursor,
        ops: pending.map((operation) => ({
          op_id: operation.opId,
          client_seq: operation.clientSeq,
          entity: operation.entity,
          entity_id: operation.entityId,
          kind: operation.kind,
          patch: operation.patch,
        })),
        limit: this.batchSize,
      });

      const rejectedAcks = response.ack.filter((ack) => ack.status === 'rejected');
      if (rejectedAcks.length > 0) {
        this.setState({
          lastError: `有 ${rejectedAcks.length} 个操作被服务器拒绝：${rejectedAcks
            .map((ack) => ack.error_code)
            .filter(Boolean)
            .join(', ')}`,
        });
      }

      await this.store.applyServerResult({
        acks: response.ack,
        changes: response.changes,
        nextCursor: response.next_cursor,
      });

      const pendingCount = await this.store.getPendingCount();
      const hasRejected = rejectedAcks.length > 0;
      const nextState: SyncState = {
        status: hasRejected
          ? 'error'
          : pendingCount > 0 || response.has_more
            ? 'syncing'
            : 'synced',
        pendingCount,
        lastSyncedAt: response.server_time,
        lastError: hasRejected ? this.state.lastError : null,
        needsBootstrap: false,
      };
      this.setState(nextState);
      if (pendingCount > 0 || response.has_more) {
        return this.run();
      }
      return this.getState();
    } catch (error) {
      if (error instanceof SyncHttpError && error.code === 'CURSOR_EXPIRED') {
        try {
          await this.store.markBootstrapRequired();
          let page = await this.transport.bootstrap();
          const entities = [...page.entities];
          let guard = 0;
          while (page.has_more && page.next_page && guard < 10_000) {
            page = await this.transport.bootstrap(page.next_page);
            entities.push(...page.entities);
            guard += 1;
          }
          await this.store.replaceFromBootstrap({
            ...page,
            entities,
            next_page: null,
            has_more: false,
          });
          this.setState({
            status: 'idle',
            pendingCount: await this.store.getPendingCount(),
            lastError: null,
            needsBootstrap: false,
          });
          // A rebase keeps unacknowledged local mutations in the outbox.
          return this.run();
        } catch (bootstrapError) {
          return this.fail(bootstrapError);
        }
      }
      if (error instanceof SyncHttpError && error.status === 401) {
        this.setState({ status: 'auth-required', lastError: '登录已过期' });
        return this.getState();
      }
      if (
        !(error instanceof SyncHttpError) &&
        typeof navigator !== 'undefined' &&
        !navigator.onLine
      ) {
        this.setState({ status: 'offline', lastError: '当前离线，修改已保存在本机' });
        return this.getState();
      }
      return this.fail(error);
    }
  }

  private fail(error: unknown): SyncState {
    this.setState({
      status: 'error',
      lastError: error instanceof Error ? error.message : '同步失败',
    });
    return this.getState();
  }

  private setState(patch: Partial<SyncState>): void {
    this.state = { ...this.state, ...patch };
    this.onState(this.getState());
  }
}
