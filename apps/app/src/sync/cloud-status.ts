import type { SyncState, SyncStatus } from '@todo/sync';

export interface CloudSyncPreviousState {
  lastSyncedAt: string | null;
  error: string | null;
}

export interface CloudSyncOutcome {
  syncStatus: SyncStatus;
  lastSyncedAt: string | null;
  error: string | null;
}

/** Keep the controller state aligned with the engine's protocol-level result. */
export function resolveCloudSyncOutcome(
  result: SyncState,
  rejected: number,
  previous: CloudSyncPreviousState,
): CloudSyncOutcome {
  const lastSyncedAt = result.lastSyncedAt ?? previous.lastSyncedAt;
  const rejectionError =
    rejected > 0 ? `有 ${rejected} 个本地修改被服务器拒绝，请查看并清除失败操作。` : null;

  if (result.status === 'synced' && result.pendingCount === 0 && rejected === 0) {
    return { syncStatus: 'synced', lastSyncedAt, error: null };
  }

  if (result.status === 'auth-required') {
    return {
      syncStatus: 'auth-required',
      lastSyncedAt,
      error: result.lastError ?? '登录已过期，请重新验证邮箱。',
    };
  }

  if (result.status === 'offline') {
    return {
      syncStatus: 'offline',
      lastSyncedAt,
      error: result.lastError ?? '当前离线，修改已保存在本机。',
    };
  }

  if (result.status === 'error') {
    return {
      syncStatus: 'error',
      lastSyncedAt,
      error: result.lastError ?? previous.error ?? '同步失败',
    };
  }

  if (rejected > 0) {
    return { syncStatus: 'error', lastSyncedAt, error: rejectionError };
  }

  if (result.pendingCount > 0) {
    return {
      syncStatus: 'syncing',
      lastSyncedAt,
      error: result.lastError ?? '仍有待同步操作',
    };
  }

  return {
    syncStatus: result.status === 'synced' ? 'error' : result.status,
    lastSyncedAt,
    error: result.lastError ?? previous.error,
  };
}
