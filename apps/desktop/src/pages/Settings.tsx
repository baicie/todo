import {
  ArrowLeft,
  Bell,
  Cloud,
  Download,
  Eye,
  FileJson,
  HardDrive,
  Languages,
  Lock,
  Monitor,
  Moon,
  Palette,
  Save,
  Shield,
  Sun,
  Trash2,
  Upload,
  User,
} from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { notificationService, useList, useSync, useTask } from '@baicie/orbit-hooks';
import { useEffect, useRef, useState } from 'react';

type ThemeMode = 'system' | 'light' | 'dark';
type TabId = 'profile' | 'appearance' | 'data' | 'security';

function SectionCard({
  title,
  icon,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
      <div className="px-6 py-4 border-b border-gray-100 flex items-center gap-3">
        <div className="p-2 bg-blue-50 rounded-md text-blue-600">{icon}</div>
        <h2 className="text-base font-semibold text-gray-900">{title}</h2>
      </div>
      <div className="p-6">{children}</div>
    </div>
  );
}

function ToggleSwitch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-sm text-gray-700">{label}</span>
      <button
        role="switch"
        aria-checked={checked}
        onClick={onChange}
        className={`w-11 h-6 rounded-full relative transition-colors ${checked ? 'bg-blue-500' : 'bg-gray-300'}`}
      >
        <span
          className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${checked ? 'translate-x-5' : 'translate-x-0.5'}`}
        />
      </button>
    </div>
  );
}

export function Settings() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { pendingCount, isSyncing, isOnline } = useSync();

  const [activeTab, setActiveTab] = useState<TabId>('profile');
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
    const stored = localStorage.getItem('orbit_theme_mode');
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
    return 'system';
  });
  const [notificationsEnabled, setNotificationsEnabled] = useState(() => {
    const settings = notificationService.getSettings();
    return settings.enabled;
  });
  const [currentLang, setCurrentLang] = useState(() => localStorage.getItem('i18nextLng') || 'zh');
  const [apiUrl, setApiUrl] = useState(
    () => localStorage.getItem('orbit_api_url') || 'http://localhost:3001/api',
  );
  const [editingName, setEditingName] = useState(false);
  const [nameValue, setNameValue] = useState(user?.name || '');
  const [nameSaved, setNameSaved] = useState(false);
  const jsonInputRef = useRef<HTMLInputElement>(null);

  const { data: tasks = [] } = useTask();
  const { data: lists = [] } = useList();

  const tabs: { id: TabId; label: string; icon: React.ReactNode }[] = [
    { id: 'profile', label: '个人资料', icon: <User size={16} /> },
    { id: 'appearance', label: '外观与语言', icon: <Palette size={16} /> },
    { id: 'data', label: '数据管理', icon: <HardDrive size={16} /> },
    { id: 'security', label: '安全', icon: <Shield size={16} /> },
  ];

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

  const handleNotificationToggle = () => {
    const newVal = !notificationsEnabled;
    setNotificationsEnabled(newVal);
    notificationService.saveSettings({ enabled: newVal });
    if (newVal) {
      void notificationService.requestPermission();
    }
  };

  const handleLangChange = (lang: string) => {
    setCurrentLang(lang);
    localStorage.setItem('i18nextLng', lang);
    window.location.reload();
  };

  const handleExportData = () => {
    const data = {
      version: '1.0.0',
      exportedAt: new Date().toISOString(),
      tasks,
      lists,
      user: user ? { name: user.name, email: user.email } : null,
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `orbit-backup-${new Date().toISOString().split('T')[0]}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleImportData = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = JSON.parse(ev.target?.result as string);
        if (data.tasks && data.lists) {
          alert(
            `读取成功：${data.tasks.length} 个任务，${data.lists.length} 个清单。\n\n数据已复制到剪贴板。`,
          );
          void navigator.clipboard.writeText(JSON.stringify(data));
        }
      } catch {
        alert('导入失败：文件格式不正确');
      }
    };
    reader.readAsText(file);
    if (e.target) e.target.value = '';
  };

  const handleSaveName = () => {
    if (!nameValue.trim()) return;
    setNameSaved(true);
    setEditingName(false);
    setTimeout(() => setNameSaved(false), 2000);
  };

  const themeModes: { value: ThemeMode; label: string; icon: React.ReactNode }[] = [
    { value: 'system', label: '跟随系统', icon: <Monitor size={16} /> },
    { value: 'light', label: '浅色', icon: <Sun size={16} /> },
    { value: 'dark', label: '深色', icon: <Moon size={16} /> },
  ];

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="bg-white border-b border-gray-200 sticky top-0 z-10">
        <div className="max-w-4xl mx-auto px-6 py-4 flex items-center gap-4">
          <button
            onClick={() => navigate(-1)}
            className="p-2 hover:bg-gray-100 rounded-md transition-colors text-gray-600"
          >
            <ArrowLeft size={20} />
          </button>
          <h1 className="text-xl font-bold text-gray-900">设置</h1>
        </div>
      </div>

      <div className="max-w-4xl mx-auto px-6 py-8">
        <div className="flex gap-8">
          <div className="w-56 flex-shrink-0">
            <nav className="space-y-1">
              {tabs.map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-medium transition-colors ${
                    activeTab === tab.id
                      ? 'bg-blue-50 text-blue-700'
                      : 'text-gray-600 hover:bg-gray-100'
                  }`}
                >
                  {tab.icon}
                  <span>{tab.label}</span>
                </button>
              ))}
            </nav>
          </div>

          <div className="flex-1 space-y-6">
            <AnimatePresence mode="wait">
              {activeTab === 'profile' && (
                <motion.div
                  key="profile"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  transition={{ duration: 0.15 }}
                  className="space-y-6"
                >
                  <SectionCard title="个人资料" icon={<User size={18} />}>
                    <div className="space-y-4">
                      <div className="flex items-center gap-4">
                        <div className="w-16 h-16 rounded-full bg-blue-100 flex items-center justify-center text-blue-600 text-2xl font-bold">
                          {user?.name?.[0]?.toUpperCase() || 'U'}
                        </div>
                        <div>
                          <p className="text-sm font-medium text-gray-900">
                            {user?.name || '未登录'}
                          </p>
                          <p className="text-sm text-gray-500">
                            {user?.email || 'guest@example.com'}
                          </p>
                        </div>
                      </div>
                      <div className="border-t border-gray-100 pt-4">
                        <label className="block text-sm font-medium text-gray-700 mb-1.5">
                          显示名称
                        </label>
                        <div className="flex items-center gap-2">
                          {editingName ? (
                            <>
                              <input
                                type="text"
                                value={nameValue}
                                onChange={(e) => setNameValue(e.target.value)}
                                className="flex-1 px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                                autoFocus
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') handleSaveName();
                                }}
                              />
                              <button
                                onClick={handleSaveName}
                                className="px-3 py-2 bg-blue-500 text-white text-sm rounded-md hover:bg-blue-600 transition-colors flex items-center gap-1"
                              >
                                <Save size={14} /> 保存
                              </button>
                              <button
                                onClick={() => {
                                  setEditingName(false);
                                  setNameValue(user?.name || '');
                                }}
                                className="px-3 py-2 bg-gray-100 text-gray-600 text-sm rounded-md hover:bg-gray-200 transition-colors"
                              >
                                取消
                              </button>
                            </>
                          ) : (
                            <>
                              <span className="flex-1 text-sm text-gray-900 py-2">
                                {nameValue || user?.name}
                              </span>
                              <button
                                onClick={() => setEditingName(true)}
                                className="px-3 py-2 bg-blue-50 text-blue-600 text-sm rounded-md hover:bg-blue-100 transition-colors"
                              >
                                编辑
                              </button>
                              {nameSaved && (
                                <span className="text-xs text-green-600 flex items-center gap-1">
                                  <Eye size={12} /> 已保存
                                </span>
                              )}
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                  </SectionCard>
                  <SectionCard title="同步状态" icon={<Cloud size={18} />}>
                    <div className="space-y-4">
                      <div className="flex items-center gap-3">
                        <div
                          className={`w-3 h-3 rounded-full ${isOnline ? 'bg-green-500' : 'bg-gray-400'}`}
                        />
                        <span className="text-sm text-gray-700">{isOnline ? '在线' : '离线'}</span>
                        {isSyncing && (
                          <span className="text-xs text-blue-500 animate-pulse">同步中...</span>
                        )}
                        {!isSyncing && pendingCount > 0 && (
                          <span className="text-xs text-amber-600">{pendingCount} 项待同步</span>
                        )}
                        {!isSyncing && pendingCount === 0 && (
                          <span className="text-xs text-green-600">已同步</span>
                        )}
                      </div>
                    </div>
                  </SectionCard>
                </motion.div>
              )}
            </AnimatePresence>

            <AnimatePresence mode="wait">
              {activeTab === 'appearance' && (
                <motion.div
                  key="appearance"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  transition={{ duration: 0.15 }}
                  className="space-y-6"
                >
                  <SectionCard title="主题" icon={<Palette size={18} />}>
                    <div className="grid grid-cols-3 gap-3">
                      {themeModes.map(({ value, label, icon }) => (
                        <button
                          key={value}
                          onClick={() => setThemeMode(value)}
                          className={`flex flex-col items-center gap-2 p-4 rounded-lg border-2 transition-colors ${
                            themeMode === value
                              ? 'border-blue-500 bg-blue-50 text-blue-700'
                              : 'border-gray-200 hover:border-gray-300 text-gray-600 hover:bg-gray-50'
                          }`}
                        >
                          <div className="p-3 bg-gray-100 rounded-lg">{icon}</div>
                          <span className="text-sm font-medium">{label}</span>
                        </button>
                      ))}
                    </div>
                  </SectionCard>
                  <SectionCard title="语言" icon={<Languages size={18} />}>
                    <div className="space-y-3">
                      {[
                        { code: 'zh', label: '简体中文', native: '中文' },
                        { code: 'en', label: 'English', native: 'English' },
                      ].map((lang) => (
                        <button
                          key={lang.code}
                          onClick={() => handleLangChange(lang.code)}
                          className={`w-full flex items-center justify-between px-4 py-3 rounded-lg border transition-colors ${
                            currentLang === lang.code
                              ? 'border-blue-500 bg-blue-50'
                              : 'border-gray-200 hover:border-gray-300'
                          }`}
                        >
                          <div>
                            <p
                              className={`text-sm font-medium ${currentLang === lang.code ? 'text-blue-700' : 'text-gray-900'}`}
                            >
                              {lang.label}
                            </p>
                            <p
                              className={`text-xs ${currentLang === lang.code ? 'text-blue-500' : 'text-gray-500'}`}
                            >
                              {lang.native}
                            </p>
                          </div>
                          {currentLang === lang.code && (
                            <div className="w-5 h-5 rounded-full bg-blue-500 flex items-center justify-center">
                              <div className="w-2 h-2 rounded-full bg-white" />
                            </div>
                          )}
                        </button>
                      ))}
                    </div>
                  </SectionCard>
                  <SectionCard title="通知" icon={<Bell size={18} />}>
                    <div className="space-y-4">
                      <ToggleSwitch
                        checked={notificationsEnabled}
                        onChange={handleNotificationToggle}
                        label="启用浏览器通知"
                      />
                      <p className="text-xs text-gray-500 -mt-2">
                        {notificationsEnabled
                          ? '到期提醒和任务通知将显示在浏览器通知中'
                          : '已禁用通知功能'}
                      </p>
                    </div>
                  </SectionCard>
                </motion.div>
              )}
            </AnimatePresence>

            <AnimatePresence mode="wait">
              {activeTab === 'data' && (
                <motion.div
                  key="data"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  transition={{ duration: 0.15 }}
                  className="space-y-6"
                >
                  <SectionCard title="数据统计" icon={<HardDrive size={18} />}>
                    <div className="grid grid-cols-3 gap-4">
                      <div className="text-center p-4 bg-gray-50 rounded-lg">
                        <p className="text-3xl font-bold text-blue-600">{tasks.length}</p>
                        <p className="text-xs text-gray-500 mt-1">总任务数</p>
                      </div>
                      <div className="text-center p-4 bg-gray-50 rounded-lg">
                        <p className="text-3xl font-bold text-green-600">{lists.length}</p>
                        <p className="text-xs text-gray-500 mt-1">清单数</p>
                      </div>
                      <div className="text-center p-4 bg-gray-50 rounded-lg">
                        <p className="text-3xl font-bold text-purple-600">
                          {tasks.filter((t) => !t.isCompleted).length}
                        </p>
                        <p className="text-xs text-gray-500 mt-1">待完成任务</p>
                      </div>
                    </div>
                  </SectionCard>
                  <SectionCard title="数据导出" icon={<Download size={18} />}>
                    <div className="space-y-4">
                      <p className="text-sm text-gray-600">
                        将所有任务、清单和个人资料导出为 JSON 文件，以便备份或迁移。
                      </p>
                      <button
                        onClick={handleExportData}
                        className="flex items-center gap-2 px-4 py-2.5 bg-blue-500 text-white text-sm rounded-md hover:bg-blue-600 transition-colors"
                      >
                        <FileJson size={16} /> 导出为 JSON
                      </button>
                    </div>
                  </SectionCard>
                  <SectionCard title="数据导入" icon={<Upload size={18} />}>
                    <div className="space-y-4">
                      <p className="text-sm text-gray-600">从之前导出的 JSON 文件恢复数据。</p>
                      <input
                        ref={jsonInputRef}
                        type="file"
                        accept=".json"
                        onChange={handleImportData}
                        className="hidden"
                      />
                      <button
                        onClick={() => jsonInputRef.current?.click()}
                        className="flex items-center gap-2 px-4 py-2.5 border border-gray-300 text-gray-700 text-sm rounded-md hover:bg-gray-50 transition-colors"
                      >
                        <Upload size={16} /> 选择 JSON 文件
                      </button>
                    </div>
                  </SectionCard>
                </motion.div>
              )}
            </AnimatePresence>

            <AnimatePresence mode="wait">
              {activeTab === 'security' && (
                <motion.div
                  key="security"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  transition={{ duration: 0.15 }}
                  className="space-y-6"
                >
                  <SectionCard title="API 配置" icon={<Lock size={18} />}>
                    <div className="space-y-4">
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1.5">
                          后端 API 地址
                        </label>
                        <div className="flex items-center gap-2">
                          <input
                            type="text"
                            value={apiUrl}
                            onChange={(e) => setApiUrl(e.target.value)}
                            placeholder="http://localhost:3001/api"
                            className="flex-1 px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                          />
                          <button
                            onClick={() => {
                              localStorage.setItem('orbit_api_url', apiUrl);
                              setNameSaved(true);
                              setTimeout(() => setNameSaved(false), 2000);
                            }}
                            className="px-4 py-2 bg-blue-500 text-white text-sm rounded-md hover:bg-blue-600 transition-colors"
                          >
                            保存
                          </button>
                        </div>
                        <p className="text-xs text-gray-500 mt-1.5">修改后需要刷新页面生效</p>
                      </div>
                    </div>
                  </SectionCard>
                  <SectionCard title="危险操作" icon={<Trash2 size={18} />}>
                    <div className="p-4 bg-red-50 rounded-lg border border-red-100">
                      <h4 className="text-sm font-medium text-red-800 mb-1">清除所有本地数据</h4>
                      <p className="text-xs text-red-600 mb-3">
                        删除 IndexedDB 中的所有任务和清单。此操作不可撤销。
                      </p>
                      <button
                        onClick={() => {
                          if (confirm('确定要清除所有本地数据吗？此操作不可撤销！')) {
                            indexedDB.deleteDatabase('OrbitDB');
                            localStorage.clear();
                            window.location.href = '/';
                          }
                        }}
                        className="flex items-center gap-1 px-3 py-1.5 bg-red-600 text-white text-xs rounded-md hover:bg-red-700 transition-colors"
                      >
                        <Trash2 size={12} /> 清除数据
                      </button>
                    </div>
                  </SectionCard>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </div>
    </div>
  );
}
