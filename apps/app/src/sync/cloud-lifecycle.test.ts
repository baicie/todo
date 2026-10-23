import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppPlatform } from '../adapters/platform';
import { DexieTaskRepository } from '../adapters/web-repository';
import { createCloudController } from './cloud';
import type { CloudSyncStorage } from './storage';

let databaseCounter = 0;
const LATE_TASK = '01a1673d-1000-7000-8000-000000000001';
const DISPOSED_TASK = '01a1673d-1000-7000-8000-000000000002';
const ACCOUNT_A_TASK = '01a1673d-1000-7000-8000-000000000003';
const BOOTSTRAP_TASK = '01a1673d-1000-7000-8000-000000000004';
const INCREMENTAL_TASK = '01a1673d-1000-7000-8000-000000000005';

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

function syncResponse(
  taskId: string,
  cursor = '2',
  serverSeq = 2,
  title = 'late server task',
): Response {
  const now = new Date().toISOString();
  return new Response(
    JSON.stringify({
      ack: [],
      changes: [
        {
          server_seq: serverSeq,
          op_id: '01a1673d-2000-7000-8000-000000000001',
          entity: 'task',
          entity_id: taskId,
          kind: 'create',
          patch: {
            title,
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
      next_cursor: cursor,
      has_more: false,
      server_time: '2026-10-23T00:00:00Z',
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

function emptySyncResponse(cursor = '0'): Response {
  return new Response(
    JSON.stringify({
      ack: [],
      changes: [],
      next_cursor: cursor,
      has_more: false,
      server_time: '2026-10-23T00:00:00Z',
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

function bootstrapResponse(taskId: string): Response {
  const now = new Date().toISOString();
  return new Response(
    JSON.stringify({
      entities: [
        {
          entity: 'task',
          entity_id: taskId,
          data: {
            title: 'bootstrap task',
            note: '',
            status: 'open',
            important: false,
            rank: 'a0',
            created_at: now,
            updated_at: now,
            deleted_at: null,
          },
        },
      ],
      snapshot_cursor: '9',
      next_page: null,
      has_more: false,
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
    resolveSync(syncResponse(LATE_TASK));
    await initializing;
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(cloud.state().phase).toBe('disconnected');
    expect(cloud.state().syncStatus).toBe('idle');
    expect(await repository.getTask(LATE_TASK)).toBeNull();
    expect(await repository.syncGetPendingCount()).toBe(0);
    expect(await repository.syncGetCursor()).toBe('0');
    cloud.dispose();
    vi.unstubAllGlobals();
  });

  it('quiescing for an account switch rejects a late old-account response', async () => {
    const repository = new DexieTaskRepository(`lifecycle-switch-${databaseCounter}`);
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
      return new Response(JSON.stringify({ code: 'UNEXPECTED', message: url }), { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const cloud = createCloudController({ platform, repository });
    const initializing = cloud.initialize();
    await started;
    await cloud.quiesceForAccountSwitch();
    resolveSync(syncResponse(LATE_TASK));
    await initializing;
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(await repository.getTask(LATE_TASK)).toBeNull();
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
    resolveSync(syncResponse(DISPOSED_TASK));
    await initializing;
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(await repository.getTask(DISPOSED_TASK)).toBeNull();
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
    resolveFirst(syncResponse(ACCOUNT_A_TASK));
    await accountA;
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(cloud.state().phase).toBe('connected');
    expect(cloud.state().syncStatus).toBe('synced');
    expect(await repository.getTask(ACCOUNT_A_TASK)).toBeNull();
    expect((await repository.syncGetDiagnostics()).pending).toBe(0);
    cloud.dispose();
    vi.unstubAllGlobals();
  });

  it('does not let a superseded session clear a newer fence', async () => {
    const repository = new DexieTaskRepository(`lifecycle-fence-order-${databaseCounter}`);
    await repository.initialize();
    let releaseClear!: () => void;
    let clearStarted!: () => void;
    let clearFinished!: () => void;
    const clearGate = new Promise<void>((resolve) => {
      releaseClear = resolve;
    });
    const started = new Promise<void>((resolve) => {
      clearStarted = resolve;
    });
    const finished = new Promise<void>((resolve) => {
      clearFinished = resolve;
    });
    let delayedClear = false;
    const wrapped = Object.create(repository) as CloudSyncStorage;
    wrapped.syncClearSession = async (expectedToken) => {
      if (!delayedClear) {
        delayedClear = true;
        clearStarted();
        await clearGate;
      }
      await repository.syncClearSession(expectedToken);
      clearFinished();
    };

    let syncCalls = 0;
    let resolveNewSync!: (response: Response) => void;
    let newSyncStarted!: () => void;
    const newSync = new Promise<Response>((resolve) => {
      resolveNewSync = resolve;
    });
    const newSyncStartedPromise = new Promise<void>((resolve) => {
      newSyncStarted = resolve;
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/auth/refresh')) return tokenResponse();
      if (url.includes('/auth/logout')) return new Response(null, { status: 204 });
      if (url.includes('/api/v1/sync')) {
        syncCalls += 1;
        if (syncCalls === 1) return emptySyncResponse();
        newSyncStarted();
        return newSync;
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const platformA = fakePlatform();
    const oldSession = createCloudController({ platform: platformA, repository: wrapped });
    await oldSession.initialize();
    expect(syncCalls).toBe(1);
    oldSession.dispose();
    await started;

    const platformB = fakePlatform();
    const newSession = createCloudController({ platform: platformB, repository: wrapped });
    const initializing = newSession.initialize();
    await newSyncStartedPromise;

    // The old clear is held in flight while the new session's HTTP response
    // is also in flight. Releasing the old clear must not delete the new token.
    releaseClear();
    await finished;
    resolveNewSync(syncResponse(LATE_TASK));
    await initializing;
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(newSession.state().phase).toBe('connected');
    expect(newSession.state().syncStatus).toBe('synced');
    expect(await repository.getTask(LATE_TASK)).not.toBeNull();
    newSession.dispose();
    vi.unstubAllGlobals();
  });

  it('rejects a stale beginSession after a newer initialize supersedes it', async () => {
    const repository = new DexieTaskRepository(`lifecycle-begin-generation-${databaseCounter}`);
    await repository.initialize();
    let releaseToken!: () => void;
    let tokenStarted!: () => void;
    const tokenGate = new Promise<void>((resolve) => {
      releaseToken = resolve;
    });
    const started = new Promise<void>((resolve) => {
      tokenStarted = resolve;
    });
    let delayedToken = false;
    const wrapped = Object.create(repository) as CloudSyncStorage;
    wrapped.syncSetSession = async (sessionId) => {
      if (!delayedToken) {
        delayedToken = true;
        tokenStarted();
        await tokenGate;
      }
      await repository.syncSetSession(sessionId);
    };

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/auth/refresh')) return tokenResponse();
      if (url.includes('/auth/logout')) return new Response(null, { status: 204 });
      if (url.includes('/api/v1/sync')) return emptySyncResponse();
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const platform = fakePlatform();
    const cloud = createCloudController({ platform, repository: wrapped });
    const first = cloud.initialize();
    await started;
    const second = cloud.initialize();
    releaseToken();
    await Promise.all([first, second]);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(cloud.state().phase).toBe('connected');
    expect(cloud.state().syncStatus).toBe('synced');
    cloud.dispose();
    vi.unstubAllGlobals();
  });

  it('serializes forceBootstrap with an in-flight sync and keeps the bootstrap cursor', async () => {
    const repository = new DexieTaskRepository(`lifecycle-force-${databaseCounter}`);
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
      if (url.includes('/sync/bootstrap')) return bootstrapResponse(BOOTSTRAP_TASK);
      if (url.includes('/api/v1/sync')) {
        syncCalls += 1;
        if (syncCalls === 1) {
          firstStarted();
          return firstSync;
        }
        return emptySyncResponse('9');
      }
      if (url.includes('/auth/logout')) return new Response(null, { status: 204 });
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const cloud = createCloudController({ platform, repository });
    const initializing = cloud.initialize();
    await started;
    const force = cloud.forceBootstrap();
    resolveFirst(syncResponse(LATE_TASK));
    await Promise.all([initializing, force]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await repository.getTask(LATE_TASK)).toBeNull();
    expect(await repository.getTask(BOOTSTRAP_TASK)).not.toBeNull();
    expect(await repository.syncGetCursor()).toBe('9');
    cloud.dispose();
    vi.unstubAllGlobals();
  });

  it('defers a new sync request until bootstrap snapshot and cursor are installed', async () => {
    const repository = new DexieTaskRepository(`lifecycle-bootstrap-mutex-${databaseCounter}`);
    await repository.initialize();
    const platform = fakePlatform();
    (platform as AppPlatform).repository = repository;
    let bootstrapMode = false;
    let bootstrapStarted!: () => void;
    let resolveBootstrap!: (response: Response) => void;
    const started = new Promise<void>((resolve) => {
      bootstrapStarted = resolve;
    });
    const bootstrapGate = new Promise<Response>((resolve) => {
      resolveBootstrap = resolve;
    });
    let syncCalls = 0;
    const syncCursors: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/auth/refresh')) return tokenResponse();
      if (url.includes('/sync/bootstrap')) {
        if (bootstrapMode) {
          bootstrapStarted();
          return bootstrapGate;
        }
        return new Response(
          JSON.stringify({ entities: [], snapshot_cursor: '0', next_page: null, has_more: false }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }
      if (url.includes('/api/v1/sync')) {
        syncCalls += 1;
        const body = JSON.parse(String(init?.body ?? '{}')) as { cursor?: string };
        syncCursors.push(body.cursor ?? '');
        return syncCalls === 1
          ? emptySyncResponse()
          : syncResponse(INCREMENTAL_TASK, '10', 10, 'incremental');
      }
      if (url.includes('/auth/logout')) return new Response(null, { status: 204 });
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const cloud = createCloudController({ platform, repository });
    await cloud.initialize();
    expect(syncCalls).toBe(1);
    bootstrapMode = true;

    const force = cloud.forceBootstrap();
    await started;
    const manual = cloud.syncNow();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(syncCalls).toBe(1);

    resolveBootstrap(bootstrapResponse(BOOTSTRAP_TASK));
    await Promise.all([force, manual]);

    expect(syncCalls).toBe(2);
    expect(syncCursors).toEqual(['0', '9']);
    expect(await repository.syncGetCursor()).toBe('10');
    expect(await repository.getTask(BOOTSTRAP_TASK)).not.toBeNull();
    expect(await repository.getTask(INCREMENTAL_TASK)).not.toBeNull();
    expect(await repository.syncGetPendingCount()).toBe(0);
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
