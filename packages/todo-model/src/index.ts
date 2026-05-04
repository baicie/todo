import { v4 as uuidv4 } from 'uuid';
import axios, { type AxiosInstance } from 'axios';
import Dexie, { type Table } from 'dexie';

// ============================================================================
// Types
// ============================================================================

export type UserRole = 'admin' | 'user' | 'moderator';

export interface BaseEntity {
  createdAt: string;
  updatedAt: string;
}

export interface User extends BaseEntity {
  id: number;
  name: string;
  email: string;
  age: number;
  role: UserRole;
}

export interface AuthResult {
  accessToken: string;
  user: User;
}

export type TaskCategory = 'blue' | 'red' | 'green' | 'orange';
export type RepeatPattern =
  | 'daily'
  | 'weekly'
  | 'monthly'
  | 'yearly'
  | 'weekdays'
  | 'custom'
  | null;

export interface TaskFile {
  id: string;
  filename: string;
  originalname: string;
  mimetype: string;
  size: number;
  path: string;
}

export interface Step extends BaseEntity {
  id: string;
  title: string;
  isCompleted: boolean;
  taskId: string;
}

export interface Task extends BaseEntity {
  id: string;
  title: string;
  description: string | null;
  isCompleted: boolean;
  isImportant: boolean;
  addToMyDay: boolean;
  dueDate: string | null;
  reminderDate: string | null;
  repeatPattern: RepeatPattern;
  category: TaskCategory | null;
  files: TaskFile[];
  listId: string | null;
  userId: number | null;
  steps: Step[];
  sortOrder: number;
  tagIds: string[];
}

export interface List extends BaseEntity {
  id: string;
  title: string;
  icon: string | null;
  theme: string | null;
  isSmart: boolean;
  userId: number | null;
  tasks?: Task[];
}

export interface Tag extends BaseEntity {
  id: string;
  name: string;
  color: string;
  userId: number | null;
}

export interface TaskFilter {
  listId?: string | null;
  isImportant?: boolean;
  addToMyDay?: boolean;
  hasDueDate?: boolean;
  isCompleted?: boolean;
  category?: TaskCategory | null;
  tagIds?: string[];
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  isCompleted?: boolean;
  isImportant?: boolean;
  addToMyDay?: boolean;
  dueDate?: string | null;
  reminderDate?: string | null;
  repeatPattern?: RepeatPattern;
  category?: TaskCategory | null;
  listId?: string | null;
  sortOrder?: number;
  tagIds?: string[];
}

export interface UpdateTaskInput {
  title?: string;
  description?: string | null;
  isCompleted?: boolean;
  isImportant?: boolean;
  addToMyDay?: boolean;
  dueDate?: string | null;
  reminderDate?: string | null;
  repeatPattern?: RepeatPattern;
  category?: TaskCategory | null;
  listId?: string | null;
  files?: TaskFile[];
  sortOrder?: number;
  tagIds?: string[];
}

export interface CreateListInput {
  title: string;
  icon?: string;
  theme?: string;
}

export interface UpdateListInput {
  title?: string;
  icon?: string | null;
  theme?: string | null;
}

export interface CreateStepInput {
  title: string;
  isCompleted?: boolean;
}

export interface UpdateStepInput {
  title?: string;
  isCompleted?: boolean;
}

export type SyncOperationType = 'create' | 'update' | 'delete';
export type SyncEntityType = 'task' | 'list' | 'step' | 'tag';
export type SyncStatus = 'pending' | 'syncing' | 'failed';

export interface SyncOperation {
  id?: number;
  entityType: SyncEntityType;
  entityId: string;
  operation: SyncOperationType;
  payload: Record<string, unknown>;
  createdAt: string;
  retryCount: number;
  status: SyncStatus;
}

export type StorageMode = 'local' | 'remote';

export interface StorageConfig {
  mode: StorageMode;
  apiBaseUrl?: string;
  syncInterval?: number;
  syncOnReconnect?: boolean;
  conflictStrategy?: 'local-wins' | 'remote-wins' | 'manual';
}

// ============================================================================
// Storage Interfaces
// ============================================================================

export interface ITaskStorage {
  getTasks(filter?: TaskFilter): Promise<Task[]>;
  getTask(id: string): Promise<Task | null>;
  createTask(input: CreateTaskInput): Promise<Task>;
  updateTask(id: string, input: UpdateTaskInput): Promise<Task>;
  deleteTask(id: string): Promise<void>;
  addStep(taskId: string, input: CreateStepInput): Promise<void>;
  updateStep(stepId: string, input: UpdateStepInput): Promise<void>;
  deleteStep(stepId: string): Promise<void>;
}

export interface IListStorage {
  getLists(): Promise<List[]>;
  getList(id: string): Promise<List | null>;
  createList(input: CreateListInput): Promise<List>;
  updateList(id: string, input: UpdateListInput): Promise<List>;
  deleteList(id: string): Promise<void>;
}

export interface IAuthStorage {
  readonly mode: 'local' | 'remote';
  login(email: string, password: string): Promise<AuthResult>;
  register(name: string, email: string, password: string): Promise<AuthResult>;
  getProfile(): Promise<User>;
  getStoredUser(): User | null;
  getStoredToken(): string | null;
  setAuth(result: AuthResult): void;
  clearAuth(): void;
}

export interface IStorage {
  readonly config: StorageConfig;
  readonly tasks: ITaskStorage;
  readonly lists: IListStorage;
  readonly auth: IAuthStorage;
  readonly tags: ITagStorage;
  initialize(): Promise<void>;
  destroy(): Promise<void>;
}

// ============================================================================
// Local Database (Dexie/IndexedDB)
// ============================================================================

export class TodoDatabase extends Dexie {
  tasks!: Table<Task, string>;
  lists!: Table<List, string>;
  steps!: Table<Step, string>;
  tags!: Table<Tag, string>;
  syncQueue!: Table<SyncOperation, number>;

  constructor() {
    super('OrbitDB');

    this.version(1).stores({
      tasks:
        'id, listId, userId, isCompleted, isImportant, addToMyDay, dueDate, reminderDate, category, createdAt, updatedAt, sortOrder',
      lists: 'id, userId, isSmart, createdAt, updatedAt',
      steps: 'id, taskId, isCompleted, createdAt, updatedAt',
      syncQueue: '++id, entityType, entityId, operation, status, createdAt',
    });

    this.version(2).stores({
      tasks:
        'id, listId, userId, isCompleted, isImportant, addToMyDay, dueDate, reminderDate, category, createdAt, updatedAt, sortOrder, *tagIds',
      lists: 'id, userId, isSmart, createdAt, updatedAt',
      steps: 'id, taskId, isCompleted, createdAt, updatedAt',
      tags: 'id, userId, createdAt, updatedAt',
      syncQueue: '++id, entityType, entityId, operation, status, createdAt',
    });
  }
}

export const db = new TodoDatabase();

// ============================================================================
// ITaskStorage — Task persistence interface
// ============================================================================

export interface ITaskStorage {
  getTasks(filter?: TaskFilter): Promise<Task[]>;
  getTask(id: string): Promise<Task | null>;
  createTask(input: CreateTaskInput): Promise<Task>;
  updateTask(id: string, input: UpdateTaskInput): Promise<Task>;
  deleteTask(id: string): Promise<void>;
  addStep(taskId: string, input: CreateStepInput): Promise<void>;
  updateStep(stepId: string, input: UpdateStepInput): Promise<void>;
  deleteStep(stepId: string): Promise<void>;
}

// ============================================================================
// IListStorage — List persistence interface
// ============================================================================

export interface IListStorage {
  getLists(): Promise<List[]>;
  getList(id: string): Promise<List | null>;
  createList(input: CreateListInput): Promise<List>;
  updateList(id: string, input: UpdateListInput): Promise<List>;
  deleteList(id: string): Promise<void>;
}

// ============================================================================
// IAuthStorage — Authentication interface
// ============================================================================

export interface IAuthStorage {
  readonly mode: 'local' | 'remote';
  login(email: string, password: string): Promise<AuthResult>;
  register(name: string, email: string, password: string): Promise<AuthResult>;
  getProfile(): Promise<User>;
  getStoredUser(): User | null;
  getStoredToken(): string | null;
  setAuth(result: AuthResult): void;
  clearAuth(): void;
}

// ============================================================================
// ITagStorage — Tag management interface
// ============================================================================

export interface ITagStorage {
  getTags(): Promise<Tag[]>;
  getTag(id: string): Promise<Tag | null>;
  createTag(input: CreateTagInput): Promise<Tag>;
  updateTag(id: string, input: UpdateTagInput): Promise<Tag>;
  deleteTag(id: string): Promise<void>;
}

export interface CreateTagInput {
  name: string;
  color: string;
}

export interface UpdateTagInput {
  name?: string;
  color?: string;
}

// ============================================================================
// IStorage — Unified storage facade
// ============================================================================

export interface IStorage {
  readonly config: StorageConfig;
  readonly tasks: ITaskStorage;
  readonly lists: IListStorage;
  readonly auth: IAuthStorage;
  readonly tags: ITagStorage;
  initialize(): Promise<void>;
  destroy(): Promise<void>;
}

// ============================================================================
// Helper
// ============================================================================

function now(): string {
  return new Date().toISOString();
}

// ============================================================================
// LocalTaskStorage — IndexedDB implementation
// ============================================================================

class LocalTaskStorageImpl implements ITaskStorage {
  async getTasks(filter?: TaskFilter): Promise<Task[]> {
    let allTasks = await db.tasks.toArray();

    // Sort by sortOrder by default
    allTasks = allTasks.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));

    return allTasks.filter((task) => {
      if (!filter) return true;
      if (filter.listId != null && task.listId !== filter.listId) return false;
      if (filter.isImportant && !task.isImportant) return false;
      if (filter.addToMyDay && !task.addToMyDay) return false;
      if (filter.hasDueDate && !task.dueDate) return false;
      if (filter.isCompleted !== undefined && task.isCompleted !== filter.isCompleted) return false;
      if (filter.category != null && task.category !== filter.category) return false;
      if (filter.tagIds && filter.tagIds.length > 0) {
        const hasTag = filter.tagIds.some((tid) => task.tagIds.includes(tid));
        if (!hasTag) return false;
      }
      return true;
    });
  }

  async getTask(id: string): Promise<Task | null> {
    return (await db.tasks.get(id)) ?? null;
  }

  async createTask(input: CreateTaskInput): Promise<Task> {
    const existingTasks = await db.tasks.toArray();
    const maxSortOrder =
      existingTasks.length > 0 ? Math.max(...existingTasks.map((t) => t.sortOrder ?? 0)) : 0;

    const task: Task = {
      id: uuidv4(),
      title: input.title,
      description: input.description ?? null,
      isCompleted: input.isCompleted ?? false,
      isImportant: input.isImportant ?? false,
      addToMyDay: input.addToMyDay ?? false,
      dueDate: input.dueDate ?? null,
      reminderDate: input.reminderDate ?? null,
      repeatPattern: input.repeatPattern ?? null,
      category: input.category ?? null,
      files: [],
      listId: input.listId ?? null,
      userId: null,
      steps: [],
      sortOrder: input.sortOrder ?? maxSortOrder + 1,
      tagIds: input.tagIds ?? [],
      createdAt: now(),
      updatedAt: now(),
    };
    await db.tasks.add(task);
    return task;
  }

  async updateTask(id: string, input: UpdateTaskInput): Promise<Task> {
    const existing = await db.tasks.get(id);
    if (!existing) throw new Error(`Task ${id} not found`);
    const updated: Task = { ...existing, ...input, updatedAt: now() };
    await db.tasks.put(updated);
    return updated;
  }

  async deleteTask(id: string): Promise<void> {
    await db.transaction('rw', db.tasks, db.steps, async () => {
      await db.steps.where('taskId').equals(id).delete();
      await db.tasks.delete(id);
    });
  }

  async addStep(taskId: string, input: CreateStepInput): Promise<void> {
    const step: Step = {
      id: uuidv4(),
      title: input.title,
      isCompleted: input.isCompleted ?? false,
      taskId,
      createdAt: now(),
      updatedAt: now(),
    };
    await db.steps.add(step);
    const task = await db.tasks.get(taskId);
    if (task) {
      await db.tasks.update(taskId, { steps: [...task.steps, step], updatedAt: now() });
    }
  }

  async updateStep(stepId: string, input: UpdateStepInput): Promise<void> {
    const existing = await db.steps.get(stepId);
    if (!existing) throw new Error(`Step ${stepId} not found`);
    await db.steps.update(stepId, { ...input, updatedAt: now() });
    const task = await db.tasks.toCollection().first();
    if (task) {
      const updatedSteps = task.steps.map((s: Step) =>
        s.id === stepId ? { ...s, ...input, updatedAt: now() } : s,
      );
      await db.tasks.update(task.id, { steps: updatedSteps, updatedAt: now() });
    }
  }

  async deleteStep(stepId: string): Promise<void> {
    await db.steps.delete(stepId);
    const tasks = await db.tasks.toArray();
    for (const task of tasks) {
      const filtered = task.steps.filter((s: Step) => s.id !== stepId);
      if (filtered.length !== task.steps.length) {
        await db.tasks.update(task.id, { steps: filtered, updatedAt: now() });
      }
    }
  }
}

// ============================================================================
// LocalListStorage — IndexedDB implementation
// ============================================================================

class LocalListStorageImpl implements IListStorage {
  async getLists(): Promise<List[]> {
    const lists = await db.lists.toArray();
    return lists.filter((l) => !l.isSmart);
  }

  async getList(id: string): Promise<List | null> {
    return (await db.lists.get(id)) ?? null;
  }

  async createList(input: CreateListInput): Promise<List> {
    const list: List = {
      id: uuidv4(),
      title: input.title,
      icon: input.icon ?? null,
      theme: input.theme ?? null,
      isSmart: false,
      userId: null,
      createdAt: now(),
      updatedAt: now(),
    };
    await db.lists.add(list);
    return list;
  }

  async updateList(id: string, input: UpdateListInput): Promise<List> {
    const existing = await db.lists.get(id);
    if (!existing) throw new Error(`List ${id} not found`);
    const updated: List = { ...existing, ...input, updatedAt: now() };
    await db.lists.put(updated);
    return updated;
  }

  async deleteList(id: string): Promise<void> {
    await db.transaction('rw', db.lists, db.tasks, async () => {
      await db.tasks.where('listId').equals(id).modify({ listId: null });
      await db.lists.delete(id);
    });
  }
}

// ============================================================================
// LocalAuthStorage — 游客模式的本地认证
// ============================================================================

class LocalAuthStorageImpl implements IAuthStorage {
  readonly mode: 'local' = 'local';

  private readonly USER_KEY = 'unitodo_local_user';
  private readonly TOKEN_KEY = 'unitodo_local_token';

  login(_email: string, _password: string): Promise<AuthResult> {
    const localUser: User = {
      id: 0,
      name: 'Local User',
      email: '',
      age: 0,
      role: 'user',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const result: AuthResult = { accessToken: 'local-token', user: localUser };
    this.setAuth(result);
    return Promise.resolve(result);
  }

  register(name: string, email: string, _password: string): Promise<AuthResult> {
    const localUser: User = {
      id: Date.now(),
      name,
      email,
      age: 0,
      role: 'user',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const result: AuthResult = { accessToken: 'local-token', user: localUser };
    this.setAuth(result);
    return Promise.resolve(result);
  }

  getProfile(): Promise<User> {
    const user = this.getStoredUser();
    if (!user) return Promise.reject(new Error('Not authenticated'));
    return Promise.resolve(user);
  }

  getStoredUser(): User | null {
    try {
      const raw = localStorage.getItem(this.USER_KEY);
      return raw ? (JSON.parse(raw) as User) : null;
    } catch {
      return null;
    }
  }

  getStoredToken(): string | null {
    return localStorage.getItem(this.TOKEN_KEY);
  }

  setAuth(result: AuthResult): void {
    localStorage.setItem(this.USER_KEY, JSON.stringify(result.user));
    localStorage.setItem(this.TOKEN_KEY, result.accessToken);
  }

  clearAuth(): void {
    localStorage.removeItem(this.USER_KEY);
    localStorage.removeItem(this.TOKEN_KEY);
  }
}

// ============================================================================
// LocalTagStorage — IndexedDB implementation
// ============================================================================

class LocalTagStorageImpl implements ITagStorage {
  async getTags(): Promise<Tag[]> {
    return db.tags.toArray();
  }

  async getTag(id: string): Promise<Tag | null> {
    return (await db.tags.get(id)) ?? null;
  }

  async createTag(input: CreateTagInput): Promise<Tag> {
    const tag: Tag = {
      id: uuidv4(),
      name: input.name,
      color: input.color,
      userId: null,
      createdAt: now(),
      updatedAt: now(),
    };
    await db.tags.add(tag);
    return tag;
  }

  async updateTag(id: string, input: UpdateTagInput): Promise<Tag> {
    const existing = await db.tags.get(id);
    if (!existing) throw new Error(`Tag ${id} not found`);
    const updated: Tag = { ...existing, ...input, updatedAt: now() };
    await db.tags.put(updated);
    return updated;
  }

  async deleteTag(id: string): Promise<void> {
    await db.transaction('rw', db.tags, db.tasks, async () => {
      const allTasks = await db.tasks.toArray();
      for (const task of allTasks) {
        if (task.tagIds.includes(id)) {
          await db.tasks.update(task.id, {
            tagIds: task.tagIds.filter((tid: string) => tid !== id),
            updatedAt: now(),
          });
        }
      }
      await db.tags.delete(id);
    });
  }
}

// ============================================================================
// Remote implementations
// ============================================================================

class RemoteTaskStorageImpl implements ITaskStorage {
  constructor(private readonly api: AxiosInstance) {}

  private buildParams(
    filter?: TaskFilter,
  ): Record<string, string | boolean | string[] | undefined> {
    if (!filter) return {};
    return {
      listId: filter.listId ?? undefined,
      isImportant: filter.isImportant,
      addToMyDay: filter.addToMyDay,
      hasDueDate: filter.hasDueDate,
      tagIds: filter.tagIds && filter.tagIds.length > 0 ? filter.tagIds : undefined,
    };
  }

  async getTasks(filter?: TaskFilter): Promise<Task[]> {
    const { data } = await this.api.get<Task[]>('/tasks', { params: this.buildParams(filter) });
    return data.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  }

  async getTask(id: string): Promise<Task | null> {
    try {
      const { data } = await this.api.get<Task>(`/tasks/${id}`);
      return data;
    } catch {
      return null;
    }
  }

  async createTask(input: CreateTaskInput): Promise<Task> {
    const { data } = await this.api.post<Task>('/tasks', input);
    return data;
  }

  async updateTask(id: string, input: UpdateTaskInput): Promise<Task> {
    const { data } = await this.api.patch<Task>(`/tasks/${id}`, input);
    return data;
  }

  async deleteTask(id: string): Promise<void> {
    await this.api.delete(`/tasks/${id}`);
  }

  async addStep(taskId: string, input: CreateStepInput): Promise<void> {
    await this.api.post(`/tasks/${taskId}/steps`, input);
  }

  async updateStep(stepId: string, input: UpdateStepInput): Promise<void> {
    await this.api.patch(`/tasks/steps/${stepId}`, input);
  }

  async deleteStep(stepId: string): Promise<void> {
    await this.api.delete(`/tasks/steps/${stepId}`);
  }
}

class RemoteListStorageImpl implements IListStorage {
  constructor(private readonly api: AxiosInstance) {}

  async getLists(): Promise<List[]> {
    const { data } = await this.api.get<List[]>('/lists');
    return data;
  }

  async getList(id: string): Promise<List | null> {
    try {
      const { data } = await this.api.get<List>(`/lists/${id}`);
      return data;
    } catch {
      return null;
    }
  }

  async createList(input: CreateListInput): Promise<List> {
    const { data } = await this.api.post<List>('/lists', input);
    return data;
  }

  async updateList(id: string, input: UpdateListInput): Promise<List> {
    const { data } = await this.api.patch<List>(`/lists/${id}`, input);
    return data;
  }

  async deleteList(id: string): Promise<void> {
    await this.api.delete(`/lists/${id}`);
  }
}

class RemoteAuthStorageImpl implements IAuthStorage {
  readonly mode: 'remote' = 'remote';
  private api: AxiosInstance;

  constructor(private readonly baseUrl: string) {
    this.api = axios.create({ baseURL: baseUrl, headers: { 'Content-Type': 'application/json' } });
    this.api.interceptors.request.use((config) => {
      const token = localStorage.getItem('unitodo_token');
      console.debug(
        '[orbit] request interceptor: token from localStorage:',
        token ? `${token.slice(0, 20)}...` : null,
      );
      console.debug('[orbit] request interceptor: full url:', config.baseURL, config.url);
      if (token) config.headers.Authorization = `Bearer ${token}`;
      return config;
    });
    this.api.interceptors.response.use(
      (r) => r,
      (error) => Promise.reject(error),
    );
  }

  async login(email: string, password: string): Promise<AuthResult> {
    console.debug('[orbit] login called with email:', email);
    const { data } = await this.api.post<{
      success: boolean;
      data: { access_token: string; user: User };
    }>('/auth/login', {
      email,
      password,
    });
    console.debug('[orbit] login response:', data);
    const result: AuthResult = {
      accessToken: data.data.access_token,
      user: this.mapBackendUser(data.data.user),
    };
    console.debug('[orbit] setAuth called with token:', result.accessToken.slice(0, 20) + '...');
    this.setAuth(result);
    return result;
  }

  async register(name: string, email: string, password: string): Promise<AuthResult> {
    const { data } = await this.api.post<{
      success: boolean;
      data: { access_token: string; user: User };
    }>('/auth/register', {
      name,
      email,
      password,
      age: 18,
    });
    const result: AuthResult = {
      accessToken: data.data.access_token,
      user: this.mapBackendUser(data.data.user),
    };
    this.setAuth(result);
    return result;
  }

  private mapBackendUser(u: User): User {
    return {
      id: u.id,
      name: u.name,
      email: u.email,
      age: u.age,
      role: u.role,
      createdAt: u.createdAt ?? new Date().toISOString(),
      updatedAt: u.updatedAt ?? new Date().toISOString(),
    };
  }

  async getProfile(): Promise<User> {
    const { data } = await this.api.get<{ success: boolean; data: { user: User } }>(
      '/auth/profile',
    );
    return this.mapBackendUser(data.data.user);
  }

  getStoredUser(): User | null {
    try {
      const raw = localStorage.getItem('unitodo_user');
      return raw ? (JSON.parse(raw) as User) : null;
    } catch {
      return null;
    }
  }

  getStoredToken(): string | null {
    return localStorage.getItem('unitodo_token');
  }

  setAuth(result: AuthResult): void {
    localStorage.setItem('unitodo_user', JSON.stringify(result.user));
    localStorage.setItem('unitodo_token', result.accessToken);
  }

  clearAuth(): void {
    localStorage.removeItem('unitodo_user');
    localStorage.removeItem('unitodo_token');
  }
}

class RemoteTagStorageImpl implements ITagStorage {
  constructor(private readonly api: AxiosInstance) {}

  async getTags(): Promise<Tag[]> {
    const { data } = await this.api.get<Tag[]>('/tags');
    return data;
  }

  async getTag(id: string): Promise<Tag | null> {
    try {
      const { data } = await this.api.get<Tag>(`/tags/${id}`);
      return data;
    } catch {
      return null;
    }
  }

  async createTag(input: CreateTagInput): Promise<Tag> {
    const { data } = await this.api.post<Tag>('/tags', input);
    return data;
  }

  async updateTag(id: string, input: UpdateTagInput): Promise<Tag> {
    const { data } = await this.api.patch<Tag>(`/tags/${id}`, input);
    return data;
  }

  async deleteTag(id: string): Promise<void> {
    await this.api.delete(`/tags/${id}`);
  }
}

// ============================================================================
// Unified Storage Classes
// ============================================================================

export class LocalStorage implements IStorage {
  readonly config: StorageConfig;
  readonly tasks: ITaskStorage;
  readonly lists: IListStorage;
  readonly auth: IAuthStorage;
  readonly tags: ITagStorage;

  constructor(config: StorageConfig) {
    this.config = config;
    this.tasks = new LocalTaskStorageImpl();
    this.lists = new LocalListStorageImpl();
    this.auth = new LocalAuthStorageImpl();
    this.tags = new LocalTagStorageImpl();
  }

  async initialize(): Promise<void> {}
  async destroy(): Promise<void> {}
}

export class RemoteStorage implements IStorage {
  readonly config: StorageConfig;
  readonly tasks: ITaskStorage;
  readonly lists: IListStorage;
  readonly auth: IAuthStorage;
  readonly tags: ITagStorage;

  constructor(config: StorageConfig) {
    const baseUrl = config.apiBaseUrl ?? 'http://localhost:3001/api';
    this.config = config;
    this.tasks = new RemoteTaskStorageImpl(
      axios.create({
        baseURL: baseUrl,
        headers: { 'Content-Type': 'application/json' },
        withCredentials: false,
      }),
    );
    this.lists = new RemoteListStorageImpl(
      axios.create({
        baseURL: baseUrl,
        headers: { 'Content-Type': 'application/json' },
        withCredentials: false,
      }),
    );
    this.auth = new RemoteAuthStorageImpl(baseUrl);
    this.tags = new RemoteTagStorageImpl(
      axios.create({
        baseURL: baseUrl,
        headers: { 'Content-Type': 'application/json' },
        withCredentials: false,
      }),
    );
  }

  async initialize(): Promise<void> {}
  async destroy(): Promise<void> {}
}

// Re-export sync queue for external use
export { syncQueue } from './sync-queue';
export type { SyncQueueListener } from './sync-queue';
