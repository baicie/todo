import { Calendar, Home, List as ListIcon, Plus, Search, Star, Sun, User } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import api from '../lib/api';
import { useAuth } from '../contexts/AuthContext';
import { useState } from 'react';

interface List {
  id: string;
  title: string;
  icon?: string;
  isSmart: boolean;
}

export const Sidebar = ({
  activeListId,
  onListSelect,
}: {
  activeListId: string;
  onListSelect: (id: string) => void;
}) => {
  const { user } = useAuth();
  const [isCreating, setIsCreating] = useState(false);
  const [newListTitle, setNewListTitle] = useState('');
  const queryClient = useQueryClient();

  const { data: lists } = useQuery<List[]>({
    queryKey: ['lists'],
    queryFn: async () => {
      const response = await api.get('/lists');
      // 确保返回的是数组，如果后端返回结构包裹在 data 字段中，需要解构
      // 假设后端返回 { success: true, data: [...] } 或直接 [...]
      const data = response.data;
      if (Array.isArray(data)) return data;
      if (data && Array.isArray(data.data)) return data.data;
      return [];
    },
    enabled: !!user,
  });

  const createListMutation = useMutation({
    mutationFn: (title: string) => {
      return api.post('/lists', { title });
    },
    onSuccess: (response) => {
      queryClient.invalidateQueries({ queryKey: ['lists'] });
      setIsCreating(false);
      setNewListTitle('');
      // 创建成功后自动选中新清单
      if (response.data && response.data.id) {
        onListSelect(response.data.id);
      } else if (response.data && response.data.data && response.data.data.id) {
        onListSelect(response.data.data.id);
      }
    },
  });

  const handleCreateList = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newListTitle.trim()) return;
    createListMutation.mutate(newListTitle);
  };

  const smartLists = [
    { id: 'my-day', icon: Sun, label: '我的一天' },
    { id: 'important', icon: Star, label: '重要' },
    { id: 'planned', icon: Calendar, label: '已计划' },
    { id: 'tasks', icon: Home, label: '任务' },
  ];

  return (
    <div className="w-[280px] h-full bg-[var(--sidebar-bg)] flex flex-col border-r border-gray-200">
      {/* User Profile */}
      <div className="p-4 flex items-center gap-3 hover:bg-[var(--sidebar-hover)] cursor-pointer transition-colors">
        <div className="w-8 h-8 rounded-full bg-gray-300 flex items-center justify-center text-gray-600">
          <User size={18} />
        </div>
        <div>
          <div className="text-sm font-medium text-gray-900">{user?.name || 'Guest'}</div>
          <div className="text-xs text-gray-500">{user?.email || 'Please login'}</div>
        </div>
      </div>

      {/* Search */}
      <div className="px-4 mb-2">
        <div className="relative">
          <input
            type="text"
            placeholder="搜索"
            className="w-full h-9 pl-9 pr-3 rounded bg-white border border-gray-200 focus:outline-none focus:border-[var(--theme-primary)] text-sm"
          />
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
        </div>
      </div>

      {/* Smart Lists */}
      <div className="flex-1 overflow-y-auto py-2">
        <div className="space-y-0.5">
          {smartLists.map((item) => (
            <div
              key={item.id}
              onClick={() => onListSelect(item.id)}
              className={`px-4 py-2.5 flex items-center gap-3 cursor-pointer transition-colors ${
                activeListId === item.id
                  ? 'bg-[var(--sidebar-hover)] text-[var(--theme-primary)]'
                  : 'text-gray-700 hover:bg-[var(--sidebar-hover)]'
              }`}
            >
              <item.icon size={20} strokeWidth={1.5} />
              <span className="flex-1 text-sm">{item.label}</span>
            </div>
          ))}
        </div>

        <div className="my-3 border-t border-gray-200 mx-4" />

        {/* Custom Lists */}
        <div className="space-y-0.5">
          {lists?.map((list) => (
            <div
              key={list.id}
              onClick={() => onListSelect(list.id)}
              className={`px-4 py-2.5 flex items-center gap-3 cursor-pointer transition-colors ${
                activeListId === list.id
                  ? 'bg-[var(--sidebar-hover)] text-[var(--theme-primary)]'
                  : 'text-gray-700 hover:bg-[var(--sidebar-hover)]'
              }`}
            >
              <ListIcon size={20} strokeWidth={1.5} />
              <span className="flex-1 text-sm">{list.title}</span>
            </div>
          ))}
        </div>
      </div>

      {/* New List Button */}
      <div className="p-3">
        {isCreating ? (
          <form onSubmit={handleCreateList} className="w-full">
            <input
              type="text"
              value={newListTitle}
              onChange={(e) => setNewListTitle(e.target.value)}
              placeholder="清单名称"
              autoFocus
              className="w-full px-3 py-2 border border-[var(--theme-primary)] rounded focus:outline-none text-sm bg-white"
              onBlur={() => {
                if (!newListTitle.trim()) setIsCreating(false);
              }}
            />
          </form>
        ) : (
          <button
            onClick={() => setIsCreating(true)}
            className="w-full flex items-center gap-2 px-3 py-2 text-[var(--theme-primary)] hover:bg-[var(--sidebar-hover)] rounded transition-colors"
          >
            <Plus size={20} />
            <span className="text-sm font-medium">新建清单</span>
          </button>
        )}
      </div>
    </div>
  );
};
