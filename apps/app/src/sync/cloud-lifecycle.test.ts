import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppPlatform } from '../adapters/platform';
import { DexieTaskRepository } from '../adapters/web-repository';
import { createCloudController } from './cloud';

let databaseCounter = 0;

function fakePlatform(): AppPlatform {
  return {
    kind: 'web',
    repository: null as never,
    reminder: {} as never,
    secureTokenStore: {
      get: async () => null,
      set: async () => {},
      remove: async () => {},
    },
    lifecycle: {
      platform: 'web',
      timeZone: 'UTC',
      onResume: () => () => {},
      onOnline: () => () => {},
    },
    setBadge: async () => {},
  } as unknown as AppPlatform;
}

function tokenResponse(): Response {
  return new Response(
    JSON.stringify({ access_token: 'access-a', expires_in: 900, refresh_token: 'refresh-a' }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

function syncResponse(taskId: string): Response {
  const now = new Date().toISOString();
  return new Response(
    JSON.stringify({
      ack: [],
      changes: [
        {
          server_seq: 2,
          op_id: 'server-op',
          entity: 'task',
          entity_id: taskId,
          kind: 'create',
          patch: {
            title: 'late server task',
            note: '',
            status: 'open',
            important: false,
            due_on: null,
            remind_at: null,
            remind_timezone: null,
            rank: 'a0',
            created_at: now,
            updated_at: now,
            deleted_at: null,
          },
        },
      ],
      next_cursor: '2',
      has_more: false,
      server_time: '2026-10-23T00:00:00Z',
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

function emptySyncResponse(): Response {
  return new Response(
    JSON.stringify({
      ack: [],
      changes: [],
      next_cursor: '0',
      has_more: false,
      server_time: '2026-10-23T00:00:00Z',
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

function unauthorizedResponse(): Response {
  return new Response(JSON.stringify({ code: 'UNAUTHORIZED', message: 'expired' }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('cloud sync session lifecycle', () => {
  beforeEach(() => {
    databaseCounter += 1;
    localStorage.clear();
    localStorage.setItem(
      'shishi.cloud.config',
      JSON.stringify({
        apiUrl: 'http://test.local',
        email: 'a@example.com',
        enabled: true,
        lastSyncedAt: null,
      }),
    );
  });

  it('does not let a delayed sync response repopulate a database after signOut(clearLocal)', async () => {
    const repository = new DexieTaskRepository(`lifecycle-${databaseCounter}`);
    await repository.initialize();
    const platform = fakePlatform();
    (platform as AppPlatform).repository = repository;

    let resolveSync!: (response: Response) => void;
    let syncStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      syncStarted = resolve;
    });
    const delayedSync = new Promise<Response>((resolve) => {
      resolveSync = resolve;
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/auth/refresh')) return tokenResponse();
      if (url.includes('/auth/logout')) return new Response(null, { status: 204 });
      if (url.includes('/api/v1/sync')) {
        syncStarted();
        return delayedSync;
      }
      return new Response(JSON.stringify({ code: 'UNEXPECTED', message: url }), { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const cloud = createCloudController({ platform, repository });
    const initializing = cloud.initialize();
    await started;
    // The sync response is still in flight. Logout must not wait for it and
    // must fence the eventual response at the repository transaction.
    await cloud.signOut(true);
    resolveSync(syncResponse('late-task'));
    await initializing;
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(cloud.state().phase).toBe('disconnected');
    expect(cloud.state().syncStatus).toBe('idle');
    expect(await repository.getTask('late-task')).toBeNull();
    expect(await repository.syncGetPendingCount()).toBe(0);
    expect(await repository.syncGetCursor()).toBe('0');
    cloud.dispose();
    vi.unstubAllGlobals();
  });

  it('refreshes once after a 401 and reaches synced on the retry', async () => {
    const repository = new DexieTaskRepository(`lifecycle-refresh-${databaseCounter}`);
    await repository.initialize();
    const platform = fakePlatform();
    (platform as AppPlatform).repository = repository;
    let refreshCalls = 0;
    let syncCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/auth/refresh')) {
        refreshCalls += 1;
        return tokenResponse();
      }
      if (url.includes('/api/v1/sync')) {
        syncCalls += 1;
        return syncCalls === 1 ? unauthorizedResponse() : emptySyncResponse();
      }
      if (url.includes('/auth/logout')) return new Response(null, { status: 204 });
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const cloud = createCloudController({ platform, repository });
    await cloud.initialize();

    expect(cloud.state().phase).toBe('connected');
    expect(cloud.state().syncStatus).toBe('synced');
    expect(refreshCalls).toBeGreaterThanOrEqual(2);
    expect(syncCalls).toBe(2);
    cloud.dispose();
    vi.unstubAllGlobals();
  });

  it('expires the session after a second 401 without reporting synced', async () => {
    const repository = new DexieTaskRepository(`lifecycle-expired-${databaseCounter}`);
    await repository.initialize();
    const platform = fakePlatform();
    (platform as AppPlatform).repository = repository;
    let refreshCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/auth/refresh')) {
        refreshCalls += 1;
        return refreshCalls === 1 ? tokenResponse() : unauthorizedResponse();
      }
      if (url.includes('/api/v1/sync')) return unauthorizedResponse();
      if (url.includes('/auth/logout')) return new Response(null, { status: 204 });
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const cloud = createCloudController({ platform, repository });
    await cloud.initialize();

    expect(cloud.state().phase).toBe('expired');
    expect(cloud.state().syncStatus).toBe('auth-required');
    expect(cloud.state().lastSyncedAt).toBeNull();
    cloud.dispose();
    vi.unstubAllGlobals();
  });

  it('does not apply a late response after dispose', async () => {
    const repository = new DexieTaskRepository(`lifecycle-dispose-${databaseCounter}`);
    await repository.initialize();
    const platform = fakePlatform();
    (platform as AppPlatform).repository = repository;
    let resolveSync!: (response: Response) => void;
    let syncStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      syncStarted = resolve;
    });
    const delayedSync = new Promise<Response>((resolve) => {
      resolveSync = resolve;
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/auth/refresh')) return tokenResponse();
      if (url.includes('/api/v1/sync')) {
        syncStarted();
        return delayedSync;
      }
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const cloud = createCloudController({ platform, repository });
    const initializing = cloud.initialize();
    await started;
    cloud.dispose();
    resolveSync(syncResponse('disposed-task'));
    await initializing;
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(await repository.getTask('disposed-task')).toBeNull();
    vi.unstubAllGlobals();
  });

  it('ignores account A response after account B starts a new session', async () => {
    const repository = new DexieTaskRepository(`lifecycle-switch-${databaseCounter}`);
    await repository.initialize();
    const platform = fakePlatform();
    (platform as AppPlatform).repository = repository;
    let syncCalls = 0;
    let resolveFirst!: (response: Response) => void;
    let firstStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const firstSync = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/auth/refresh')) return tokenResponse();
      if (url.includes('/auth/logout')) return new Response(null, { status: 204 });
      if (url.includes('/api/v1/sync')) {
        syncCalls += 1;
        if (syncCalls === 1) {
          firstStarted();
          return firstSync;
        }
        return emptySyncResponse();
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const cloud = createCloudController({ platform, repository });
    const accountA = cloud.initialize();
    await started;
    await cloud.initialize();
    resolveFirst(syncResponse('account-a-late-task'));
    await accountA;
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(cloud.state().phase).toBe('connected');
    expect(cloud.state().syncStatus).toBe('synced');
    expect(await repository.getTask('account-a-late-task')).toBeNull();
    expect((await repository.syncGetDiagnostics()).pending).toBe(0);
    cloud.dispose();
    vi.unstubAllGlobals();
  });

  it('does not allow a stale bootstrap response to replace local data after account switch', async () => {
    const repository = new DexieTaskRepository(`lifecycle-bootstrap-${databaseCounter}`);
    await repository.initialize();
    const platform = fakePlatform();
    (platform as AppPlatform).repository = repository;
    await repository.syncSetSession('session-a');
    await repository.syncSetSession('session-b');
    const before = await repository.listTasks({ view: 'all', limit: 1000 });

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/auth/refresh')) return tokenResponse();
      if (url.includes('/auth/logout')) return new Response(null, { status: 204 });
      if (url.includes('/api/v1/sync/bootstrap')) {
        return new Response(
          JSON.stringify({
            entities: [],
            snapshot_cursor: '99',
            next_page: null,
            has_more: false,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ code: 'UNEXPECTED', message: url }), { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      repository.syncReplaceSnapshot(
        {
          cursor: '99',
          lists: [],
          tasks: [],
          steps: [],
          dayPlans: [],
        },
        'session-a',
      ),
    ).rejects.toMatchObject({ code: 'STALE_SYNC_SESSION' });
    const after = await repository.listTasks({ view: 'all', limit: 1000 });
    expect(after.items.map((task) => task.id)).toEqual(before.items.map((task) => task.id));
    vi.unstubAllGlobals();
  });
});
