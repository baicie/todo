import {
  For,
  Match,
  Show,
  Switch,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  type JSX,
} from 'solid-js';
import {
  CalendarDays,
  Check,
  CheckSquare2,
  ChevronDown,
  Info,
  LayoutGrid,
  ListTodo,
  MoreHorizontal,
  PanelLeft,
  Plus,
  Search,
  Settings2,
  Star,
  Sun,
  UserRound,
  X,
} from 'lucide-solid';
import {
  TaskService,
  downloadBlob,
  exportFilename,
  fromIcs,
  toCsv,
  toIcs,
  type ViewCounts,
} from '@todo/application';
import {
  formatDateLong,
  formatDateShort,
  todayInTimeZone,
  type ListPatch,
  type StepPatch,
  type TaskPatch,
  type TaskWithSteps,
} from '@todo/domain';
import type { AppPlatform, ThemePreference } from './adapters/platform';
import { DetailPanel } from './components/DetailPanel';
import { CalendarView } from './components/CalendarView';
import { QuickAdd } from './components/QuickAdd';
import { SearchDialog } from './components/SearchDialog';
import { SettingsDialog } from './components/SettingsDialog';
import { SharedListsDialog } from './components/SharedListsDialog';
import { Sidebar } from './components/Sidebar';
import { TaskFilterBar } from './components/TaskFilterBar';
import { TaskList } from './components/TaskList';
import { TemplateDialog } from './components/TemplateDialog';
import { WeeklyReviewDialog } from './components/WeeklyReviewDialog';
import {
  loadTemplates,
  persistTemplates,
  templateFromTask,
  type TaskTemplate,
} from './lib/templates';
import { loadSavedViews, persistSavedViews } from './lib/saved-views';
import { applyTheme, getThemePreference, watchSystemTheme } from './lib/theme';
import { createCloudController } from './sync/cloud';
import type { AppView, SavedView, TaskFilter } from './types';
import { EMPTY_FILTER, SMART_TITLES } from './types';

interface ToastState {
  message: string;
  actionLabel?: string;
  action?: () => Promise<void>;
  tone?: 'default' | 'success' | 'danger';
}

const EMPTY_COUNTS: ViewCounts = {
  myDay: 0,
  important: 0,
  planned: 0,
  completed: 0,
  all: 0,
  lists: {},
};

export function App(props: { platform: AppPlatform }): JSX.Element {
  const service = new TaskService(
    props.platform.repository,
    () => props.platform.lifecycle.timeZone,
  );
  const cloud = createCloudController({
    platform: props.platform,
    repository: props.platform.repository,
  });
  const [view, setView] = createSignal<AppView>({ kind: 'smart', id: 'my-day' });
  const [lists, setLists] = createSignal<
    Awaited<ReturnType<AppPlatform['repository']['listLists']>>
  >([]);
  const [tasks, setTasks] = createSignal<TaskWithSteps[]>([]);
  const [suggestions, setSuggestions] = createSignal<TaskWithSteps[]>([]);
  const [counts, setCounts] = createSignal<ViewCounts>(EMPTY_COUNTS);
  const [selectedId, setSelectedId] = createSignal<string | null>(null);
  const [selectedTask, setSelectedTask] = createSignal<TaskWithSteps | null>(null);
  const [revision, setRevision] = createSignal(0);
  const [today, setToday] = createSignal(todayInTimeZone(props.platform.lifecycle.timeZone));
  const [loading, setLoading] = createSignal(true);
  const [sidebarOpen, setSidebarOpen] = createSignal(false);
  const [searchOpen, setSearchOpen] = createSignal(false);
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  const [theme, setTheme] = createSignal<ThemePreference>(getThemePreference());
  const [filter, setFilter] = createSignal<TaskFilter>({ ...EMPTY_FILTER, tags: [] });
  const [savedViews, setSavedViews] = createSignal<SavedView[]>(loadSavedViews());
  const [templates, setTemplates] = createSignal<TaskTemplate[]>(loadTemplates());
  const [templatesOpen, setTemplatesOpen] = createSignal(false);
  const [reviewOpen, setReviewOpen] = createSignal(false);
  const [reviewTasks, setReviewTasks] = createSignal<TaskWithSteps[]>([]);
  const [sharedOpen, setSharedOpen] = createSignal(false);
  const [toast, setToast] = createSignal<ToastState | null>(null);
  const [renaming, setRenaming] = createSignal(false);
  const [renameValue, setRenameValue] = createSignal('');
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  let quickAddInput: HTMLInputElement | undefined;
  let listMenu: HTMLDetailsElement | undefined;
  let loadGeneration = 0;
  const scheduledReminders = new Set<string>();

  const timeZone = () => props.platform.lifecycle.timeZone;
  const refresh = () => setRevision((value) => value + 1);

  const showToast = (message: string, options: Omit<ToastState, 'message'> = {}) => {
    if (toastTimer) clearTimeout(toastTimer);
    setToast({ message, ...options });
    toastTimer = setTimeout(() => setToast(null), options.action ? 7000 : 3200);
  };

  const reportError = (error: unknown) => {
    showToast(error instanceof Error ? error.message : '操作没有完成', { tone: 'danger' });
  };

  const currentList = () =>
    view().kind === 'list' ? (lists().find((list) => list.id === view().id) ?? null) : null;

  const availableTags = createMemo(() =>
    [...new Set(tasks().flatMap((task) => task.tags ?? []))].sort((a, b) => a.localeCompare(b)),
  );

  const filteredTasks = createMemo(() => {
    const current = filter();
    return tasks().filter((task) => {
      if (current.tags.length > 0) {
        const tags = new Set((task.tags ?? []).map((tag) => tag.toLowerCase()));
        if (!current.tags.every((tag) => tags.has(tag.toLowerCase()))) return false;
      }
      if (current.status !== 'all' && task.status !== current.status) return false;
      if (current.due === 'today' && task.dueOn !== today()) return false;
      if (current.due === 'overdue' && (!task.dueOn || task.dueOn >= today())) return false;
      if (current.due === 'none' && task.dueOn !== null) return false;
      return true;
    });
  });

  const saveCurrentView = (name: string) => {
    const next: SavedView = {
      id: crypto.randomUUID(),
      name,
      view: view(),
      filter: filter(),
    };
    const updated = [...savedViews(), next];
    setSavedViews(updated);
    persistSavedViews(updated);
    showToast('已保存当前视图', { tone: 'success' });
  };

  const deleteSavedView = (id: string) => {
    const updated = savedViews().filter((item) => item.id !== id);
    setSavedViews(updated);
    persistSavedViews(updated);
  };

  const saveTemplateFromTask = (task: TaskWithSteps) => {
    const name = window.prompt('模板名称', task.title)?.trim();
    if (!name) return;
    const updated = [...templates(), templateFromTask(task, today(), name)];
    setTemplates(updated);
    persistTemplates(updated);
    showToast('已保存为模板', { tone: 'success' });
  };

  const deleteTemplate = (id: string) => {
    const updated = templates().filter((item) => item.id !== id);
    setTemplates(updated);
    persistTemplates(updated);
  };

  const useTemplate = async (template: TaskTemplate) => {
    try {
      const dueOn =
        template.dueOffsetDays === null
          ? null
          : new Date(
              new Date(`${today()}T00:00:00Z`).getTime() + template.dueOffsetDays * 86_400_000,
            )
              .toISOString()
              .slice(0, 10);
      const task = await service.createTask({
        title: template.title,
        note: template.note,
        tags: template.tags,
        important: template.important,
        dueOn,
        planDate: view().kind === 'smart' && view().id === 'my-day' ? today() : null,
      });
      for (const step of template.steps) {
        await service.addStep({ taskId: task.id, title: step });
      }
      refresh();
      showToast('已从模板创建任务', { tone: 'success' });
    } catch (error) {
      reportError(error);
    }
  };

  const openWeeklyReview = async () => {
    try {
      const page = await props.platform.repository.listTasks({
        view: 'all',
        includeCompleted: true,
        limit: 100_000,
      });
      setReviewTasks(page.items);
      setReviewOpen(true);
    } catch (error) {
      reportError(error);
    }
  };

  const viewTitle = () => {
    const selection = view();
    if (selection.kind === 'list') return currentList()?.name ?? '清单';
    return SMART_TITLES[selection.id];
  };

  const viewSubtitle = () => {
    const selection = view();
    if (selection.kind === 'smart' && selection.id === 'my-day') {
      return `${formatDateLong(today(), 'zh-CN', { weekday: 'long' })} · ${counts().myDay} 项待办`;
    }
    if (selection.kind === 'smart' && selection.id === 'completed') {
      return `完成记录保存在本机 · ${counts().completed} 项`;
    }
    if (selection.kind === 'smart' && selection.id === 'important') {
      return `跨清单汇总 · ${counts().important} 项`;
    }
    if (selection.kind === 'smart' && selection.id === 'planned') {
      return `按截止日期安排 · ${counts().planned} 项`;
    }
    if (selection.kind === 'smart') return `收件箱与所有清单 · ${counts().all} 项待办`;
    return `本地清单 · ${counts().lists[selection.id] ?? 0} 项待办`;
  };

  const refreshReminders = async () => {
    try {
      const page = await props.platform.repository.listTasks({
        view: 'all',
        includeCompleted: false,
        limit: 1000,
      });
      const upcoming = new Set<string>();
      for (const task of page.items) {
        if (!task.remindAt || task.status !== 'open') continue;
        upcoming.add(task.id);
        await props.platform.reminder.schedule({
          reminderId: task.id,
          fireAtUtc: task.remindAt,
          title: task.title,
          body: task.note.trim().slice(0, 120) || '该完成这项任务了',
        });
      }
      for (const id of [...scheduledReminders]) {
        if (!upcoming.has(id)) {
          await props.platform.reminder.cancel(id);
          scheduledReminders.delete(id);
        }
      }
      upcoming.forEach((id) => scheduledReminders.add(id));
    } catch {
      // Reminder scheduling is best-effort and must not block data loading.
    }
  };

  const loadView = async (selection: AppView, date: string) => {
    const generation = ++loadGeneration;
    setLoading(true);
    try {
      const taskPromise =
        selection.kind === 'smart' && selection.id === 'my-day'
          ? props.platform.repository
              .listDayPlan(date)
              .then((items) => items.filter((task) => task.status === 'open'))
          : selection.kind === 'smart'
            ? props.platform.repository
                .listTasks({
                  view: selection.id,
                  localDate: date,
                  includeCompleted: selection.id === 'completed',
                  limit: 100_000,
                })
                .then((page) => page.items)
            : props.platform.repository
                .listTasks({
                  view: 'list',
                  listId: selection.id,
                  localDate: date,
                  limit: 100_000,
                })
                .then((page) => page.items);
      const suggestionPromise =
        selection.kind === 'smart' && selection.id === 'my-day'
          ? service.suggestions(date)
          : Promise.resolve([] as TaskWithSteps[]);
      const [nextLists, nextCounts, nextTasks, nextSuggestions] = await Promise.all([
        props.platform.repository.listLists(),
        props.platform.repository.getCounts(date),
        taskPromise,
        suggestionPromise,
      ]);
      if (generation !== loadGeneration) return;
      setLists(nextLists);
      setCounts(nextCounts);
      setTasks(nextTasks);
      setSuggestions(nextSuggestions);
      void props.platform.setBadge(nextCounts.myDay);
    } catch (error) {
      if (generation === loadGeneration) reportError(error);
    } finally {
      if (generation === loadGeneration) setLoading(false);
    }
  };

  createEffect(() => {
    revision();
    const selection = view();
    const date = today();
    void loadView(selection, date);
  });

  createEffect(() => {
    revision();
    const id = selectedId();
    if (!id) {
      setSelectedTask(null);
      return;
    }
    void props.platform.repository.getTask(id).then((task) => {
      if (selectedId() !== id) return;
      if (!task) {
        setSelectedTask(null);
        setSelectedId(null);
      } else {
        setSelectedTask(task);
      }
    });
  });

  createEffect(() => {
    const title = viewTitle();
    document.title = title === '我的一天' ? '我的一天 · 拾事' : `${title} · 拾事`;
  });

  onMount(() => {
    applyTheme(theme());
    const stopTheme = watchSystemTheme(() => {
      if (theme() === 'system') applyTheme('system');
    });
    const unsubscribe = props.platform.repository.subscribeChanges(() => refresh());
    const dateTimer = setInterval(() => {
      const next = todayInTimeZone(timeZone());
      if (next !== today()) setToday(next);
    }, 30_000);
    const stopResume = props.platform.lifecycle.onResume(() => {
      const next = todayInTimeZone(timeZone());
      if (next !== today()) setToday(next);
      refresh();
    });
    const stopOnline = props.platform.lifecycle.onOnline(() => refresh());
    const onKeydown = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      if (mod && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setSearchOpen(true);
        return;
      }
      if (mod && event.key.toLowerCase() === 'n') {
        event.preventDefault();
        setSidebarOpen(false);
        quickAddInput?.focus();
        quickAddInput?.select();
        return;
      }
      if (event.key === 'Escape') {
        const target = event.target as HTMLElement | null;
        const tagName = target?.tagName.toLowerCase();
        if (
          target &&
          (tagName === 'input' ||
            tagName === 'textarea' ||
            tagName === 'select' ||
            target.isContentEditable)
        ) {
          target.blur();
          return;
        }
        if (searchOpen()) setSearchOpen(false);
        else if (settingsOpen()) setSettingsOpen(false);
        else if (sidebarOpen()) setSidebarOpen(false);
        else if (selectedId()) setSelectedId(null);
        return;
      }
      if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
        const task = selectedTask();
        if (task) {
          event.preventDefault();
          void service
            .reorderTask(task.id, event.key === 'ArrowUp' ? 'up' : 'down')
            .then(refresh)
            .catch(reportError);
        }
      }
    };
    window.addEventListener('keydown', onKeydown);
    void refreshReminders();
    void cloud.initialize();
    if (props.platform.kind === 'web' && 'serviceWorker' in navigator && import.meta.env.PROD) {
      void navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
    onCleanup(() => {
      cloud.dispose();
      stopTheme();
      unsubscribe();
      stopResume();
      stopOnline();
      clearInterval(dateTimer);
      window.removeEventListener('keydown', onKeydown);
      if (toastTimer) clearTimeout(toastTimer);
    });
  });

  createEffect(() => {
    revision();
    void refreshReminders();
  });

  const cloudSyncLabel = () => {
    const cloudState = cloud.state();
    if (cloudState.phase !== 'connected') return '仅本机 · 已自动保存';
    if (cloudState.syncStatus === 'syncing') return '云端同步中…';
    if (cloudState.syncStatus === 'error') return '同步异常 · 查看设置';
    if (cloudState.syncStatus === 'offline') return '离线 · 已保存在本机';
    return cloudState.pending > 0 ? `${cloudState.pending} 项待上传` : '云端已同步';
  };

  const cloudSyncTone = (): 'local' | 'synced' | 'syncing' | 'error' | 'offline' => {
    const cloudState = cloud.state();
    if (cloudState.phase !== 'connected') return 'local';
    if (cloudState.syncStatus === 'syncing') return 'syncing';
    if (cloudState.syncStatus === 'error' || cloudState.syncStatus === 'auth-required') {
      return 'error';
    }
    if (cloudState.syncStatus === 'offline') return 'offline';
    return 'synced';
  };

  const navigate = (next: AppView, options?: { filter?: TaskFilter }) => {
    setView(next);
    setFilter(options?.filter ?? { ...EMPTY_FILTER, tags: [] });
    setSelectedId(null);
    setRenaming(false);
    setSidebarOpen(false);
  };

  const createTask = async (text: string) => {
    try {
      await service.quickAdd(text, {
        localDate: today(),
        listId: view().kind === 'list' ? view().id : null,
        lists: lists(),
        planDate: view().kind === 'smart' && view().id === 'my-day' ? today() : null,
      });
      refresh();
    } catch (error) {
      reportError(error);
      throw error;
    }
  };

  const toggleTask = async (task: TaskWithSteps) => {
    try {
      const result = await service.toggleTask(task.id);
      if (result.task.status === 'completed') {
        await props.platform.reminder.cancel(task.id);
        scheduledReminders.delete(task.id);
        if (result.nextTask) {
          showToast(`已完成。下一项安排在 ${formatDateShort(result.nextTask.dueOn!)}`, {
            tone: 'success',
          });
        }
      } else {
        await refreshReminders();
      }
      refresh();
    } catch (error) {
      reportError(error);
    }
  };

  const starTask = async (task: TaskWithSteps) => {
    try {
      await service.patchTask(task.id, { important: !task.important });
      refresh();
    } catch (error) {
      reportError(error);
    }
  };

  const planTask = async (task: TaskWithSteps, planned = true) => {
    try {
      await service.planTask(task.id, today(), planned);
      refresh();
      if (planned) {
        showToast('已加入我的一天', {
          actionLabel: '撤销',
          action: async () => {
            await service.planTask(task.id, today(), false);
            refresh();
          },
        });
      }
    } catch (error) {
      reportError(error);
    }
  };

  const patchSelected = async (patch: TaskPatch) => {
    const task = selectedTask();
    if (!task) return;
    try {
      const updated = await service.patchTask(task.id, patch);
      if ('remindAt' in patch) {
        if (updated.remindAt && updated.status === 'open') {
          await props.platform.reminder.schedule({
            reminderId: updated.id,
            fireAtUtc: updated.remindAt,
            title: updated.title,
            body: updated.note.slice(0, 120) || '该完成这项任务了',
          });
          scheduledReminders.add(updated.id);
        } else {
          await props.platform.reminder.cancel(updated.id);
          scheduledReminders.delete(updated.id);
        }
      }
      refresh();
    } catch (error) {
      reportError(error);
      throw error;
    }
  };

  const deleteTask = async (task: TaskWithSteps) => {
    try {
      await service.deleteTask(task.id);
      await props.platform.reminder.cancel(task.id);
      scheduledReminders.delete(task.id);
      setSelectedId(null);
      setSelectedTask(null);
      refresh();
      showToast(`已删除「${task.title}」`, {
        actionLabel: '撤销',
        tone: 'danger',
        action: async () => {
          await service.restoreTask(task.id);
          refresh();
        },
      });
    } catch (error) {
      reportError(error);
    }
  };

  const addStep = async (title: string) => {
    const task = selectedTask();
    if (!task) return;
    try {
      await service.addStep({ taskId: task.id, title });
      refresh();
    } catch (error) {
      reportError(error);
      throw error;
    }
  };

  const patchStep = async (id: string, patch: StepPatch) => {
    try {
      await service.patchStep(id, patch);
      refresh();
    } catch (error) {
      reportError(error);
    }
  };

  const deleteStep = async (id: string) => {
    try {
      await service.deleteStep(id);
      refresh();
    } catch (error) {
      reportError(error);
    }
  };

  const reorderSelected = async (direction: 'up' | 'down') => {
    const task = selectedTask();
    if (!task) return;
    try {
      await service.reorderTask(task.id, direction);
      refresh();
    } catch (error) {
      reportError(error);
    }
  };

  const addList = async (name: string) => {
    try {
      const list = await service.createList({ name });
      refresh();
      navigate({ kind: 'list', id: list.id });
    } catch (error) {
      reportError(error);
    }
  };

  const renameList = async () => {
    const list = currentList();
    const name = renameValue().trim();
    setRenaming(false);
    if (!list || !name || name === list.name) return;
    try {
      await service.patchList(list.id, { name });
      refresh();
    } catch (error) {
      reportError(error);
    }
  };

  const deleteList = async () => {
    const list = currentList();
    if (!list) return;
    if (!window.confirm(`删除「${list.name}」？清单中的任务会移到收件箱。`)) return;
    try {
      await service.deleteList(list.id);
      navigate({ kind: 'smart', id: 'all' });
      refresh();
      showToast(`已删除清单「${list.name}」`, {
        actionLabel: '撤销',
        action: async () => {
          await service.restoreList(list.id);
          refresh();
        },
      });
    } catch (error) {
      reportError(error);
    }
  };

  const setThemePreference = (next: ThemePreference) => {
    setTheme(next);
    applyTheme(next);
  };

  const exportJson = async () => {
    const bundle = await service.exportBundle();
    downloadBlob(
      JSON.stringify(bundle, null, 2),
      exportFilename('json'),
      'application/json;charset=utf-8',
    );
    showToast('JSON 备份已导出', { tone: 'success' });
  };

  const exportCsv = async () => {
    const bundle = await service.exportBundle();
    downloadBlob(toCsv(bundle), exportFilename('csv'), 'text/csv;charset=utf-8');
    showToast('CSV 表格已导出', { tone: 'success' });
  };

  const exportIcs = async () => {
    const bundle = await service.exportBundle();
    downloadBlob(toIcs(bundle), exportFilename('ics'), 'text/calendar;charset=utf-8');
    showToast('日历已导出', { tone: 'success' });
  };

  const importBackup = async (file: File, mode: 'merge' | 'replace') => {
    if (cloud.state().phase === 'connected') {
      throw new Error('请先在“同步”设置中退出云同步，再导入备份。');
    }
    try {
      const text = await file.text();
      if (/\.ics$/i.test(file.name)) {
        const imported = fromIcs(text);
        if (mode === 'replace') await service.clearAll();
        for (const item of imported) {
          await service.createTask({
            title: item.title,
            note: item.note,
            dueOn: item.dueOn,
          });
        }
        setSelectedId(null);
        refresh();
        showToast(`已导入 ${imported.length} 个日历任务`, { tone: 'success' });
        return;
      }
      const parsed = JSON.parse(text) as Parameters<typeof service.importBundle>[0];
      await service.importBundle(parsed, mode);
      setSelectedId(null);
      refresh();
      showToast(mode === 'replace' ? '备份已恢复' : '备份已合并', { tone: 'success' });
    } catch (error) {
      reportError(error);
      throw error;
    }
  };

  const clearAll = async () => {
    try {
      if (cloud.state().phase === 'connected') {
        await cloud.signOut(true);
      } else {
        await service.clearAll();
      }
      setSelectedId(null);
      refresh();
      showToast('本机数据已清除');
    } catch (error) {
      reportError(error);
      throw error;
    }
  };

  const requestNotifications = async () => {
    if (props.platform.reminder.requestPermission) {
      return props.platform.reminder.requestPermission();
    }
    if (typeof Notification === 'undefined') return 'denied' as const;
    const result = await Notification.requestPermission();
    return result === 'default' ? ('prompt' as const) : result;
  };

  const openTaskFromSearch = (task: TaskWithSteps) => {
    setSelectedId(task.id);
    setSearchOpen(false);
  };

  return (
    <div class="app-frame">
      <header class="app-topbar" aria-label="应用栏">
        <button
          type="button"
          class="app-topbar__menu"
          aria-label="打开导航"
          onClick={() => setSidebarOpen(true)}
        >
          <LayoutGrid size={18} />
        </button>
        <div class="app-topbar__brand">
          <span class="app-topbar__mark" aria-hidden="true">
            <Check size={16} stroke-width={3} />
          </span>
          <strong>拾事</strong>
        </div>
        <button
          type="button"
          class="app-topbar__search"
          onClick={() => setSearchOpen(true)}
          aria-label="搜索"
        >
          <Search size={16} aria-hidden="true" />
          <span>搜索</span>
          <kbd aria-hidden="true">
            {navigator.platform.toLowerCase().includes('mac') ? '⌘' : 'Ctrl'} K
          </kbd>
        </button>
        <div class="app-topbar__actions">
          <button
            type="button"
            class="app-topbar__icon"
            aria-label="设置"
            onClick={() => setSettingsOpen(true)}
          >
            <Settings2 size={17} />
          </button>
          <button
            type="button"
            class="app-topbar__icon"
            aria-label="帮助"
            onClick={() => setSettingsOpen(true)}
          >
            <Info size={17} />
          </button>
          <button type="button" class="app-topbar__avatar" aria-label="账号">
            <UserRound size={17} />
          </button>
        </div>
      </header>
      <div
        class="app-shell"
        classList={{
          'app-shell--detail': Boolean(selectedTask()),
          'app-shell--sidebar': sidebarOpen(),
        }}
      >
        <Sidebar
          view={view()}
          lists={lists()}
          counts={counts()}
          open={sidebarOpen()}
          syncLabel={cloudSyncLabel()}
          syncTone={cloudSyncTone()}
          onSelect={navigate}
          onSearch={() => setSearchOpen(true)}
          onAddList={addList}
          onOpenSettings={() => {
            setSettingsOpen(true);
            setSidebarOpen(false);
          }}
          onOpenReview={() => {
            setSidebarOpen(false);
            void openWeeklyReview();
          }}
          onOpenShared={() => setSharedOpen(true)}
          onClose={() => setSidebarOpen(false)}
        />
        <Show when={sidebarOpen()}>
          <button
            type="button"
            class="page-backdrop sidebar-backdrop"
            aria-label="关闭导航"
            onClick={() => setSidebarOpen(false)}
          />
        </Show>

        <main class="main-panel" id="main-content">
          <header class="page-header">
            <div class="page-header__top">
              <div class="mobile-only page-header__left">
                <button
                  type="button"
                  class="icon-button"
                  aria-label="打开导航"
                  onClick={() => setSidebarOpen(true)}
                >
                  <PanelLeft size={19} />
                </button>
              </div>
              <div class="page-header__crumbs">
                <span class="crumb-brand">拾事</span>
                <span class="crumb-separator">/</span>
                <span>{viewTitle()}</span>
              </div>
              <div class="page-header__tools">
                <button
                  type="button"
                  class="icon-button"
                  aria-label="搜索"
                  title="搜索（Ctrl/⌘ K）"
                  onClick={() => setSearchOpen(true)}
                >
                  <Search size={18} />
                </button>
                <button
                  type="button"
                  class="icon-button mobile-only"
                  aria-label="设置"
                  onClick={() => setSettingsOpen(true)}
                >
                  <Settings2 size={18} />
                </button>
                <div class="header-avatar" aria-hidden="true">
                  <Check size={14} stroke-width={2.6} />
                </div>
              </div>
            </div>

            <div class="page-header__title-row">
              <div class="page-title">
                <div class="page-title__heading">
                  <Switch fallback={null}>
                    <Match when={view().kind === 'smart' && view().id === 'my-day'}>
                      <Sun size={26} class="page-title__icon page-title__icon--sun" />
                    </Match>
                    <Match when={view().kind === 'smart' && view().id === 'important'}>
                      <Star size={25} class="page-title__icon page-title__icon--star" />
                    </Match>
                    <Match when={view().kind === 'smart' && view().id === 'planned'}>
                      <CalendarDays size={24} class="page-title__icon" />
                    </Match>
                    <Match when={view().kind === 'smart' && view().id === 'calendar'}>
                      <CalendarDays size={24} class="page-title__icon" />
                    </Match>
                    <Match when={view().kind === 'smart' && view().id === 'all'}>
                      <ListTodo size={24} class="page-title__icon" />
                    </Match>
                    <Match when={view().kind === 'smart' && view().id === 'completed'}>
                      <CheckSquare2
                        size={24}
                        class="page-title__icon page-title__icon--completed"
                      />
                    </Match>
                  </Switch>
                  <Show when={view().kind === 'list'}>
                    <span
                      class="page-title__dot"
                      style={{ '--list-color': currentList()?.color ?? 'var(--text-tertiary)' }}
                    />
                  </Show>
                  <Show when={renaming()} fallback={<h1>{viewTitle()}</h1>}>
                    <input
                      class="page-title__input"
                      value={renameValue()}
                      autofocus
                      aria-label="清单名称"
                      onInput={(event) => setRenameValue(event.currentTarget.value)}
                      onBlur={() => void renameList()}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          event.currentTarget.blur();
                        } else if (event.key === 'Escape') {
                          setRenaming(false);
                        }
                      }}
                    />
                  </Show>
                </div>
                <p class="page-title__subtitle">{viewSubtitle()}</p>
              </div>
              <div class="page-header__actions">
                <Show when={view().kind === 'list'}>
                  <details ref={listMenu} class="list-menu">
                    <summary class="icon-button" aria-label="清单选项">
                      <MoreHorizontal size={19} />
                    </summary>
                    <div class="list-menu__popover">
                      <button
                        type="button"
                        onClick={() => {
                          setRenameValue(currentList()?.name ?? '');
                          setRenaming(true);
                          if (listMenu) listMenu.open = false;
                        }}
                      >
                        重命名清单
                      </button>
                      <button type="button" class="danger-text" onClick={() => void deleteList()}>
                        删除清单
                      </button>
                    </div>
                  </details>
                </Show>
                <button
                  type="button"
                  class="primary-button page-header__add"
                  onClick={() => {
                    quickAddInput?.focus();
                    quickAddInput?.select();
                  }}
                >
                  <Plus size={16} stroke-width={2.4} />
                  新建任务
                </button>
              </div>
            </div>
          </header>

          <div class="page-scroll">
            <div class="page-content">
              <QuickAdd
                listId={view().kind === 'list' ? view().id : null}
                inputRef={(element) => (quickAddInput = element)}
                onAdd={createTask}
                onOpenTemplates={() => setTemplatesOpen(true)}
                placeholder={
                  view().kind === 'list'
                    ? `添加到「${viewTitle()}」，按 Enter 保存`
                    : '添加任务，按 Enter 保存'
                }
              />

              <Show
                when={!loading()}
                fallback={
                  <div class="task-skeleton" aria-label="正在加载">
                    <For each={[1, 2, 3, 4]}>
                      {() => (
                        <div class="task-skeleton__row">
                          <span class="task-skeleton__check" />
                          <span class="task-skeleton__lines">
                            <span />
                            <span />
                          </span>
                        </div>
                      )}
                    </For>
                  </div>
                }
              >
                <Show
                  when={view().kind === 'smart' && view().id === 'calendar'}
                  fallback={
                    <>
                      <TaskFilterBar
                        filter={filter()}
                        availableTags={availableTags()}
                        savedViews={savedViews()}
                        onChange={setFilter}
                        onSave={saveCurrentView}
                        onApplySaved={(saved) => navigate(saved.view, { filter: saved.filter })}
                        onDeleteSaved={deleteSavedView}
                      />
                      <TaskList
                        view={view()}
                        tasks={filteredTasks()}
                        suggestions={suggestions()}
                        lists={lists()}
                        today={today()}
                        selectedId={selectedId()}
                        onSelect={(task) => setSelectedId(task.id)}
                        onToggle={(task) => void toggleTask(task)}
                        onStar={(task) => void starTask(task)}
                        onPlan={(task) => void planTask(task, true)}
                        onUnplan={(task) => void planTask(task, false)}
                      />
                    </>
                  }
                >
                  <CalendarView
                    tasks={tasks()}
                    today={today()}
                    onSelect={(task) => setSelectedId(task.id)}
                  />
                </Show>
              </Show>

              <div class="page-footer-hint">
                <span>
                  <Show
                    when={view().kind === 'smart' && view().id === 'my-day'}
                    fallback={
                      <>
                        <Check size={13} /> 所有修改已自动保存在本机
                      </>
                    }
                  >
                    <Sun size={13} /> 我的一天每天自动刷新，未完成任务仍留在原清单
                  </Show>
                </span>
                <span class="page-footer-hint__storage">
                  {props.platform.kind === 'tauri' ? 'SQLite' : 'IndexedDB'} 本地保存
                </span>
              </div>
            </div>
          </div>
        </main>

        <Show when={selectedTask()}>
          {(task) => (
            <>
              <button
                type="button"
                class="page-backdrop detail-backdrop"
                aria-label="关闭任务详情"
                onClick={() => setSelectedId(null)}
              />
              <DetailPanel
                task={task()}
                lists={lists()}
                today={today()}
                timeZone={timeZone()}
                onClose={() => setSelectedId(null)}
                onToggle={() => void toggleTask(task())}
                onPatch={patchSelected}
                onSaveTemplate={saveTemplateFromTask}
                onDelete={() => void deleteTask(task())}
                onAddStep={addStep}
                onPatchStep={patchStep}
                onDeleteStep={deleteStep}
                onPlan={(planned) => planTask(task(), planned)}
                onReorder={reorderSelected}
              />
            </>
          )}
        </Show>

        <nav class="bottom-nav" aria-label="移动端导航">
          <button
            type="button"
            classList={{
              'bottom-nav__item--active': view().kind === 'smart' && view().id === 'my-day',
            }}
            onClick={() => navigate({ kind: 'smart', id: 'my-day' })}
          >
            <Sun size={20} />
            <span>今天</span>
          </button>
          <button
            type="button"
            classList={{
              'bottom-nav__item--active': view().kind === 'smart' && view().id === 'all',
            }}
            onClick={() => navigate({ kind: 'smart', id: 'all' })}
          >
            <ListTodo size={20} />
            <span>全部</span>
          </button>
          <button
            type="button"
            classList={{ 'bottom-nav__item--active': sidebarOpen() || view().kind === 'list' }}
            onClick={() => setSidebarOpen(true)}
          >
            <PanelLeft size={20} />
            <span>清单</span>
          </button>
          <button
            type="button"
            classList={{ 'bottom-nav__item--active': settingsOpen() }}
            onClick={() => setSettingsOpen(true)}
          >
            <UserRound size={20} />
            <span>我</span>
          </button>
        </nav>

        <SharedListsDialog open={sharedOpen()} cloud={cloud} onClose={() => setSharedOpen(false)} />

        <WeeklyReviewDialog
          open={reviewOpen()}
          tasks={reviewTasks()}
          lists={lists()}
          today={today()}
          onClose={() => setReviewOpen(false)}
        />

        <TemplateDialog
          open={templatesOpen()}
          templates={templates()}
          onClose={() => setTemplatesOpen(false)}
          onUse={(template) => void useTemplate(template)}
          onDelete={deleteTemplate}
        />

        <SearchDialog
          open={searchOpen()}
          lists={lists()}
          today={today()}
          repository={props.platform.repository}
          onClose={() => setSearchOpen(false)}
          onOpenTask={openTaskFromSearch}
        />

        <SettingsDialog
          open={settingsOpen()}
          onClose={() => setSettingsOpen(false)}
          theme={theme()}
          onThemeChange={setThemePreference}
          platformKind={props.platform.kind}
          taskCount={counts().all + counts().completed}
          listCount={lists().length}
          cloud={cloud}
          desktop={props.platform.lifecycle.desktop}
          reminderPermission={() => props.platform.reminder.getPermission()}
          onRequestNotifications={requestNotifications}
          onExportJson={exportJson}
          onExportCsv={exportCsv}
          onExportIcs={exportIcs}
          onImport={importBackup}
          onClear={clearAll}
        />

        <Show when={toast()}>
          {(current) => (
            <div
              class="toast"
              classList={{
                'toast--success': current().tone === 'success',
                'toast--danger': current().tone === 'danger',
              }}
              role="status"
            >
              <Show when={current().tone === 'success'}>
                <Check size={16} class="toast__icon" />
              </Show>
              <span class="toast__message">{current().message}</span>
              <Show when={current().action}>
                <button
                  type="button"
                  class="toast__action"
                  onClick={async () => {
                    const action = current().action;
                    setToast(null);
                    try {
                      await action?.();
                    } catch (error) {
                      reportError(error);
                    }
                  }}
                >
                  {current().actionLabel ?? '撤销'}
                </button>
              </Show>
              <button
                type="button"
                class="icon-button icon-button--small toast__close"
                aria-label="关闭提示"
                onClick={() => setToast(null)}
              >
                <X size={14} />
              </button>
            </div>
          )}
        </Show>
      </div>
    </div>
  );
}
