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
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { notificationService, useList, useSync, useTask } from '@baicie/orbit-hooks';
import { useEffect, useRef, useState } from 'react';
import { Button, Input } from '@baicie/orbit-ui';

type ThemeMode = 'system' | 'light' | 'dark';
type TabId = 'profile' | 'appearance' | 'data' | 'security';

interface SectionCardProps {
  title: string;
  children: React.ReactNode;
  icon: React.ReactNode;
}

function SectionCard({ title, icon, children }: SectionCardProps) {
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
      <Button
        role="switch"
        aria-checked={checked}
        onClick={onChange}
        className={`w-11 h-6 rounded-full relative transition-colors p-0 ${checked ? 'bg-blue-500' : 'bg-gray-300'}`}
      >
        <span
          className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${checked ? 'translate-x-5' : 'translate-x-0.5'}`}
        />
      </Button>
    </div>
  );
}

export function Settings() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { pendingCount, isSyncing, isOnline, triggerSync } = useSync();

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
          void navigator.clipboard.writeText(JSON.stringify(data));
          alert(
            `读取成功：${data.tasks.length} 个任务，${data.lists.length} 个清单。数据已复制到剪贴板。\n\n如需导入，请在开发者控制台手动处理。`,
          );
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
      {/* Header */}
      <div className="bg-white border-b border-gray-200 sticky top-0 z-10">
        <div className="max-w-4xl mx-auto px-6 py-4 flex items-center gap-4">
          <Button variant="ghost" onClick={() => navigate(-1)} className="p-2">
            <ArrowLeft size={20} />
          </Button>
          <h1 className="text-xl font-bold text-gray-900">设置</h1>
        </div>
      </div>

      <div className="max-w-4xl mx-auto px-6 py-8">
        <div className="flex gap-8">
          {/* Sidebar */}
          <div className="w-56 flex-shrink-0">
            <nav className="space-y-1">
              {tabs.map((tab) => (
                <Button
                  key={tab.id}
                  variant={activeTab === tab.id ? 'secondary' : 'ghost'}
                  onClick={() => setActiveTab(tab.id)}
                  className="w-full justify-start"
                >
                  {tab.icon}
                  <span>{tab.label}</span>
                </Button>
              ))}
            </nav>
          </div>

          {/* Content */}
          <div className="flex-1 space-y-6">
            {/* Profile Tab */}
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
                              <Input
                                type="text"
                                value={nameValue}
                                onChange={(e) => setNameValue(e.target.value)}
                                className="flex-1"
                                autoFocus
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') handleSaveName();
                                }}
                              />
                              <Button onClick={handleSaveName} size="sm">
                                <Save size={14} />
                                保存
                              </Button>
                              <Button
                                variant="outline"
                                onClick={() => {
                                  setEditingName(false);
                                  setNameValue(user?.name || '');
                                }}
                                size="sm"
                              >
                                取消
                              </Button>
                            </>
                          ) : (
                            <>
                              <span className="flex-1 text-sm text-gray-900 py-2">
                                {nameValue || user?.name}
                              </span>
                              <Button
                                variant="secondary"
                                onClick={() => setEditingName(true)}
                                size="sm"
                              >
                                编辑
                              </Button>
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
                      {isOnline && pendingCount > 0 && (
                        <Button onClick={() => void triggerSync()} disabled={isSyncing} size="sm">
                          立即同步
                        </Button>
                      )}
                    </div>
                  </SectionCard>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Appearance Tab */}
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
                        <Button
                          key={value}
                          variant={themeMode === value ? 'secondary' : 'outline'}
                          onClick={() => setThemeMode(value)}
                          className="flex flex-col items-center gap-2 p-4 h-auto"
                        >
                          <div className="p-3 bg-gray-100 rounded-lg">{icon}</div>
                          <span className="text-sm font-medium">{label}</span>
                        </Button>
                      ))}
                    </div>
                  </SectionCard>

                  <SectionCard title="语言" icon={<Languages size={18} />}>
                    <div className="space-y-3">
                      {[
                        { code: 'zh', label: '简体中文', native: '中文' },
                        { code: 'en', label: 'English', native: 'English' },
                      ].map((lang) => (
                        <Button
                          key={lang.code}
                          variant={currentLang === lang.code ? 'secondary' : 'outline'}
                          onClick={() => handleLangChange(lang.code)}
                          className="w-full justify-between"
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
                        </Button>
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

            {/* Data Tab */}
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
                      <Button onClick={handleExportData}>
                        <FileJson size={16} />
                        导出为 JSON
                      </Button>
                    </div>
                  </SectionCard>

                  <SectionCard title="数据导入" icon={<Upload size={18} />}>
                    <div className="space-y-4">
                      <p className="text-sm text-gray-600">
                        从之前导出的 JSON
                        文件恢复数据。（注意：导入功能需要手动确认，当前版本仅读取并复制到剪贴板）
                      </p>
                      <input
                        ref={jsonInputRef}
                        type="file"
                        accept=".json"
                        onChange={handleImportData}
                        className="hidden"
                      />
                      <Button variant="outline" onClick={() => jsonInputRef.current?.click()}>
                        <Upload size={16} />
                        选择 JSON 文件
                      </Button>
                    </div>
                  </SectionCard>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Security Tab */}
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
                          <Input
                            type="text"
                            value={apiUrl}
                            onChange={(e) => setApiUrl(e.target.value)}
                            placeholder="http://localhost:3001/api"
                            className="flex-1"
                          />
                          <Button
                            onClick={() => {
                              localStorage.setItem('orbit_api_url', apiUrl);
                              setNameSaved(true);
                              setTimeout(() => setNameSaved(false), 2000);
                            }}
                            size="sm"
                          >
                            保存
                          </Button>
                        </div>
                        <p className="text-xs text-gray-500 mt-1.5">修改后需要刷新页面生效</p>
                      </div>
                    </div>
                  </SectionCard>

                  <SectionCard title="账号安全" icon={<Shield size={18} />}>
                    <div className="space-y-4">
                      {user ? (
                        <>
                          <ToggleSwitch
                            checked={false}
                            onChange={() => alert('密码修改功能开发中')}
                            label="修改密码"
                          />
                          <ToggleSwitch
                            checked={false}
                            onChange={() => alert('邮箱修改功能开发中')}
                            label="修改邮箱"
                          />
                        </>
                      ) : (
                        <div className="text-center py-8 text-gray-500">
                          <User size={32} className="mx-auto mb-2 opacity-50" />
                          <p className="text-sm">登录后可管理账号安全设置</p>
                          <Button onClick={() => navigate('/login')} className="mt-3">
                            登录
                          </Button>
                        </div>
                      )}
                    </div>
                  </SectionCard>

                  <SectionCard title="危险操作" icon={<Trash2 size={18} />}>
                    <div className="space-y-4">
                      <div className="p-4 bg-red-50 rounded-lg border border-red-100">
                        <h4 className="text-sm font-medium text-red-800 mb-1">清除所有本地数据</h4>
                        <p className="text-xs text-red-600 mb-3">
                          删除 IndexedDB 中的所有任务和清单。此操作不可撤销。
                        </p>
                        <Button
                          variant="destructive"
                          size="sm"
                          onClick={() => {
                            if (confirm('确定要清除所有本地数据吗？此操作不可撤销！')) {
                              indexedDB.deleteDatabase('OrbitDB');
                              localStorage.clear();
                              window.location.href = '/';
                            }
                          }}
                        >
                          <Trash2 size={12} />
                          清除数据
                        </Button>
                      </div>
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
