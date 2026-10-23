export interface AccountProfile {
  id: string;
  email: string;
  apiUrl: string;
  createdAt: string;
}

export interface NativeAccountContext {
  accountId: string;
  kind: 'anonymous' | 'cloud';
  email: string | null;
  apiUrl?: string | null;
  migratedFromLegacy: boolean;
}

export interface NativeAccountSummary {
  id: string;
  kind: 'anonymous' | 'cloud';
  email: string | null;
  apiUrl: string | null;
  pending: boolean;
  active: boolean;
  lastOpenedAt: string;
}

export interface NativeAccountList {
  activeAccountId: string;
  accounts: NativeAccountSummary[];
}

export type NativeSwitchPhase = 'PREPARED' | 'RESTART_REQUIRED' | 'VERIFYING_TARGET' | 'FAILED';

export interface NativeSwitchStatus {
  active: boolean;
  fromAccountId: string | null;
  toAccountId: string | null;
  generation: number | null;
  phase: NativeSwitchPhase | null;
  pendingOutbox: number;
  errorCode: string | null;
}

const PROFILES_KEY = 'shishi.accounts.v1';
const ACTIVE_KEY = 'shishi.active-account.v1';
const LEGACY_CLOUD_CONFIG_KEY = 'shishi.cloud.config';
export const DEFAULT_ACCOUNT_ID = 'default';

export function cloudConfigKey(accountId: string): string {
  return accountId === DEFAULT_ACCOUNT_ID
    ? LEGACY_CLOUD_CONFIG_KEY
    : `${LEGACY_CLOUD_CONFIG_KEY}.${accountId}`;
}

export function loadAccountProfiles(): AccountProfile[] {
  try {
    const raw = localStorage.getItem(PROFILES_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? (parsed as AccountProfile[]) : [];
  } catch {
    return [];
  }
}

export function activeAccountId(): string {
  try {
    return localStorage.getItem(ACTIVE_KEY) ?? DEFAULT_ACCOUNT_ID;
  } catch {
    return DEFAULT_ACCOUNT_ID;
  }
}

export function activeDatabaseName(): string {
  const id = activeAccountId();
  return id === DEFAULT_ACCOUNT_ID ? 'shishi-todo' : `shishi-todo:${id}`;
}

export function activeAccount(): AccountProfile | null {
  return loadAccountProfiles().find((profile) => profile.id === activeAccountId()) ?? null;
}

export function saveAccountProfile(profile: AccountProfile): void {
  const profiles = loadAccountProfiles();
  const existing = profiles.findIndex((item) => item.id === profile.id);
  if (existing >= 0) profiles[existing] = profile;
  else profiles.push(profile);
  localStorage.setItem(PROFILES_KEY, JSON.stringify(profiles));
}

export function updateActiveAccountEmail(email: string): void {
  const id = activeAccountId();
  const existing = activeAccount() ?? {
    id,
    email,
    apiUrl: '',
    createdAt: new Date().toISOString(),
  };
  saveAccountProfile({ ...existing, email });
}

export function switchAccount(id: string): void {
  if (isNativeRuntime()) {
    throw new Error('Native 运行时必须通过 Rust 账号切换协议切换账号');
  }
  localStorage.setItem(ACTIVE_KEY, id);
  window.location.reload();
}

export function createAndSwitchAccount(apiUrl: string): void {
  if (isNativeRuntime()) {
    throw new Error('Native 运行时请使用 native_create_account');
  }
  const profile: AccountProfile = {
    id: crypto.randomUUID(),
    email: '',
    apiUrl,
    createdAt: new Date().toISOString(),
  };
  saveAccountProfile(profile);
  switchAccount(profile.id);
}

export function removeAccountProfile(id: string): void {
  if (id === DEFAULT_ACCOUNT_ID) return;
  if (isNativeRuntime()) {
    throw new Error('Native 运行时账号目录删除需使用独立验收的恢复工具');
  }
  localStorage.setItem(
    PROFILES_KEY,
    JSON.stringify(loadAccountProfiles().filter((profile) => profile.id !== id)),
  );
  if (activeAccountId() === id) switchAccount(DEFAULT_ACCOUNT_ID);
}

function readCloudConfig(accountId: string): { email?: unknown; apiUrl?: unknown } | null {
  try {
    const raw = localStorage.getItem(cloudConfigKey(accountId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object'
      ? (parsed as { email?: unknown; apiUrl?: unknown })
      : null;
  } catch {
    return null;
  }
}

/**
 * Adopt the native account selected before the WebView bundle was loaded.
 *
 * This does not enable account switching. It only keeps localStorage cloud
 * configuration and the module-level account id in sync with the database that
 * the Rust side already opened. Legacy config is copied only when its email
 * matches the verified database binding.
 */
export function adoptNativeAccountContext(context: NativeAccountContext): void {
  if (!context || !context.accountId) return;
  if (context.accountId === DEFAULT_ACCOUNT_ID) {
    // Switching back to the default data space must also reset the WebView's
    // active id; otherwise the old cloud module key would survive a restart.
    localStorage.setItem(ACTIVE_KEY, DEFAULT_ACCOUNT_ID);
    if (!loadAccountProfiles().some((profile) => profile.id === DEFAULT_ACCOUNT_ID)) {
      saveAccountProfile({
        id: DEFAULT_ACCOUNT_ID,
        email: '',
        apiUrl: '',
        createdAt: new Date().toISOString(),
      });
    }
    return;
  }
  const existingProfile = loadAccountProfiles().find((profile) => profile.id === context.accountId);
  const targetConfigKey = cloudConfigKey(context.accountId);
  if (context.migratedFromLegacy && !localStorage.getItem(targetConfigKey)) {
    const legacy = readCloudConfig(DEFAULT_ACCOUNT_ID);
    const legacyEmail = typeof legacy?.email === 'string' ? legacy.email.trim().toLowerCase() : '';
    if (legacy && context.email && legacyEmail === context.email.trim().toLowerCase()) {
      const raw = localStorage.getItem(LEGACY_CLOUD_CONFIG_KEY);
      if (raw) localStorage.setItem(targetConfigKey, raw);
    }
  }
  const config = readCloudConfig(context.accountId);
  const apiUrl =
    typeof config?.apiUrl === 'string'
      ? config.apiUrl
      : (context.apiUrl ?? existingProfile?.apiUrl ?? '');
  if (!localStorage.getItem(targetConfigKey) && context.email && context.apiUrl) {
    localStorage.setItem(
      targetConfigKey,
      JSON.stringify({
        apiUrl,
        email: context.email,
        enabled: false,
        lastSyncedAt: null,
      }),
    );
  }
  saveAccountProfile({
    id: context.accountId,
    email: context.email ?? existingProfile?.email ?? '',
    apiUrl,
    createdAt: existingProfile?.createdAt ?? new Date().toISOString(),
  });
  localStorage.setItem(ACTIVE_KEY, context.accountId);
}

async function invokeNative<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(command, args);
}

export function isNativeRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export async function nativeListAccounts(): Promise<NativeAccountList> {
  return invokeNative<NativeAccountList>('native_list_accounts');
}

export async function nativeCreateAccount(
  email: string,
  apiUrl: string,
): Promise<NativeAccountSummary> {
  return invokeNative<NativeAccountSummary>('native_create_account', { email, apiUrl });
}

export async function nativePrepareAccountSwitch(
  targetAccountId: string,
): Promise<NativeSwitchStatus> {
  return invokeNative<NativeSwitchStatus>('native_prepare_account_switch', {
    targetAccountId,
  });
}

export async function nativeRequestAccountSwitch(
  targetAccountId: string,
  generation: number,
): Promise<NativeSwitchStatus> {
  return invokeNative<NativeSwitchStatus>('native_request_account_switch', {
    targetAccountId,
    generation,
  });
}

export async function nativeAbortAccountSwitch(): Promise<void> {
  await invokeNative('native_abort_account_switch');
}

export async function nativeAccountSwitchStatus(): Promise<NativeSwitchStatus> {
  return invokeNative<NativeSwitchStatus>('native_account_switch_status');
}

/** Persist a profile/config shell for a freshly added account before switching. */
export function rememberNativeAccount(account: NativeAccountSummary): void {
  const existing = loadAccountProfiles().find((profile) => profile.id === account.id);
  saveAccountProfile({
    id: account.id,
    email: account.email ?? '',
    apiUrl: account.apiUrl ?? '',
    createdAt: existing?.createdAt ?? new Date().toISOString(),
  });
  const configKey = cloudConfigKey(account.id);
  if (!localStorage.getItem(configKey)) {
    localStorage.setItem(
      configKey,
      JSON.stringify({
        apiUrl: account.apiUrl ?? '',
        email: account.email ?? '',
        enabled: false,
        lastSyncedAt: null,
      }),
    );
  }
}
