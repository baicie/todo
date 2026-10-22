import {
  apiErrorSchema,
  bootstrapPageSchema,
  syncResponseSchema,
  tokenPairSchema,
  type BootstrapPage,
  type SyncRequest,
  type SyncResponse,
  type TokenPair,
} from '@todo/contracts';
import { SyncHttpError, type SyncTransport } from './index';

export interface AuthClientOptions {
  baseUrl: string;
  fetch?: typeof fetch;
  getAccessToken?: () => Promise<string | null> | string | null;
}

async function readError(response: Response): Promise<SyncHttpError> {
  let code = 'INTERNAL';
  let message = response.statusText || 'Request failed';
  try {
    const parsed = apiErrorSchema.safeParse(await response.json());
    if (parsed.success) {
      code = parsed.data.code;
      message = parsed.data.message;
    }
  } catch {
    // Non-JSON upstream error.
  }
  return new SyncHttpError(response.status, code, message);
}

async function authorizedFetch(
  options: AuthClientOptions,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const token = await options.getAccessToken?.();
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  if (init.body) headers.set('Content-Type', 'application/json');
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return (options.fetch ?? fetch)(`${options.baseUrl.replace(/\/$/, '')}${path}`, {
    ...init,
    headers,
    credentials: 'include',
  });
}

export class RestSyncTransport implements SyncTransport {
  constructor(private readonly options: AuthClientOptions) {}

  async sync(batch: SyncRequest): Promise<SyncResponse> {
    const response = await authorizedFetch(this.options, '/api/v1/sync', {
      method: 'POST',
      body: JSON.stringify({
        ...batch,
        ops: batch.ops.map(toServerMutation),
      }),
    });
    if (!response.ok) throw await readError(response);
    const parsed = syncResponseSchema.parse(await response.json());
    return {
      ...parsed,
      changes: parsed.changes.map((change) => ({
        ...change,
        patch: toDomainPatch(change.patch),
      })),
    };
  }

  async bootstrap(cursor?: string): Promise<BootstrapPage> {
    const query = new URLSearchParams({ limit: '500' });
    if (cursor) query.set('continuation', cursor);
    const response = await authorizedFetch(
      this.options,
      `/api/v1/sync/bootstrap?${query.toString()}`,
    );
    if (!response.ok) throw await readError(response);
    const parsed = bootstrapPageSchema.parse(await response.json());
    return {
      ...parsed,
      entities: parsed.entities.map((entity) => ({
        ...entity,
        data: toDomainPatch(entity.data),
      })),
    };
  }
}

export interface DeviceInfo {
  id: string;
  name: string;
  platform: string;
  last_seen_at: string | null;
}

const SERVER_FIELD_NAMES: Record<string, string> = {
  listId: 'list_id',
  dueOn: 'due_on',
  remindAt: 'remind_at',
  remindTimezone: 'remind_timezone',
  seriesId: 'series_id',
  occurrenceKey: 'occurrence_key',
  completedAt: 'completed_at',
  taskId: 'task_id',
  localDate: 'local_date',
  isCompleted: 'is_completed',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  deletedAt: 'deleted_at',
};

const DOMAIN_FIELD_NAMES = Object.fromEntries(
  Object.entries(SERVER_FIELD_NAMES).map(([domain, server]) => [server, domain]),
);

const LOCAL_ONLY_FIELDS = new Set(['id', 'createdAt', 'updatedAt', 'deletedAt']);

function mapPatchKeys(
  patch: Record<string, unknown>,
  names: Record<string, string>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(patch).map(([key, value]) => [names[key] ?? key, value]),
  );
}

/** Convert repository camelCase patches to the API's snake_case field contract. */
export function toServerPatch(
  entity: string,
  kind: string,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const cleaned = Object.fromEntries(
    Object.entries(patch).filter(([key]) => kind === 'delete' || !LOCAL_ONLY_FIELDS.has(key)),
  );
  const mapped = mapPatchKeys(cleaned, SERVER_FIELD_NAMES);
  // Server create endpoints set these from the mutation envelope/defaults.
  if (kind === 'create') {
    delete mapped.id;
    delete mapped.created_at;
    delete mapped.updated_at;
    delete mapped.deleted_at;
  }
  return mapped;
}

function toDomainPatch(patch: Record<string, unknown>): Record<string, unknown> {
  return mapPatchKeys(patch, DOMAIN_FIELD_NAMES);
}

function toServerMutation(operation: SyncRequest['ops'][number]) {
  return {
    ...operation,
    patch: toServerPatch(operation.entity, operation.kind, operation.patch),
  };
}

export interface PushConfig {
  enabled: boolean;
  public_key: string | null;
}

export interface PushSubscriptionInput {
  endpoint: string;
  p256dh: string;
  auth: string;
  user_agent?: string;
}

export class AuthClient {
  constructor(private readonly options: AuthClientOptions) {}

  async requestCode(email: string): Promise<void> {
    const response = await authorizedFetch(this.options, '/api/v1/auth/code/request', {
      method: 'POST',
      body: JSON.stringify({ email }),
    });
    if (!response.ok) throw await readError(response);
  }

  async verifyCode(input: {
    email: string;
    code: string;
    deviceId: string;
    deviceName: string;
    platform: string;
  }): Promise<TokenPair> {
    const response = await authorizedFetch(this.options, '/api/v1/auth/code/verify', {
      method: 'POST',
      body: JSON.stringify({
        email: input.email,
        code: input.code,
        device_id: input.deviceId,
        device_name: input.deviceName,
        platform: input.platform,
      }),
    });
    if (!response.ok) throw await readError(response);
    return tokenPairSchema.parse(await response.json());
  }

  async refresh(refreshToken?: string): Promise<TokenPair> {
    const response = await authorizedFetch(this.options, '/api/v1/auth/refresh', {
      method: 'POST',
      body: JSON.stringify(refreshToken ? { refresh_token: refreshToken } : {}),
    });
    if (!response.ok) throw await readError(response);
    return tokenPairSchema.parse(await response.json());
  }

  async logout(): Promise<void> {
    const response = await authorizedFetch(this.options, '/api/v1/auth/logout', {
      method: 'POST',
    });
    if (!response.ok) throw await readError(response);
  }

  async devices(): Promise<DeviceInfo[]> {
    const response = await authorizedFetch(this.options, '/api/v1/devices');
    if (!response.ok) throw await readError(response);
    return (await response.json()) as DeviceInfo[];
  }

  async revokeDevice(deviceId: string): Promise<void> {
    const response = await authorizedFetch(
      this.options,
      `/api/v1/devices/${encodeURIComponent(deviceId)}`,
      { method: 'DELETE' },
    );
    if (!response.ok) throw await readError(response);
  }

  async exportAccount(): Promise<Record<string, unknown>> {
    const response = await authorizedFetch(this.options, '/api/v1/export');
    if (!response.ok) throw await readError(response);
    return (await response.json()) as Record<string, unknown>;
  }

  async pushConfig(): Promise<PushConfig> {
    const response = await authorizedFetch(this.options, '/api/v1/push/config');
    if (!response.ok) throw await readError(response);
    return (await response.json()) as PushConfig;
  }

  async subscribePush(input: PushSubscriptionInput): Promise<void> {
    const response = await authorizedFetch(this.options, '/api/v1/push/subscriptions', {
      method: 'POST',
      body: JSON.stringify(input),
    });
    if (!response.ok) throw await readError(response);
  }

  async unsubscribePush(endpoint: string): Promise<void> {
    const response = await authorizedFetch(this.options, '/api/v1/push/subscriptions', {
      method: 'DELETE',
      body: JSON.stringify({ endpoint }),
    });
    if (!response.ok) throw await readError(response);
  }

  async testPush(): Promise<void> {
    const response = await authorizedFetch(this.options, '/api/v1/push/test', {
      method: 'POST',
    });
    if (!response.ok) throw await readError(response);
  }

  async sharedRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await authorizedFetch(this.options, `/api/v1/shared${path}`, init);
    if (!response.ok) throw await readError(response);
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  async deleteAccount(): Promise<void> {
    const response = await authorizedFetch(this.options, '/api/v1/account', {
      method: 'DELETE',
    });
    if (!response.ok) throw await readError(response);
  }
}
