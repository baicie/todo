/**
 * useNotifications — 浏览器系统通知服务 + 应用内通知 Hook
 *
 * 重构后的模块，导出两个独立系统：
 * 1. notificationService — 浏览器原生 Notification API
 * 2. useNotifications — React Hook，管理应用内通知面板
 */

export { notificationService, type NotificationSettings } from './browser-notifications';
export { notificationStore } from './useNotificationStore';
export type { AppNotification, NotificationType } from './useNotificationStore';

// ---- React Hook for in-app notifications ----

import { useCallback, useEffect, useState } from 'react';
import { type AppNotification, notificationStore } from './useNotificationStore';

export function useNotifications() {
  const [notifications, setNotifications] = useState<AppNotification[]>(() =>
    notificationStore.getAll().filter((n) => !n.dismissed),
  );
  const [unreadCount, setUnreadCount] = useState(0);

  const refresh = useCallback(() => {
    setNotifications(notificationStore.getAll().filter((n) => !n.dismissed));
    setUnreadCount(notificationStore.getUnreadCount());
  }, []);

  useEffect(() => {
    refresh();
    return notificationStore.addChangeListener(refresh);
  }, [refresh]);

  return {
    notifications,
    unreadCount,
    markRead: notificationStore.markRead.bind(notificationStore),
    markAllRead: notificationStore.markAllRead.bind(notificationStore),
    dismiss: notificationStore.dismiss.bind(notificationStore),
    clearAll: notificationStore.clearAll.bind(notificationStore),
  };
}
