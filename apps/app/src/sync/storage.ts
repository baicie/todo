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
  syncApplyResult(result: { acks: Ack[]; changes: Change[]; nextCursor: string }): Promise<void>;
  syncInitializeCloud(
    snapshot: CloudSnapshot,
    mode: CloudMergeMode,
    accountEmail: string,
  ): Promise<CloudInitializeResult>;
  syncReplaceSnapshot(snapshot: CloudSnapshot): Promise<void>;
  syncSetEnabled(enabled: boolean): Promise<void>;
  syncClearRejected(): Promise<void>;
  syncMarkBootstrapRequired(): Promise<void>;
  syncClearAccountBinding(): Promise<void>;
  syncGetDiagnostics(): Promise<CloudDiagnostics>;
}
