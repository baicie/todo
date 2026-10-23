import { createSignal, type Accessor } from 'solid-js';
import { SyncEngine, SyncHttpError, type SyncState, type SyncStatus } from '@todo/sync';
import { AuthClient, RestSyncTransport, type DeviceInfo } from '@todo/sync/rest';
import type { Ack, BootstrapPage, Change } from '@todo/contracts';
import type { AppPlatform } from '../adapters/platform';
import { downloadBlob, exportFilename } from '@todo/application';
import { activeAccountId, updateActiveAccountEmail } from '../lib/accounts';
import { subscribeWebPush, unsubscribeWebPush, webPushSupported } from '../lib/web-push';
import type {
  CloudDiagnostics,
  CloudMergeMode,
  CloudSyncStorage,
  RejectedMutation,
} from './storage';
import { StaleSyncSessionError } from './storage';
import { resolveCloudSyncOutcome } from './cloud-status';
import {
  normalizeBootstrap,
  readFullBootstrap,
  snapshotCounts,
  type CloudSnapshot,
  type SnapshotCounts,
} from './snapshot';

const ACCOUNT_ID = activeAccountId();
const CONFIG_KEY =
  ACCOUNT_ID === 'default' ? 'shishi.cloud.config' : `shishi.cloud.config.${ACCOUNT_ID}`;
const REFRESH_KEY = `cloud-refresh:${ACCOUNT_ID}`;

interface StoredConfig {
  apiUrl: string;
  email: string;
  enabled: boolean;
  lastSyncedAt: string | null;
}

export interface MergePreview {
  local: SnapshotCounts;
  remote: SnapshotCounts;
  boundAccount: string | null;
}

export type CloudPhase = 'disconnected' | 'code-sent' | 'choose-merge' | 'connected' | 'expired';

export interface CloudState {
  phase: CloudPhase;
  syncStatus: SyncStatus;
  apiUrl: string;
  email: string;
  boundAccount: string | null;
  busy: string | null;
  error: string | null;
  pending: number;
  rejected: number;
  cursor: string;
  deviceId: string;
  lastSyncedAt: string | null;
  mergePreview: MergePreview | null;
  devices: DeviceInfo[];
  rejections: RejectedMutation[];
  push: {
    supported: boolean;
    available: boolean;
    subscribed: boolean;
  };
}

export interface CloudController {
  state: Accessor<CloudState>;
  initialize(): Promise<void>;
  dispose(): void;
  setApiUrl(value: string): void;
  setEmail(value: string): void;
  requestCode(): Promise<void>;
  verifyCode(code: string): Promise<void>;
  chooseMerge(mode: CloudMergeMode | 'cancel'): Promise<void>;
  syncNow(): Promise<void>;
  forceBootstrap(): Promise<void>;
  clearRejected(): Promise<void>;
  discardRejection(opId: string): Promise<void>;
  refreshDevices(): Promise<void>;
  revokeDevice(deviceId: string): Promise<void>;
  signOut(clearLocal: boolean): Promise<void>;
  deleteAccount(clearLocal: boolean): Promise<void>;
  downloadLocalBackup(): Promise<void>;
  downloadCloudBackup(): Promise<void>;
  downloadDiagnostics(): Promise<void>;
  enablePush(): Promise<void>;
  disablePush(): Promise<void>;
  testPush(): Promise<void>;
  sharedRequest<T>(path: string, init?: RequestInit): Promise<T>;
}

class RepositorySyncStore {
  constructor(
    private readonly repository: CloudSyncStorage,
    private readonly sessionId: string,
    private readonly isCurrent: () => boolean,
  ) {}

  getDeviceId = () => this.repository.syncGetDeviceId();
  getCursor = () => this.repository.syncGetCursor();
  getPendingMutations = (limit: number) => this.repository.syncGetPending(limit);
  getPendingCount = () => this.repository.syncGetPendingCount();
  applyServerResult = async (result: { acks: Ack[]; changes: Change[]; nextCursor: string }) => {
    if (!this.isCurrent()) throw new StaleSyncSessionError();
    await this.repository.syncApplyResult(result, this.sessionId);
  };
  replaceFromBootstrap = async (page: BootstrapPage) => {
    if (!this.isCurrent()) throw new StaleSyncSessionError();
    await this.repository.syncReplaceSnapshot(
      normalizeBootstrap(page.entities, page.snapshot_cursor),
      this.sessionId,
    );
  };
  markBootstrapRequired = () => {
    if (!this.isCurrent()) return Promise.resolve();
    return this.repository.syncMarkBootstrapRequired();
  };
}

function defaultApiUrl(): string {
  const configured = import.meta.env.VITE_API_URL as string | undefined;
  return configured?.replace(/\/$/, '') ?? 'http://127.0.0.1:8787';
}

function readConfig(): StoredConfig | null {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<StoredConfig>;
    if (typeof value.apiUrl !== 'string' || typeof value.email !== 'string') return null;
    return {
      apiUrl: value.apiUrl,
      email: value.email,
      enabled: value.enabled === true,
      lastSyncedAt: typeof value.lastSyncedAt === 'string' ? value.lastSyncedAt : null,
    };
  } catch {
    return null;
  }
}

function writeConfig(config: StoredConfig): void {
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
  } catch {
    // Private browsing can reject storage; the in-memory session still works.
  }
}

function deviceName(platform: AppPlatform['lifecycle']['platform']): string {
  const labels: Record<AppPlatform['lifecycle']['platform'], string> = {
    web: '浏览器',
    windows: 'Windows 桌面',
    macos: 'macOS 桌面',
    linux: 'Linux 桌面',
    android: 'Android 设备',
    ios: 'iOS 设备',
  };
  return labels[platform];
}

function visibleCountsFromBundle(bundle: {
  tasks: Array<{ deletedAt: string | null }>;
  lists: Array<{ deletedAt: string | null }>;
  steps: Array<{ deletedAt: string | null }>;
  dayPlans: Array<{ deletedAt: string | null }>;
}): SnapshotCounts {
  return {
    tasks: bundle.tasks.length,
    lists: bundle.lists.length,
    steps: bundle.steps.length,
    dayPlans: bundle.dayPlans.length,
    visibleTasks: bundle.tasks.filter((task) => !task.deletedAt).length,
  };
}

export function createCloudController(options: {
  platform: AppPlatform;
  repository: CloudSyncStorage;
}): CloudController {
  const { platform, repository } = options;
  const config = readConfig();
  const [state, setState] = createSignal<CloudState>({
    phase: 'disconnected',
    syncStatus: 'idle',
    apiUrl: config?.apiUrl ?? defaultApiUrl(),
    email: config?.email ?? '',
    boundAccount: null,
    busy: null,
    error: null,
    pending: 0,
    rejected: 0,
    cursor: '0',
    deviceId: '',
    lastSyncedAt: config?.lastSyncedAt ?? null,
    mergePreview: null,
    devices: [],
    rejections: [],
    push: {
      supported: webPushSupported(),
      available: false,
      subscribed: false,
    },
  });

  let accessToken: string | null = null;
  let expiresAt = 0;
  let memoryRefreshToken: string | null = null;
  let auth: AuthClient | null = null;
  let transport: RestSyncTransport | null = null;
  let engine: SyncEngine | null = null;
  let pendingSnapshot: CloudSnapshot | null = null;
  let pendingSession: { generation: number; token: string } | null = null;
  let autoSyncTimer: ReturnType<typeof setTimeout> | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let refreshInFlight: Promise<string> | null = null;
  let runInFlight: Promise<void> | null = null;
  let bootstrapInFlight: Promise<void> | null = null;
  let bootstrapCompletion: Promise<void> | null = null;
  let queuedSync: Promise<void> | null = null;
  let sessionGeneration = 0;
  let sessionToken: string | null = null;
  let disposed = false;
  let fenceTail: Promise<void> = Promise.resolve();
  let unsubscribe: (() => void) | null = null;
  let stopOnline: (() => void) | null = null;
  let stopResume: (() => void) | null = null;

  const update = (patch: Partial<CloudState>) => {
    if (disposed) return;
    setState((current) => ({ ...current, ...patch }));
  };

  const isCurrentGeneration = (generation: number): boolean =>
    !disposed && generation === sessionGeneration;

  // Fence writes are serialized in invocation order. A write is a no-op if a
  // newer generation has already superseded it, so an old logout clear can
  // never erase a token installed by a newer beginSession.
  const enqueueFenceWrite = (generation: number, token: string): Promise<void> => {
    const operation = fenceTail.then(async () => {
      if (generation !== sessionGeneration) return;
      await repository.syncSetSession(token);
    });
    fenceTail = operation.catch(() => {
      // Keep the queue alive; the caller still observes the failure.
    });
    return operation;
  };

  const enqueueFenceClear = (generation: number, expectedToken: string | null): Promise<void> => {
    const operation = fenceTail.then(async () => {
      // A newer beginSession owns the DB fence now; do not touch it.
      if (generation !== sessionGeneration) return;
      // The repository compares expectedToken inside its write transaction.
      // If a newer session already installed a token, this is a no-op.
      await repository.syncClearSession(expectedToken);
    });
    fenceTail = operation.catch(() => {
      // Keep the queue alive; the caller still observes the failure.
    });
    return operation;
  };

  const beginSession = async (): Promise<{ generation: number; token: string }> => {
    if (disposed) throw new StaleSyncSessionError();
    const token = crypto.randomUUID();
    const generation = (sessionGeneration += 1);
    sessionToken = token;
    runInFlight = null;
    bootstrapInFlight = null;
    bootstrapCompletion = null;
    queuedSync = null;
    refreshInFlight = null;
    if (autoSyncTimer) clearTimeout(autoSyncTimer);
    autoSyncTimer = undefined;
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = undefined;
    unsubscribe?.();
    unsubscribe = null;
    stopOnline?.();
    stopOnline = null;
    stopResume?.();
    stopResume = null;
    engine = null;
    await enqueueFenceWrite(generation, token);
    if (!isCurrentGeneration(generation) || sessionToken !== token) {
      throw new StaleSyncSessionError();
    }
    return { generation, token };
  };

  const invalidateSession = (): Promise<void> => {
    const generation = (sessionGeneration += 1);
    const expectedToken = sessionToken;
    sessionToken = null;
    engine = null;
    runInFlight = null;
    bootstrapInFlight = null;
    bootstrapCompletion = null;
    queuedSync = null;
    refreshInFlight = null;
    if (autoSyncTimer) clearTimeout(autoSyncTimer);
    autoSyncTimer = undefined;
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = undefined;
    unsubscribe?.();
    unsubscribe = null;
    stopOnline?.();
    stopOnline = null;
    stopResume?.();
    stopResume = null;
    return enqueueFenceClear(generation, expectedToken);
  };

  const persist = (enabled = state().phase === 'connected') => {
    const current = state();
    writeConfig({
      apiUrl: current.apiUrl.replace(/\/$/, ''),
      email: current.email.trim().toLowerCase(),
      enabled,
      lastSyncedAt: current.lastSyncedAt,
    });
  };

  const buildClients = () => {
    const baseUrl = state().apiUrl.replace(/\/$/, '');
    const authOptions = {
      baseUrl,
      getAccessToken: () => accessToken,
    };
    auth = new AuthClient(authOptions);
    transport = new RestSyncTransport({
      baseUrl,
      getAccessToken: async () => ensureAccessToken(),
    });
  };

  const applyTokens = async (tokens: {
    access_token: string;
    expires_in: number;
    refresh_token?: string;
  }) => {
    accessToken = tokens.access_token;
    expiresAt = Date.now() + Math.max(30, tokens.expires_in) * 1000;
    if (platform.kind === 'tauri' && tokens.refresh_token) {
      memoryRefreshToken = tokens.refresh_token;
      try {
        await platform.secureTokenStore.set(REFRESH_KEY, tokens.refresh_token);
      } catch {
        // Some Linux sessions or mobile shells have no OS credential store.
        // Keep the session usable in memory; it will require login after restart.
      }
    }
  };

  const clearTokens = async () => {
    accessToken = null;
    expiresAt = 0;
    memoryRefreshToken = null;
    if (platform.kind === 'tauri') {
      try {
        await platform.secureTokenStore.remove(REFRESH_KEY);
      } catch {
        // Missing credential stores are already equivalent to "no token".
      }
    }
  };

  const refreshAccessToken = async (): Promise<string> => {
    if (refreshInFlight) return refreshInFlight;
    const generation = sessionGeneration;
    const pending = (async () => {
      if (!auth) throw new Error('云服务尚未配置');
      let storedRefresh = memoryRefreshToken;
      if (!storedRefresh && platform.kind === 'tauri') {
        storedRefresh = await platform.secureTokenStore.get(REFRESH_KEY).catch(() => null);
      }
      const tokens = await auth.refresh(storedRefresh ?? undefined);
      if (!isCurrentGeneration(generation)) throw new StaleSyncSessionError();
      await applyTokens(tokens);
      return tokens.access_token;
    })();
    const tracked = pending.finally(() => {
      if (refreshInFlight === tracked) refreshInFlight = null;
    });
    refreshInFlight = tracked;
    return tracked;
  };

  const ensureAccessToken = async (): Promise<string> => {
    if (accessToken && expiresAt > Date.now() + 30_000) return accessToken;
    return refreshAccessToken();
  };

  const diagnostics = async (generation?: number): Promise<CloudDiagnostics> => {
    const next = await repository.syncGetDiagnostics();
    const rejections =
      next.rejected > 0 && repository.syncListRejected ? await repository.syncListRejected(50) : [];
    if (generation === undefined || isCurrentGeneration(generation)) {
      update({
        pending: next.pending,
        rejected: next.rejected,
        cursor: next.cursor,
        deviceId: next.deviceId,
        boundAccount: next.boundAccount,
        rejections,
      });
    }
    return next;
  };

  const onEngineState = (sync: SyncState) => {
    update({
      syncStatus: sync.status,
      pending: sync.pendingCount,
      lastSyncedAt: sync.lastSyncedAt ?? state().lastSyncedAt,
      error: sync.lastError,
    });
  };

  const installEngine = (generation: number, token: string) => {
    if (!transport) throw new Error('云服务尚未配置');
    engine = new SyncEngine(
      transport,
      new RepositorySyncStore(repository, token, () => isCurrentGeneration(generation)),
      (sync) => {
        if (isCurrentGeneration(generation)) onEngineState(sync);
      },
      100,
    );
  };

  const scheduleSync = () => {
    if (state().phase !== 'connected' || !engine) return;
    if (autoSyncTimer) clearTimeout(autoSyncTimer);
    autoSyncTimer = setTimeout(() => void runSync(), 1000);
  };

  const expireSession = async (): Promise<void> => {
    await clearTokens();
    update({
      phase: 'expired',
      syncStatus: 'auth-required',
      error: '登录已过期，请重新验证邮箱。',
    });
  };

  const handleSyncError = async (error: unknown): Promise<void> => {
    if (error instanceof SyncHttpError && error.status === 401) {
      await expireSession();
      return;
    }
    update({
      syncStatus:
        typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : 'error',
      error: error instanceof Error ? error.message : '同步失败',
    });
  };

  const executeSync = async (generation: number): Promise<void> => {
    if (!isCurrentGeneration(generation) || !engine || state().phase !== 'connected') return;
    update({ busy: 'sync', error: null });
    try {
      let result = await engine.syncNow();
      if (!isCurrentGeneration(generation)) return;
      if (result.status === 'auth-required') {
        // Retry at most once per run. A second auth-required response means
        // the refresh credential is also invalid; do not loop indefinitely.
        try {
          await refreshAccessToken();
          if (!isCurrentGeneration(generation)) return;
          result = await engine.syncNow();
          if (!isCurrentGeneration(generation)) return;
        } catch (error) {
          if (!isCurrentGeneration(generation)) return;
          await handleSyncError(error);
          return;
        }
      }
      if (result.status === 'auth-required') {
        if (isCurrentGeneration(generation)) await expireSession();
        return;
      }

      const next = await diagnostics(generation);
      if (!isCurrentGeneration(generation)) return;
      const outcome = resolveCloudSyncOutcome(result, next.rejected, state());
      update({
        syncStatus: outcome.syncStatus,
        lastSyncedAt: outcome.lastSyncedAt,
        pending: next.pending,
        rejected: next.rejected,
        cursor: next.cursor,
        error: outcome.error,
      });
      if (result.lastSyncedAt) persist(true);
      if (outcome.syncStatus === 'syncing') scheduleSync();
    } catch (error) {
      if (isCurrentGeneration(generation)) await handleSyncError(error);
    } finally {
      if (isCurrentGeneration(generation)) update({ busy: null });
    }
  };

  const runSync = (): Promise<void> => {
    if (bootstrapInFlight) {
      if (!queuedSync) {
        const queuedGeneration = sessionGeneration;
        const queued = bootstrapInFlight.then(() => {
          if (queuedSync === queued) queuedSync = null;
          if (queuedGeneration !== sessionGeneration) return;
          return runSync();
        });
        queuedSync = queued;
      }
      return queuedSync;
    }
    if (runInFlight) return runInFlight;
    const generation = sessionGeneration;
    const pending = executeSync(generation);
    const tracked = pending.finally(() => {
      if (runInFlight === tracked) runInFlight = null;
    });
    runInFlight = tracked;
    return tracked;
  };

  const fetchSnapshot = async (): Promise<CloudSnapshot> => {
    if (!transport) throw new Error('云服务尚未配置');
    return readFullBootstrap(transport);
  };

  const prepareMergePreview = async (
    snapshot: CloudSnapshot,
    session: { generation: number; token: string },
  ) => {
    const localBundle = await repository.exportData();
    const local = visibleCountsFromBundle(localBundle);
    pendingSnapshot = snapshot;
    pendingSession = session;
    update({
      phase: 'choose-merge',
      mergePreview: {
        local,
        remote: snapshotCounts(snapshot),
        boundAccount: state().boundAccount,
      },
    });
  };

  const refreshPush = async (generation?: number) => {
    if (!auth || !webPushSupported()) {
      if (generation === undefined || isCurrentGeneration(generation)) {
        update({ push: { supported: false, available: false, subscribed: false } });
      }
      return;
    }
    try {
      const config = await auth.pushConfig();
      if (generation !== undefined && !isCurrentGeneration(generation)) return;
      const registration = await navigator.serviceWorker.getRegistration('/sw.js');
      const subscription = await registration?.pushManager.getSubscription();
      if (generation !== undefined && !isCurrentGeneration(generation)) return;
      update({
        push: {
          supported: true,
          available: config.enabled,
          subscribed: Boolean(subscription),
        },
      });
    } catch {
      if (generation === undefined || isCurrentGeneration(generation)) {
        update({ push: { supported: true, available: false, subscribed: false } });
      }
    }
  };

  const activateCloud = async (existing?: { generation: number; token: string }) => {
    const session =
      existing && isCurrentGeneration(existing.generation) && sessionToken === existing.token
        ? existing
        : await beginSession();
    const generation = session.generation;
    installEngine(generation, session.token);
    const next = await diagnostics(generation);
    if (!isCurrentGeneration(generation)) return;
    update({
      phase: 'connected',
      syncStatus: 'idle',
      pending: next.pending,
      rejected: next.rejected,
      cursor: next.cursor,
      deviceId: next.deviceId,
      mergePreview: null,
      error: null,
    });
    persist(true);
    void refreshPush(generation);
    unsubscribe?.();
    unsubscribe = repository.subscribeChanges(() => {
      if (!isCurrentGeneration(generation)) return;
      void diagnostics(generation).then((latest) => {
        if (latest.pending > 0 && isCurrentGeneration(generation)) scheduleSync();
      });
    });
    stopOnline?.();
    stopOnline = platform.lifecycle.onOnline(() => {
      if (isCurrentGeneration(generation)) scheduleSync();
    });
    stopResume?.();
    stopResume = platform.lifecycle.onResume(() => {
      if (!isCurrentGeneration(generation)) return;
      scheduleSync();
      void refreshDevices().catch(() => {});
    });
    if (!pollTimer) {
      pollTimer = setInterval(() => {
        if (
          isCurrentGeneration(generation) &&
          state().phase === 'connected' &&
          document.visibilityState === 'visible'
        ) {
          scheduleSync();
        }
      }, 45_000);
    }
    await runSync();
  };

  const initialize = async () => {
    const nextDiagnostics = await diagnostics();
    update({ boundAccount: nextDiagnostics.boundAccount });
    if (!config?.enabled || !config.email) return;
    const initializeGeneration = sessionGeneration;
    buildClients();
    try {
      await refreshAccessToken();
      await repository.syncSetEnabled(true);
      update({ email: config.email, lastSyncedAt: config.lastSyncedAt });
      await activateCloud();
    } catch {
      if (!disposed && sessionGeneration === initializeGeneration) {
        update({
          phase: 'expired',
          syncStatus: 'auth-required',
          email: config.email,
          error: '上次登录已失效，请重新获取验证码。',
        });
      }
    }
  };

  const requestCode = async () => {
    const apiUrl = state().apiUrl.trim().replace(/\/$/, '');
    const email = state().email.trim().toLowerCase();
    if (!/^https?:\/\//.test(apiUrl)) {
      update({ error: 'API 地址必须以 http:// 或 https:// 开头。' });
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      update({ error: '请输入有效的邮箱地址。' });
      return;
    }
    update({ apiUrl, email, busy: 'code', error: null });
    try {
      buildClients();
      await auth!.requestCode(email);
      update({ phase: 'code-sent' });
      persist(false);
    } catch (error) {
      update({ error: error instanceof Error ? error.message : '验证码发送失败' });
    } finally {
      update({ busy: null });
    }
  };

  const verifyCode = async (code: string) => {
    if (!auth) buildClients();
    update({ busy: 'verify', error: null });
    try {
      const deviceId = await repository.syncRotateDevice();
      const tokens = await auth!.verifyCode({
        email: state().email.trim().toLowerCase(),
        code: code.trim(),
        deviceId,
        deviceName: deviceName(platform.lifecycle.platform),
        platform: platform.lifecycle.platform,
      });
      await applyTokens(tokens);
      updateActiveAccountEmail(state().email.trim().toLowerCase());
      await repository.syncSetEnabled(false);
      const nextDiagnostics = await repository.syncGetDiagnostics();
      update({
        deviceId,
        boundAccount: nextDiagnostics.boundAccount,
      });
      if (
        nextDiagnostics.boundAccount &&
        nextDiagnostics.boundAccount.toLowerCase() !== state().email.trim().toLowerCase()
      ) {
        throw new Error(
          `本机数据已绑定 ${nextDiagnostics.boundAccount}。请先在设置中清除本机数据，再登录其他账号。`,
        );
      }
      persist(false);
      const snapshot = await fetchSnapshot();
      const local = visibleCountsFromBundle(await repository.exportData());
      const remote = snapshotCounts(snapshot);
      const session = await beginSession();
      if (local.tasks === 0 && local.lists === 0) {
        await repository.syncInitializeCloud(
          snapshot,
          'cloud',
          state().email.trim().toLowerCase(),
          session.token,
        );
        await activateCloud(session);
      } else {
        await prepareMergePreview(snapshot, session);
      }
      update({ busy: null });
    } catch (error) {
      await invalidateSession();
      pendingSnapshot = null;
      pendingSession = null;
      try {
        if (auth) await auth.logout();
      } catch {
        // Best-effort session cleanup; local error reporting still wins.
      }
      await clearTokens();
      update({
        busy: null,
        error: error instanceof Error ? error.message : '登录失败',
      });
      throw error;
    }
  };

  const chooseMerge = async (mode: CloudMergeMode | 'cancel') => {
    if (mode === 'cancel') {
      update({ phase: 'disconnected', mergePreview: null, error: null });
      pendingSnapshot = null;
      pendingSession = null;
      await invalidateSession();
      try {
        if (auth) await auth.logout();
      } catch {
        // Cancel must work even if the just-created session is already gone.
      }
      await clearTokens();
      persist(false);
      return;
    }
    if (!pendingSnapshot) {
      update({ error: '云端快照已失效，请重新登录。', phase: 'disconnected' });
      return;
    }
    update({ busy: 'merge', error: null });
    try {
      const session = pendingSession ?? (await beginSession());
      await repository.syncInitializeCloud(
        pendingSnapshot,
        mode,
        state().email.trim().toLowerCase(),
        session.token,
      );
      pendingSnapshot = null;
      pendingSession = null;
      await activateCloud(session);
    } catch (error) {
      update({ error: error instanceof Error ? error.message : '合并失败' });
      throw error;
    } finally {
      update({ busy: null });
    }
  };

  const syncNow = async () => {
    if (state().phase !== 'connected') return;
    await runSync();
  };

  const forceBootstrap = async (): Promise<void> => {
    if (state().phase !== 'connected') return;
    if (bootstrapCompletion) return bootstrapCompletion;
    const generation = sessionGeneration;
    const token = sessionToken;
    if (!token) return;

    // The whole bootstrap (wait for old sync -> snapshot -> replace -> cursor
    // diagnostics) is one mutually exclusive operation. While
    // `bootstrapInFlight` is set, every new sync trigger is deferred into a
    // single queued run after the snapshot is installed.
    const core = (async () => {
      if (runInFlight) await runInFlight;
      if (!isCurrentGeneration(generation) || !token) return;
      update({ busy: 'bootstrap', error: null });
      try {
        const snapshot = await fetchSnapshot();
        if (!isCurrentGeneration(generation) || !token) return;
        await repository.syncReplaceSnapshot(snapshot, token);
        if (!isCurrentGeneration(generation)) return;
        await diagnostics(generation);
      } catch (error) {
        if (isCurrentGeneration(generation)) await handleSyncError(error);
      } finally {
        if (isCurrentGeneration(generation)) update({ busy: null });
      }
    })();
    const tracked = core.finally(() => {
      if (bootstrapInFlight === tracked) bootstrapInFlight = null;
    });
    bootstrapInFlight = tracked;

    const completion: Promise<void> = tracked
      .then(async () => {
        if (!isCurrentGeneration(generation)) return;
        const queued = queuedSync;
        if (queued) {
          await queued;
          return;
        }
        await runSync();
      })
      .finally(() => {
        if (bootstrapCompletion === completion) bootstrapCompletion = null;
      });
    bootstrapCompletion = completion;
    return completion;
  };

  const clearRejected = async () => {
    const generation = sessionGeneration;
    update({ busy: 'clear-rejected' });
    try {
      if (!isCurrentGeneration(generation)) return;
      await repository.syncClearRejected();
      if (!isCurrentGeneration(generation)) return;
      await diagnostics(generation);
      await runSync();
    } catch (error) {
      if (isCurrentGeneration(generation)) {
        update({ error: error instanceof Error ? error.message : '清除失败操作失败' });
      }
    } finally {
      if (isCurrentGeneration(generation)) update({ busy: null });
    }
  };

  const discardRejection = async (opId: string) => {
    if (!repository.syncDiscardRejected) {
      update({ error: '当前平台暂不支持单条失败操作回滚，请使用“清除失败操作”。' });
      return;
    }
    const generation = sessionGeneration;
    update({ busy: 'discard-rejection' });
    try {
      if (!isCurrentGeneration(generation)) return;
      await repository.syncDiscardRejected(opId);
      if (!isCurrentGeneration(generation)) return;
      await diagnostics(generation);
    } catch (error) {
      if (isCurrentGeneration(generation)) {
        update({ error: error instanceof Error ? error.message : '回滚失败操作失败' });
      }
    } finally {
      if (isCurrentGeneration(generation)) update({ busy: null });
    }
  };

  const refreshDevices = async () => {
    if (!auth || state().phase !== 'connected') return;
    const generation = sessionGeneration;
    try {
      const devices = await auth.devices();
      if (isCurrentGeneration(generation)) update({ devices });
    } catch {
      // Device listing is diagnostic and not required for sync correctness.
    }
  };

  const revokeDevice = async (deviceId: string) => {
    if (!auth) return;
    await auth.revokeDevice(deviceId);
    if (deviceId === state().deviceId) {
      await signOut(false);
      return;
    }
    await refreshDevices();
  };

  const signOut = async (clearLocal: boolean) => {
    update({ busy: 'logout' });
    // Stop all future work and invalidate the DB fence before touching local
    // data. Any late HTTP response now fails at syncApplyResult time.
    await invalidateSession();
    try {
      if (auth) {
        try {
          // Best-effort server-side revoke. A refresh is deliberately not
          // attempted after invalidation because it could bind new tokens to
          // the session being destroyed.
          await auth.logout();
        } catch {
          // Local sign-out must still work when the access token expired.
        }
      }
      await clearTokens();
      await repository.syncSetEnabled(false);
      if (clearLocal) {
        await repository.clearAll();
        await repository.syncClearAccountBinding();
      }
      update({
        phase: 'disconnected',
        syncStatus: 'idle',
        mergePreview: null,
        pending: 0,
        rejected: 0,
        devices: [],
        error: null,
      });
      persist(false);
    } finally {
      update({ busy: null });
    }
  };

  const deleteAccount = async (clearLocal: boolean) => {
    if (!auth) return;
    await ensureAccessToken();
    await auth.deleteAccount();
    await signOut(clearLocal);
  };

  const downloadLocalBackup = async () => {
    const bundle = await repository.exportData();
    downloadBlob(
      JSON.stringify(bundle, null, 2),
      exportFilename('before-cloud-merge.json'),
      'application/json;charset=utf-8',
    );
  };

  const downloadCloudBackup = async () => {
    if (!auth) throw new Error('云服务尚未登录');
    await ensureAccessToken();
    const bundle = await auth.exportAccount();
    downloadBlob(
      JSON.stringify(bundle, null, 2),
      exportFilename('cloud-backup.json'),
      'application/json;charset=utf-8',
    );
  };

  const downloadDiagnostics = async () => {
    const next = await diagnostics();
    const payload = {
      appVersion: '1.1.0',
      platform: platform.lifecycle.platform,
      generatedAt: new Date().toISOString(),
      cloud: {
        apiUrl: state().apiUrl,
        phase: state().phase,
        deviceId: next.deviceId,
        cursor: next.cursor,
        pending: next.pending,
        rejected: next.rejected,
        lastSyncedAt: state().lastSyncedAt,
      },
      push: state().push,
      recentErrors: state().error ? [state().error] : [],
      rejections: state().rejections.map((item) => ({
        entity: item.entity,
        entityId: item.entityId,
        kind: item.kind,
        fields: Object.keys(item.patch),
        errorCode: item.errorCode,
        createdAt: item.createdAt,
      })),
    };
    downloadBlob(
      JSON.stringify(payload, null, 2),
      exportFilename('diagnostics.json'),
      'application/json;charset=utf-8',
    );
  };

  const enablePush = async () => {
    if (!auth) throw new Error('云服务尚未登录');
    update({ busy: 'push' });
    try {
      await ensureAccessToken();
      const config = await auth.pushConfig();
      if (!config.enabled || !config.public_key) {
        throw new Error('服务器未启用网页推送');
      }
      const subscription = await subscribeWebPush(config.public_key);
      await auth.subscribePush({ ...subscription, user_agent: navigator.userAgent });
      update({
        push: { supported: true, available: true, subscribed: true },
        error: null,
      });
    } finally {
      update({ busy: null });
    }
  };

  const disablePush = async () => {
    if (!auth) return;
    update({ busy: 'push' });
    try {
      const endpoint = await unsubscribeWebPush();
      if (endpoint) await auth.unsubscribePush(endpoint);
      update({ push: { ...state().push, subscribed: false }, error: null });
    } finally {
      update({ busy: null });
    }
  };

  const testPush = async () => {
    if (!auth) throw new Error('云服务尚未登录');
    update({ busy: 'push' });
    try {
      await ensureAccessToken();
      await auth.testPush();
    } finally {
      update({ busy: null });
    }
  };

  const sharedRequest = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    if (!auth) throw new Error('请先在同步设置中登录云端账号');
    await ensureAccessToken();
    return auth.sharedRequest<T>(path, init);
  };

  const dispose = () => {
    disposed = true;
    void invalidateSession();
  };

  return {
    state,
    initialize,
    dispose,
    setApiUrl(value) {
      update({ apiUrl: value, error: null });
    },
    setEmail(value) {
      update({ email: value, error: null });
    },
    requestCode,
    verifyCode,
    chooseMerge,
    syncNow,
    forceBootstrap,
    clearRejected,
    discardRejection,
    refreshDevices,
    revokeDevice,
    signOut,
    deleteAccount,
    downloadLocalBackup,
    downloadCloudBackup,
    downloadDiagnostics,
    enablePush,
    disablePush,
    testPush,
    sharedRequest,
  };
}
