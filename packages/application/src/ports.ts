import type {
  DateOnly,
  DayPlan,
  Id,
  Instant,
  ListPatch,
  NewList,
  NewStep,
  NewTask,
  Page,
  Step,
  StepPatch,
  Task,
  TaskList,
  TaskPatch,
  TaskQuery,
  TaskWithSteps,
} from '@todo/domain';

export interface ExportBundle {
  format: 'todo-export';
  version: 1;
  exportedAt: Instant;
  appVersion: string;
  tasks: Task[];
  lists: TaskList[];
  steps: Step[];
  dayPlans: DayPlan[];
}

export interface CompletionCommit {
  taskId: Id;
  completedAt: Instant;
  nextTask: Task | null;
}

export interface CompleteResult {
  task: Task;
  nextTask: Task | null;
}

export interface ViewCounts {
  myDay: number;
  important: number;
  planned: number;
  completed: number;
  all: number;
  lists: Record<string, number>;
}

export interface TaskRepository {
  createTask(input: NewTask): Promise<Task>;
  patchTask(id: Id, patch: TaskPatch): Promise<Task>;
  getTask(id: Id): Promise<TaskWithSteps | null>;
  listTasks(query: TaskQuery): Promise<Page<TaskWithSteps>>;
  /** Open, non-deleted tasks with a reminder, ordered by remindAt ascending. */
  listReminderCandidates(): Promise<Task[]>;
  getCounts(localDate: DateOnly): Promise<ViewCounts>;
  /** Marks complete and inserts the generated recurrence instance atomically. */
  commitCompletion(commit: CompletionCommit): Promise<CompleteResult>;
  deleteTask(id: Id): Promise<void>;
  restoreTask(id: Id): Promise<void>;
  reorderTask(id: Id, direction: 'up' | 'down'): Promise<void>;

  listLists(): Promise<TaskList[]>;
  createList(input: NewList): Promise<TaskList>;
  patchList(id: Id, patch: ListPatch): Promise<TaskList>;
  deleteList(id: Id): Promise<void>;
  restoreList(id: Id): Promise<void>;

  listDayPlan(date: DateOnly): Promise<TaskWithSteps[]>;
  addToDay(taskId: Id, date: DateOnly): Promise<void>;
  removeFromDay(taskId: Id, date: DateOnly): Promise<void>;

  createStep(input: NewStep): Promise<Step>;
  patchStep(id: Id, patch: StepPatch): Promise<Step>;
  deleteStep(id: Id): Promise<void>;

  exportData(): Promise<ExportBundle>;
  importData(bundle: ExportBundle, mode: 'merge' | 'replace'): Promise<void>;
  clearAll(): Promise<void>;

  subscribeChanges(callback: (entityIds: Id[]) => void): () => void;
}

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

export type ReminderPermission = 'granted' | 'denied' | 'prompt';

export type ReminderScheduleStatus =
  | 'scheduled'
  | 'skipped-past'
  | 'outside-window'
  | 'permission-denied'
  | 'capacity-exceeded'
  | 'failed';

export interface ReminderScheduleResult {
  status: ReminderScheduleStatus;
  message?: string;
  mode?: string;
}

export interface ReminderScheduler {
  schedule(input: {
    reminderId: string;
    fireAtUtc: string;
    title: string;
    body?: string;
  }): Promise<ReminderScheduleResult>;
  cancel(reminderId: string): Promise<void>;
  rescheduleUpcoming(): Promise<void>;
  getPermission(): Promise<ReminderPermission>;
  /** Present on platforms where permission must be requested interactively. */
  requestPermission?(): Promise<ReminderPermission>;
}

export interface SecureTokenStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface DesktopSettings {
  closeToTray: boolean;
  autostartEnabled: boolean;
  autostartSupported: boolean;
}

export interface DesktopLifecycle {
  getSettings(): Promise<DesktopSettings>;
  setCloseToTray(enabled: boolean): Promise<void>;
  setAutostart(enabled: boolean): Promise<void>;
}

export interface AppLifecycle {
  platform: 'web' | 'windows' | 'macos' | 'linux' | 'android' | 'ios';
  timeZone: string;
  desktop?: DesktopLifecycle;
  onResume(callback: () => void): () => void;
  onOnline(callback: () => void): () => void;
}

export interface PlatformPort {
  storage: TaskRepository;
  reminder: ReminderScheduler;
  secureTokenStore: SecureTokenStore;
  lifecycle: AppLifecycle;
}
