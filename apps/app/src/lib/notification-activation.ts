import { activeAccountId } from './accounts';

export interface NotificationTargetV1 {
  accountId: string;
  taskId: string;
  sourceVersion: 1;
}

export interface NotificationActivation {
  activationId: string;
  target: NotificationTargetV1;
  taskTitle: string;
}

export interface RejectedNotificationActivation {
  code: string;
  message: string;
}

const EVENT_OPEN = 'native-notification-activation';
const EVENT_REJECTED = 'native-notification-rejected';

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * Deliver Native-validated notification targets to the task detail view.
 *
 * Native has already checked the active account, runtime gate and task
 * existence. The frontend repeats the account check only as a stale-localStorage
 * defense; it never switches accounts or stores a target across a restart.
 */
export async function startNotificationActivationBridge(options: {
  openTask: (taskId: string) => void;
  notify: (message: string, tone: 'danger' | 'success') => void;
}): Promise<() => void> {
  if (!isTauriRuntime()) return () => {};

  const [{ invoke }, { listen }] = await Promise.all([
    import('@tauri-apps/api/core'),
    import('@tauri-apps/api/event'),
  ]);
  const seen = new Set<string>();

  const handleOpen = (activation: NotificationActivation) => {
    if (!activation?.activationId || seen.has(activation.activationId)) return;
    seen.add(activation.activationId);
    if (activation.target.accountId !== activeAccountId()) {
      options.notify('该提醒属于另一个账号，请先切换账号', 'danger');
      void invoke('native_ack_notification_activation', {
        activationId: activation.activationId,
      }).catch(() => {});
      return;
    }
    options.openTask(activation.target.taskId);
    void invoke('native_ack_notification_activation', {
      activationId: activation.activationId,
    }).catch(() => {});
  };

  const unlistenOpen = await listen<NotificationActivation>(EVENT_OPEN, (event) => {
    handleOpen(event.payload);
  });
  const unlistenRejected = await listen<RejectedNotificationActivation>(
    EVENT_REJECTED,
    (event) => {
      options.notify(event.payload.message, 'danger');
    },
  );

  try {
    const pending = await invoke<NotificationActivation | null>(
      'native_take_notification_activation',
    );
    if (pending) handleOpen(pending);
  } catch {
    // The activation bridge is an enhancement; task editing must stay usable.
  }

  return () => {
    unlistenOpen();
    unlistenRejected();
  };
}
