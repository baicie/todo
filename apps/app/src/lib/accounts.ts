export interface AccountProfile {
  id: string;
  email: string;
  apiUrl: string;
  createdAt: string;
}

const PROFILES_KEY = 'shishi.accounts.v1';
const ACTIVE_KEY = 'shishi.active-account.v1';
export const DEFAULT_ACCOUNT_ID = 'default';

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
