import { useCallback, useEffect, useRef, useState } from 'react';
import type { IAuthStorage, IStorage, StorageConfig, StorageMode } from '@baicie/orbit';
import { LocalStorage, RemoteStorage } from '@baicie/orbit';

let globalStorage: IStorage | null = null;
let globalAuthStorage: IAuthStorage | null = null;

const CONFIG_KEY = 'unitodo_storage_config';

function loadConfig(): StorageConfig {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (raw) return JSON.parse(raw) as StorageConfig;
  } catch {
    // ignore
  }
  return { mode: 'local' as StorageMode };
}

function saveConfig(config: StorageConfig) {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
}

export function createStorage(config: StorageConfig): IStorage {
  if (config.mode === 'local') {
    return new LocalStorage(config);
  }
  return new RemoteStorage(config);
}

export function getStorage(): IStorage {
  if (!globalStorage) {
    const config = loadConfig();
    globalStorage = createStorage(config);
    globalAuthStorage = globalStorage.auth;
  }
  return globalStorage;
}

export function switchStorageMode(mode: StorageMode, apiBaseUrl?: string): void {
  const config: StorageConfig = {
    mode,
    apiBaseUrl: apiBaseUrl ?? 'http://localhost:3001/api',
    syncOnReconnect: true,
    conflictStrategy: 'local-wins',
  };
  globalStorage = createStorage(config);
  globalAuthStorage = globalStorage.auth;
  saveConfig(config);
}

// ============================================================================
// useStorage — 获取当前 storage 实例
// ============================================================================

export function useStorage(): IStorage {
  return getStorage();
}

// ============================================================================
// useAuth — 认证状态管理
// ============================================================================

export interface AuthState {
  user: import('@baicie/orbit').User | null;
  token: string | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  storageMode: StorageMode;
}

export function useAuth() {
  const storage = useStorage();
  const [state, setState] = useState<AuthState>(() => ({
    user: storage.auth.getStoredUser(),
    token: storage.auth.getStoredToken(),
    isLoading: true,
    isAuthenticated: storage.auth.getStoredUser() !== null,
    storageMode: storage.config.mode,
  }));

  useEffect(() => {
    const checkAuth = async () => {
      const user = storage.auth.getStoredUser();
      const token = storage.auth.getStoredToken();

      if (token && user) {
        if (storage.config.mode === 'remote') {
          try {
            const profile = await storage.auth.getProfile();
            setState((s) => ({
              ...s,
              user: profile,
              isLoading: false,
              isAuthenticated: true,
            }));
          } catch {
            storage.auth.clearAuth();
            setState((s) => ({
              ...s,
              user: null,
              token: null,
              isLoading: false,
              isAuthenticated: false,
            }));
          }
        } else {
          setState((s) => ({ ...s, user, token, isLoading: false }));
        }
      } else {
        setState((s) => ({ ...s, isLoading: false }));
      }
    };

    checkAuth();
  }, [storage]);

  const login = useCallback(
    async (email: string, password: string) => {
      const result = await storage.auth.login(email, password);
      setState({
        user: result.user,
        token: result.accessToken,
        isLoading: false,
        isAuthenticated: true,
        storageMode: storage.config.mode,
      });
      return result;
    },
    [storage],
  );

  const register = useCallback(
    async (name: string, email: string, password: string) => {
      const result = await storage.auth.register(name, email, password);
      return result;
    },
    [storage],
  );

  const logout = useCallback(() => {
    storage.auth.clearAuth();
    setState((s) => ({
      ...s,
      user: null,
      token: null,
      isLoading: false,
      isAuthenticated: false,
    }));
  }, [storage]);

  const switchMode = useCallback((mode: StorageMode, apiBaseUrl?: string) => {
    switchStorageMode(mode, apiBaseUrl);
    const newStorage = getStorage();
    setState((s) => ({
      ...s,
      user: newStorage.auth.getStoredUser(),
      token: newStorage.auth.getStoredToken(),
      storageMode: newStorage.config.mode,
      isAuthenticated: newStorage.auth.getStoredUser() !== null,
    }));
  }, []);

  return {
    ...state,
    login,
    register,
    logout,
    switchMode,
    storage,
  };
}
