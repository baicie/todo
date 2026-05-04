import { Home, Search } from 'lucide-react';

export function NotFound() {
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center">
      <div className="text-center max-w-md mx-auto px-4">
        <div className="text-[120px] font-bold text-gray-100 leading-none select-none mb-2">
          404
        </div>
        <div className="-mt-12 mb-4">
          <Search size={40} className="mx-auto text-gray-300" />
        </div>
        <h1 className="text-2xl font-semibold text-gray-900 mb-2">页面未找到</h1>
        <p className="text-gray-500 mb-8">抱歉，你访问的页面不存在或已被移除。</p>
        <a
          href="/"
          className="inline-flex items-center gap-2 px-6 py-3 bg-blue-500 text-white rounded-xl hover:bg-blue-600 transition-colors font-medium"
        >
          <Home size={16} />
          返回首页
        </a>
      </div>
    </div>
  );
}
