import type { ReactNode } from 'react';
import { useAuth as useAuthHook } from '@baicie/orbit-hooks';
import type { User } from '@baicie/orbit';
import type { StorageMode } from '@baicie/orbit';

interface AuthContextType {
  user: User | null;
  isLoading: boolean;
  storageMode: StorageMode;
  login: (email: string, password: string) => Promise<{ accessToken: string; user: User }>;
  logout: () => void;
  register: (
    name: string,
    email: string,
    password: string,
  ) => Promise<{ accessToken: string; user: User }>;
}

import { createContext, useContext } from 'react';

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const auth = useAuthHook();

  const value: AuthContextType = {
    user: auth.user,
    isLoading: auth.isLoading,
    storageMode: auth.storageMode,
    login: auth.login,
    logout: auth.logout,
    register: auth.register,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
