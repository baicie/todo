import type {
  AppLifecycle,
  DesktopSettings,
  ReminderScheduler,
  SecureTokenStore,
} from '@todo/application';
import { DexieTaskRepository } from './web-repository';
import { WebReminderScheduler } from './web-reminder';
import { TauriTaskRepository } from './tauri-repository';
import { activeDatabaseName } from '../lib/accounts';

export type ThemePreference = 'system' | 'light' | 'dark';

export interface AppPlatform {
  kind: 'web' | 'tauri';
  repository: DexieTaskRepository | TauriTaskRepository;
  reminder: ReminderScheduler;
  secureTokenStore: SecureTokenStore;
  lifecycle: AppLifecycle;
  setBadge(count: number): Promise<void>;
}

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function detectPlatform(): AppLifecycle['platform'] {
  if (typeof navigator === 'undefined') return 'web';
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes('android')) return isTauri() ? 'android' : 'web';
  if (/iphone|ipad|ipod/.test(ua)) return isTauri() ? 'ios' : 'web';
  if (isTauri()) {
    if (ua.includes('mac')) return 'macos';
    if (ua.includes('linux')) return 'linux';
    return 'windows';
  }
  return 'web';
}

class LocalTokenStore implements SecureTokenStore {
  async get(key: string): Promise<string | null> {
    try {
      return localStorage.getItem(`shishi.token.${key}`);
    } catch {
      return null;
    }
  }

  async set(key: string, value: string): Promise<void> {
    localStorage.setItem(`shishi.token.${key}`, value);
  }

  async remove(key: string): Promise<void> {
    localStorage.removeItem(`shishi.token.${key}`);
  }
}

class TauriTokenStore implements SecureTokenStore {
  async get(key: string): Promise<string | null> {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      return await invoke<string | null>('secure_token_get', { key });
    } catch {
      return null;
    }
  }

  async set(key: string, value: string): Promise<void> {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('secure_token_set', { key, value });
  }

  async remove(key: string): Promise<void> {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('secure_token_remove', { key });
    } catch {
      // Removing an absent credential is intentionally idempotent.
    }
  }
}

function createLifecycle(kind: 'web' | 'tauri'): AppLifecycle {
  const platform = detectPlatform();
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai';
  const resumeListeners = new Set<() => void>();
  const onlineListeners = new Set<() => void>();
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        resumeListeners.forEach((listener) => listener());
      }
    });
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('online', () => onlineListeners.forEach((listener) => listener()));
  }
  return {
    platform: kind === 'tauri' ? platform : 'web',
    timeZone,
    desktop:
      kind === 'tauri' && (platform === 'windows' || platform === 'macos' || platform === 'linux')
        ? {
            async getSettings() {
              const { invoke } = await import('@tauri-apps/api/core');
              return invoke<DesktopSettings>('get_desktop_settings');
            },
            async setCloseToTray(enabled: boolean) {
              const { invoke } = await import('@tauri-apps/api/core');
              await invoke('set_close_to_tray', { enabled });
            },
            async setAutostart(enabled: boolean) {
              const { invoke } = await import('@tauri-apps/api/core');
              await invoke('set_autostart', { enabled });
            },
          }
        : undefined,
    onResume(callback) {
      resumeListeners.add(callback);
      return () => resumeListeners.delete(callback);
    },
    onOnline(callback) {
      onlineListeners.add(callback);
      return () => onlineListeners.delete(callback);
    },
  };
}

export async function createAppPlatform(): Promise<AppPlatform> {
  if (isTauri()) {
    const repository = new TauriTaskRepository();
    await repository.initialize();
    const { TauriReminderScheduler } = await import('./tauri-reminder');
    const reminder = new TauriReminderScheduler();
    return {
      kind: 'tauri',
      repository,
      reminder,
      secureTokenStore: new TauriTokenStore(),
      lifecycle: createLifecycle('tauri'),
      async setBadge(count) {
        try {
          const { invoke } = await import('@tauri-apps/api/core');
          await invoke('set_badge_count', { count });
        } catch {
          // Badge count is an enhancement and may be unavailable.
        }
      },
    };
  }

  const repository = new DexieTaskRepository(activeDatabaseName());
  await repository.initialize();
  const reminder = new WebReminderScheduler();
  return {
    kind: 'web',
    repository,
    reminder,
    secureTokenStore: new LocalTokenStore(),
    lifecycle: createLifecycle('web'),
    async setBadge(count) {
      const nav = navigator as Navigator & { setAppBadge?: (value?: number) => Promise<void> };
      if (typeof nav.setAppBadge === 'function') {
        try {
          if (count > 0) await nav.setAppBadge(count);
          else await nav.clearAppBadge?.();
        } catch {
          // Not supported by this browser.
        }
      }
    },
  };
}
