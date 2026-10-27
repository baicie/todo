import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  startNotificationActivationBridge,
  type NotificationActivation,
  type RejectedNotificationActivation,
} from './notification-activation';

const invokeMock = vi.fn();
const listenMock = vi.fn();
const handlers = new Map<string, (event: { payload: unknown }) => void>();
const unlistenOpen = vi.fn();
const unlistenRejected = vi.fn();
const activationQueue: Array<NotificationActivation | null> = [];
const rejectionQueue: Array<RejectedNotificationActivation | null> = [];
let failActivations = false;
let failRejections = false;

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: (...args: unknown[]) => listenMock(...args),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function activation(
  activationId: string,
  accountId = 'default',
  taskId = `task-${activationId}`,
): NotificationActivation {
  return {
    activationId,
    target: { accountId, taskId, sourceVersion: 1 },
    taskTitle: `title-${activationId}`,
  };
}

function rejection(message: string): RejectedNotificationActivation {
  return { code: 'ACCOUNT_SWITCH_REQUIRED', message };
}

function commandCalls(command: string): number {
  return invokeMock.mock.calls.filter(([name]) => name === command).length;
}

function setTauriRuntime(): void {
  Object.defineProperty(window, '__TAURI_INTERNALS__', {
    configurable: true,
    value: {},
  });
  localStorage.setItem('shishi.active-account.v1', 'default');
}

function defaultOptions() {
  return { openTask: vi.fn(async () => true), notify: vi.fn() };
}

async function waitForInvoke(): Promise<void> {
  await vi.waitFor(() => expect(invokeMock).toHaveBeenCalled());
}

beforeEach(() => {
  invokeMock.mockReset();
  listenMock.mockReset();
  handlers.clear();
  unlistenOpen.mockReset();
  unlistenRejected.mockReset();
  activationQueue.length = 0;
  rejectionQueue.length = 0;
  failActivations = false;
  failRejections = false;
  listenMock.mockImplementation(
    async (event: string, handler: (event: { payload: unknown }) => void) => {
      handlers.set(event, handler);
      return event === 'native-notification-activation' ? unlistenOpen : unlistenRejected;
    },
  );
  invokeMock.mockImplementation(async (command: string) => {
    if (command === 'native_notification_listener_ready') return true;
    if (command === 'native_ack_notification_activation') return true;
    if (command === 'native_take_notification_activation') {
      if (failActivations) throw new Error('native activation unavailable');
      return activationQueue.shift() ?? null;
    }
    if (command === 'native_take_notification_rejection') {
      if (failRejections) throw new Error('native rejection unavailable');
      return rejectionQueue.shift() ?? null;
    }
    throw new Error(`unexpected command: ${command}`);
  });
  setTauriRuntime();
});

afterEach(() => {
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('notification activation bridge activation drain', () => {
  it('drains two activations queued before the listener without another event', async () => {
    activationQueue.push(activation('a1'), activation('a2'), null);
    const options = defaultOptions();

    const stop = await startNotificationActivationBridge(options);

    expect(options.openTask.mock.calls).toEqual([['task-a1'], ['task-a2']]);
    expect(commandCalls('native_take_notification_activation')).toBe(3);
    stop();
  });

  it('ends the initial drain when Native reports an empty queue', async () => {
    const options = defaultOptions();

    const stop = await startNotificationActivationBridge(options);

    expect(options.openTask).not.toHaveBeenCalled();
    expect(commandCalls('native_take_notification_activation')).toBe(1);
    stop();
  });

  it('leaves the drain after a Native invocation failure instead of retrying forever', async () => {
    failActivations = true;
    const options = defaultOptions();

    const stop = await startNotificationActivationBridge(options);

    expect(commandCalls('native_take_notification_activation')).toBe(1);
    expect(options.openTask).not.toHaveBeenCalled();
    stop();
  });

  it('does not open the same activation twice', async () => {
    activationQueue.push(activation('a1'), activation('a1'), null);
    const options = defaultOptions();

    const stop = await startNotificationActivationBridge(options);

    expect(options.openTask).toHaveBeenCalledTimes(1);
    stop();
  });

  it('does not open a task from another account', async () => {
    activationQueue.push(activation('other', 'account-b'), null);
    const options = defaultOptions();

    const stop = await startNotificationActivationBridge(options);

    expect(options.openTask).not.toHaveBeenCalled();
    expect(options.notify).toHaveBeenCalledWith('该提醒属于另一个账号，请先切换账号', 'danger');
    stop();
  });

  it('bounds one drain cycle to the Native queue capacity of eight', async () => {
    for (let index = 0; index < 8; index += 1) {
      activationQueue.push(activation(`a${index}`));
    }
    const options = defaultOptions();

    const stop = await startNotificationActivationBridge(options);

    expect(commandCalls('native_take_notification_activation')).toBe(8);
    expect(options.openTask).toHaveBeenCalledTimes(8);
    stop();
  });

  it('does not ACK opened when the task detail cannot be resolved', async () => {
    activationQueue.push(activation('a1'), null);
    const acks: Array<Record<string, unknown>> = [];
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'native_notification_listener_ready') return true;
      if (command === 'native_ack_notification_activation') {
        acks.push(args ?? {});
        return true;
      }
      if (command === 'native_take_notification_activation') return activationQueue.shift() ?? null;
      if (command === 'native_take_notification_rejection') return null;
      return null;
    });
    const options = defaultOptions();
    options.openTask = vi.fn(async () => false);
    const stop = await startNotificationActivationBridge(options);
    expect(acks).toEqual([expect.objectContaining({ activationId: 'a1', outcome: 'rejected' })]);
    expect(options.notify).toHaveBeenCalled();
    stop();
  });

  it('does not ACK opened when navigation throws', async () => {
    activationQueue.push(activation('a1'), null);
    const acks: Array<Record<string, unknown>> = [];
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'native_notification_listener_ready') return true;
      if (command === 'native_ack_notification_activation') {
        acks.push(args ?? {});
        return true;
      }
      if (command === 'native_take_notification_activation') return activationQueue.shift() ?? null;
      if (command === 'native_take_notification_rejection') return null;
      return null;
    });
    const options = defaultOptions();
    options.openTask = vi.fn(async () => {
      throw new Error('navigation failed');
    });
    const stop = await startNotificationActivationBridge(options);
    expect(acks).toEqual([expect.objectContaining({ activationId: 'a1', outcome: 'rejected' })]);
    stop();
  });

  it('registers a listener session before the first drain', async () => {
    let readyCall = -1;
    let takeCall = -1;
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'native_notification_listener_ready') {
        readyCall = invokeMock.mock.calls.length;
        return true;
      }
      if (command === 'native_take_notification_activation') {
        takeCall = invokeMock.mock.calls.length;
        return null;
      }
      if (command === 'native_take_notification_rejection') return null;
      return true;
    });
    const stop = await startNotificationActivationBridge(defaultOptions());
    expect(readyCall).toBeGreaterThan(0);
    expect(takeCall).toBeGreaterThan(readyCall);
    stop();
  });

  it('ACKs opened only after the task opener succeeds', async () => {
    activationQueue.push(activation('a1'), null);
    const acks: Array<Record<string, unknown>> = [];
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'native_notification_listener_ready') return true;
      if (command === 'native_ack_notification_activation') {
        acks.push(args ?? {});
        return true;
      }
      if (command === 'native_take_notification_activation') {
        return activationQueue.shift() ?? null;
      }
      if (command === 'native_take_notification_rejection') return null;
      return null;
    });
    const options = defaultOptions();
    const stop = await startNotificationActivationBridge(options);
    expect(options.openTask).toHaveBeenCalledWith('task-a1');
    expect(acks).toEqual([
      expect.objectContaining({
        activationId: 'a1',
        outcome: 'opened',
        sessionId: expect.any(String),
      }),
    ]);
    stop();
  });

  it('ACKs rejected without opening another account target', async () => {
    activationQueue.push(activation('a1', 'other'), null);
    const acks: Array<Record<string, unknown>> = [];
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'native_notification_listener_ready') return true;
      if (command === 'native_ack_notification_activation') {
        acks.push(args ?? {});
        return true;
      }
      if (command === 'native_take_notification_activation') return activationQueue.shift() ?? null;
      if (command === 'native_take_notification_rejection') return null;
      return null;
    });
    const options = defaultOptions();
    const stop = await startNotificationActivationBridge(options);
    expect(options.openTask).not.toHaveBeenCalled();
    expect(acks).toEqual([
      expect.objectContaining({
        activationId: 'a1',
        outcome: 'rejected',
        sessionId: expect.any(String),
      }),
    ]);
    stop();
  });

  it('serializes a wake event behind the in-flight drain', async () => {
    const first = deferred<NotificationActivation | null>();
    let activationCalls = 0;
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'native_notification_listener_ready') return true;
      if (command === 'native_ack_notification_activation') return true;
      if (command === 'native_take_notification_rejection') return null;
      activationCalls += 1;
      return activationCalls === 1 ? first.promise : null;
    });
    const options = defaultOptions();

    const start = startNotificationActivationBridge(options);
    await waitForInvoke();
    expect(activationCalls).toBe(1);

    handlers.get('native-notification-activation')?.({ payload: activation('wake') });
    expect(activationCalls).toBe(1);

    first.resolve(null);
    await start;
    await vi.waitFor(() => expect(activationCalls).toBe(2));
    expect(options.openTask).not.toHaveBeenCalled();
  });
});

describe('notification rejection queue drain', () => {
  it('delivers multiple rejections queued before the listener in FIFO order', async () => {
    rejectionQueue.push(rejection('first'), rejection('second'), null);
    const options = defaultOptions();

    const stop = await startNotificationActivationBridge(options);

    expect(options.notify.mock.calls).toEqual([
      ['first', 'danger'],
      ['second', 'danger'],
    ]);
    expect(options.openTask).not.toHaveBeenCalled();
    stop();
  });

  it('ends the rejection drain on an empty queue', async () => {
    const options = defaultOptions();

    const stop = await startNotificationActivationBridge(options);

    expect(commandCalls('native_take_notification_rejection')).toBe(1);
    expect(options.notify).not.toHaveBeenCalled();
    stop();
  });

  it('uses events only as a wake-up and does not notify directly from the event', async () => {
    const options = defaultOptions();
    const stop = await startNotificationActivationBridge(options);

    handlers.get('native-notification-rejected')?.({
      payload: rejection('event payload must not be displayed'),
    });
    await Promise.resolve();
    expect(options.notify).not.toHaveBeenCalled();

    rejectionQueue.push(rejection('queued message'), null);
    handlers.get('native-notification-rejected')?.({ payload: {} });
    await vi.waitFor(() => expect(options.notify).toHaveBeenCalledWith('queued message', 'danger'));
    expect(options.notify).toHaveBeenCalledTimes(1);
    stop();
  });

  it('does not duplicate a toast when the same wake event is repeated', async () => {
    const options = defaultOptions();
    const stop = await startNotificationActivationBridge(options);

    rejectionQueue.push(rejection('once'), null);
    handlers.get('native-notification-rejected')?.({ payload: {} });
    handlers.get('native-notification-rejected')?.({ payload: {} });
    await vi.waitFor(() => expect(options.notify).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(options.notify).toHaveBeenCalledTimes(1);
    expect(commandCalls('native_take_notification_rejection')).toBeLessThan(5);
    stop();
  });

  it('handles the eighth and ninth rejection at the bounded drain boundary', async () => {
    for (let index = 0; index < 9; index += 1) {
      rejectionQueue.push(rejection(`r${index}`));
    }
    rejectionQueue.push(null);
    const options = defaultOptions();
    const stop = await startNotificationActivationBridge(options);

    expect(options.notify).toHaveBeenCalledTimes(8);
    expect(options.notify.mock.calls.map(([message]) => message)).toEqual([
      'r0',
      'r1',
      'r2',
      'r3',
      'r4',
      'r5',
      'r6',
      'r7',
    ]);

    handlers.get('native-notification-rejected')?.({ payload: {} });
    await vi.waitFor(() => expect(options.notify).toHaveBeenCalledTimes(9));
    expect(options.notify).toHaveBeenLastCalledWith('r8', 'danger');
    stop();
  });

  it('drains activation and rejection queues without consuming each other', async () => {
    activationQueue.push(activation('a1'), null);
    rejectionQueue.push(rejection('r1'), null);
    const options = defaultOptions();

    const stop = await startNotificationActivationBridge(options);

    expect(options.openTask.mock.calls).toEqual([['task-a1']]);
    expect(options.notify.mock.calls).toEqual([['r1', 'danger']]);
    stop();
  });

  it('continues activation delivery when the rejection drain fails', async () => {
    activationQueue.push(activation('a1'), null);
    failRejections = true;
    const options = defaultOptions();

    const stop = await startNotificationActivationBridge(options);

    expect(options.openTask).toHaveBeenCalledWith('task-a1');
    expect(options.notify).not.toHaveBeenCalled();
    stop();
  });

  it('allows a later wake to retry after a rejection Native failure', async () => {
    failRejections = true;
    const options = defaultOptions();
    const stop = await startNotificationActivationBridge(options);
    expect(options.notify).not.toHaveBeenCalled();

    failRejections = false;
    rejectionQueue.push(rejection('retry'), null);
    handlers.get('native-notification-rejected')?.({ payload: {} });

    await vi.waitFor(() => expect(options.notify).toHaveBeenCalledWith('retry', 'danger'));
    expect(options.notify).toHaveBeenCalledTimes(1);
    stop();
  });

  it('does not show a rejection when cleanup happens during its invoke', async () => {
    const take = deferred<RejectedNotificationActivation | null>();
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'native_notification_listener_ready') return true;
      if (command === 'native_ack_notification_activation') return true;
      if (command === 'native_take_notification_activation') return null;
      return take.promise;
    });
    const controller = new AbortController();
    const options = defaultOptions();

    const start = startNotificationActivationBridge(options, controller.signal);
    await vi.waitFor(() => expect(commandCalls('native_take_notification_rejection')).toBe(1));
    controller.abort();
    take.resolve(rejection('late'));

    await expect(start).rejects.toMatchObject({ name: 'AbortError' });
    expect(options.notify).not.toHaveBeenCalled();
    expect(unlistenOpen).toHaveBeenCalledTimes(1);
    expect(unlistenRejected).toHaveBeenCalledTimes(1);
  });

  it('stops after a rejection Native invocation failure', async () => {
    failRejections = true;
    const options = defaultOptions();

    const stop = await startNotificationActivationBridge(options);

    expect(commandCalls('native_take_notification_rejection')).toBe(1);
    expect(options.notify).not.toHaveBeenCalled();
    stop();
  });
});

describe('notification activation bridge abort lifecycle', () => {
  it('rejects before registering listeners when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const options = defaultOptions();

    await expect(
      startNotificationActivationBridge(options, controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(listenMock).not.toHaveBeenCalled();
    expect(options.openTask).not.toHaveBeenCalled();
  });

  it('does not register listeners when aborted while dynamic imports resolve', async () => {
    const controller = new AbortController();
    const options = defaultOptions();

    const start = startNotificationActivationBridge(options, controller.signal);
    controller.abort();

    await expect(start).rejects.toMatchObject({ name: 'AbortError' });
    expect(listenMock).not.toHaveBeenCalled();
    expect(options.openTask).not.toHaveBeenCalled();
  });

  it('unlistens the first listener when cleanup occurs during its registration', async () => {
    const registration = deferred<() => void>();
    listenMock.mockReturnValueOnce(registration.promise);
    const controller = new AbortController();
    const options = defaultOptions();

    const start = startNotificationActivationBridge(options, controller.signal);
    await vi.waitFor(() => expect(listenMock).toHaveBeenCalledTimes(1));
    controller.abort();
    registration.resolve(unlistenOpen);

    await expect(start).rejects.toMatchObject({ name: 'AbortError' });
    expect(unlistenOpen).toHaveBeenCalledTimes(1);
    expect(options.openTask).not.toHaveBeenCalled();
  });

  it('unlistens both listeners when cleanup occurs during the second registration', async () => {
    const secondRegistration = deferred<() => void>();
    listenMock.mockResolvedValueOnce(unlistenOpen).mockReturnValueOnce(secondRegistration.promise);
    const controller = new AbortController();
    const options = defaultOptions();

    const start = startNotificationActivationBridge(options, controller.signal);
    await vi.waitFor(() => expect(listenMock).toHaveBeenCalledTimes(2));
    controller.abort();
    secondRegistration.resolve(unlistenRejected);

    await expect(start).rejects.toMatchObject({ name: 'AbortError' });
    expect(unlistenOpen).toHaveBeenCalledTimes(1);
    expect(unlistenRejected).toHaveBeenCalledTimes(1);
  });

  it('does not deliver a pending activation when cleanup happens during the initial drain', async () => {
    const take = deferred<NotificationActivation | null>();
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'native_notification_listener_ready') return true;
      if (command === 'native_ack_notification_activation') return true;
      if (command === 'native_take_notification_rejection') return null;
      return take.promise;
    });
    const controller = new AbortController();
    const options = defaultOptions();

    const start = startNotificationActivationBridge(options, controller.signal);
    await waitForInvoke();
    controller.abort();
    take.resolve(activation('late'));

    await expect(start).rejects.toMatchObject({ name: 'AbortError' });
    expect(options.openTask).not.toHaveBeenCalled();
    expect(unlistenOpen).toHaveBeenCalledTimes(1);
    expect(unlistenRejected).toHaveBeenCalledTimes(1);
  });

  it('is idempotent on normal cleanup and ignores later events', async () => {
    const options = defaultOptions();

    const stop = await startNotificationActivationBridge(options);
    stop();
    stop();

    expect(unlistenOpen).toHaveBeenCalledTimes(1);
    expect(unlistenRejected).toHaveBeenCalledTimes(1);

    handlers.get('native-notification-activation')?.({ payload: activation('late') });
    handlers.get('native-notification-rejected')?.({ payload: {} });
    await Promise.resolve();
    expect(options.openTask).not.toHaveBeenCalled();
    expect(options.notify).not.toHaveBeenCalled();
    stop();
  });

  it('delivers normally when cleanup happens after initialization', async () => {
    activationQueue.push(activation('a1'), null);
    const options = defaultOptions();

    const stop = await startNotificationActivationBridge(options);
    expect(options.openTask).toHaveBeenCalledWith('task-a1');
    stop();
    expect(unlistenOpen).toHaveBeenCalledTimes(1);
    expect(unlistenRejected).toHaveBeenCalledTimes(1);
  });
});
