import {
  ArrowUpDown,
  Bell,
  Calendar,
  ChevronRight,
  Grid2X2,
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
import { useNavigate, useParams } from 'react-router-dom';
import {
  useBatchOperations,
  useCreateTask,
  useDeleteTask,
  useList,
  useReorderTasks,
  useReorderTasksOptimistic,
  useTag,
  useTask,
  useTaskListShortcuts,
  useToggleComplete,
  useToggleImportant,
  useToggleMyDay,
  useUpdateTask,
} from '@baicie/orbit-hooks';
import { Button, Input, TaskCheckbox, ViewModeToggle } from '@baicie/orbit-ui';
import { ShortcutsHelp } from './ShortcutsHelp';
import { TaskDetailDrawer } from './TaskDetailDrawer';
import { Sidebar } from './Sidebar';
import { SortableTaskList } from './SortableTaskList';
import { ShareDialog } from './ShareDialog';
import { DatePicker } from './DatePicker';
import type { Task, TaskFilter } from '@baicie/orbit';
import { BatchActionsBar } from './BatchActionsBar';

export function MainContent() {
  const { listId } = useParams();
  const navigate = useNavigate();
  const activeListId = listId || 'my-day';
  const { t } = useTranslation();
  const [newTask, setNewTask] = useState('');
  const [newTaskDueDate, setNewTaskDueDate] = useState<string | null>(null);
  const [isInputFocused, setIsInputFocused] = useState(false);
  const [isDatePickerOpen, setIsDatePickerOpen] = useState(false);
  const [isCompletedCollapsed, setIsCompletedCollapsed] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [viewMode, setViewMode] = useState<'list' | 'table'>('list');
  const [isShortcutsHelpOpen, setIsShortcutsHelpOpen] = useState(false);
  const [isSortMenuOpen, setIsSortMenuOpen] = useState(false);
  const [isShareDialogOpen, setIsShareDialogOpen] = useState(false);
  const [sortBy, setSortBy] = useState<
    'createdAt' | 'updatedAt' | 'dueDate' | 'title' | 'importance'
  >('createdAt');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');
  const [hasReordered, setHasReordered] = useState(false);

  const filter = buildFilter(activeListId);
  const { data: tasks = [] } = useTask(filter);
  const { data: allTags = [] } = useTag();
  const { data: allLists = [] } = useList();

  const createTask = useCreateTask();
  const updateTask = useUpdateTask();
  const deleteTask = useDeleteTask();
  const toggleComplete = useToggleComplete();
  const toggleImportant = useToggleImportant();
  const toggleMyDay = useToggleMyDay();
  const reorderTasks = useReorderTasks();
  const reorderTasksOptimistic = useReorderTasksOptimistic();
  const batchOps = useBatchOperations();

  useTaskListShortcuts({
    tasks,
    selectedTaskId,
    onSelectTask: setSelectedTaskId,
    onToggleComplete: toggleComplete,
    onToggleImportant: toggleImportant,
    onToggleMyDay: toggleMyDay,
    onDeleteTask: (id) => deleteTask.mutate(id),
    onOpenCommandPalette: () => {},
    onOpenSettings: () => navigate('/settings'),
    onOpenSearch: () => {},
    onOpenShortcutsHelp: () => setIsShortcutsHelpOpen(true),
    onAddTask: () => {
      const input = document.querySelector<HTMLInputElement>('input[placeholder*="添加任务"]');
      input?.focus();
    },
    onOpenTaskDetail: (id) => setSelectedTaskId(id),
    onDuplicateTask: (task) => {
      createTask.mutate({ title: task.title, listId: task.listId ?? undefined });
    },
    onToggleSidebar: () => setIsSidebarOpen((v) => !v),
    onNavigate: navigate,
  });

  const handleAddTask = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTask.trim()) return;
    const isSmartList = ['my-day', 'important', 'planned', 'tasks'].includes(activeListId);
    const payload: {
      title: string;
      listId?: string;
      addToMyDay?: boolean;
      isImportant?: boolean;
      dueDate?: string;
    } = { title: newTask };
    if (activeListId === 'my-day') payload.addToMyDay = true;
    if (activeListId === 'important') payload.isImportant = true;
    if (!isSmartList) payload.listId = activeListId;
    if (newTaskDueDate) payload.dueDate = newTaskDueDate;
    createTask.mutate(payload);
    setNewTask('');
    setNewTaskDueDate(null);
  };

  const getTitle = () => {
    if (activeListId === 'my-day') return t('sidebar.myDay');
    if (activeListId === 'important') return t('sidebar.important');
    if (activeListId === 'planned') return t('sidebar.planned');
    if (activeListId === 'tasks') return t('sidebar.tasks');
    if (activeListId.startsWith('tag:')) {
      const tagId = activeListId.slice(4);
      const tag = allTags.find((tg) => tg.id === tagId);
      return tag ? tag.name : '标签';
    }
    return t('app.title');
  };

  const activeTasks = tasks.filter((task) => !task.isCompleted);
  const completedTasks = tasks.filter((task) => task.isCompleted);
  const selectedTask = tasks.find((task) => task.id === selectedTaskId) || null;

  const sortedActiveTasks = [...activeTasks].sort((a, b) => {
    if (hasReordered) {
      return (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
    }
    let cmp = 0;
    switch (sortBy) {
      case 'title':
        cmp = a.title.localeCompare(b.title);
        break;
      case 'dueDate':
        if (!a.dueDate && !b.dueDate) cmp = 0;
        else if (!a.dueDate) cmp = 1;
        else if (!b.dueDate) cmp = -1;
        else cmp = new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime();
        break;
      case 'importance':
        if (a.isImportant === b.isImportant) cmp = 0;
        else cmp = a.isImportant ? -1 : 1;
        break;
      case 'createdAt':
        cmp = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
        break;
      case 'updatedAt':
        cmp = new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime();
        break;
      default:
        cmp = 0;
    }
    return sortOrder === 'asc' ? cmp : -cmp;
  });

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
              <Button variant="ghost" size="icon" onClick={() => setIsSidebarOpen(true)}>
                <Menu size={24} />
              </Button>
              <div className="flex items-center gap-2 text-[var(--theme-primary)]">
                <ListIcon size={24} />
                <h1 className="text-xl sm:text-2xl font-bold">{getTitle()}</h1>
              </div>
              <Button variant="ghost" size="icon">
                <MoreHorizontal size={20} />
              </Button>
              <ViewModeToggle value={viewMode} onChange={setViewMode} />
            </div>
            <div className="flex items-center gap-1">
              <div className="relative">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setIsSortMenuOpen((v) => !v)}
                  className="flex items-center gap-1"
                >
                  <ArrowUpDown size={16} />
                  <span>排序</span>
                </Button>
                {isSortMenuOpen && (
                  <div className="absolute top-full right-0 mt-1 w-48 bg-white rounded-lg shadow-xl border border-gray-200 py-1 z-50">
                    {(
                      [
                        { key: 'createdAt', label: '创建时间' },
                        { key: 'updatedAt', label: '更新时间' },
                        { key: 'dueDate', label: '截止日期' },
                        { key: 'title', label: '标题' },
                        { key: 'importance', label: '重要性' },
                      ] as const
                    ).map(({ key, label }) => (
                      <Button
                        key={key}
                        variant="ghost"
                        onClick={() => setSortBy(key)}
                        className={`w-full text-left px-4 py-2 text-sm flex items-center justify-between ${
                          sortBy === key
                            ? 'bg-blue-50 text-blue-600'
                            : 'text-gray-700 hover:bg-gray-50'
                        }`}
                      >
                        <span>{label}</span>
                        {sortBy === key && (
                          <span className="text-xs">{sortOrder === 'asc' ? '↑' : '↓'}</span>
                        )}
                      </Button>
                    ))}
                    <div className="border-t border-gray-100 my-1" />
                    <Button
                      variant="ghost"
                      onClick={() => setSortOrder((o) => (o === 'asc' ? 'desc' : 'asc'))}
                      className="w-full text-left px-4 py-2 text-sm text-gray-500 hover:bg-gray-50 flex items-center justify-between"
                    >
                      <span>方向</span>
                      <span>{sortOrder === 'asc' ? '升序 ↑' : '降序 ↓'}</span>
                    </Button>
                  </div>
                )}
              </div>
              <Button variant="ghost" size="sm" className="flex items-center gap-1">
                <Grid2X2 size={16} />
                <span>组</span>
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setIsShareDialogOpen(true)}
                className="flex items-center gap-1"
                title="分享"
              >
                <UserPlus size={16} />
                <span>共享</span>
              </Button>
            </div>
          </div>
        </header>

        <motion.div layout className="flex-1 overflow-y-auto px-4 sm:px-8 pb-24 scroll-smooth">
          {/* Add Task */}
          <div className="mb-4 bg-white rounded-md shadow-sm border transition-all border-gray-200">
            <form onSubmit={handleAddTask} className="flex items-center gap-3 p-3">
              <Plus
                className={isInputFocused ? 'text-[var(--theme-primary)]' : 'text-gray-400'}
                size={24}
              />
              <Input
                type="text"
                value={newTask}
                onChange={(e) => setNewTask(e.target.value)}
                onFocus={() => setIsInputFocused(true)}
                onBlur={() => !newTask && setIsInputFocused(false)}
                placeholder={t('main.addTask')}
                className="flex-1 bg-transparent border-none outline-none text-sm placeholder:text-gray-500 text-gray-900 focus:ring-0"
              />
              {newTask && (
                <Button
                  type="submit"
                  size="sm"
                  disabled={createTask.isPending}
                  variant="ghost"
                  className="text-xs font-medium text-[var(--theme-primary)] uppercase px-2"
                >
                  {createTask.isPending ? t('main.adding') : t('main.add')}
                </Button>
              )}
            </form>
            {isInputFocused && (
              <div className="flex items-center gap-1 px-3 pb-2 bg-gray-50/50 rounded-b-md border-t border-gray-100 pt-2 relative">
                <div className="relative">
                  <Button
                    variant="ghost"
                    size="icon"
                    title="设置截止日期"
                    onClick={() => setIsDatePickerOpen((v) => !v)}
                  >
                    <Calendar
                      size={18}
                      className={newTaskDueDate ? 'text-[var(--theme-primary)]' : ''}
                    />
                  </Button>
                  <AnimatePresence>
                    {isDatePickerOpen && (
                      <motion.div
                        initial={{ opacity: 0, y: -4 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -4 }}
                        transition={{ duration: 0.1 }}
                        className="absolute top-full left-0 mt-1 z-50"
                      >
                        <DatePicker
                          value={newTaskDueDate ? newTaskDueDate.split('T')[0] : null}
                          onChange={(date) => {
                            setNewTaskDueDate(
                              date ? new Date(date + 'T00:00:00').toISOString() : null,
                            );
                            setIsDatePickerOpen(false);
                          }}
                          onClear={() => {
                            setNewTaskDueDate(null);
                            setIsDatePickerOpen(false);
                          }}
                        />
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
                <Button variant="ghost" size="icon" title="设置提醒">
                  <Bell size={18} />
                </Button>
                <Button variant="ghost" size="icon" title="设置重复">
                  <Repeat size={18} />
                </Button>
              </div>
            )}
          </div>

          {/* Active Tasks */}
          <motion.div
            layout
            className={viewMode === 'table' ? 'flex flex-col gap-0.5' : 'space-y-1'}
          >
            <SortableTaskList
              tasks={sortedActiveTasks}
              activeTaskId={selectedTask?.id ?? null}
              isChecked={batchOps.isSelected}
              onSelectTask={setSelectedTaskId}
              onToggleCheck={batchOps.toggleSelection}
              onToggleComplete={toggleComplete}
              onToggleImportant={toggleImportant}
              onReorder={(activeId, overId) => {
                const activeTask = tasks.find((t) => t.id === activeId);
                const overTask = tasks.find((t) => t.id === overId);
                if (activeTask && overTask) {
                  const updatedTasks = reorderTasksOptimistic(activeTask, overTask);
                  if (updatedTasks.length > 0) {
                    void reorderTasks(updatedTasks);
                    setHasReordered(true);
                  }
                }
              }}
              viewMode={viewMode}
            />
          </motion.div>

          {/* Completed Tasks */}
          {completedTasks.length > 0 && (
            <div className="mt-6">
              <Button
                variant="ghost"
                onClick={() => setIsCompletedCollapsed(!isCompletedCollapsed)}
                className="flex items-center gap-2 mb-2 px-2 py-1 cursor-pointer"
              >
                <ChevronRight
                  size={16}
                  className={`text-gray-500 transition-transform ${!isCompletedCollapsed ? 'rotate-90' : ''}`}
                />
                <span className="text-sm font-medium text-gray-600">{t('main.completed')}</span>
                <span className="text-xs text-gray-400">{completedTasks.length}</span>
              </Button>
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
                          <TaskCheckbox checked={true} onChange={() => toggleComplete(task)} />
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

      <BatchActionsBar
        selectedCount={batchOps.selectedCount}
        onClear={batchOps.clearSelection}
        onMarkComplete={() => batchOps.batchMarkComplete()}
        onMarkImportant={() => batchOps.batchMarkImportant()}
        onAddToMyDay={() => batchOps.batchAddToMyDay()}
        onDelete={batchOps.batchDelete}
      />

      <ShortcutsHelp isOpen={isShortcutsHelpOpen} onClose={() => setIsShortcutsHelpOpen(false)} />

      {(() => {
        const isSmartList = ['my-day', 'important', 'planned', 'tasks'].includes(activeListId);
        const currentList = isSmartList ? null : allLists.find((l) => l.id === activeListId);
        if (!isSmartList && currentList) {
          return (
            <ShareDialog
              isOpen={isShareDialogOpen}
              onClose={() => setIsShareDialogOpen(false)}
              listId={currentList.id}
              listTitle={currentList.title}
            />
          );
        }
        return null;
      })()}
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
  if (listId.startsWith('tag:')) {
    const tagId = listId.slice(4);
    return { tagIds: [tagId] };
  }
  return { listId };
}
