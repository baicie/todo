import { describe, expect, it, vi } from 'vitest';
import { AuthClient, RestSyncTransport, toServerPatch } from './rest-transport';
import { SyncHttpError } from './index';
import type { SyncRequest } from '@todo/contracts';

const opId = '019a0000-0000-7000-8000-000000000002';
const entityId = '019a0000-0000-7000-8000-000000000003';
const deviceId = '019a0000-0000-7000-8000-000000000001';

describe('REST sync transport field mapping', () => {
  it('strips local-only fields and maps repository names to API names', () => {
    expect(
      toServerPatch('task', 'create', {
        id: entityId,
        title: '提交报销',
        listId: null,
        dueOn: '2026-10-21',
        createdAt: '2026-10-20T00:00:00Z',
        updatedAt: '2026-10-20T00:00:00Z',
        deletedAt: null,
      }),
    ).toEqual({
      title: '提交报销',
      list_id: null,
      due_on: '2026-10-21',
    });
  });

  it('sends snake_case ops and returns camelCase patches', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ack: [{ op_id: opId, server_seq: 2, status: 'applied' }],
            changes: [
              {
                server_seq: 2,
                op_id: opId,
                entity: 'task',
                entity_id: entityId,
                kind: 'patch',
                patch: { due_on: '2026-10-22', list_id: null },
              },
            ],
            next_cursor: '2',
            has_more: false,
            server_time: '2026-10-21T05:00:00Z',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    );
    const transport = new RestSyncTransport({
      baseUrl: 'http://localhost:8787',
      fetch: fetchMock as unknown as typeof fetch,
      getAccessToken: () => 'token',
    });
    const batch: SyncRequest = {
      device_id: deviceId,
      cursor: '1',
      ops: [
        {
          op_id: opId,
          client_seq: 4,
          entity: 'task',
          entity_id: entityId,
          kind: 'patch',
          patch: { dueOn: '2026-10-22' },
        },
      ],
    };
    const result = await transport.sync(batch);
    const request = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(request[1].body)).ops[0].patch).toEqual({
      due_on: '2026-10-22',
    });
    expect(result.changes[0]?.patch).toEqual({ dueOn: '2026-10-22', listId: null });
  });
});

describe('AuthClient refresh', () => {
  it('posts the rotating refresh token and returns the new access token', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            access_token: 'new-access',
            expires_in: 900,
            refresh_token: 'rotated',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    );
    const auth = new AuthClient({
      baseUrl: 'http://localhost:8787',
      fetch: fetchMock as unknown as typeof fetch,
      getAccessToken: () => 'old-access',
    });
    await expect(auth.refresh('old-refresh')).resolves.toMatchObject({
      access_token: 'new-access',
      refresh_token: 'rotated',
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/api/v1/auth/refresh');
    expect(JSON.parse(String(init.body))).toEqual({ refresh_token: 'old-refresh' });
  });

  it('surfaces an expired refresh credential as a 401 SyncHttpError', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ code: 'UNAUTHORIZED', message: 'expired' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    const auth = new AuthClient({
      baseUrl: 'http://localhost:8787',
      fetch: fetchMock as unknown as typeof fetch,
    });
    const error = await auth.refresh('expired').catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(SyncHttpError);
    expect(error).toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
  });
});
