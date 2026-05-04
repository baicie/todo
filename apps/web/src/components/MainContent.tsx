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
import { useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
import { TaskDetailDrawer } from './TaskDetailDrawer';
import { ContextMenu } from './ContextMenu';
import { Sidebar } from './Sidebar';
import { SortableTaskList } from './SortableTaskList';
import { BatchActionsBar } from './BatchActionsBar';
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
import type { Task, TaskFilter } from '@baicie/orbit';
import { CommandPalette } from './CommandPalette';
import { ShortcutsHelp } from './ShortcutsHelp';
import { DatePicker } from './DatePicker';
import { ShareDialog } from './ShareDialog';
import { useAppEvent } from '../hooks/useAppEvents';

export const MainContent = () => {
  const { listId } = useParams();
  const activeListId = listId || 'my-day';
  const { t } = useTranslation();
  const [newTask, setNewTask] = useState('');
  const [newTaskDueDate, setNewTaskDueDate] = useState<string | null>(null);
  const [isInputFocused, setIsInputFocused] = useState(false);
  const [isCompletedCollapsed, setIsCompletedCollapsed] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; task: Task } | null>(null);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [viewMode, setViewMode] = useState<'list' | 'table'>('list');
  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState(false);
  const [isShortcutsHelpOpen, setIsShortcutsHelpOpen] = useState(false);
  const [isDatePickerOpen, setIsDatePickerOpen] = useState(false);
  const [isSortMenuOpen, setIsSortMenuOpen] = useState(false);
  const [sortBy, setSortBy] = useState<
    'createdAt' | 'updatedAt' | 'dueDate' | 'title' | 'importance'
  >('createdAt');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');
  const [activeDatePickerTaskId, setActiveDatePickerTaskId] = useState<string | null>(null);
  const [isShareDialogOpen, setIsShareDialogOpen] = useState(false);

  const filter = buildFilter(activeListId);
  const { data: tasks = [] } = useTask(filter);
  const { data: allTags = [] } = useTag();
  const { data: lists = [] } = useList();

  const createTask = useCreateTask();
  const updateTask = useUpdateTask();
  const deleteTask = useDeleteTask();
  const toggleComplete = useToggleComplete();
  const toggleImportant = useToggleImportant();
  const toggleMyDay = useToggleMyDay();
  const reorderTasks = useReorderTasks();
  const reorderTasksOptimistic = useReorderTasksOptimistic();
  const batchOps = useBatchOperations();
  const navigate = useNavigate();
  const taskInputRef = useRef<HTMLInputElement>(null);

  const { focusedIndex } = useTaskListShortcuts({
    tasks,
    selectedTaskId,
    onSelectTask: setSelectedTaskId,
    onToggleComplete: toggleComplete,
    onToggleImportant: toggleImportant,
    onToggleMyDay: toggleMyDay,
    onDeleteTask: (id) => deleteTask.mutate(id),
    onOpenCommandPalette: () => setIsCommandPaletteOpen(true),
    onOpenSettings: () => navigate('/settings'),
    onOpenSearch: () => {
      const headerSearch = document.querySelector<HTMLInputElement>('header input[type="text"]');
      headerSearch?.focus();
    },
    onOpenShortcutsHelp: () => setIsShortcutsHelpOpen(true),
    onAddTask: () => taskInputRef.current?.focus(),
    onOpenTaskDetail: (id) => setSelectedTaskId(id),
    onDuplicateTask: (task) => {
      createTask.mutate({ title: task.title, listId: task.listId ?? undefined });
    },
    onToggleSidebar: () => setIsSidebarOpen((v) => !v),
    onNavigate: navigate,
  });

  // Listen to app-level events from keyboard shortcuts
  useAppEvent('open-command-palette', () => setIsCommandPaletteOpen(true));
  useAppEvent('open-settings', () => {
    const headerSettingsBtn = document.querySelector<HTMLElement>('header button[title]');
    headerSettingsBtn?.click();
  });
  useAppEvent('open-search', () => {
    const headerSearch = document.querySelector<HTMLInputElement>('header input[type="text"]');
    headerSearch?.focus();
  });

  const handleAddTask = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTask.trim()) return;

    const isSmartList = ['my-day', 'important', 'planned', 'tasks'].includes(activeListId);
    const payload: {
      title: string;
      dueDate?: string | null;
      listId?: string;
      addToMyDay?: boolean;
      isImportant?: boolean;
    } = { title: newTask };

    if (newTaskDueDate) payload.dueDate = newTaskDueDate;
    if (activeListId === 'my-day') payload.addToMyDay = true;
    if (activeListId === 'important') payload.isImportant = true;
    if (!isSmartList) payload.listId = activeListId;

    createTask.mutate(payload);
    setNewTask('');
    setNewTaskDueDate(null);
  };

  const getTitle = () => {
    return getListTitle(activeListId, allTags, (k) => t(k));
  };

  const activeTasks = tasks.filter((task) => !task.isCompleted);
  const completedTasks = tasks.filter((task) => task.isCompleted);
  const selectedTask = tasks.find((task) => task.id === selectedTaskId) || null;

  const sortedActiveTasks = [...activeTasks].sort((a, b) => {
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

  const handleContextMenu = (e: React.MouseEvent, task: Task) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, task });
  };

  const getDueDateText = (dateStr?: string | null) => {
    if (!dateStr) return { text: '-', isOverdue: false };
    const date = new Date(dateStr);
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const isToday = date.toDateString() === today.toDateString();
    const isYesterday = date.toDateString() === yesterday.toDateString();
    const isTomorrow = date.toDateString() === tomorrow.toDateString();
    const isOverdue = date < today && !isToday;

    let text = date.toLocaleDateString();
    if (isToday) text = '今天';
    if (isYesterday) text = '昨天';
    if (isTomorrow) text = '明天';

    return { text, isOverdue };
  };

  const handleDateChange = (task: Task, dateStr: string | null) => {
    updateTask.mutate({ id: task.id, input: { dueDate: dateStr } });
  };

  return (
    <div className="flex-1 h-full flex flex-row overflow-hidden relative">
      <div className="flex-1 h-full flex flex-col bg-[var(--theme-bg)] overflow-hidden">
        <header className="px-4 sm:px-8 pt-6 sm:pt-8 pb-4">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-4">
              <button
                className="md:hidden p-2 -ml-2 text-gray-600 hover:bg-gray-100 rounded-md"
                onClick={() => setIsSidebarOpen(true)}
              >
                <Menu size={24} />
              </button>

              <div className="flex items-center gap-2 text-[var(--theme-primary)]">
                <ListIcon size={24} className="text-[var(--theme-primary)]" />
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
              <button
                onClick={() => setIsSortMenuOpen((v) => !v)}
                className="flex items-center gap-1 px-2 py-1 text-sm text-[var(--theme-primary)] hover:bg-white/50 rounded transition-colors relative"
              >
                <ArrowUpDown size={16} />
                <span>排序</span>
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
                      <button
                        key={key}
                        onClick={() => setSortBy(key)}
                        className={`w-full text-left px-4 py-2 text-sm flex items-center justify-between transition-colors ${
                          sortBy === key
                            ? 'bg-blue-50 text-blue-600'
                            : 'text-gray-700 hover:bg-gray-50'
                        }`}
                      >
                        <span>{label}</span>
                        {sortBy === key && (
                          <span className="text-xs">{sortOrder === 'asc' ? '↑' : '↓'}</span>
                        )}
                      </button>
                    ))}
                    <div className="border-t border-gray-100 my-1" />
                    <button
                      onClick={() => setSortOrder((o) => (o === 'asc' ? 'desc' : 'asc'))}
                      className="w-full text-left px-4 py-2 text-sm text-gray-500 hover:bg-gray-50 transition-colors flex items-center justify-between"
                    >
                      <span>方向</span>
                      <span>{sortOrder === 'asc' ? '升序 ↑' : '降序 ↓'}</span>
                    </button>
                  </div>
                )}
              </button>
              <button className="flex items-center gap-1 px-2 py-1 text-sm text-[var(--theme-primary)] hover:bg-white/50 rounded transition-colors">
                <Grid2X2 size={16} />
                <span>组</span>
              </button>
              <button
                onClick={() => {
                  const smartSet = new Set(['my-day', 'important', 'planned', 'tasks']);
                  if (smartSet.has(activeListId)) {
                    alert('请选择一个自定义清单进行分享');
                    return;
                  }
                  setIsShareDialogOpen(true);
                }}
                className="flex items-center gap-1 px-2 py-1 text-sm text-[var(--theme-primary)] hover:bg-white/50 rounded transition-colors"
              >
                <UserPlus size={16} />
                <span>共享</span>
              </button>
            </div>
          </div>
        </header>

        <motion.div layout className="flex-1 overflow-y-auto px-4 sm:px-8 pb-24 scroll-smooth">
          <div
            className={`mb-4 bg-white rounded-md shadow-sm border transition-all ${isInputFocused ? 'border-gray-200' : 'border-gray-200'}`}
          >
            <form onSubmit={handleAddTask} className="flex items-center gap-3 p-3">
              <Plus
                className={`${isInputFocused ? 'text-[var(--theme-primary)]' : 'text-gray-400'}`}
                size={24}
              />
              <input
                ref={taskInputRef}
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
            {isInputFocused && (
              <div className="flex items-center justify-between px-3 pb-2 bg-gray-50/50 rounded-b-md border-t border-gray-100 pt-2">
                <div className="flex items-center gap-1 relative">
                  <button
                    className="p-1.5 hover:bg-gray-200 rounded text-gray-500 relative"
                    title={t('main.options.addDueDate')}
                    onClick={() => setIsDatePickerOpen((v) => !v)}
                  >
                    <Calendar
                      size={18}
                      className={newTaskDueDate ? 'text-[var(--theme-primary)]' : ''}
                    />
                  </button>
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
                  <button
                    className="p-1.5 hover:bg-gray-200 rounded text-gray-500"
                    title={t('main.options.remindMe')}
                  >
                    <Bell size={18} />
                  </button>
                  <button
                    className="p-1.5 hover:bg-gray-200 rounded text-gray-500"
                    title={t('main.options.repeat')}
                  >
                    <Repeat size={18} />
                  </button>
                </div>
              </div>
            )}
          </div>

          <motion.div
            layout
            className={viewMode === 'table' ? 'flex flex-col gap-0.5' : 'space-y-1'}
          >
            {viewMode === 'table' && activeTasks.length > 0 && (
              <div className="grid grid-cols-12 gap-4 px-3 py-2 text-xs font-medium text-gray-500 border-b border-gray-100">
                <div className="col-span-6">标题</div>
                <div className="col-span-3">截止日期</div>
                <div className="col-span-3">重要性</div>
              </div>
            )}
            <SortableTaskList
              tasks={sortedActiveTasks}
              activeTaskId={selectedTask?.id ?? null}
              isChecked={batchOps.isSelected}
              onSelectTask={setSelectedTaskId}
              onToggleCheck={batchOps.toggleSelection}
              onContextMenu={handleContextMenu}
              onToggleComplete={toggleComplete}
              onToggleImportant={toggleImportant}
              onDateChange={handleDateChange}
              onReorder={(activeId, overId) => {
                const activeTask = tasks.find((t) => t.id === activeId);
                const overTask = tasks.find((t) => t.id === overId);
                if (activeTask && overTask) {
                  reorderTasksOptimistic(activeTask, overTask);
                  void reorderTasks(activeId, overTask.sortOrder ?? 0);
                }
              }}
              viewMode={viewMode}
              focusedIndex={focusedIndex}
            />
          </motion.div>

          {completedTasks.length > 0 && (
            <div className="mt-6">
              <button
                onClick={() => setIsCompletedCollapsed(!isCompletedCollapsed)}
                className="flex items-center gap-2 mb-2 px-2 py-1 hover:bg-gray-100 rounded transition-colors cursor-pointer w-full text-left"
              >
                <ChevronRight
                  size={16}
                  className={`text-gray-500 transition-transform ${!isCompletedCollapsed ? 'rotate-90' : ''}`}
                />
                <span className="text-sm font-medium text-gray-600">{t('main.completed')}</span>
                <span className="text-xs text-gray-400">{completedTasks.length}</span>
              </button>

              {!isCompletedCollapsed && (
                <motion.div
                  layout
                  className={`opacity-75 ${viewMode === 'table' ? 'flex flex-col gap-0.5' : 'space-y-1'}`}
                >
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
                        onContextMenu={(e) => handleContextMenu(e, task)}
                        className={`group bg-white rounded-md shadow-sm border p-3 flex items-center gap-3 hover:bg-gray-50 transition-colors cursor-pointer ${
                          selectedTask?.id === task.id
                            ? 'bg-blue-50 border-blue-200'
                            : 'border-gray-100'
                        } ${viewMode === 'table' ? 'grid grid-cols-12 gap-4 !items-center' : ''}`}
                      >
                        <div
                          className={`flex items-center gap-3 w-full ${viewMode === 'table' ? 'col-span-6' : ''}`}
                        >
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleComplete(task);
                            }}
                            className="w-5 h-5 rounded-full border-2 bg-[var(--theme-primary)] border-[var(--theme-primary)] flex items-center justify-center transition-colors flex-shrink-0"
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
                          <span className="flex-1 text-sm text-gray-400 line-through break-words line-clamp-2">
                            <div className="flex flex-col">
                              <span>{task.title}</span>
                              {task.steps && task.steps.length > 0 && (
                                <span className="text-xs text-gray-400 no-line-through">
                                  {t('main.stepProgress', {
                                    completed: task.steps.filter((s) => s.isCompleted).length,
                                    total: task.steps.length,
                                  })}
                                </span>
                              )}
                            </div>
                          </span>
                        </div>

                        {viewMode === 'table' ? (
                          <>
                            <div className="col-span-3 text-sm relative">
                              {(() => {
                                const { text, isOverdue } = getDueDateText(task.dueDate);
                                return (
                                  <div
                                    className={`flex items-center gap-2 ${isOverdue ? 'text-red-500' : 'text-gray-500 hover:text-gray-700'}`}
                                  >
                                    {task.dueDate && <Calendar size={14} />}
                                    <button
                                      className="text-left flex-1 cursor-pointer"
                                      onClick={() => {
                                        if (activeDatePickerTaskId === task.id) {
                                          setActiveDatePickerTaskId(null);
                                        } else {
                                          setActiveDatePickerTaskId(task.id);
                                        }
                                      }}
                                    >
                                      {text}
                                    </button>
                                    {activeDatePickerTaskId === task.id && (
                                      <div className="absolute top-full left-0 mt-1 z-50">
                                        <DatePicker
                                          value={task.dueDate ? task.dueDate.split('T')[0] : null}
                                          onChange={(date) => {
                                            handleDateChange(
                                              task,
                                              date
                                                ? new Date(date + 'T00:00:00').toISOString()
                                                : null,
                                            );
                                            setActiveDatePickerTaskId(null);
                                          }}
                                          onClear={() => {
                                            handleDateChange(task, null);
                                            setActiveDatePickerTaskId(null);
                                          }}
                                        />
                                      </div>
                                    )}
                                  </div>
                                );
                              })()}
                            </div>
                            <div className="col-span-3 flex items-center justify-between">
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  toggleImportant(task);
                                }}
                                className={`p-1.5 rounded hover:bg-gray-100 transition-colors flex-shrink-0 ${
                                  task.isImportant ? 'text-[var(--theme-primary)]' : 'text-gray-400'
                                }`}
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
                            className={`p-1.5 rounded hover:bg-gray-100 transition-colors flex-shrink-0 ${
                              task.isImportant ? 'text-[var(--theme-primary)]' : 'text-gray-400'
                            }`}
                          >
                            <Star size={18} fill={task.isImportant ? 'currentColor' : 'none'} />
                          </button>
                        )}
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

      <AnimatePresence>
        {isSidebarOpen && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsSidebarOpen(false)}
              className="fixed inset-0 bg-black/20 z-40 md:hidden"
            />
            <motion.div
              initial={{ x: '-100%' }}
              animate={{ x: 0 }}
              exit={{ x: '-100%' }}
              transition={{ type: 'spring', stiffness: 300, damping: 30 }}
              className="fixed inset-y-0 left-0 z-50 md:hidden"
            >
              <Sidebar onItemClick={() => setIsSidebarOpen(false)} />
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          task={contextMenu.task}
          onClose={() => setContextMenu(null)}
          onToggleComplete={() => toggleComplete(contextMenu.task)}
          onToggleImportant={() => toggleImportant(contextMenu.task)}
          onToggleMyDay={() => toggleMyDay(contextMenu.task)}
          onDelete={() => deleteTask.mutate(contextMenu.task.id)}
        />
      )}

      <CommandPalette
        isOpen={isCommandPaletteOpen}
        onClose={() => setIsCommandPaletteOpen(false)}
      />

      <ShortcutsHelp isOpen={isShortcutsHelpOpen} onClose={() => setIsShortcutsHelpOpen(false)} />

      <BatchActionsBar
        selectedCount={batchOps.selectedCount}
        onClear={batchOps.clearSelection}
        onMarkComplete={() => batchOps.batchMarkComplete()}
        onMarkImportant={() => batchOps.batchMarkImportant()}
        onAddToMyDay={() => batchOps.batchAddToMyDay()}
        onDelete={batchOps.batchDelete}
      />

      <ShareDialog
        isOpen={isShareDialogOpen}
        onClose={() => setIsShareDialogOpen(false)}
        listId={activeListId}
        listTitle={lists?.find((l) => l.id === activeListId)?.title ?? '清单'}
      />
    </div>
  );
};

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

function getListTitle(
  listId: string,
  allTags?: Array<{ id: string; name: string }>,
  tFn?: (key: string) => string,
): string {
  if (listId === 'my-day') return tFn ? tFn('sidebar.myDay') : '我的一天';
  if (listId === 'important') return tFn ? tFn('sidebar.important') : '重要';
  if (listId === 'planned') return tFn ? tFn('sidebar.planned') : '计划内';
  if (listId === 'tasks') return tFn ? tFn('sidebar.tasks') : '所有任务';
  if (listId.startsWith('tag:')) {
    const tagId = listId.slice(4);
    const tag = allTags?.find((t) => t.id === tagId);
    return tag ? `${tag.name}` : '标签';
  }
  return '任务';
}
