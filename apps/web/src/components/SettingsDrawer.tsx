import {
  Bell,
  Cloud,
  CloudOff,
  Download,
  HelpCircle,
  Info,
  Monitor,
  Moon,
  Shield,
  Sun,
  X,
} from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { notificationService, switchStorageMode, useSync } from '@baicie/orbit-hooks';
import { useEffect, useState } from 'react';

interface SettingsDrawerProps {
  isOpen: boolean;
  onClose: () => void;
}

type ThemeMode = 'system' | 'light' | 'dark';

function getStoredThemeMode(): ThemeMode {
  if (typeof window === 'undefined') return 'system';
  const stored = localStorage.getItem('orbit_theme_mode');
  if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
  return 'system';
}

function getStoredNotificationsEnabled(): boolean {
  if (typeof window === 'undefined') return true;
  const settings = notificationService.getSettings();
  return settings.enabled;
}

export const SettingsDrawer = ({ isOpen, onClose }: SettingsDrawerProps) => {
  const { t } = useTranslation();
  const { user, storageMode } = useAuth();
  const { pendingCount, isSyncing, isOnline, triggerSync } = useSync();
  const [isSwitchingMode, setIsSwitchingMode] = useState(false);
  const [themeMode, setThemeMode] = useState<ThemeMode>(getStoredThemeMode);
  const [notificationsEnabled, setNotificationsEnabled] = useState(getStoredNotificationsEnabled);

  useEffect(() => {
    const root = document.documentElement;
    if (themeMode === 'system') {
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      root.classList.toggle('dark', prefersDark);
    } else {
      root.classList.toggle('dark', themeMode === 'dark');
    }
    localStorage.setItem('orbit_theme_mode', themeMode);
  }, [themeMode]);

  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) => {
      if (themeMode === 'system') {
        document.documentElement.classList.toggle('dark', e.matches);
      }
    };
    mediaQuery.addEventListener('change', handler);
    return () => mediaQuery.removeEventListener('change', handler);
  }, [themeMode]);

  const handleNotificationToggle = () => {
    const newVal = !notificationsEnabled;
    setNotificationsEnabled(newVal);
    notificationService.saveSettings({ enabled: newVal });
    if (newVal) {
      void notificationService.requestPermission();
    }
  };

  const handleSwitchMode = async () => {
    setIsSwitchingMode(true);
    try {
      if (storageMode === 'local') {
        const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:3001/api';
        switchStorageMode('remote', apiUrl);
      } else {
        switchStorageMode('local');
      }
      window.location.reload();
    } finally {
      setIsSwitchingMode(false);
    }
  };

  const themeModes: { value: ThemeMode; label: string; icon: React.ReactNode }[] = [
    { value: 'system', label: t('settings.systemDefault'), icon: <Monitor size={16} /> },
    { value: 'light', label: t('settings.light'), icon: <Sun size={16} /> },
    { value: 'dark', label: t('settings.dark'), icon: <Moon size={16} /> },
  ];

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 bg-black/20 z-40"
          />

          {/* Drawer */}
          <motion.div
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', stiffness: 300, damping: 30 }}
            className="fixed right-0 top-0 bottom-0 w-[360px] bg-white shadow-2xl z-50 flex flex-col"
          >
            {/* Header */}
            <div className="flex items-center justify-between p-4 border-b border-gray-200">
              <h2 className="text-lg font-semibold text-gray-900">{t('settings.title')}</h2>
              <button
                onClick={onClose}
                className="p-2 hover:bg-gray-100 rounded-md transition-colors text-gray-500"
              >
                <X size={20} />
              </button>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto p-4 space-y-6">
              {/* Sync Status */}
              <section>
                <h3 className="text-sm font-medium text-gray-900 mb-3">
                  {t('settings.sync') || '同步状态'}
                </h3>
                <div className="space-y-2">
                  {/* Online Status */}
                  <div className="flex items-center justify-between p-3 rounded-md bg-gray-50">
                    <div className="flex items-center gap-3">
                      <div
                        className={`p-2 rounded-md ${isOnline ? 'bg-green-50 text-green-600' : 'bg-red-50 text-red-500'}`}
                      >
                        {isOnline ? <Cloud size={18} /> : <CloudOff size={18} />}
                      </div>
                      <div>
                        <span className="text-sm text-gray-700 block">
                          {isOnline ? '在线' : '离线'}
                        </span>
                        <span className="text-xs text-gray-400">
                          {isSyncing
                            ? '同步中...'
                            : pendingCount > 0
                              ? `${pendingCount} 项待同步`
                              : '已同步'}
                        </span>
                      </div>
                    </div>
                    {isOnline && pendingCount > 0 && (
                      <button
                        onClick={triggerSync}
                        disabled={isSyncing}
                        className="text-xs text-blue-500 hover:text-blue-600 disabled:opacity-50"
                      >
                        {isSyncing ? '同步中' : '立即同步'}
                      </button>
                    )}
                  </div>

                  {/* Storage Mode */}
                  <div
                    className="flex items-center justify-between p-3 rounded-md hover:bg-gray-50 cursor-pointer transition-colors"
                    onClick={handleSwitchMode}
                  >
                    <div className="flex items-center gap-3">
                      <div className="p-2 bg-blue-50 rounded-md text-blue-600">
                        {storageMode === 'remote' ? <Cloud size={18} /> : <Monitor size={18} />}
                      </div>
                      <div>
                        <span className="text-sm text-gray-700 block">
                          {storageMode === 'remote' ? '云端模式' : '本地模式'}
                        </span>
                        <span className="text-xs text-gray-400">
                          {storageMode === 'remote' ? '数据同步到服务器' : '数据仅保存在本地'}
                        </span>
                      </div>
                    </div>
                    {isSwitchingMode ? (
                      <span className="text-xs text-gray-400">切换中...</span>
                    ) : (
                      <span className="text-xs text-blue-500">
                        切换为{storageMode === 'local' ? '云端' : '本地'}
                      </span>
                    )}
                  </div>
                </div>
              </section>

              {/* General */}
              <section>
                <h3 className="text-sm font-medium text-gray-900 mb-3">{t('settings.general')}</h3>
                <div className="space-y-2">
                  {/* Theme */}
                  <div className="p-3 rounded-md bg-gray-50">
                    <div className="flex items-center gap-3 mb-3">
                      <div className="p-2 bg-blue-50 rounded-md text-blue-600">
                        <Sun size={18} />
                      </div>
                      <span className="text-sm text-gray-700">{t('settings.theme')}</span>
                    </div>
                    <div className="flex gap-1">
                      {themeModes.map(({ value, label, icon }) => (
                        <button
                          key={value}
                          onClick={() => setThemeMode(value)}
                          className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded text-xs font-medium transition-colors ${
                            themeMode === value
                              ? 'bg-blue-100 text-blue-700 border border-blue-200'
                              : 'bg-white text-gray-600 border border-gray-200 hover:bg-gray-50'
                          }`}
                          aria-pressed={themeMode === value}
                        >
                          {icon}
                          <span className="hidden sm:inline">{label}</span>
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Notifications */}
                  <div className="flex items-center justify-between p-3 rounded-md hover:bg-gray-50 transition-colors">
                    <div className="flex items-center gap-3">
                      <div className="p-2 bg-purple-50 rounded-md text-purple-600">
                        <Bell size={18} />
                      </div>
                      <span className="text-sm text-gray-700">{t('settings.notifications')}</span>
                    </div>
                    <button
                      role="switch"
                      aria-checked={notificationsEnabled}
                      onClick={handleNotificationToggle}
                      className={`w-10 h-5 rounded-full relative transition-colors ${
                        notificationsEnabled ? 'bg-blue-500' : 'bg-gray-300'
                      }`}
                    >
                      <span
                        className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${
                          notificationsEnabled ? 'translate-x-5' : 'translate-x-0.5'
                        }`}
                      />
                    </button>
                  </div>
                </div>
              </section>

              {/* PWA Install */}
              <section>
                <h3 className="text-sm font-medium text-gray-900 mb-3">
                  {t('settings.installApp')}
                </h3>
                <div className="p-3 rounded-md bg-gray-50">
                  <div className="flex items-center gap-3">
                    <div className="p-2 bg-green-50 rounded-md text-green-600">
                      <Download size={18} />
                    </div>
                    <div className="flex-1">
                      <span className="text-sm text-gray-700 block">{t('pwa.installTitle')}</span>
                      <span className="text-xs text-gray-400">{t('pwa.installDesc')}</span>
                    </div>
                  </div>
                </div>
              </section>

              {/* Account */}
              <section>
                <h3 className="text-sm font-medium text-gray-900 mb-3">{t('settings.account')}</h3>
                <div className="space-y-2">
                  {user ? (
                    <div className="p-3 rounded-md bg-gray-50">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-full bg-blue-100 flex items-center justify-center text-blue-600 font-semibold">
                          {user.name?.[0]?.toUpperCase() || 'U'}
                        </div>
                        <div>
                          <span className="text-sm font-medium text-gray-900 block">
                            {user.name}
                          </span>
                          <span className="text-xs text-gray-400">{user.email}</span>
                        </div>
                      </div>
                      <div className="mt-2 flex items-center gap-2">
                        <div
                          className={`w-2 h-2 rounded-full ${isOnline ? 'bg-green-500' : 'bg-gray-400'}`}
                        />
                        <span className="text-xs text-gray-400">
                          {isOnline ? '已连接' : '未连接'}
                        </span>
                      </div>
                    </div>
                  ) : (
                    <div className="p-3 rounded-md bg-amber-50 border border-amber-100">
                      <div className="flex items-center gap-3">
                        <div className="p-2 bg-amber-100 rounded-md text-amber-600">
                          <Shield size={18} />
                        </div>
                        <div>
                          <span className="text-sm font-medium text-gray-900 block">游客模式</span>
                          <span className="text-xs text-gray-400">
                            数据保存在本地，可随时登录同步
                          </span>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </section>

              {/* About */}
              <section>
                <h3 className="text-sm font-medium text-gray-900 mb-3">{t('settings.about')}</h3>
                <div className="space-y-2">
                  <div className="flex items-center justify-between p-3 rounded-md hover:bg-gray-50 cursor-pointer transition-colors">
                    <div className="flex items-center gap-3">
                      <div className="p-2 bg-orange-50 rounded-md text-orange-600">
                        <HelpCircle size={18} />
                      </div>
                      <span className="text-sm text-gray-700">{t('settings.helpFeedback')}</span>
                    </div>
                  </div>

                  <div className="flex items-center justify-between p-3 rounded-md hover:bg-gray-50 cursor-pointer transition-colors">
                    <div className="flex items-center gap-3">
                      <div className="p-2 bg-gray-50 rounded-md text-gray-600">
                        <Info size={18} />
                      </div>
                      <span className="text-sm text-gray-700">{t('settings.version')}</span>
                    </div>
                    <span className="text-xs text-gray-400">v1.0.0</span>
                  </div>
                </div>
              </section>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
};
