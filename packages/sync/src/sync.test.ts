import { describe, expect, it, vi } from 'vitest';
import { SyncEngine, SyncHttpError } from '../src';
import type { SyncStore, SyncTransport } from '../src';
import type { Ack, Change, SyncResponse } from '@todo/contracts';

const opId = '019a0000-0000-7000-8000-000000000001';

function fakeStore(pending = 1): SyncStore & { applied: unknown[] } {
  const applied: unknown[] = [];
  return {
    applied,
    getDeviceId: async () => '019a0000-0000-7000-8000-000000000099',
    getCursor: async () => '10',
    getPendingMutations: vi.fn(async (limit: number) =>
      Array.from({ length: Math.min(limit, pending) }, (_, index) => ({
        opId,
        deviceId: '019a0000-0000-7000-8000-000000000099',
        clientSeq: index + 1,
        entity: 'task' as const,
        entityId: opId,
        kind: 'patch' as const,
        patch: { title: 'x' },
      })),
    ),
    getPendingCount: vi.fn(async () => 0),
    applyServerResult: vi.fn(async (result) => {
      applied.push(result);
    }),
    replaceFromBootstrap: vi.fn(async () => {}),
    markBootstrapRequired: vi.fn(async () => {}),
  };
}

function response(overrides: Partial<SyncResponse> = {}): SyncResponse {
  return {
    ack: [{ op_id: opId, status: 'applied', server_seq: 11 } as Ack],
    changes: [
      {
        server_seq: 11,
        op_id: opId,
        entity: 'task',
        entity_id: opId,
        kind: 'patch',
        patch: { title: 'x' },
      } as Change,
    ],
    next_cursor: '11',
    has_more: false,
    server_time: '2026-10-21T03:00:00Z',
    ...overrides,
  };
}

describe('SyncEngine', () => {
  it('applies server changes and cursor in one store call', async () => {
    const store = fakeStore();
    const transport: SyncTransport = {
      sync: vi.fn(async () => response()),
      bootstrap: vi.fn(),
    };
    const states: string[] = [];
    const engine = new SyncEngine(transport, store, (state) => states.push(state.status));
    const result = await engine.syncNow();
    expect(result.status).toBe('synced');
    expect(store.applied).toHaveLength(1);
    expect(states).toContain('syncing');
    expect(states.at(-1)).toBe('synced');
  });

  it('reports offline without clearing pending mutations', async () => {
    const store = fakeStore();
    const transport: SyncTransport = {
      sync: vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
      bootstrap: vi.fn(),
    };
    const engine = new SyncEngine(transport, store);
    const originalOnLine = Object.getOwnPropertyDescriptor(navigator, 'onLine');
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
    try {
      await expect(engine.syncNow()).resolves.toMatchObject({ status: 'offline' });
      expect(store.applyServerResult).not.toHaveBeenCalled();
    } finally {
      if (originalOnLine) Object.defineProperty(navigator, 'onLine', originalOnLine);
      else Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
    }
  });

  it('reports HTTP 500 as an error without advancing the success timestamp', async () => {
    const store = fakeStore();
    const transport: SyncTransport = {
      sync: vi.fn(async () => {
        throw new SyncHttpError(500, 'INTERNAL', 'server failed');
      }),
      bootstrap: vi.fn(),
    };
    const engine = new SyncEngine(transport, store);
    const result = await engine.syncNow();
    expect(result.status).toBe('error');
    expect(result.lastError).toContain('server failed');
    expect(result.lastSyncedAt).toBeNull();
    expect(store.applyServerResult).not.toHaveBeenCalled();
  });

  it('surfaces rejected acknowledgements instead of reporting synced', async () => {
    const store = fakeStore();
    const transport: SyncTransport = {
      sync: vi.fn(async () =>
        response({
          ack: [
            {
              op_id: opId,
              status: 'rejected',
              server_seq: 11,
              error_code: 'VALIDATION',
            } as Ack,
          ],
        }),
      ),
      bootstrap: vi.fn(),
    };
    const engine = new SyncEngine(transport, store);
    const result = await engine.syncNow();
    expect(result.status).toBe('error');
    expect(result.lastError).toContain('VALIDATION');
    expect(store.applyServerResult).toHaveBeenCalledTimes(1);
  });

  it('deduplicates concurrent syncNow calls', async () => {
    const store = fakeStore();
    let resolveSync!: (value: SyncResponse) => void;
    const sync = vi.fn(
      () =>
        new Promise<SyncResponse>((resolve) => {
          resolveSync = resolve;
        }),
    );
    const transport: SyncTransport = { sync, bootstrap: vi.fn() };
    const engine = new SyncEngine(transport, store);

    const first = engine.syncNow();
    const second = engine.syncNow();
    await vi.waitFor(() => expect(sync).toHaveBeenCalledTimes(1));
    resolveSync(response());
    const [one, two] = await Promise.all([first, second]);
    expect(one.status).toBe('synced');
    expect(two.status).toBe('synced');
  });

  it('completes cleanly when there are no pending operations', async () => {
    const store = fakeStore(0);
    const transport: SyncTransport = {
      sync: vi.fn(async () => response({ ack: [], changes: [] })),
      bootstrap: vi.fn(),
    };
    const engine = new SyncEngine(transport, store);
    await expect(engine.syncNow()).resolves.toMatchObject({ status: 'synced', pendingCount: 0 });
  });

  it('rebases from bootstrap on an expired cursor without clearing pending work', async () => {
    const store = fakeStore();
    const transport: SyncTransport = {
      sync: vi
        .fn()
        .mockRejectedValueOnce(new SyncHttpError(409, 'CURSOR_EXPIRED', 'expired'))
        .mockResolvedValueOnce(response()),
      bootstrap: vi.fn(async () => ({
        entities: [],
        snapshot_cursor: '20',
        next_page: null,
        has_more: false,
      })),
    };
    const engine = new SyncEngine(transport, store);
    const result = await engine.syncNow();
    expect(store.markBootstrapRequired).toHaveBeenCalled();
    expect(store.replaceFromBootstrap).toHaveBeenCalled();
    expect(result.status).toBe('synced');
  });

  it('reports authentication expiry without destructive local changes', async () => {
    const store = fakeStore();
    const transport: SyncTransport = {
      sync: vi.fn(async () => {
        throw new SyncHttpError(401, 'UNAUTHORIZED', 'expired');
      }),
      bootstrap: vi.fn(),
    };
    const engine = new SyncEngine(transport, store);
    const result = await engine.syncNow();
    expect(result.status).toBe('auth-required');
    expect(store.applyServerResult).not.toHaveBeenCalled();
  });

  it('combines every bootstrap page before replacing the local shadow', async () => {
    const store = fakeStore();
    const bootstrap = vi
      .fn()
      .mockResolvedValueOnce({
        entities: [{ entity: 'task', entity_id: opId, data: { title: 'one' } }],
        snapshot_cursor: '20',
        next_page: 'page-2',
        has_more: true,
      })
      .mockResolvedValueOnce({
        entities: [{ entity: 'task', entity_id: opId, data: { title: 'two' } }],
        snapshot_cursor: '20',
        next_page: null,
        has_more: false,
      });
    const transport: SyncTransport = {
      sync: vi
        .fn()
        .mockRejectedValueOnce(new SyncHttpError(409, 'CURSOR_EXPIRED', 'expired'))
        .mockResolvedValueOnce(response()),
      bootstrap,
    };
    const engine = new SyncEngine(transport, store);
    await engine.syncNow();
    expect(bootstrap.mock.calls[0]).toEqual([]);
    expect(bootstrap).toHaveBeenNthCalledWith(2, 'page-2');
    expect(store.replaceFromBootstrap).toHaveBeenCalledWith(
      expect.objectContaining({
        entities: expect.arrayContaining([
          expect.objectContaining({ data: { title: 'one' } }),
          expect.objectContaining({ data: { title: 'two' } }),
        ]),
        has_more: false,
      }),
    );
  });
});
