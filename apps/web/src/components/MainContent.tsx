import { MoreHorizontal, Plus, Star, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import api from '../lib/api';

interface Task {
  id: string;
  title: string;
  isCompleted: boolean;
  isImportant: boolean;
  listId?: string;
}

export const MainContent = ({ activeListId }: { activeListId: string }) => {
  const [newTask, setNewTask] = useState('');
  const queryClient = useQueryClient();

  const { data: tasks = [] } = useQuery<Task[]>({
    queryKey: ['tasks', activeListId],
    queryFn: async () => {
      // 构建查询参数
      const params: any = {};

      const isSmartList = ['my-day', 'important', 'planned', 'tasks'].includes(activeListId);

      if (!isSmartList) {
        // 如果是普通清单，按 listId 筛选
        params.listId = activeListId;
      } else {
        // 如果是智能清单
        if (activeListId === 'my-day') params.addToMyDay = true;
        if (activeListId === 'important') params.isImportant = true;
        if (activeListId === 'planned') params.hasDueDate = true;
        // 'tasks' 默认显示所有未分类任务，或者所有任务。这里我们暂定显示所有任务，或者可以添加 isCompleted=false 默认只看未完成的
      }

      const response = await api.get('/tasks', { params });
      const data = response.data;
      if (Array.isArray(data)) return data;
      if (data && Array.isArray(data.data)) return data.data;
      return [];
    },
  });

  const createTaskMutation = useMutation({
    mutationFn: (title: string) => {
      const isSmartList = ['my-day', 'important', 'planned', 'tasks'].includes(activeListId);

      const payload: any = { title };

      if (!isSmartList) {
        payload.listId = activeListId;
      }

      if (activeListId === 'my-day') {
        payload.addToMyDay = true;
      }

      if (activeListId === 'important') {
        payload.isImportant = true;
      }

      return api.post('/tasks', payload);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
      setNewTask('');
    },
  });

  const toggleTaskMutation = useMutation({
    mutationFn: ({ id, isCompleted }: { id: string; isCompleted: boolean }) => {
      return api.patch(`/tasks/${id}`, { isCompleted });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
    },
  });

  const toggleImportanceMutation = useMutation({
    mutationFn: ({ id, isImportant }: { id: string; isImportant: boolean }) => {
      return api.patch(`/tasks/${id}`, { isImportant });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
    },
  });

  const deleteTaskMutation = useMutation({
    mutationFn: (id: string) => {
      return api.delete(`/tasks/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
    },
  });

  const handleAddTask = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTask.trim()) return;
    createTaskMutation.mutate(newTask);
  };

  const getTitle = () => {
    if (activeListId === 'my-day') return '我的一天';
    if (activeListId === 'important') return '重要';
    if (activeListId === 'planned') return '已计划';
    if (activeListId === 'tasks') return '任务';
    // 尝试查找自定义清单标题（需要从 Sidebar 获取或在全局状态中管理，这里简化处理）
    return '清单';
  };

  return (
    <div className="flex-1 h-full flex flex-col bg-[var(--theme-bg)] relative overflow-hidden">
      {/* Header */}
      <header className="px-8 pt-8 pb-4 flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2 text-[var(--theme-primary)] mb-1">
            <h1 className="text-3xl font-bold">{getTitle()}</h1>
          </div>
          <div className="text-sm text-gray-500">
            {new Date().toLocaleDateString('zh-CN', {
              weekday: 'long',
              month: 'long',
              day: 'numeric',
            })}
          </div>
        </div>
        <button className="p-2 hover:bg-gray-100 rounded text-gray-600">
          <MoreHorizontal size={20} />
        </button>
      </header>

      {/* Task List */}
      <div className="flex-1 overflow-y-auto px-8 pb-24">
        <div className="space-y-1">
          {tasks?.map((task) => (
            <div
              key={task.id}
              className="group bg-white rounded-md shadow-sm border border-gray-100 p-3 flex items-center gap-3 hover:bg-gray-50 transition-colors cursor-pointer"
            >
              <button
                onClick={() =>
                  toggleTaskMutation.mutate({
                    id: task.id,
                    isCompleted: !task.isCompleted,
                  })
                }
                className={`w-5 h-5 rounded-full border-2 flex items-center justify-center transition-colors ${
                  task.isCompleted
                    ? 'bg-[var(--theme-primary)] border-[var(--theme-primary)]'
                    : 'border-gray-400 hover:border-[var(--theme-primary)]'
                }`}
              >
                {task.isCompleted && (
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="3"
                    className="w-3 h-3 text-white"
                  >
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                )}
              </button>
              <span
                className={`flex-1 text-sm ${
                  task.isCompleted ? 'text-gray-400 line-through' : 'text-gray-700'
                }`}
              >
                {task.title}
              </span>

              <button
                onClick={() =>
                  toggleImportanceMutation.mutate({
                    id: task.id,
                    isImportant: !task.isImportant,
                  })
                }
                className={`p-1.5 rounded hover:bg-gray-100 transition-colors ${
                  task.isImportant
                    ? 'text-[var(--theme-primary)]'
                    : 'text-gray-400 opacity-0 group-hover:opacity-100'
                }`}
              >
                <Star size={18} fill={task.isImportant ? 'currentColor' : 'none'} />
              </button>

              <button
                onClick={() => deleteTaskMutation.mutate(task.id)}
                className="p-1.5 rounded hover:bg-red-50 text-gray-400 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-all"
                title="删除任务"
              >
                <Trash2 size={18} />
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Add Task Input */}
      <div className="absolute bottom-0 left-0 right-0 p-6 bg-gradient-to-t from-[var(--theme-bg)] via-[var(--theme-bg)] to-transparent">
        <form
          onSubmit={handleAddTask}
          className="bg-white/80 backdrop-blur-md rounded-md shadow-lg border border-gray-200 p-3 flex items-center gap-3 focus-within:ring-2 focus-within:ring-[var(--theme-primary)] transition-all"
        >
          <Plus className="text-[var(--theme-primary)]" size={24} />
          <input
            type="text"
            value={newTask}
            onChange={(e) => setNewTask(e.target.value)}
            placeholder="添加任务"
            className="flex-1 bg-transparent border-none outline-none text-sm placeholder:text-gray-500 text-gray-700"
          />
          {newTask && (
            <button
              type="submit"
              disabled={createTaskMutation.isPending}
              className="text-xs font-medium text-[var(--theme-primary)] uppercase px-2"
            >
              {createTaskMutation.isPending ? '添加中...' : '添加'}
            </button>
          )}
        </form>
      </div>
    </div>
  );
};
