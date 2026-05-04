import { useState } from 'react';
import { useAuth } from '@baicie/orbit-hooks';
import {
  useCreateTask,
  useDeleteTask,
  useTask,
  useToggleComplete,
  useToggleImportant,
} from '@baicie/orbit-hooks';
import type { TaskFilter } from '@baicie/orbit';
import { Button, Input } from '@baicie/orbit-ui';
import { Calendar, Check, List, Plus, Search, Star, Sun } from 'lucide-react';

interface TaskListProps {
  filter: 'all' | 'today' | 'important';
  onFilterChange: (filter: 'all' | 'today' | 'important') => void;
}

export function TaskList({ filter, onFilterChange }: TaskListProps) {
  const { user, logout } = useAuth();
  const [newTask, setNewTask] = useState('');
  void user;
  void logout;

  const taskFilter: TaskFilter = {
    ...(filter === 'today' ? { addToMyDay: true } : {}),
    ...(filter === 'important' ? { isImportant: true } : {}),
  };

  const { data: tasks = [] } = useTask(taskFilter);
  const createTask = useCreateTask();
  const toggleComplete = useToggleComplete();
  const toggleImportant = useToggleImportant();
  const deleteTask = useDeleteTask();

  const activeTasks = tasks.filter((t) => !t.isCompleted);
  const completedTasks = tasks.filter((t) => t.isCompleted);

  const handleAddTask = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTask.trim()) return;
    createTask.mutate(
      { title: newTask, ...(filter === 'today' ? { addToMyDay: true } : {}) },
      { onSuccess: () => setNewTask('') },
    );
  };

  return (
    <>
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-200 bg-white">
        <div className="flex items-center gap-2">
          <span className="text-sm font-bold text-blue-500">Orbit</span>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" className="p-1">
            <Search size={16} />
          </Button>
          <Button variant="ghost" size="sm" onClick={logout} className="text-xs">
            {user?.name || '退出'}
          </Button>
        </div>
      </div>

      {/* Filter Tabs */}
      <div className="flex border-b border-gray-200 bg-white">
        {(
          [
            { key: 'all', label: '全部', Icon: List },
            { key: 'today', label: '今天', Icon: Sun },
            { key: 'important', label: '重要', Icon: Star },
          ] as const
        ).map(({ key, label, Icon }) => (
          <Button
            key={key}
            variant="ghost"
            size="sm"
            onClick={() => onFilterChange(key)}
            className={`flex-1 justify-center gap-1 ${
              filter === key
                ? 'text-blue-500 border-b-2 border-blue-500 rounded-none'
                : 'text-gray-500'
            }`}
          >
            <Icon size={14} />
            {label}
          </Button>
        ))}
      </div>

      {/* Add Task */}
      <form onSubmit={handleAddTask} className="px-3 py-2 bg-white border-b border-gray-200">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" className="p-0 text-gray-400" type="button">
            <Plus size={18} />
          </Button>
          <Input
            type="text"
            value={newTask}
            onChange={(e) => setNewTask(e.target.value)}
            placeholder="添加任务..."
            className="flex-1 shadow-none bg-transparent"
          />
          {newTask && (
            <Button
              type="submit"
              variant="ghost"
              size="sm"
              className="text-xs text-blue-500 font-medium"
            >
              添加
            </Button>
          )}
        </div>
      </form>

      {/* Task List */}
      <div className="flex-1 overflow-y-auto">
        {activeTasks.length === 0 && completedTasks.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-gray-400">
            <List size={32} className="mb-2 opacity-50" />
            <p className="text-sm">暂无任务</p>
          </div>
        )}

        {activeTasks.map((task) => (
          <div
            key={task.id}
            className="flex items-center gap-2 px-3 py-2.5 hover:bg-gray-100 transition-colors group"
          >
            <Button
              variant="ghost"
              size="icon"
              onClick={() => toggleComplete(task)}
              className="w-5 h-5 min-w-5 min-h-5 p-0 rounded-full border-2 border-gray-300 hover:border-blue-500 flex-shrink-0 transition-colors"
            />
            <span className="flex-1 text-sm text-gray-800 line-clamp-1">{task.title}</span>
            {task.dueDate && (
              <span className="text-xs text-gray-400 flex-shrink-0">
                <Calendar size={12} />
              </span>
            )}
            <Button
              variant="ghost"
              size="icon"
              onClick={() => toggleImportant(task)}
              className={`flex-shrink-0 w-5 h-5 min-w-5 min-h-5 p-0 ${
                task.isImportant ? 'text-yellow-500' : 'text-gray-300'
              }`}
            >
              <Star size={14} fill={task.isImportant ? 'currentColor' : 'none'} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => deleteTask.mutate(task.id)}
              className="flex-shrink-0 text-gray-300 hover:text-red-500 opacity-0 group-hover:opacity-100 w-5 h-5 min-w-5 min-h-5 p-0"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </Button>
          </div>
        ))}

        {completedTasks.length > 0 && (
          <div className="border-t border-gray-200">
            <div className="px-3 py-1.5 text-xs text-gray-400">{completedTasks.length} 已完成</div>
            {completedTasks.map((task) => (
              <div
                key={task.id}
                className="flex items-center gap-2 px-3 py-2 hover:bg-gray-100 transition-colors group"
              >
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => toggleComplete(task)}
                  className="w-5 h-5 min-w-5 min-h-5 p-0 rounded-full bg-blue-500 border-blue-500 flex-shrink-0"
                >
                  <Check size={12} className="text-white" strokeWidth={3} />
                </Button>
                <span className="flex-1 text-sm text-gray-400 line-through line-clamp-1">
                  {task.title}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => deleteTask.mutate(task.id)}
                  className="flex-shrink-0 text-gray-300 hover:text-red-500 opacity-0 group-hover:opacity-100 w-5 h-5 min-w-5 min-h-5 p-0"
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
