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

function setTauriRuntime(): void {
  Object.defineProperty(window, '__TAURI_INTERNALS__', {
    configurable: true,
    value: {},
  });
  localStorage.setItem('shishi.active-account.v1', 'default');
}

function defaultOptions() {
  return { openTask: vi.fn(), notify: vi.fn() };
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
  listenMock.mockImplementation(
    async (event: string, handler: (event: { payload: unknown }) => void) => {
      handlers.set(event, handler);
      return event === 'native-notification-activation' ? unlistenOpen : unlistenRejected;
    },
  );
  setTauriRuntime();
});

afterEach(() => {
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('notification activation bridge drain', () => {
  it('drains two activations queued before the listener without another event', async () => {
    invokeMock
      .mockResolvedValueOnce(activation('a1'))
      .mockResolvedValueOnce(activation('a2'))
      .mockResolvedValueOnce(null);
    const options = defaultOptions();

    const stop = await startNotificationActivationBridge(options);

    expect(options.openTask.mock.calls).toEqual([['task-a1'], ['task-a2']]);
    expect(invokeMock).toHaveBeenCalledTimes(3);
    stop();
  });

  it('ends the initial drain when Native reports an empty queue', async () => {
    invokeMock.mockResolvedValue(null);
    const options = defaultOptions();

    const stop = await startNotificationActivationBridge(options);

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(options.openTask).not.toHaveBeenCalled();
    stop();
  });

  it('stops after a rejected/empty result and does not busy-loop', async () => {
    invokeMock.mockResolvedValue(null);
    const options = defaultOptions();

    const stop = await startNotificationActivationBridge(options);

    expect(invokeMock).toHaveBeenCalledTimes(1);
    stop();
  });

  it('leaves the drain after a Native invocation failure instead of retrying forever', async () => {
    invokeMock.mockRejectedValue(new Error('native unavailable'));
    const options = defaultOptions();

    const stop = await startNotificationActivationBridge(options);

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(options.openTask).not.toHaveBeenCalled();
    stop();
  });

  it('does not open the same activation twice', async () => {
    invokeMock
      .mockResolvedValueOnce(activation('a1'))
      .mockResolvedValueOnce(activation('a1'))
      .mockResolvedValueOnce(null);
    const options = defaultOptions();

    const stop = await startNotificationActivationBridge(options);

    expect(options.openTask).toHaveBeenCalledTimes(1);
    stop();
  });

  it('does not open a task from another account', async () => {
    invokeMock.mockResolvedValueOnce(activation('other', 'account-b')).mockResolvedValueOnce(null);
    const options = defaultOptions();

    const stop = await startNotificationActivationBridge(options);

    expect(options.openTask).not.toHaveBeenCalled();
    expect(options.notify).toHaveBeenCalledWith('该提醒属于另一个账号，请先切换账号', 'danger');
    stop();
  });

  it('bounds one drain cycle to the Native queue capacity of eight', async () => {
    for (let index = 0; index < 8; index += 1) {
      invokeMock.mockResolvedValueOnce(activation(`a${index}`));
    }
    const options = defaultOptions();

    const stop = await startNotificationActivationBridge(options);

    expect(invokeMock).toHaveBeenCalledTimes(8);
    expect(options.openTask).toHaveBeenCalledTimes(8);
    stop();
  });

  it('serializes a wake event behind the in-flight drain', async () => {
    const first = deferred<NotificationActivation | null>();
    invokeMock
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    const options = defaultOptions();

    const start = startNotificationActivationBridge(options);
    await waitForInvoke();
    expect(invokeMock).toHaveBeenCalledTimes(1);

    handlers.get('native-notification-activation')?.({ payload: activation('wake') });
    expect(invokeMock).toHaveBeenCalledTimes(1);

    first.resolve(null);
    await start;
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(2));
    expect(options.openTask).not.toHaveBeenCalled();
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
    invokeMock.mockReturnValue(take.promise);
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
    invokeMock.mockResolvedValue(null);
    const options = defaultOptions();

    const stop = await startNotificationActivationBridge(options);
    stop();
    stop();

    expect(unlistenOpen).toHaveBeenCalledTimes(1);
    expect(unlistenRejected).toHaveBeenCalledTimes(1);

    handlers.get('native-notification-activation')?.({ payload: activation('late') });
    await Promise.resolve();
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(options.openTask).not.toHaveBeenCalled();
  });

  it('delivers normally when cleanup happens after initialization', async () => {
    invokeMock.mockResolvedValueOnce(activation('a1')).mockResolvedValueOnce(null);
    const options = defaultOptions();

    const stop = await startNotificationActivationBridge(options);
    expect(options.openTask).toHaveBeenCalledWith('task-a1');
    stop();
    expect(unlistenOpen).toHaveBeenCalledTimes(1);
    expect(unlistenRejected).toHaveBeenCalledTimes(1);
  });

  it('forwards rejected activation messages without opening a task', async () => {
    invokeMock.mockResolvedValue(null);
    const options = defaultOptions();
    const stop = await startNotificationActivationBridge(options);

    const rejected: RejectedNotificationActivation = {
      code: 'ACCOUNT_SWITCH_REQUIRED',
      message: '该提醒属于另一个账号',
    };
    handlers.get('native-notification-rejected')?.({ payload: rejected });
    expect(options.notify).toHaveBeenCalledWith('该提醒属于另一个账号', 'danger');
    expect(options.openTask).not.toHaveBeenCalled();
    stop();
  });
});
