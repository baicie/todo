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

/** Native keeps at most 8 pending activations; keep each drain bounded too. */
const MAX_DRAIN_PER_CYCLE = 8;

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function abortError(): Error {
  const error = new Error('notification activation bridge aborted');
  error.name = 'AbortError';
  return error;
}

/**
 * Deliver Native-validated notification targets to the task detail view.
 *
 * Native has already checked the active account, runtime gate and task
 * existence. The frontend repeats the account check only as a stale-localStorage
 * defense; it never switches accounts or stores a target across a restart.
 *
 * Delivery is serialized and bounded. Native's take command skips rejected
 * records (emitting a reject event) and returns null only when it has no valid
 * activation left to deliver, so the loop below can stop on the first null.
 * An AbortSignal makes initialization cancellable at every await boundary; the
 * returned disposer is idempotent.
 */
export async function startNotificationActivationBridge(
  options: {
    openTask: (taskId: string) => void;
    notify: (message: string, tone: 'danger' | 'success') => void;
  },
  signal?: AbortSignal,
): Promise<() => void> {
  if (!isTauriRuntime()) return () => {};

  let disposed = false;
  const unlisteners: Array<() => void> = [];
  let removeAbortListener = () => {};

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    removeAbortListener();
    for (const unlisten of unlisteners.splice(0)) {
      try {
        unlisten();
      } catch {
        // A partially initialized bridge must still release its other listeners.
      }
    }
  };

  const ensureActive = () => {
    if (disposed || signal?.aborted) {
      dispose();
      throw abortError();
    }
  };

  if (signal) {
    if (signal.aborted) throw abortError();
    signal.addEventListener('abort', dispose, { once: true });
    removeAbortListener = () => signal.removeEventListener('abort', dispose);
  }

  try {
    const [{ invoke }, { listen }] = await Promise.all([
      import('@tauri-apps/api/core'),
      import('@tauri-apps/api/event'),
    ]);
    ensureActive();

    const seen = new Set<string>();
    const handleOpen = (activation: NotificationActivation) => {
      if (disposed || signal?.aborted) return;
      if (!activation?.activationId || seen.has(activation.activationId)) return;
      if (seen.size > 64) seen.clear();
      seen.add(activation.activationId);
      if (activation.target.accountId !== activeAccountId()) {
        options.notify('该提醒属于另一个账号，请先切换账号', 'danger');
        return;
      }
      // Native's take command is pop-on-read: taking the activation is the
      // delivery commitment. There is no second ACK mutation to fail.
      options.openTask(activation.target.taskId);
    };

    let drainChain: Promise<void> = Promise.resolve();
    const drainOnce = async () => {
      for (let index = 0; index < MAX_DRAIN_PER_CYCLE; index += 1) {
        if (disposed || signal?.aborted) return;
        let pending: NotificationActivation | null;
        try {
          pending = await invoke<NotificationActivation | null>(
            'native_take_notification_activation',
          );
        } catch {
          // A failed Native call ends this cycle; the next event may retry.
          return;
        }
        if (disposed || signal?.aborted) return;
        if (!pending) return;
        handleOpen(pending);
      }
    };
    const drainPending = (): Promise<void> => {
      // Serialize cycles so a burst of events cannot interleave Native takes
      // or reorder task openings.
      drainChain = drainChain.then(drainOnce).catch(() => {
        // UI callbacks must not poison the serial chain; a later event can
        // still drain a fresh Native activation.
      });
      return drainChain;
    };

    const unlistenOpen = await listen<NotificationActivation>(EVENT_OPEN, () => {
      if (disposed || signal?.aborted) return;
      void drainPending();
    });
    unlisteners.push(unlistenOpen);
    if (disposed || signal?.aborted) {
      // The abort listener may already have run while listen() was awaited;
      // dispose() then had no reference to this new unlistener.
      unlistenOpen();
      ensureActive();
    }

    const unlistenRejected = await listen<RejectedNotificationActivation>(
      EVENT_REJECTED,
      (event) => {
        if (disposed || signal?.aborted) return;
        options.notify(event.payload.message, 'danger');
      },
    );
    unlisteners.push(unlistenRejected);
    if (disposed || signal?.aborted) {
      unlistenRejected();
      ensureActive();
    }

    // Consume activations that were queued before the WebView listened. The
    // event handler only wakes a drain; this initial cycle must not depend on
    // another notification arriving.
    await drainPending();
    ensureActive();

    return dispose;
  } catch (error) {
    dispose();
    throw error;
  }
}
