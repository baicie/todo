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
    if (seen.size > 64) seen.clear();
    seen.add(activation.activationId);
    if (activation.target.accountId !== activeAccountId()) {
      options.notify('该提醒属于另一个账号，请先切换账号', 'danger');
      return;
    }
    // The Native command is pop-on-read: taking the activation is the
    // delivery commitment. There is no second ACK mutation to fail.
    options.openTask(activation.target.taskId);
  };

  let drainInFlight: Promise<void> = Promise.resolve();
  const drainPending = (): Promise<void> => {
    drainInFlight = drainInFlight.then(async () => {
      try {
        const pending = await invoke<NotificationActivation | null>(
          'native_take_notification_activation',
        );
        if (pending) handleOpen(pending);
      } catch {
        // A failed delivery must not break the normal task UI.
      }
    });
    return drainInFlight;
  };

  const unlistenOpen = await listen<NotificationActivation>(EVENT_OPEN, () => {
    // The event is only a wake-up: take the activation back from Native so the
    // active account, gate and task are revalidated at delivery time.
    void drainPending();
  });
  const unlistenRejected = await listen<RejectedNotificationActivation>(EVENT_REJECTED, (event) => {
    options.notify(event.payload.message, 'danger');
  });

  // Covers an activation emitted before the WebView listener existed.
  await drainPending();

  return () => {
    unlistenOpen();
    unlistenRejected();
  };
}
