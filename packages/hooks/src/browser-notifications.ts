/**
 * useNotifications — 浏览器系统通知服务
 *
 * 提供浏览器 Notification API 的封装，支持：
 * - 权限请求与状态查询
 * - 定时检查任务到期提醒
 * - 自定义通知展示与点击处理
 */

import type { Task } from '@baicie/orbit';

export interface NotificationSettings {
  enabled: boolean;
  reminderLeadTime: number;
  repeatNotifications: boolean;
  sound: boolean;
  importantOnly: boolean;
}

const DEFAULT_SETTINGS: NotificationSettings = {
  enabled: true,
  reminderLeadTime: 0,
  repeatNotifications: true,
  sound: true,
  importantOnly: false,
};

const NOTIFIED_KEY_PREFIX = 'orbit_notified_';
const CHECK_INTERVAL = 60000;

export class NotificationService {
  private checkIntervalId: ReturnType<typeof setInterval> | null = null;
  private settings: NotificationSettings = DEFAULT_SETTINGS;
  private listeners: Set<() => void> = new Set();

  constructor() {
    this.loadSettings();
  }

  private loadSettings(): void {
    try {
      const stored = localStorage.getItem('orbit_notification_settings');
      if (stored) {
        this.settings = { ...DEFAULT_SETTINGS, ...JSON.parse(stored) };
      }
    } catch {
      this.settings = DEFAULT_SETTINGS;
    }
  }

  saveSettings(settings: Partial<NotificationSettings>): void {
    this.settings = { ...this.settings, ...settings };
    try {
      localStorage.setItem('orbit_notification_settings', JSON.stringify(this.settings));
    } catch {
      // Storage full or unavailable
    }
    this.notifyChange();
  }

  getSettings(): NotificationSettings {
    return { ...this.settings };
  }

  private notifyChange(): void {
    this.listeners.forEach((l) => l());
  }

  addChangeListener(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async requestPermission(): Promise<boolean> {
    if (typeof Notification === 'undefined') return false;
    if (Notification.permission === 'granted') return true;
    if (Notification.permission === 'denied') return false;

    try {
      const result = await Notification.requestPermission();
      return result === 'granted';
    } catch {
      return false;
    }
  }

  isSupported(): boolean {
    return typeof Notification !== 'undefined';
  }

  getPermissionStatus(): NotificationPermission | 'unsupported' {
    if (typeof Notification === 'undefined') return 'unsupported';
    return Notification.permission;
  }

  start(getTasks: () => Promise<Task[]>): void {
    this.stop();
    void this.checkReminders(getTasks);
    this.checkIntervalId = setInterval(() => {
      void this.checkReminders(getTasks);
    }, CHECK_INTERVAL);
  }

  stop(): void {
    if (this.checkIntervalId !== null) {
      clearInterval(this.checkIntervalId);
      this.checkIntervalId = null;
    }
  }

  private async checkReminders(getTasks: () => Promise<Task[]>): Promise<void> {
    if (!this.settings.enabled) return;
    if (!this.isSupported()) return;
    if (Notification.permission !== 'granted') return;

    const now = new Date();
    const leadTime = this.settings.reminderLeadTime * 60 * 1000;

    try {
      const tasks = await getTasks();
      const notifiedKeys = new Set<string>();

      for (const task of tasks) {
        if (!task.reminderDate || task.isCompleted) continue;
        if (this.settings.importantOnly && !task.isImportant) continue;

        const reminderTime = new Date(task.reminderDate).getTime() - leadTime;
        const timeDiff = now.getTime() - reminderTime;

        if (timeDiff >= 0 && timeDiff < CHECK_INTERVAL) {
          const notifiedKey = `${NOTIFIED_KEY_PREFIX}${task.id}`;
          if (!notifiedKeys.has(notifiedKey) && !localStorage.getItem(notifiedKey)) {
            await this.showNotification(task);
            try {
              localStorage.setItem(notifiedKey, new Date().toISOString());
            } catch {
              // Storage full
            }
            notifiedKeys.add(notifiedKey);
          }
        }
      }
    } catch {
      // Tasks fetch failed
    }
  }

  async showNotification(task: Task): Promise<void> {
    if (!this.isSupported()) return;
    if (Notification.permission !== 'granted') return;

    const title = task.title;
    const body = task.description || '任务已到期';

    try {
      const notification = new Notification(title, {
        body,
        icon: '/icons/icon-192.svg',
        tag: task.id,
        data: { taskId: task.id },
        silent: !this.settings.sound,
      });

      notification.onclick = () => {
        window.focus();
        notification.close();
        const url = new URL(window.location.href);
        url.searchParams.set('highlight', task.id);
        window.history.pushState({}, '', url.toString());
        window.dispatchEvent(
          new CustomEvent('orbit-task-highlight', { detail: { taskId: task.id } }),
        );
      };

      setTimeout(() => notification.close(), 10000);
    } catch {
      // Notification failed
    }
  }

  clearNotificationHistory(): void {
    const keysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(NOTIFIED_KEY_PREFIX)) {
        keysToRemove.push(key);
      }
    }
    keysToRemove.forEach((k) => localStorage.removeItem(k));
  }
}

export const notificationService = new NotificationService();
