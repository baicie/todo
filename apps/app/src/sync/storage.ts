import type { Ack, Change } from '@todo/contracts';
import type { TaskRepository } from '@todo/application';
import type { StoredMutation } from '@todo/sync';
import type { CloudSnapshot } from './snapshot';

export type CloudMergeMode = 'merge' | 'cloud';

export interface CloudDiagnostics {
  enabled: boolean;
  deviceId: string;
  cursor: string;
  pending: number;
  rejected: number;
  boundAccount: string | null;
  boundApiUrl?: string | null;
}

export interface CloudInitializeResult {
  preparedOps: number;
}

export interface RejectedMutation {
  opId: string;
  entity: 'task' | 'list' | 'step' | 'day_plan';
  entityId: string;
  kind: 'create' | 'patch' | 'delete' | 'restore';
  patch: Record<string, unknown>;
  errorCode: string | null;
  createdAt: string | null;
}

/** Thrown inside the local DB transaction when a sync session was superseded. */
export class StaleSyncSessionError extends Error {
  readonly code = 'STALE_SYNC_SESSION';

  constructor() {
    super('同步会话已失效，已丢弃迟到的服务端响应');
    this.name = 'StaleSyncSessionError';
  }
}

/**
 * Storage operations required by the cloud sync controller. The concrete
 * implementation lives beside the local repository so shadow, cursor and
 * materialized rows can be changed in one transaction.
 */
export interface CloudSyncStorage extends TaskRepository {
  syncGetDeviceId(): Promise<string>;
  /** Rotate the sync identity before a fresh cloud sign-in. */
  syncRotateDevice(): Promise<string>;
  syncGetCursor(): Promise<string>;
  syncGetPending(limit: number): Promise<StoredMutation[]>;
  syncGetPendingCount(): Promise<number>;
  syncGetRejectedCount(): Promise<number>;
  /** Optional on platforms that cannot expand rejected operations yet. */
  syncListRejected?(limit: number): Promise<RejectedMutation[]>;
  syncDiscardRejected?(opId: string): Promise<void>;
  /** Binds subsequent server writes to this local session generation. */
  syncSetSession(sessionId: string): Promise<void>;
  syncClearSession(expectedToken: string | null): Promise<void>;
  syncApplyResult(
    result: { acks: Ack[]; changes: Change[]; nextCursor: string },
    sessionId?: string,
  ): Promise<void>;
  syncInitializeCloud(
    snapshot: CloudSnapshot,
    mode: CloudMergeMode,
    accountEmail: string,
    sessionId?: string,
    accountApiUrl?: string,
  ): Promise<CloudInitializeResult>;
  syncReplaceSnapshot(snapshot: CloudSnapshot, sessionId?: string): Promise<void>;
  syncSetEnabled(enabled: boolean): Promise<void>;
  syncClearRejected(): Promise<void>;
  syncMarkBootstrapRequired(): Promise<void>;
  syncClearAccountBinding(): Promise<void>;
  syncGetDiagnostics(): Promise<CloudDiagnostics>;
}
