import { Bell, BellOff, Check, CheckCheck, Clock, Sparkles, Trash2, X } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { useNotifications } from '@baicie/orbit-hooks';
import type { AppNotification, NotificationType } from '@baicie/orbit-hooks';
import { useState } from 'react';
import { Button } from '@baicie/orbit-ui';

interface NotificationPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

function getNotificationIcon(type: NotificationType): React.ReactNode {
  switch (type) {
    case 'reminder':
      return <Bell size={16} className="text-blue-500" />;
    case 'due':
      return <Clock size={16} className="text-amber-500" />;
    case 'overdue':
      return <BellOff size={16} className="text-red-500" />;
    case 'system':
      return <Sparkles size={16} className="text-purple-500" />;
    case 'sync':
      return <Bell size={16} className="text-green-500" />;
    case 'achievement':
      return <Check size={16} className="text-yellow-500" />;
    default:
      return <Bell size={16} className="text-gray-500" />;
  }
}

function getNotificationTitle(type: NotificationType): string {
  switch (type) {
    case 'reminder':
      return '提醒';
    case 'due':
      return '到期';
    case 'overdue':
      return '逾期';
    case 'system':
      return '系统';
    case 'sync':
      return '同步';
    case 'achievement':
      return '成就';
    default:
      return '通知';
  }
}

function formatTime(isoString: string): string {
  const date = new Date(isoString);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
  return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
}

export function NotificationPanel({ isOpen, onClose }: NotificationPanelProps) {
  const navigate = useNavigate();
  const { notifications, unreadCount, markRead, markAllRead, dismiss, clearAll } =
    useNotifications();
  const [activeFilter, setActiveFilter] = useState<'all' | 'unread'>('all');

  const filteredNotifications =
    activeFilter === 'unread' ? notifications.filter((n) => !n.read) : notifications;

  const handleNavigate = (notification: AppNotification) => {
    if (notification.taskId) navigate(`/tasks/my-day`);
    onClose();
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 bg-black/20 z-40"
          />
          <motion.div
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', stiffness: 300, damping: 30 }}
            className="fixed right-0 top-0 bottom-0 w-[380px] bg-white shadow-2xl z-50 flex flex-col"
          >
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
              <div className="flex items-center gap-2">
                <Bell size={18} className="text-gray-600" />
                <h2 className="text-base font-semibold text-gray-900">通知</h2>
                {unreadCount > 0 && (
                  <span className="px-1.5 py-0.5 bg-blue-500 text-white text-xs rounded-full font-medium">
                    {unreadCount}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1">
                {unreadCount > 0 && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={markAllRead}
                    className="text-gray-500"
                    title="全部标为已读"
                  >
                    <CheckCheck size={16} />
                  </Button>
                )}
                {notifications.length > 0 && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={clearAll}
                    className="text-gray-400 hover:text-red-500"
                    title="清空"
                  >
                    <Trash2 size={16} />
                  </Button>
                )}
                <Button variant="ghost" size="icon" onClick={onClose} className="text-gray-500">
                  <X size={16} />
                </Button>
              </div>
            </div>

            {/* Filter Tabs */}
            <div className="flex border-b border-gray-200 px-4">
              {(['all', 'unread'] as const).map((filter) => (
                <Button
                  key={filter}
                  variant="ghost"
                  onClick={() => setActiveFilter(filter)}
                  className={`px-3 py-2 text-sm font-medium border-b-2 transition-colors -mb-px rounded-none ${
                    activeFilter === filter
                      ? 'border-blue-500 text-blue-600 bg-transparent'
                      : 'border-transparent text-gray-500 hover:text-gray-700'
                  }`}
                >
                  {filter === 'all' ? '全部' : '未读'} (
                  {filter === 'all' ? notifications.length : unreadCount})
                </Button>
              ))}
            </div>

            {/* List */}
            <div className="flex-1 overflow-y-auto">
              {filteredNotifications.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 text-gray-400">
                  <Bell size={40} className="mb-3 opacity-50" />
                  <p className="text-sm font-medium">
                    {activeFilter === 'unread' ? '没有未读通知' : '暂无通知'}
                  </p>
                </div>
              ) : (
                <div className="divide-y divide-gray-100">
                  {filteredNotifications.map((notification) => (
                    <div
                      key={notification.id}
                      className={`flex items-start gap-3 px-4 py-3 hover:bg-gray-50 transition-colors cursor-pointer ${
                        !notification.read ? 'bg-blue-50/50' : ''
                      }`}
                      onClick={() => {
                        markRead(notification.id);
                        handleNavigate(notification);
                      }}
                    >
                      <div className="flex-shrink-0 mt-0.5">
                        {getNotificationIcon(notification.type)}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs font-medium text-gray-500">
                            {getNotificationTitle(notification.type)}
                          </span>
                          <span className="text-xs text-gray-400 flex-shrink-0">
                            {formatTime(notification.createdAt)}
                          </span>
                        </div>
                        <p className="text-sm text-gray-900 mt-0.5 font-medium truncate">
                          {notification.title}
                        </p>
                        {notification.body && (
                          <p className="text-xs text-gray-500 mt-0.5 line-clamp-2">
                            {notification.body}
                          </p>
                        )}
                      </div>
                      {!notification.read && (
                        <div className="w-2 h-2 rounded-full bg-blue-500 flex-shrink-0 mt-1.5" />
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
