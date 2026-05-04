import { useState } from 'react';
import { useAuth } from '@baicie/orbit-hooks';
import { Button, Input } from '@baicie/orbit-ui';

export function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const { login } = useAuth();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      await login(email, password);
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { message?: string } } };
      setError(axiosErr.response?.data?.message || '登录失败');
    }
  };

  const handleGuestLogin = async () => {
    try {
      await login('guest', '');
    } catch {
      // ignore
    }
  };

  return (
    <div className="w-full h-full flex items-center justify-center bg-gray-50 p-4">
      <form onSubmit={handleSubmit} className="w-full max-w-[280px] space-y-3">
        <h1 className="text-xl font-bold text-center text-gray-800">Orbit</h1>
        <p className="text-sm text-gray-500 text-center">登录以同步任务</p>
        {error && <p className="text-xs text-red-500 text-center">{error}</p>}
        <Input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="邮箱"
          className="w-full"
        />
        <Input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="密码"
          className="w-full"
        />
        <Button type="submit" className="w-full">
          登录
        </Button>
        <Button type="button" variant="outline" onClick={handleGuestLogin} className="w-full">
          游客模式
        </Button>
        <p className="text-xs text-gray-400 text-center">不登录也可以使用，任务保存在本地</p>
      </form>
    </div>
  );
}
