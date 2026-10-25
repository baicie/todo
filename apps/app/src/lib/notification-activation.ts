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

/** Native keeps at most 8 pending activations and 8 pending rejections. */
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
 * Both the activation and rejection queues are pop-on-read. Events are only
 * wake-ups: the frontend drains the bounded Native queues, so a rejection that
 * happened before listener registration is not lost. Drains are serialized and
 * bounded; an AbortSignal makes initialization cancellable at every await
 * boundary and the returned disposer is idempotent.
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

    const drainActivations = async () => {
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

    const drainRejections = async () => {
      for (let index = 0; index < MAX_DRAIN_PER_CYCLE; index += 1) {
        if (disposed || signal?.aborted) return;
        let rejection: RejectedNotificationActivation | null;
        try {
          rejection = await invoke<RejectedNotificationActivation | null>(
            'native_take_notification_rejection',
          );
        } catch {
          // A failed Native call ends this cycle; the next event may retry.
          return;
        }
        if (disposed || signal?.aborted) return;
        if (!rejection) return;
        options.notify(rejection.message, 'danger');
      }
    };

    let activationRequested = false;
    let rejectionRequested = false;
    let drainRunning = false;
    let drainChain: Promise<void> = Promise.resolve();
    const requestDrain = (kind: 'activation' | 'rejection' | 'both' = 'both') => {
      if (kind === 'activation' || kind === 'both') activationRequested = true;
      if (kind === 'rejection' || kind === 'both') rejectionRequested = true;
      if (drainRunning) return drainChain;
      drainRunning = true;
      drainChain = Promise.resolve()
        .then(async () => {
          while (!disposed && !signal?.aborted && (activationRequested || rejectionRequested)) {
            if (activationRequested) {
              activationRequested = false;
              await drainActivations();
            }
            if (rejectionRequested) {
              rejectionRequested = false;
              await drainRejections();
            }
          }
        })
        .catch(() => {
          // UI callbacks must not poison the serial chain; a later event can
          // still drain a fresh Native result.
        })
        .finally(() => {
          drainRunning = false;
          if (!disposed && !signal?.aborted && (activationRequested || rejectionRequested)) {
            // A wake-up can arrive between the loop condition and this finally.
            // Requeue it explicitly instead of losing the last event.
            if (activationRequested) void requestDrain('activation');
            if (rejectionRequested) void requestDrain('rejection');
          }
        });
      return drainChain;
    };

    const unlistenOpen = await listen<NotificationActivation>(EVENT_OPEN, () => {
      if (disposed || signal?.aborted) return;
      void requestDrain('activation');
    });
    unlisteners.push(unlistenOpen);
    if (disposed || signal?.aborted) {
      // The abort listener may already have run while listen() was awaited;
      // dispose() then had no reference to this new unlistener.
      unlistenOpen();
      ensureActive();
    }

    const unlistenRejected = await listen<RejectedNotificationActivation>(EVENT_REJECTED, () => {
      if (disposed || signal?.aborted) return;
      // The event is a wake-up only. The message is delivered exactly once
      // through the Native rejection queue, never directly from the event.
      void requestDrain('rejection');
    });
    unlisteners.push(unlistenRejected);
    if (disposed || signal?.aborted) {
      unlistenRejected();
      ensureActive();
    }

    // Listeners are installed before this drain, so a rejection produced by a
    // cold-start notification is replayed from the Native queue.
    activationRequested = true;
    rejectionRequested = true;
    await requestDrain();
    ensureActive();

    return dispose;
  } catch (error) {
    dispose();
    throw error;
  }
}
