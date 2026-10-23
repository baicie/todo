import { describe, expect, it } from 'vitest';
import { resolveCloudSyncOutcome } from './cloud-status';
import type { SyncState } from '@todo/sync';

const base: SyncState = {
  status: 'synced',
  pendingCount: 0,
  lastSyncedAt: '2026-10-22T08:00:00Z',
  lastError: null,
  needsBootstrap: false,
};

const previous = { lastSyncedAt: '2026-10-21T08:00:00Z', error: 'old error' };

describe('resolveCloudSyncOutcome', () => {
  it('marks a clean server response as synced and advances the server timestamp', () => {
    expect(resolveCloudSyncOutcome(base, 0, previous)).toEqual({
      syncStatus: 'synced',
      lastSyncedAt: '2026-10-22T08:00:00Z',
      error: null,
    });
  });

  it('never reports HTTP/network errors as synced and preserves the last success', () => {
    const result = resolveCloudSyncOutcome(
      { ...base, status: 'error', lastSyncedAt: null, lastError: 'HTTP 500' },
      0,
      previous,
    );
    expect(result.syncStatus).toBe('error');
    expect(result.error).toBe('HTTP 500');
    expect(result.lastSyncedAt).toBe(previous.lastSyncedAt);
  });

  it('reports offline without inventing a success timestamp', () => {
    const result = resolveCloudSyncOutcome(
      { ...base, status: 'offline', pendingCount: 2, lastSyncedAt: null, lastError: '当前离线' },
      0,
      previous,
    );
    expect(result).toEqual({
      syncStatus: 'offline',
      lastSyncedAt: previous.lastSyncedAt,
      error: '当前离线',
    });
  });

  it('reports auth-required separately from a generic error', () => {
    expect(
      resolveCloudSyncOutcome(
        { ...base, status: 'auth-required', lastSyncedAt: null, lastError: null },
        0,
        previous,
      ),
    ).toMatchObject({ syncStatus: 'auth-required', lastSyncedAt: previous.lastSyncedAt });
  });

  it('does not mark a response with pending operations as synced', () => {
    expect(
      resolveCloudSyncOutcome({ ...base, status: 'syncing', pendingCount: 3 }, 0, previous),
    ).toMatchObject({ syncStatus: 'syncing', lastSyncedAt: base.lastSyncedAt });
  });

  it('surfaces rejected operations instead of silently succeeding', () => {
    const result = resolveCloudSyncOutcome(base, 1, previous);
    expect(result.syncStatus).toBe('error');
    expect(result.error).toContain('1 个本地修改被服务器拒绝');
  });

  it('recovers from error to synced after a later clean response', () => {
    const failed = resolveCloudSyncOutcome(
      { ...base, status: 'error', lastSyncedAt: null, lastError: 'network' },
      0,
      previous,
    );
    expect(failed.syncStatus).toBe('error');
    const recovered = resolveCloudSyncOutcome(base, 0, failed);
    expect(recovered.syncStatus).toBe('synced');
    expect(recovered.lastSyncedAt).toBe(base.lastSyncedAt);
    expect(recovered.error).toBeNull();
  });
});
