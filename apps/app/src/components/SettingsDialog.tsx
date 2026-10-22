import { For, Show, createSignal, onMount } from 'solid-js';
import {
  Bell,
  CalendarDays,
  CheckCircle2,
  Cloud,
  Database,
  Download,
  HardDrive,
  Info,
  Keyboard,
  Laptop,
  Monitor,
  Moon,
  Palette,
  ShieldCheck,
  Sun,
  Upload,
  Trash2,
} from 'lucide-solid';
import type { DesktopLifecycle, DesktopSettings, ReminderPermission } from '@todo/application';
import type { ThemePreference } from '../adapters/platform';
import type { CloudController } from '../sync/cloud';
import { CloudPanel } from './CloudPanel';
import { Modal } from './Modal';

type SettingsTab = 'appearance' | 'data' | 'sync' | 'desktop' | 'about';

interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
  theme: ThemePreference;
  onThemeChange: (theme: ThemePreference) => void;
  platformKind: 'web' | 'tauri';
  taskCount: number;
  listCount: number;
  cloud: CloudController;
  desktop?: DesktopLifecycle;
  reminderPermission: () => Promise<ReminderPermission>;
  onRequestNotifications: () => Promise<ReminderPermission>;
  onExportJson: () => Promise<void>;
  onExportCsv: () => Promise<void>;
  onExportIcs: () => Promise<void>;
  onImport: (file: File, mode: 'merge' | 'replace') => Promise<void>;
  onClear: () => Promise<void>;
}

const TABS: Array<{ id: SettingsTab; label: string; icon: typeof Palette }> = [
  { id: 'appearance', label: '外观', icon: Palette },
  { id: 'data', label: '数据', icon: Database },
  { id: 'sync', label: '同步', icon: Cloud },
  { id: 'desktop', label: '桌面', icon: Monitor },
  { id: 'about', label: '关于', icon: Info },
];

export function SettingsDialog(props: SettingsDialogProps) {
  const [tab, setTab] = createSignal<SettingsTab>('appearance');
  const [permission, setPermission] = createSignal<ReminderPermission>('prompt');
  const [importMode, setImportMode] = createSignal<'merge' | 'replace'>('merge');
  const [busy, setBusy] = createSignal<string | null>(null);
  const [confirmClear, setConfirmClear] = createSignal(false);
  const [persisted, setPersisted] = createSignal<boolean | null>(null);
  const [apiStatus, setApiStatus] = createSignal<'idle' | 'checking' | 'online' | 'offline'>(
    'idle',
  );
  const [desktopSettings, setDesktopSettings] = createSignal<DesktopSettings | null>(null);
  const [desktopBusy, setDesktopBusy] = createSignal<string | null>(null);
  const [desktopError, setDesktopError] = createSignal<string | null>(null);
  let fileInput: HTMLInputElement | undefined;

  const visibleTabs = () => TABS.filter((item) => item.id !== 'desktop' || Boolean(props.desktop));

  const updateDesktop = async (
    action: 'close-to-tray' | 'autostart',
    enabled: boolean,
  ): Promise<void> => {
    if (!props.desktop) return;
    setDesktopBusy(action);
    setDesktopError(null);
    try {
      if (action === 'close-to-tray') await props.desktop.setCloseToTray(enabled);
      else await props.desktop.setAutostart(enabled);
      setDesktopSettings(await props.desktop.getSettings());
    } catch (error) {
      setDesktopError(error instanceof Error ? error.message : '桌面设置更新失败');
    } finally {
      setDesktopBusy(null);
    }
  };

  onMount(() => {
    void props.reminderPermission().then(setPermission);
    if (props.desktop) {
      void props.desktop
        .getSettings()
        .then(setDesktopSettings)
        .catch((error) =>
          setDesktopError(error instanceof Error ? error.message : '桌面设置读取失败'),
        );
    }
    if (navigator.storage?.persisted) {
      void navigator.storage.persisted().then(setPersisted);
    }
  });

  const requestNotifications = async () => {
    setBusy('notifications');
    try {
      setPermission(await props.onRequestNotifications());
    } finally {
      setBusy(null);
    }
  };

  const requestPersistence = async () => {
    if (!navigator.storage?.persist) return;
    setBusy('persist');
    try {
      setPersisted(await navigator.storage.persist());
    } finally {
      setBusy(null);
    }
  };

  const healthCheck = async () => {
    const apiUrl = props.cloud.state().apiUrl.trim().replace(/\/$/, '');
    if (!apiUrl) {
      setApiStatus('offline');
      return;
    }
    setApiStatus('checking');
    try {
      const response = await fetch(`${apiUrl}/healthz`, { signal: AbortSignal.timeout(4000) });
      setApiStatus(response.ok ? 'online' : 'offline');
    } catch {
      setApiStatus('offline');
    }
  };

  return (
    <Modal
      open={props.open}
      onClose={props.onClose}
      title="设置与数据"
      description="所有设置仅保存在这台设备上。"
      size="lg"
      class="settings-modal"
    >
      <div class="settings-layout">
        <nav class="settings-nav" aria-label="设置分类">
          <For each={visibleTabs()}>
            {(item) => (
              <button
                type="button"
                classList={{ 'settings-nav__item--active': tab() === item.id }}
                onClick={() => setTab(item.id)}
              >
                <item.icon size={16} />
                {item.label}
              </button>
            )}
          </For>
          <div class="settings-nav__version">拾事 1.0.0</div>
        </nav>

        <div class="settings-panel">
          <Show when={tab() === 'appearance'}>
            <section class="settings-section">
              <h3>主题</h3>
              <p class="settings-intro">默认跟随系统。切换会立即生效，并记住你的选择。</p>
              <div class="theme-options" role="radiogroup" aria-label="主题">
                <For
                  each={[
                    { id: 'system' as const, label: '跟随系统', icon: Laptop },
                    { id: 'light' as const, label: '浅色', icon: Sun },
                    { id: 'dark' as const, label: '深色', icon: Moon },
                  ]}
                >
                  {(item) => (
                    <button
                      type="button"
                      role="radio"
                      aria-checked={props.theme === item.id}
                      class="theme-option"
                      classList={{ 'theme-option--active': props.theme === item.id }}
                      onClick={() => props.onThemeChange(item.id)}
                    >
                      <span class={`theme-preview theme-preview--${item.id}`}>
                        <span class="theme-preview__sidebar" />
                        <span class="theme-preview__body">
                          <span />
                          <span />
                          <span />
                        </span>
                      </span>
                      <span class="theme-option__label">
                        <item.icon size={15} />
                        {item.label}
                        <Show when={props.theme === item.id}>
                          <CheckCircle2 size={15} class="theme-option__check" />
                        </Show>
                      </span>
                    </button>
                  )}
                </For>
              </div>
            </section>

            <section class="settings-section">
              <h3>提醒</h3>
              <div class="settings-row">
                <div class="settings-row__icon">
                  <Bell size={17} />
                </div>
                <div class="settings-row__body">
                  <span>系统通知</span>
                  <span class="settings-row__hint">
                    {permission() === 'granted'
                      ? '已允许。网页端仅在页面打开时发送提醒；原生端由系统调度。'
                      : permission() === 'denied'
                        ? '浏览器已阻止通知，请在站点设置中重新允许。'
                        : '允许后，到点的本地任务会尝试提醒你。'}
                  </span>
                </div>
                <button
                  type="button"
                  class="secondary-button"
                  disabled={permission() !== 'prompt' || busy() === 'notifications'}
                  onClick={() => void requestNotifications()}
                >
                  {permission() === 'granted'
                    ? '已开启'
                    : permission() === 'denied'
                      ? '已被阻止'
                      : '开启通知'}
                </button>
              </div>
            </section>
          </Show>

          <Show when={tab() === 'data'}>
            <section class="settings-section">
              <h3>你的数据</h3>
              <div class="data-stats">
                <div>
                  <strong>{props.taskCount}</strong>
                  <span>任务</span>
                </div>
                <div>
                  <strong>{props.listCount}</strong>
                  <span>清单</span>
                </div>
                <div>
                  <strong>{props.platformKind === 'tauri' ? 'SQLite' : 'IndexedDB'}</strong>
                  <span>本地存储</span>
                </div>
              </div>
              <div class="settings-row">
                <div class="settings-row__icon">
                  <HardDrive size={17} />
                </div>
                <div class="settings-row__body">
                  <span>持久化存储</span>
                  <span class="settings-row__hint">
                    {persisted() === true
                      ? '浏览器已承诺尽量不自动清理本机数据。仍建议定期导出备份。'
                      : '浏览器可能在空间不足时清理数据，建议导出备份。'}
                  </span>
                </div>
                <Show when={props.platformKind === 'web'}>
                  <button
                    type="button"
                    class="secondary-button"
                    disabled={persisted() === true || busy() === 'persist'}
                    onClick={() => void requestPersistence()}
                  >
                    {persisted() === true ? '已保护' : '申请保护'}
                  </button>
                </Show>
              </div>
            </section>

            <section class="settings-section">
              <h3>导出备份</h3>
              <p class="settings-intro">
                导出包含所有任务、清单、子步骤和“我的一天”记录，不包含任何账号凭据。
              </p>
              <div class="button-row">
                <button
                  type="button"
                  class="primary-button"
                  disabled={busy() === 'json'}
                  onClick={async () => {
                    setBusy('json');
                    try {
                      await props.onExportJson();
                    } finally {
                      setBusy(null);
                    }
                  }}
                >
                  <Download size={16} /> 导出 JSON
                </button>
                <button
                  type="button"
                  class="secondary-button"
                  disabled={busy() === 'csv'}
                  onClick={async () => {
                    setBusy('csv');
                    try {
                      await props.onExportCsv();
                    } finally {
                      setBusy(null);
                    }
                  }}
                >
                  <Download size={16} /> 导出 CSV
                </button>
                <button
                  type="button"
                  class="secondary-button"
                  disabled={busy() === 'ics'}
                  onClick={async () => {
                    setBusy('ics');
                    try {
                      await props.onExportIcs();
                    } finally {
                      setBusy(null);
                    }
                  }}
                >
                  <CalendarDays size={16} /> 导出日历
                </button>
              </div>
            </section>

            <section class="settings-section">
              <h3>恢复备份</h3>
              <p class="settings-intro">
                合并会保留现有数据并覆盖同 ID 的记录；替换会先清空本机任务数据。也支持导入 .ics
                日历事件。
              </p>
              <div class="import-row">
                <select
                  class="meta-input"
                  value={importMode()}
                  aria-label="导入方式"
                  onChange={(event) =>
                    setImportMode(event.currentTarget.value as 'merge' | 'replace')
                  }
                >
                  <option value="merge">合并导入</option>
                  <option value="replace">替换全部</option>
                </select>
                <button
                  type="button"
                  class="secondary-button"
                  onClick={() => fileInput?.click()}
                  disabled={busy() === 'import'}
                >
                  <Upload size={16} /> 选择 JSON 文件
                </button>
                <input
                  ref={fileInput}
                  type="file"
                  accept="application/json,.json,text/calendar,.ics"
                  class="sr-only"
                  onChange={async (event) => {
                    const file = event.currentTarget.files?.[0];
                    event.currentTarget.value = '';
                    if (!file) return;
                    if (
                      importMode() === 'replace' &&
                      !window.confirm('替换会删除当前设备上的所有任务。继续？')
                    ) {
                      return;
                    }
                    setBusy('import');
                    try {
                      await props.onImport(file, importMode());
                    } finally {
                      setBusy(null);
                    }
                  }}
                />
              </div>
            </section>

            <section class="settings-section settings-section--danger">
              <h3>清除本机数据</h3>
              <p class="settings-intro">删除此设备上的全部任务、清单和本地操作记录，不可撤销。</p>
              <Show
                when={confirmClear()}
                fallback={
                  <button type="button" class="danger-button" onClick={() => setConfirmClear(true)}>
                    <Trash2 size={15} /> 清除所有数据
                  </button>
                }
              >
                <div class="confirm-row">
                  <span>确定要清除吗？此操作无法撤销。</span>
                  <button
                    type="button"
                    class="secondary-button"
                    onClick={() => setConfirmClear(false)}
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    class="danger-button danger-button--solid"
                    onClick={async () => {
                      setBusy('clear');
                      try {
                        await props.onClear();
                        setConfirmClear(false);
                      } finally {
                        setBusy(null);
                      }
                    }}
                  >
                    确认清除
                  </button>
                </div>
              </Show>
            </section>
          </Show>

          <Show when={tab() === 'sync'}>
            <section class="settings-section">
              <h3>账号与云同步</h3>
              <p class="settings-intro">
                本地写入始终优先。连接自托管服务后，可以选择合并本机数据或使用云端快照。
              </p>
              <CloudPanel cloud={props.cloud} />
            </section>

            <section class="settings-section">
              <h3>服务连通性</h3>
              <p class="settings-intro">
                API 地址由上方账号设置或构建变量 <code>VITE_API_URL</code>{' '}
                指定。此操作只检查服务健康状态，不上传任何任务。
              </p>
              <div class="import-row">
                <button
                  type="button"
                  class="secondary-button"
                  onClick={() => void healthCheck()}
                  disabled={apiStatus() === 'checking'}
                >
                  <Cloud size={16} /> 检查自托管服务
                </button>
                <span
                  class="status-inline"
                  classList={{
                    'status-inline--ok': apiStatus() === 'online',
                    'status-inline--bad': apiStatus() === 'offline',
                  }}
                >
                  {apiStatus() === 'checking'
                    ? '检查中…'
                    : apiStatus() === 'online'
                      ? '服务在线'
                      : apiStatus() === 'offline'
                        ? '未配置或不可达'
                        : ''}
                </span>
              </div>
            </section>
          </Show>

          <Show when={tab() === 'desktop'}>
            <section class="settings-section">
              <h3>桌面行为</h3>
              <p class="settings-intro">
                这些设置只影响当前桌面设备。关闭到托盘后，应用会继续在后台运行和调度提醒。
              </p>
              <Show
                when={desktopSettings()}
                fallback={<p class="settings-intro">正在读取桌面设置…</p>}
              >
                {(settings) => (
                  <>
                    <div class="settings-row">
                      <div class="settings-row__icon">
                        <Monitor size={17} />
                      </div>
                      <div class="settings-row__body">
                        <span>关闭窗口时隐藏到系统托盘</span>
                        <span class="settings-row__hint">托盘菜单可恢复窗口或彻底退出拾事。</span>
                      </div>
                      <button
                        type="button"
                        role="switch"
                        class="switch"
                        aria-checked={settings().closeToTray}
                        aria-label="关闭窗口时隐藏到系统托盘"
                        disabled={desktopBusy() !== null}
                        onClick={() => void updateDesktop('close-to-tray', !settings().closeToTray)}
                      >
                        <span />
                      </button>
                    </div>
                    <div class="settings-row">
                      <div class="settings-row__icon">
                        <Laptop size={17} />
                      </div>
                      <div class="settings-row__body">
                        <span>开机自动启动</span>
                        <span class="settings-row__hint">
                          {settings().autostartSupported
                            ? '登录系统后在后台启动，不主动弹出窗口。'
                            : '当前系统或运行方式不支持自启。'}
                        </span>
                      </div>
                      <button
                        type="button"
                        role="switch"
                        class="switch"
                        aria-checked={settings().autostartEnabled}
                        aria-label="开机自动启动"
                        disabled={desktopBusy() !== null || !settings().autostartSupported}
                        onClick={() =>
                          void updateDesktop('autostart', !settings().autostartEnabled)
                        }
                      >
                        <span />
                      </button>
                    </div>
                  </>
                )}
              </Show>
              <Show when={desktopError()}>
                {(message) => <p class="settings-error">{message()}</p>}
              </Show>
            </section>
          </Show>

          <Show when={tab() === 'about'}>
            <section class="settings-section about-hero">
              <div class="brand__mark brand__mark--large" aria-hidden="true">
                <CheckCircle2 size={28} stroke-width={2.2} />
              </div>
              <div>
                <h3>拾事 1.0.0</h3>
                <p>把今天过清楚。一个不打扰你的本地优先待办工具。</p>
              </div>
            </section>

            <section class="settings-section">
              <h3>键盘快捷键</h3>
              <div class="shortcut-list">
                <div>
                  <span>快速添加任务</span>
                  <span>
                    <kbd>Ctrl</kbd>
                    <kbd>N</kbd>
                  </span>
                </div>
                <div>
                  <span>搜索任务</span>
                  <span>
                    <kbd>Ctrl</kbd>
                    <kbd>K</kbd>
                  </span>
                </div>
                <div>
                  <span>完成当前任务</span>
                  <span>
                    <kbd>Space</kbd>
                  </span>
                </div>
                <div>
                  <span>上移 / 下移任务</span>
                  <span>
                    <kbd>Alt</kbd>
                    <kbd>↑</kbd>
                    <kbd>↓</kbd>
                  </span>
                </div>
                <div>
                  <span>关闭详情或对话框</span>
                  <span>
                    <kbd>Esc</kbd>
                  </span>
                </div>
              </div>
            </section>

            <section class="settings-section">
              <h3>隐私与边界</h3>
              <div class="privacy-line">
                <ShieldCheck size={17} />
                <p>
                  默认不采集任务内容，也不发送诊断数据。任务备注按纯文本呈现；网页端提醒可靠性受浏览器后台策略限制。
                </p>
              </div>
              <div class="privacy-line">
                <Keyboard size={17} />
                <p>数据格式开放。你可以随时导出 JSON / CSV，把记录迁移到自己的其他工具。</p>
              </div>
            </section>
          </Show>
        </div>
      </div>
    </Modal>
  );
}
