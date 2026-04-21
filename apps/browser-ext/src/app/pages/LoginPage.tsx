import { useState } from 'react';
import { useExtAuth } from '../../contexts/AuthContext';

export function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const { login } = useExtAuth();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await login(email, password);
    } catch {
      // ignore
    }
  };

  return (
    <div className="w-full h-full flex items-center justify-center bg-gray-50 p-4">
      <form onSubmit={handleSubmit} className="w-full max-w-[280px] space-y-3">
        <h1 className="text-xl font-bold text-center text-gray-800">Orbit</h1>
        <p className="text-sm text-gray-500 text-center">登录以同步任务</p>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="邮箱"
          className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 text-gray-900 bg-white"
        />
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="密码"
          className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 text-gray-900 bg-white"
        />
        <button
          type="submit"
          className="w-full py-2 bg-blue-500 text-white rounded-md text-sm font-medium hover:bg-blue-600 transition-colors"
        >
          登录
        </button>
        <p className="text-xs text-gray-400 text-center">或直接使用，任务将保存在本地</p>
      </form>
    </div>
  );
}
