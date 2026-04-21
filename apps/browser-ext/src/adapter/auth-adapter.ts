import type { AuthResult, User } from '@baicie/orbit';

export class ExtAuthStorage {
  readonly mode: 'local' = 'local';

  private readonly USER_KEY = 'unitodo_ext_user';
  private readonly TOKEN_KEY = 'unitodo_ext_token';

  login(_email: string, _password: string): Promise<AuthResult> {
    const localUser: User = {
      id: 0,
      name: 'Local User',
      email: '',
      age: 0,
      role: 'user',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const result: AuthResult = { accessToken: 'local-token', user: localUser };
    this.setAuth(result);
    return Promise.resolve(result);
  }

  register(name: string, email: string, _password: string): Promise<AuthResult> {
    const localUser: User = {
      id: Date.now(),
      name,
      email,
      age: 0,
      role: 'user',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const result: AuthResult = { accessToken: 'local-token', user: localUser };
    this.setAuth(result);
    return Promise.resolve(result);
  }

  getProfile(): Promise<User> {
    const user = this.getStoredUser();
    if (!user) return Promise.reject(new Error('Not authenticated'));
    return Promise.resolve(user);
  }

  getStoredUser(): User | null {
    try {
      const raw = localStorage.getItem(this.USER_KEY);
      return raw ? (JSON.parse(raw) as User) : null;
    } catch {
      return null;
    }
  }

  getStoredToken(): string | null {
    return localStorage.getItem(this.TOKEN_KEY);
  }

  setAuth(result: AuthResult): void {
    localStorage.setItem(this.USER_KEY, JSON.stringify(result.user));
    localStorage.setItem(this.TOKEN_KEY, result.accessToken);
  }

  clearAuth(): void {
    localStorage.removeItem(this.USER_KEY);
    localStorage.removeItem(this.TOKEN_KEY);
  }
}
