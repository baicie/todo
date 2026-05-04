/**
 * Orbit 插件系统 — 插件宿主（Plugin Host）
 *
 * 负责插件的注册、加载、生命周期管理和 UI 扩展点注册。
 */

import type { ReactNode } from 'react';
import type { PluginManifest, PluginScope, PluginPermission } from '../types';
import type { TaskAction, SidebarPanel } from '../types';

export type PluginStatus = 'pending' | 'loading' | 'active' | 'error' | 'disabled';

export interface PluginInstance {
  manifest: PluginManifest;
  status: PluginStatus;
  error?: string;
  unregisterFns: Array<() => void>;
}

const pluginRegistry = new Map<string, PluginInstance>();

let taskBadgeRenderers: Array<(task: unknown) => ReactNode> = [];
let taskActions: Array<TaskAction> = [];
let sidebarPanels: Array<SidebarPanel> = [];

export function registerPlugin(manifest: PluginManifest): void {
  if (pluginRegistry.has(manifest.id)) {
    console.warn(`[PluginHost] Plugin "${manifest.id}" is already registered.`);
    return;
  }

  const instance: PluginInstance = {
    manifest,
    status: 'pending',
    unregisterFns: [],
  };

  pluginRegistry.set(manifest.id, instance);
}

export function activatePlugin(pluginId: string): void {
  const instance = pluginRegistry.get(pluginId);
  if (!instance) {
    console.error(`[PluginHost] Plugin "${pluginId}" not found in registry.`);
    return;
  }

  if (instance.status === 'active') {
    console.warn(`[PluginHost] Plugin "${pluginId}" is already active.`);
    return;
  }

  instance.status = 'active';
  instance.error = undefined;
}

export function deactivatePlugin(pluginId: string): void {
  const instance = pluginRegistry.get(pluginId);
  if (!instance) {
    console.warn(`[PluginHost] Plugin "${pluginId}" not found in registry.`);
    return;
  }

  for (const unregister of instance.unregisterFns) {
    try {
      unregister();
    } catch {
      console.warn(`[PluginHost] Unregister function failed for plugin "${pluginId}"`);
    }
  }
  instance.unregisterFns = [];
  instance.status = 'disabled';

  taskBadgeRenderers = [];
  taskActions = taskActions.filter((a) => !a.id.startsWith(`${pluginId}:`));
  sidebarPanels = sidebarPanels.filter((p) => !p.id.startsWith(`${pluginId}:`));
}

export function getPluginInstance(pluginId: string): PluginInstance | undefined {
  return pluginRegistry.get(pluginId);
}

export function getAllPlugins(): PluginInstance[] {
  return Array.from(pluginRegistry.values());
}

export function getPluginsByScope(scope: PluginScope): PluginInstance[] {
  return Array.from(pluginRegistry.values()).filter((p) => p.manifest.scope.includes(scope));
}

export function getActivePlugins(): PluginInstance[] {
  return Array.from(pluginRegistry.values()).filter((p) => p.status === 'active');
}

export function hasPermission(pluginId: string, permission: PluginPermission): boolean {
  const instance = pluginRegistry.get(pluginId);
  if (!instance) return false;
  return instance.manifest.permissions.includes(permission);
}

export function addTaskBadgeRenderer(
  pluginId: string,
  renderer: (task: unknown) => ReactNode,
): () => void {
  taskBadgeRenderers.push(renderer);
  const instance = pluginRegistry.get(pluginId);
  if (instance) {
    instance.unregisterFns.push(() => {
      taskBadgeRenderers = taskBadgeRenderers.filter((r) => r !== renderer);
    });
  }
  return () => {
    taskBadgeRenderers = taskBadgeRenderers.filter((r) => r !== renderer);
  };
}

export function addTaskAction(pluginId: string, action: TaskAction): () => void {
  const id = `${pluginId}:${action.id}`;
  taskActions.push({ ...action, id });
  const instance = pluginRegistry.get(pluginId);
  if (instance) {
    instance.unregisterFns.push(() => {
      taskActions = taskActions.filter((a) => a.id !== id);
    });
  }
  return () => {
    taskActions = taskActions.filter((a) => a.id !== id);
  };
}

export function addSidebarPanel(pluginId: string, panel: SidebarPanel): () => void {
  const id = `${pluginId}:${panel.id}`;
  sidebarPanels.push({ ...panel, id });
  sidebarPanels.sort((a, b) => (a.order ?? 99) - (b.order ?? 99));
  const instance = pluginRegistry.get(pluginId);
  if (instance) {
    instance.unregisterFns.push(() => {
      sidebarPanels = sidebarPanels.filter((p) => p.id !== id);
    });
  }
  return () => {
    sidebarPanels = sidebarPanels.filter((p) => p.id !== id);
  };
}

export function getTaskBadgeRenderers(): Array<(task: unknown) => ReactNode> {
  return taskBadgeRenderers;
}

export function getTaskActions(): Array<TaskAction> {
  return taskActions;
}

export function getSidebarPanels(): Array<SidebarPanel> {
  return sidebarPanels;
}

export function removePlugin(pluginId: string): void {
  deactivatePlugin(pluginId);
  pluginRegistry.delete(pluginId);
}
