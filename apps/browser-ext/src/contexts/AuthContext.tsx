import { type ReactNode, createContext, useContext, useState } from 'react';
import { ExtAuthStorage } from '../adapter';

interface User {
  id: number;
  name: string;
  email: string;
  age: number;
  role: string;
}

interface AuthContextType {
  user: User | null;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<{ accessToken: string; user: User }>;
  logout: () => void;
  register: (
    name: string,
    email: string,
    password: string,
  ) => Promise<{ accessToken: string; user: User }>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

interface AuthProviderProps {
  children: ReactNode;
  initialUser?: User | null;
}

export function AuthProvider({ children, initialUser }: AuthProviderProps) {
  const authStorage = new ExtAuthStorage();
  const [user, setUser] = useState<User | null>(() => initialUser ?? authStorage.getStoredUser());
  const [isLoading, setIsLoading] = useState(false);

  const login = async (email: string, _password: string) => {
    setIsLoading(true);
    try {
      const result = await authStorage.login(email, _password);
      setUser(result.user);
      return result;
    } finally {
      setIsLoading(false);
    }
  };

  const register = async (name: string, email: string, _password: string) => {
    setIsLoading(true);
    try {
      const result = await authStorage.register(name, email, _password);
      setUser(result.user);
      return result;
    } finally {
      setIsLoading(false);
    }
  };

  const logout = () => {
    authStorage.clearAuth();
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, isLoading, login, logout, register }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useExtAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useExtAuth must be used within an AuthProvider');
  }
  return context;
}
