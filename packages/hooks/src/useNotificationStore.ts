/**
 * 通知系统 — 本地通知存储
 *
 * 管理应用内通知历史，支持按类型、时间过滤，
 * 数据存储在 localStorage 中（最多保留 100 条）。
 */

export type NotificationType = 'reminder' | 'due' | 'overdue' | 'system' | 'sync' | 'achievement';

export interface AppNotification {
  id: string;
  type: NotificationType;
  title: string;
  body?: string;
  taskId?: string;
  read: boolean;
  createdAt: string;
  dismissed: boolean;
}

const STORAGE_KEY = 'orbit_notifications';
const MAX_NOTIFICATIONS = 100;

function loadNotifications(): AppNotification[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    // ignore
  }
  return [];
}

function saveNotifications(notifications: AppNotification[]): void {
  try {
    const trimmed = notifications.slice(0, MAX_NOTIFICATIONS);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
  } catch {
    // ignore
  }
}

const listeners = new Set<() => void>();

function notifyChange() {
  listeners.forEach((fn) => fn());
}

export const notificationStore = {
  getAll(): AppNotification[] {
    return loadNotifications();
  },

  getUnreadCount(): number {
    return loadNotifications().filter((n) => !n.read && !n.dismissed).length;
  },

  add(data: Omit<AppNotification, 'id' | 'read' | 'dismissed'>): AppNotification {
    const notifications = loadNotifications();
    const notification: AppNotification = {
      ...data,
      id: `notif_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      read: false,
      dismissed: false,
    };
    notifications.unshift(notification);
    saveNotifications(notifications);
    notifyChange();
    return notification;
  },

  markRead(id: string): void {
    const notifications = loadNotifications().map((n) => (n.id === id ? { ...n, read: true } : n));
    saveNotifications(notifications);
    notifyChange();
  },

  markAllRead(): void {
    const notifications = loadNotifications().map((n) => ({ ...n, read: true }));
    saveNotifications(notifications);
    notifyChange();
  },

  dismiss(id: string): void {
    const notifications = loadNotifications().map((n) =>
      n.id === id ? { ...n, dismissed: true } : n,
    );
    saveNotifications(notifications);
    notifyChange();
  },

  clearAll(): void {
    saveNotifications([]);
    notifyChange();
  },

  addChangeListener(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  addReminder(taskId: string, taskTitle: string, dueDate?: string): AppNotification {
    return notificationStore.add({
      type: dueDate ? 'due' : 'reminder',
      title: dueDate ? '任务到期' : '提醒',
      body: taskTitle,
      taskId,
      createdAt: new Date().toISOString(),
    });
  },

  addSystem(title: string, body?: string): AppNotification {
    return notificationStore.add({
      type: 'system',
      title,
      body,
      createdAt: new Date().toISOString(),
    });
  },

  addSync(type: 'success' | 'error' | 'conflict', message: string): AppNotification {
    return notificationStore.add({
      type: 'sync',
      title: type === 'success' ? '同步成功' : type === 'error' ? '同步失败' : '同步冲突',
      body: message,
      createdAt: new Date().toISOString(),
    });
  },
};
