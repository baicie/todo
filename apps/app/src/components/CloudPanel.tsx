import { For, Show, createSignal, onMount } from 'solid-js';
import {
  AlertTriangle,
  Bell,
  Check,
  ChevronRight,
  Cloud,
  CloudOff,
  Download,
  HardDrive,
  KeyRound,
  LoaderCircle,
  LogOut,
  Plus,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  Trash2,
  UserRound,
  WifiOff,
} from 'lucide-solid';
import type { CloudController } from '../sync/cloud';
import {
  activeAccountId,
  createAndSwitchAccount,
  isNativeRuntime,
  loadAccountProfiles,
  nativeAbortAccountSwitch,
  nativeAccountSwitchStatus,
  nativeCreateAccount,
  nativeListAccounts,
  nativePrepareAccountSwitch,
  nativeRequestAccountSwitch,
  rememberNativeAccount,
  switchAccount,
  type NativeAccountSummary,
  type NativeSwitchStatus,
} from '../lib/accounts';

interface CloudPanelProps {
  cloud: CloudController;
}

const STATUS_LABEL: Record<string, string> = {
  idle: '已连接',
  syncing: '同步中',
  synced: '已同步',
  offline: '离线，等待重试',
  error: '同步异常',
  'auth-required': '登录过期',
};

function shortId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value;
}

function formatTime(value: string | null): string {
  if (!value) return '尚未同步';
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(value));
  } catch {
    return value;
  }
}

export function CloudPanel(props: CloudPanelProps) {
  const [code, setCode] = createSignal('');
  const [profiles] = createSignal(loadAccountProfiles());
  const native = isNativeRuntime();
  const [nativeAccounts, setNativeAccounts] = createSignal<NativeAccountSummary[]>([]);
  const [nativeStatus, setNativeStatus] = createSignal<NativeSwitchStatus | null>(null);
  const [nativeBusy, setNativeBusy] = createSignal<string | null>(null);
  const [nativeError, setNativeError] = createSignal<string | null>(null);
  const cloud = () => props.cloud.state();
  const busy = (action: string) => cloud().busy === action;
  const connected = () => cloud().phase === 'connected';
  const accountRows = () => {
    const rows = profiles();
    if (rows.some((profile) => profile.id === 'default')) return rows;
    return [{ id: 'default', email: cloud().email, apiUrl: '', createdAt: '' }, ...rows];
  };
  const canSwitchProfiles = () => !native;
  const activeProfile = () => activeAccountId();
  const canEnterCode = () => cloud().phase === 'code-sent' || cloud().phase === 'expired';

  const refreshNative = async () => {
    if (!native) return;
    try {
      const [accounts, status] = await Promise.all([
        nativeListAccounts(),
        nativeAccountSwitchStatus(),
      ]);
      setNativeAccounts(accounts.accounts);
      setNativeStatus(status);
    } catch (error) {
      setNativeError(error instanceof Error ? error.message : '无法读取本机账号');
    }
  };

  onMount(() => {
    void refreshNative();
  });

  const nativeSwitch = async (target: NativeAccountSummary) => {
    if (nativeBusy()) return;
    const mobileNative =
      native && /android|iphone|ipad|ipod/i.test(navigator.userAgent.toLowerCase());
    if (mobileNative) {
      setNativeError('移动端冷重启切换暂未实现，当前账号保持不变');
      return;
    }
    setNativeError(null);
    setNativeBusy(target.id);
    let prepared = false;
    try {
      const status = await nativePrepareAccountSwitch(target.id);
      prepared = true;
      const pending = status.pendingOutbox;
      const warning =
        pending > 0
          ? `当前账号还有 ${pending} 条未同步修改，它们会保留在旧账号数据库中。继续切换？`
          : '切换账号会停止当前同步与提醒并重启应用，是否继续？';
      if (!window.confirm(warning)) {
        try {
          await nativeAbortAccountSwitch();
        } catch {
          // The gate is reset by the command itself when it is reachable; a
          // transport failure still requires a process restart to clear it.
        }
        prepared = false;
        setNativeBusy(null);
        return;
      }
      // Stop timers, listeners, polling and the SQLite sync-session fence
      // before the native side closes the write gate and requests restart.
      await props.cloud.quiesceForAccountSwitch();
      await nativeRequestAccountSwitch(target.id, status.generation ?? 0);
      setNativeBusy('restarting');
    } catch (error) {
      if (prepared) {
        await nativeAbortAccountSwitch().catch(() => undefined);
      }
      setNativeError(error instanceof Error ? error.message : '账号切换失败');
      setNativeBusy(null);
    }
  };

  const addNativeAccount = async () => {
    if (nativeBusy()) return;
    const email = window.prompt('新账号邮箱');
    if (!email?.trim()) return;
    const apiUrl = window.prompt('API 服务地址', cloud().apiUrl) ?? cloud().apiUrl;
    if (!apiUrl?.trim()) return;
    setNativeError(null);
    setNativeBusy('add');
    try {
      const account = await nativeCreateAccount(email.trim(), apiUrl.trim());
      rememberNativeAccount(account);
      await refreshNative();
      setNativeBusy(null);
      if (window.confirm('账号已创建为待验证状态，数据库为空。现在切换到该账号并登录验证身份？')) {
        await nativeSwitch(account);
      }
    } catch (error) {
      setNativeError(error instanceof Error ? error.message : '无法添加账号');
      setNativeBusy(null);
    }
  };

  const verify = async () => {
    if (code().trim().length < 6) return;
    try {
      await props.cloud.verifyCode(code());
      setCode('');
    } catch {
      // The controller exposes the message in the error banner.
    }
  };

  return (
    <div class="cloud-panel">
      <Show when={cloud().error}>
        <div class="cloud-banner cloud-banner--error" role="alert">
          <AlertTriangle size={16} />
          <span>{cloud().error}</span>
        </div>
      </Show>

      <Show when={connected()}>
        <div class="cloud-account-card">
          <div class="cloud-account-card__identity">
            <div class="cloud-account-card__avatar">
              <UserRound size={20} />
            </div>
            <div>
              <strong>{cloud().email}</strong>
              <span>{cloud().apiUrl.replace(/^https?:\/\//, '')}</span>
            </div>
          </div>
          <span
            class="status-badge"
            classList={{
              'status-badge--local': cloud().syncStatus === 'synced',
              'status-badge--warn':
                cloud().syncStatus === 'syncing' || cloud().syncStatus === 'idle',
              'status-badge--danger':
                cloud().syncStatus === 'error' ||
                cloud().syncStatus === 'auth-required' ||
                cloud().syncStatus === 'offline',
            }}
          >
            {cloud().syncStatus === 'syncing' ? (
              <LoaderCircle size={12} class="spin-icon" />
            ) : (
              <Check size={12} />
            )}
            {STATUS_LABEL[cloud().syncStatus] ?? cloud().syncStatus}
          </span>
        </div>

        <div class="cloud-metrics">
          <div>
            <strong>{cloud().pending}</strong>
            <span>待上传</span>
          </div>
          <div classList={{ 'cloud-metrics__danger': cloud().rejected > 0 }}>
            <strong>{cloud().rejected}</strong>
            <span>已拒绝</span>
          </div>
          <div>
            <strong>{formatTime(cloud().lastSyncedAt)}</strong>
            <span>最后同步</span>
          </div>
        </div>

        <div class="cloud-actions">
          <button
            type="button"
            class="primary-button"
            disabled={busy('sync') || cloud().syncStatus === 'syncing'}
            onClick={() => void props.cloud.syncNow()}
          >
            <RefreshCw size={15} classList={{ 'spin-icon': busy('sync') }} />
            立即同步
          </button>
          <button
            type="button"
            class="secondary-button"
            disabled={busy('bootstrap')}
            onClick={() => void props.cloud.forceBootstrap()}
          >
            <Cloud size={15} /> 重新校正云端快照
          </button>
          <Show when={cloud().rejected > 0}>
            <button
              type="button"
              class="secondary-button"
              disabled={busy('clear-rejected')}
              onClick={() => void props.cloud.clearRejected()}
            >
              <Trash2 size={15} /> 清除失败操作
            </button>
          </Show>
          <button
            type="button"
            class="secondary-button"
            onClick={() => void props.cloud.refreshDevices()}
          >
            <Smartphone size={15} /> 刷新设备
          </button>
          <button
            type="button"
            class="secondary-button"
            onClick={() => void props.cloud.downloadCloudBackup()}
          >
            <Download size={15} /> 云端备份
          </button>
          <button
            type="button"
            class="secondary-button"
            onClick={() => void props.cloud.downloadDiagnostics()}
          >
            <Download size={15} /> 诊断包
          </button>
        </div>

        <Show when={cloud().rejections.length > 0}>
          <div class="cloud-rejections">
            <div class="cloud-devices__heading">
              <h4>失败操作</h4>
              <span>回滚会丢弃该条本地变更，保留服务器版本</span>
            </div>
            <For each={cloud().rejections}>
              {(item) => (
                <div class="cloud-rejection">
                  <AlertTriangle size={15} />
                  <div>
                    <strong>
                      {item.entity} · {shortId(item.entityId)}
                    </strong>
                    <span>
                      {Object.keys(item.patch).join(', ') || '无字段'} ·{' '}
                      {item.errorCode ?? 'REJECTED'}
                    </span>
                  </div>
                  <button
                    type="button"
                    class="text-button danger-text"
                    disabled={busy('discard-rejection')}
                    onClick={() => void props.cloud.discardRejection(item.opId)}
                  >
                    回滚
                  </button>
                </div>
              )}
            </For>
          </div>
        </Show>

        <Show when={cloud().push.supported}>
          <div class="cloud-push">
            <div class="cloud-push__heading">
              <span>
                <Bell size={15} /> 网页推送
              </span>
              <strong classList={{ 'cloud-push__off': !cloud().push.subscribed }}>
                {cloud().push.subscribed ? '已开启' : '未开启'}
              </strong>
            </div>
            <p>
              {cloud().push.available
                ? '页面关闭后也能收到已同步任务的到期提醒。'
                : '服务器尚未配置 VAPID 密钥。'}
            </p>
            <Show when={cloud().push.available}>
              <div class="cloud-push__actions">
                <Show
                  when={cloud().push.subscribed}
                  fallback={
                    <button
                      type="button"
                      class="secondary-button"
                      disabled={busy('push')}
                      onClick={() => void props.cloud.enablePush()}
                    >
                      开启网页推送
                    </button>
                  }
                >
                  <button
                    type="button"
                    class="secondary-button"
                    disabled={busy('push')}
                    onClick={() => void props.cloud.testPush()}
                  >
                    发送测试通知
                  </button>
                  <button
                    type="button"
                    class="text-button danger-text"
                    disabled={busy('push')}
                    onClick={() => void props.cloud.disablePush()}
                  >
                    关闭
                  </button>
                </Show>
              </div>
            </Show>
          </div>
        </Show>

        <div class="cloud-diagnostics">
          <div>
            <span>设备</span>
            <code>{shortId(cloud().deviceId)}</code>
          </div>
          <div>
            <span>同步游标</span>
            <code>{cloud().cursor}</code>
          </div>
          <div>
            <span>账号绑定</span>
            <code>{cloud().boundAccount || cloud().email}</code>
          </div>
        </div>

        <Show when={cloud().devices.length > 0}>
          <div class="cloud-devices">
            <div class="cloud-devices__heading">
              <h4>已登录设备</h4>
              <span>撤销后该设备需要重新验证</span>
            </div>
            <For each={cloud().devices}>
              {(device) => (
                <div class="cloud-device">
                  <Smartphone size={16} />
                  <div>
                    <strong>{device.name}</strong>
                    <span>
                      {device.platform} ·{' '}
                      {device.last_seen_at ? formatTime(device.last_seen_at) : '未知'}
                      {device.id === cloud().deviceId ? ' · 当前设备' : ''}
                    </span>
                  </div>
                  <button
                    type="button"
                    class="text-button danger-text"
                    onClick={async () => {
                      if (!window.confirm(`撤销设备「${device.name}」？`)) return;
                      await props.cloud.revokeDevice(device.id);
                    }}
                  >
                    撤销
                  </button>
                </div>
              )}
            </For>
          </div>
        </Show>

        <div class="cloud-account-actions">
          <button
            type="button"
            class="secondary-button"
            disabled={busy('logout')}
            onClick={() => void props.cloud.signOut(false)}
          >
            <LogOut size={15} /> 退出登录（保留本机）
          </button>
          <button
            type="button"
            class="danger-button"
            disabled={busy('logout')}
            onClick={async () => {
              if (!window.confirm('退出并删除本机所有任务？此操作无法撤销。')) return;
              await props.cloud.signOut(true);
            }}
          >
            退出并清除本机
          </button>
          <button
            type="button"
            class="text-button danger-text"
            onClick={async () => {
              if (
                !window.confirm(
                  '永久删除云端账号及其全部数据？本机数据也将被清除，此操作不可撤销。',
                )
              ) {
                return;
              }
              await props.cloud.deleteAccount(true);
            }}
          >
            删除云端账号
          </button>
        </div>
      </Show>

      <Show when={canSwitchProfiles()}>
        <div class="cloud-accounts">
          <div class="cloud-devices__heading">
            <h4>本机账号</h4>
            <span>每个账号使用独立的本地数据库</span>
          </div>
          <For each={accountRows()}>
            {(profile) => (
              <div class="cloud-account-row">
                <UserRound size={15} />
                <div>
                  <strong>{profile.email || '未登录账号'}</strong>
                  <span>{profile.id === 'default' ? '默认数据空间' : '独立数据空间'}</span>
                </div>
                <Show
                  when={profile.id === activeProfile()}
                  fallback={
                    <button
                      type="button"
                      class="text-button"
                      onClick={async () => {
                        if (!window.confirm('切换账号会退出当前云端会话，是否继续？')) return;
                        await props.cloud.signOut(false);
                        switchAccount(profile.id);
                      }}
                    >
                      切换
                    </button>
                  }
                >
                  <span class="cloud-account-active">当前</span>
                </Show>
              </div>
            )}
          </For>
          <button
            type="button"
            class="secondary-button"
            onClick={async () => {
              if (!window.confirm('添加账号会退出当前云端会话并创建独立数据空间，是否继续？')) {
                return;
              }
              const apiUrl = cloud().apiUrl || 'http://127.0.0.1:8787';
              await props.cloud.signOut(false);
              createAndSwitchAccount(apiUrl);
            }}
          >
            <Plus size={15} /> 添加账号
          </button>
        </div>
      </Show>

      <Show when={native}>
        <div class="cloud-accounts">
          <div class="cloud-devices__heading">
            <h4>本机账号</h4>
            <span>切换会停止同步、取消提醒并冷重启应用</span>
          </div>
          <Show when={nativeError()}>
            <div class="cloud-banner cloud-banner--error" role="alert">
              <AlertTriangle size={16} />
              <span>{nativeError()}</span>
            </div>
          </Show>
          <Show when={nativeStatus()?.phase === 'FAILED'}>
            <div class="cloud-banner cloud-banner--error" role="status">
              <AlertTriangle size={16} />
              <span>上次切换未完成，已恢复原账号：{nativeStatus()?.errorCode ?? '未知错误'}</span>
            </div>
          </Show>
          <Show when={nativeBusy() === 'restarting'}>
            <div class="cloud-banner" role="status">
              <LoaderCircle size={16} class="spin-icon" />
              <span>正在保存切换并重启应用…</span>
            </div>
          </Show>
          <For each={nativeAccounts()}>
            {(account) => (
              <div class="cloud-account-row">
                <UserRound size={15} />
                <div>
                  <strong>
                    {account.email || '匿名数据空间'}
                    {account.pending ? '（待验证）' : ''}
                  </strong>
                  <span>
                    {account.id === 'default' ? '默认数据空间' : account.apiUrl || '本机账号'}
                  </span>
                </div>
                <Show
                  when={account.active}
                  fallback={
                    <button
                      type="button"
                      class="text-button"
                      disabled={nativeBusy() !== null}
                      onClick={() => void nativeSwitch(account)}
                    >
                      {nativeBusy() === account.id ? '准备中…' : '切换'}
                    </button>
                  }
                >
                  <span class="cloud-account-active">当前</span>
                </Show>
              </div>
            )}
          </For>
          <button
            type="button"
            class="secondary-button"
            disabled={nativeBusy() !== null}
            onClick={() => void addNativeAccount()}
          >
            <Plus size={15} /> 添加账号
          </button>
          <p class="cloud-accounts__note">
            未同步修改保留在旧账号数据库中；切换不会退出或删除旧账号凭据。
          </p>
        </div>
      </Show>

      <Show when={!connected() && cloud().phase !== 'choose-merge'}>
        <div class="cloud-signin">
          <div class="cloud-hero">
            <div class="cloud-hero__icon">
              <CloudOff size={22} />
            </div>
            <div>
              <h3>连接自托管云同步</h3>
              <p>
                当前任务已保存在本机。登录后可以显式选择上传、合并或使用云端快照；不会静默覆盖任何数据。
              </p>
            </div>
          </div>

          <div class="cloud-form">
            <label class="cloud-field">
              <span>API 地址</span>
              <input
                type="url"
                value={cloud().apiUrl}
                placeholder="https://todo.example.com"
                autocomplete="url"
                onInput={(event) => props.cloud.setApiUrl(event.currentTarget.value)}
                disabled={canEnterCode()}
              />
            </label>
            <label class="cloud-field">
              <span>邮箱</span>
              <input
                type="email"
                value={cloud().email}
                placeholder="you@example.com"
                autocomplete="email"
                onInput={(event) => props.cloud.setEmail(event.currentTarget.value)}
                disabled={canEnterCode()}
              />
            </label>
            <Show when={!canEnterCode()}>
              <button
                type="button"
                class="primary-button cloud-form__submit"
                disabled={busy('code')}
                onClick={() => void props.cloud.requestCode()}
              >
                {busy('code') ? (
                  <LoaderCircle size={15} class="spin-icon" />
                ) : (
                  <KeyRound size={15} />
                )}
                发送登录验证码
              </button>
            </Show>
            <Show when={canEnterCode()}>
              <label class="cloud-field">
                <span>验证码</span>
                <input
                  type="text"
                  inputmode="numeric"
                  autocomplete="one-time-code"
                  maxlength="8"
                  value={code()}
                  placeholder="6 位验证码"
                  onInput={(event) => setCode(event.currentTarget.value.replace(/\D/g, ''))}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void verify();
                  }}
                />
              </label>
              <div class="cloud-form__row">
                <button
                  type="button"
                  class="primary-button cloud-form__submit"
                  disabled={busy('verify') || code().length < 6}
                  onClick={() => void verify()}
                >
                  {busy('verify') ? (
                    <LoaderCircle size={15} class="spin-icon" />
                  ) : (
                    <ChevronRight size={15} />
                  )}
                  验证并连接
                </button>
                <button
                  type="button"
                  class="text-button"
                  onClick={() => void props.cloud.requestCode()}
                >
                  重新发送
                </button>
              </div>
              <p class="cloud-form__hint">
                开发环境验证码由服务端 `AUTH_DEV_CODE` 配置；生产环境请使用邮件中的验证码。
              </p>
            </Show>
          </div>

          <div class="cloud-signin__facts">
            <span>
              <ShieldCheck size={14} /> Refresh Token 使用 HttpOnly Cookie / 系统安全存储
            </span>
            <span>
              <WifiOff size={14} /> 断网期间继续本地写入，不改交互
            </span>
            <span>
              <HardDrive size={14} /> 首次连接可先下载本机备份
            </span>
          </div>

          <Show when={cloud().boundAccount && cloud().boundAccount !== cloud().email}>
            <div class="cloud-banner cloud-banner--warning">
              <AlertTriangle size={16} />
              <span>本机数据属于 {cloud().boundAccount}，登录其他账号前请先清除本机数据。</span>
            </div>
          </Show>
        </div>
      </Show>

      <Show when={cloud().phase === 'choose-merge' && cloud().mergePreview}>
        {(preview) => (
          <div class="cloud-merge">
            <div class="cloud-hero">
              <div class="cloud-hero__icon">
                <Cloud size={22} />
              </div>
              <div>
                <h3>首次连接：选择数据处理方式</h3>
                <p>这是一次显式操作。建议先下载本机备份，再选择合并或仅使用云端数据。</p>
              </div>
            </div>

            <div class="cloud-merge__comparison">
              <div class="cloud-merge__side">
                <span class="cloud-merge__label">本机</span>
                <strong>{preview().local.visibleTasks}</strong>
                <span>项任务 · {preview().local.lists} 个清单</span>
              </div>
              <div class="cloud-merge__vs">对比</div>
              <div class="cloud-merge__side">
                <span class="cloud-merge__label">云端</span>
                <strong>{preview().remote.visibleTasks}</strong>
                <span>项任务 · {preview().remote.lists} 个清单</span>
              </div>
            </div>

            <div class="cloud-banner cloud-banner--warning">
              <AlertTriangle size={16} />
              <span>
                合并会按 ID
                和更新时间生成字段级操作。本机与云端各自新建的同一件事可能保留为两条记录。
              </span>
            </div>

            <div class="cloud-merge__actions">
              <button
                type="button"
                class="secondary-button"
                onClick={() => void props.cloud.downloadLocalBackup()}
              >
                <Download size={15} /> 先下载本机备份
              </button>
              <button
                type="button"
                class="primary-button"
                disabled={Boolean(cloud().busy)}
                onClick={() => void props.cloud.chooseMerge('merge')}
              >
                {busy('merge') ? <LoaderCircle size={15} class="spin-icon" /> : null}
                合并本机与云端
              </button>
              <button
                type="button"
                class="secondary-button"
                disabled={Boolean(cloud().busy)}
                onClick={async () => {
                  if (!window.confirm('仅使用云端数据会清空本机任务。已下载备份？')) return;
                  await props.cloud.chooseMerge('cloud');
                }}
              >
                仅使用云端数据
              </button>
              <button
                type="button"
                class="text-button"
                onClick={() => void props.cloud.chooseMerge('cancel')}
              >
                取消登录
              </button>
            </div>
          </div>
        )}
      </Show>
    </div>
  );
}
