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
  migratedFromLegacy: boolean;
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
  localStorage.setItem(ACTIVE_KEY, id);
  window.location.reload();
}

export function createAndSwitchAccount(apiUrl: string): void {
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
  if (!context || !context.accountId || context.accountId === DEFAULT_ACCOUNT_ID) return;
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
    typeof config?.apiUrl === 'string' ? config.apiUrl : (existingProfile?.apiUrl ?? '');
  saveAccountProfile({
    id: context.accountId,
    email: context.email ?? existingProfile?.email ?? '',
    apiUrl,
    createdAt: existingProfile?.createdAt ?? new Date().toISOString(),
  });
  localStorage.setItem(ACTIVE_KEY, context.accountId);
}
