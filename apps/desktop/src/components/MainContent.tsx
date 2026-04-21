import {
  ArrowUpDown,
  Bell,
  Calendar,
  ChevronRight,
  Grid2X2,
  LayoutGrid,
  List as ListIcon,
  Menu,
  MoreHorizontal,
  Plus,
  Repeat,
  Star,
  UserPlus,
} from 'lucide-react';
import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router-dom';
import {
  useCreateTask,
  useDeleteTask,
  useTask,
  useToggleComplete,
  useToggleImportant,
  useToggleMyDay,
  useUpdateTask,
} from '@baicie/orbit-hooks';
import { TaskDetailDrawer } from './TaskDetailDrawer';
import { Sidebar } from './Sidebar';
import type { Task, TaskFilter } from '@baicie/orbit';

export function MainContent() {
  const { listId } = useParams();
  const activeListId = listId || 'my-day';
  const { t } = useTranslation();
  const [newTask, setNewTask] = useState('');
  const [isInputFocused, setIsInputFocused] = useState(false);
  const [isCompletedCollapsed, setIsCompletedCollapsed] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [viewMode, setViewMode] = useState<'list' | 'table'>('list');

  const filter = buildFilter(activeListId);
  const { data: tasks = [] } = useTask(filter);

  const createTask = useCreateTask();
  const updateTask = useUpdateTask();
  const deleteTask = useDeleteTask();
  const toggleComplete = useToggleComplete();
  const toggleImportant = useToggleImportant();
  const toggleMyDay = useToggleMyDay();

  const handleAddTask = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTask.trim()) return;
    const isSmartList = ['my-day', 'important', 'planned', 'tasks'].includes(activeListId);
    const payload: { title: string; listId?: string; addToMyDay?: boolean; isImportant?: boolean } =
      { title: newTask };
    if (activeListId === 'my-day') payload.addToMyDay = true;
    if (activeListId === 'important') payload.isImportant = true;
    if (!isSmartList) payload.listId = activeListId;
    createTask.mutate(payload);
    setNewTask('');
  };

  const getTitle = () => {
    if (activeListId === 'my-day') return t('sidebar.myDay');
    if (activeListId === 'important') return t('sidebar.important');
    if (activeListId === 'planned') return t('sidebar.planned');
    if (activeListId === 'tasks') return t('sidebar.tasks');
    return t('app.title');
  };

  const activeTasks = tasks.filter((task) => !task.isCompleted);
  const completedTasks = tasks.filter((task) => task.isCompleted);
  const selectedTask = tasks.find((task) => task.id === selectedTaskId) || null;

  const getDueDateText = (dateStr?: string | null) => {
    if (!dateStr) return { text: '-', isOverdue: false };
    const date = new Date(dateStr);
    const today = new Date();
    const isToday = date.toDateString() === today.toDateString();
    const isOverdue = date < today && !isToday;
    let text = date.toLocaleDateString();
    if (isToday) text = '今天';
    return { text, isOverdue };
  };

  return (
    <div className="flex-1 h-full flex flex-row overflow-hidden relative">
      <div className="flex-1 h-full flex flex-col bg-[var(--theme-bg)] overflow-hidden">
        <header className="px-4 sm:px-8 pt-6 sm:pt-8 pb-4">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-4">
              <button
                className="p-2 text-gray-600 hover:bg-gray-100 rounded-md"
                onClick={() => setIsSidebarOpen(true)}
              >
                <Menu size={24} />
              </button>
              <div className="flex items-center gap-2 text-[var(--theme-primary)]">
                <ListIcon size={24} />
                <h1 className="text-xl sm:text-2xl font-bold">{getTitle()}</h1>
              </div>
              <button className="p-1 text-[var(--theme-primary)] hover:bg-white/50 rounded transition-colors">
                <MoreHorizontal size={20} />
              </button>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setViewMode('table')}
                  className={`flex items-center gap-1 px-3 py-1.5 rounded-sm text-sm font-medium transition-all relative ${
                    viewMode === 'table'
                      ? 'text-[var(--theme-primary)]'
                      : 'text-gray-500 hover:bg-gray-100'
                  }`}
                >
                  <LayoutGrid size={16} />
                  <span>网格</span>
                  {viewMode === 'table' && (
                    <motion.div
                      layoutId="viewModeIndicator"
                      className="absolute bottom-0 left-0 right-0 h-0.5 bg-[var(--theme-primary)]"
                    />
                  )}
                </button>
                <button
                  onClick={() => setViewMode('list')}
                  className={`flex items-center gap-1 px-3 py-1.5 rounded-sm text-sm font-medium transition-all relative ${
                    viewMode === 'list'
                      ? 'text-[var(--theme-primary)]'
                      : 'text-gray-500 hover:bg-gray-100'
                  }`}
                >
                  <ListIcon size={16} />
                  <span>列表</span>
                  {viewMode === 'list' && (
                    <motion.div
                      layoutId="viewModeIndicator"
                      className="absolute bottom-0 left-0 right-0 h-0.5 bg-[var(--theme-primary)]"
                    />
                  )}
                </button>
              </div>
            </div>
            <div className="flex items-center gap-1">
              <button className="flex items-center gap-1 px-2 py-1 text-sm text-[var(--theme-primary)] hover:bg-white/50 rounded transition-colors">
                <ArrowUpDown size={16} />
                <span>排序</span>
              </button>
              <button className="flex items-center gap-1 px-2 py-1 text-sm text-[var(--theme-primary)] hover:bg-white/50 rounded transition-colors">
                <Grid2X2 size={16} />
                <span>组</span>
              </button>
              <button className="flex items-center gap-1 px-2 py-1 text-sm text-[var(--theme-primary)] hover:bg-white/50 rounded transition-colors">
                <UserPlus size={16} />
                <span>共享</span>
              </button>
            </div>
          </div>
        </header>

        <motion.div layout className="flex-1 overflow-y-auto px-4 sm:px-8 pb-24 scroll-smooth">
          {/* Add Task */}
          <div
            className={`mb-4 bg-white rounded-md shadow-sm border transition-all ${isInputFocused ? 'border-gray-200' : 'border-gray-200'}`}
          >
            <form onSubmit={handleAddTask} className="flex items-center gap-3 p-3">
              <Plus
                className={isInputFocused ? 'text-[var(--theme-primary)]' : 'text-gray-400'}
                size={24}
              />
              <input
                type="text"
                value={newTask}
                onChange={(e) => setNewTask(e.target.value)}
                onFocus={() => setIsInputFocused(true)}
                onBlur={() => !newTask && setIsInputFocused(false)}
                placeholder={t('main.addTask')}
                className="flex-1 bg-transparent border-none outline-none text-sm placeholder:text-gray-500 text-gray-900 focus:ring-0"
              />
              {newTask && (
                <button
                  type="submit"
                  disabled={createTask.isPending}
                  className="text-xs font-medium text-[var(--theme-primary)] uppercase px-2"
                >
                  {createTask.isPending ? t('main.adding') : t('main.add')}
                </button>
              )}
            </form>
          </div>

          {/* Active Tasks */}
          <motion.div
            layout
            className={viewMode === 'table' ? 'flex flex-col gap-0.5' : 'space-y-1'}
          >
            <AnimatePresence initial={false} mode="popLayout">
              {activeTasks.map((task) => (
                <motion.div
                  key={task.id}
                  layout
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.9 }}
                  transition={{ type: 'spring', stiffness: 500, damping: 30 }}
                  onClick={() => setSelectedTaskId(task.id)}
                  className={`group bg-white rounded-md shadow-sm border border-gray-100 p-3 flex items-center gap-3 hover:bg-gray-50 transition-colors cursor-pointer ${
                    selectedTask?.id === task.id ? 'bg-blue-50 border-blue-200' : ''
                  } ${viewMode === 'table' ? 'grid grid-cols-12 gap-4 !items-center' : ''}`}
                >
                  <div
                    className={`flex items-center gap-3 ${viewMode === 'table' ? 'col-span-6' : ''}`}
                  >
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleComplete(task);
                      }}
                      className="w-5 h-5 rounded-full border-2 border-gray-400 hover:border-[var(--theme-primary)] flex items-center justify-center transition-colors flex-shrink-0"
                    />
                    <span className="flex-1 text-sm text-gray-900 break-words line-clamp-2">
                      {task.title}
                    </span>
                  </div>
                  {viewMode === 'table' ? (
                    <>
                      <div className="col-span-3 text-sm text-gray-500">
                        {getDueDateText(task.dueDate).text}
                      </div>
                      <div className="col-span-3">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleImportant(task);
                          }}
                          className={`p-1.5 rounded hover:bg-gray-100 ${task.isImportant ? 'text-[var(--theme-primary)]' : 'text-gray-400'}`}
                        >
                          <Star size={18} fill={task.isImportant ? 'currentColor' : 'none'} />
                        </button>
                      </div>
                    </>
                  ) : (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleImportant(task);
                      }}
                      className={`p-1.5 rounded hover:bg-gray-100 flex-shrink-0 ${task.isImportant ? 'text-[var(--theme-primary)]' : 'text-gray-400'}`}
                    >
                      <Star size={18} fill={task.isImportant ? 'currentColor' : 'none'} />
                    </button>
                  )}
                </motion.div>
              ))}
            </AnimatePresence>
          </motion.div>

          {/* Completed Tasks */}
          {completedTasks.length > 0 && (
            <div className="mt-6">
              <button
                onClick={() => setIsCompletedCollapsed(!isCompletedCollapsed)}
                className="flex items-center gap-2 mb-2 px-2 py-1 hover:bg-gray-100 rounded cursor-pointer"
              >
                <ChevronRight
                  size={16}
                  className={`text-gray-500 transition-transform ${!isCompletedCollapsed ? 'rotate-90' : ''}`}
                />
                <span className="text-sm font-medium text-gray-600">{t('main.completed')}</span>
                <span className="text-xs text-gray-400">{completedTasks.length}</span>
              </button>
              {!isCompletedCollapsed && (
                <motion.div layout className="space-y-1">
                  <AnimatePresence initial={false} mode="popLayout">
                    {completedTasks.map((task) => (
                      <motion.div
                        key={task.id}
                        layout
                        initial={{ opacity: 0, scale: 0.9 }}
                        animate={{ opacity: 1, scale: 1 }}
                        exit={{ opacity: 0, scale: 0.9 }}
                        transition={{ type: 'spring', stiffness: 500, damping: 30 }}
                        onClick={() => setSelectedTaskId(task.id)}
                        className={`group bg-white rounded-md shadow-sm border border-gray-100 p-3 flex items-center gap-3 hover:bg-gray-50 transition-colors cursor-pointer opacity-75 ${
                          selectedTask?.id === task.id ? 'bg-blue-50 border-blue-200' : ''
                        }`}
                      >
                        <div className="flex items-center gap-3 flex-1">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleComplete(task);
                            }}
                            className="w-5 h-5 rounded-full border-2 bg-[var(--theme-primary)] border-[var(--theme-primary)] flex items-center justify-center flex-shrink-0"
                          >
                            <svg
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="3"
                              className="w-3 h-3 text-white"
                            >
                              <polyline points="20 6 9 17 4 12" />
                            </svg>
                          </button>
                          <span className="flex-1 text-sm text-gray-400 line-through">
                            {task.title}
                          </span>
                        </div>
                      </motion.div>
                    ))}
                  </AnimatePresence>
                </motion.div>
              )}
            </div>
          )}
        </motion.div>
      </div>

      <TaskDetailDrawer task={selectedTask} onClose={() => setSelectedTaskId(null)} />

      {/* Mobile Sidebar */}
      <AnimatePresence>
        {isSidebarOpen && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsSidebarOpen(false)}
              className="fixed inset-0 bg-black/20 z-40"
            />
            <motion.div
              initial={{ x: '-100%' }}
              animate={{ x: 0 }}
              exit={{ x: '-100%' }}
              transition={{ type: 'spring', stiffness: 300, damping: 30 }}
              className="fixed inset-y-0 left-0 z-50"
            >
              <Sidebar onItemClick={() => setIsSidebarOpen(false)} />
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}

function buildFilter(listId: string): TaskFilter | undefined {
  const smartSet = new Set(['my-day', 'important', 'planned', 'tasks']);
  if (smartSet.has(listId)) {
    if (listId === 'my-day') return { addToMyDay: true };
    if (listId === 'important') return { isImportant: true };
    if (listId === 'planned') return { hasDueDate: true };
    return {};
  }
  return { listId };
}
