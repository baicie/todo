/**
 * Orbit 插件系统 — 核心类型定义
 */

import type { ReactNode } from 'react';

export type PluginPermission =
  | 'task:read'
  | 'task:write'
  | 'list:read'
  | 'list:write'
  | 'ui:inject'
  | 'ui:badge'
  | 'ui:action'
  | 'ui:panel'
  | 'storage:local'
  | 'storage:sync'
  | 'webhook:invoke';

export type PluginScope = 'task-list' | 'task-detail' | 'list-sidebar' | 'global';

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  homepage?: string;
  permissions: PluginPermission[];
  entry: string;
  scope: PluginScope[];
  hooks?: string[];
  customFields?: CustomFieldDefinition[];
  icon?: string;
}

export interface CustomFieldDefinition {
  key: string;
  label: string;
  type: 'text' | 'number' | 'select' | 'date' | 'checkbox';
  options?: string[];
  defaultValue?: unknown;
  min?: number;
  max?: number;
  unit?: string;
  required?: boolean;
}

export interface PluginContext {
  manifest: PluginManifest;
  api: PluginApi;
  storage: Map<string, unknown>;
  onReady: (callback: () => void) => void;
  onDestroy: (callback: () => void) => void;
}

export interface TaskAction {
  id: string;
  label: string;
  icon?: string;
  onClick: (taskId: string) => void;
}

export interface SidebarPanel {
  id: string;
  title: string;
  icon?: string;
  order?: number;
  render: () => ReactNode;
}

export interface PluginApi {
  tasks: {
    get(id: string): Promise<unknown>;
    create(input: Record<string, unknown>): Promise<unknown>;
    update(id: string, patch: Record<string, unknown>): Promise<unknown>;
    query(filter: Record<string, unknown>): Promise<unknown[]>;
  };
  lists: {
    getAll(): Promise<unknown[]>;
    get(id: string): Promise<unknown>;
  };
  storage: {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<void>;
  };
  ui: {
    registerTaskBadge(renderer: (task: unknown) => ReactNode): void;
    registerTaskAction(action: TaskAction): void;
    registerSidebarPanel(panel: SidebarPanel): void;
    showToast(message: string, type?: 'info' | 'success' | 'warning' | 'error'): void;
    unregisterTaskBadge(): void;
    unregisterTaskAction(id: string): void;
    unregisterSidebarPanel(id: string): void;
  };
  workflow: {
    registerTrigger(type: string, handler: (data: unknown) => void): void;
    unregisterTrigger(type: string): void;
  };
}
