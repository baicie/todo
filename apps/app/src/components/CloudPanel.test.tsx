import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CloudPanel } from './CloudPanel';
import type { CloudController } from '../sync/cloud';

const invoke = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

const nativeAccounts = {
  activeAccountId: 'account-a',
  accounts: [
    {
      id: 'account-a',
      kind: 'cloud',
      email: 'a@example.com',
      apiUrl: 'https://a.example',
      pending: false,
      active: true,
      lastOpenedAt: '2026-10-24T00:00:00Z',
    },
    {
      id: 'account-b',
      kind: 'cloud',
      email: 'b@example.com',
      apiUrl: 'https://b.example',
      pending: false,
      active: false,
      lastOpenedAt: '2026-10-24T00:00:00Z',
    },
  ],
};

const idleStatus = {
  active: true,
  fromAccountId: 'account-a',
  toAccountId: null,
  generation: null,
  phase: null,
  pendingOutbox: 0,
  errorCode: null,
};

function fakeCloud(overrides: Partial<CloudController> = {}): CloudController {
  const state = {
    phase: 'disconnected',
    syncStatus: 'idle',
    apiUrl: 'https://a.example',
    email: 'a@example.com',
    error: null,
    busy: null,
    pending: 0,
    rejected: 0,
    lastSyncedAt: null,
    devices: [],
    boundAccount: 'a@example.com',
    cursor: '0',
    deviceId: 'device-a',
    push: { supported: false, available: false, subscribed: false },
    mergePreview: null,
    rejections: [],
  };
  return {
    state: () => state,
    quiesceForAccountSwitch: vi.fn(async () => {}),
    ...overrides,
  } as unknown as CloudController;
}

function setNativeRuntime(): void {
  Object.defineProperty(window, '__TAURI_INTERNALS__', {
    configurable: true,
    value: {
      invoke: (command: string, args: Record<string, unknown> | undefined) => invoke(command, args),
    },
  });
}

function invoked(command: string): boolean {
  return invoke.mock.calls.some((call) => call[0] === command);
}

describe('CloudPanel native switch recovery', () => {
  beforeEach(() => {
    invoke.mockReset();
    setNativeRuntime();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    invoke.mockImplementation(async (command: string) => {
      switch (command) {
        case 'native_list_accounts':
          return nativeAccounts;
        case 'native_account_switch_status':
          return idleStatus;
        case 'native_prepare_account_switch':
          return {
            active: false,
            fromAccountId: 'account-a',
            toAccountId: 'account-b',
            generation: 42,
            phase: 'PREPARED',
            pendingOutbox: 0,
            errorCode: null,
          };
        case 'native_restart_account_recovery':
          return undefined;
        default:
          throw new Error(`unexpected command: ${command}`);
      }
    });
  });

  afterEach(() => {
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    vi.restoreAllMocks();
  });

  it('cold-restarts instead of aborting after quiesce when reminder cancellation fails', async () => {
    const cloud = fakeCloud();
    const requestFailure = Object.assign(new Error('无法取消旧账号系统通知'), {
      code: 'REMINDER_ERROR',
    });
    invoke.mockImplementation(async (command: string) => {
      switch (command) {
        case 'native_list_accounts':
          return nativeAccounts;
        case 'native_account_switch_status':
          return idleStatus;
        case 'native_prepare_account_switch':
          return {
            active: false,
            fromAccountId: 'account-a',
            toAccountId: 'account-b',
            generation: 42,
            phase: 'PREPARED',
            pendingOutbox: 0,
            errorCode: null,
          };
        case 'native_request_account_switch':
          throw requestFailure;
        case 'native_restart_account_recovery':
          return undefined;
        default:
          throw new Error(`unexpected command: ${command}`);
      }
    });

    render(() => <CloudPanel cloud={cloud} />);
    await screen.findByText('b@example.com');
    fireEvent.click(screen.getByText('切换'));

    await waitFor(() => expect(invoked('native_restart_account_recovery')).toBe(true));
    expect(cloud.quiesceForAccountSwitch).toHaveBeenCalledTimes(1);
    expect(invoked('native_abort_account_switch')).toBe(false);
    expect(screen.getByText(/正在冷重启并恢复旧账号/)).toBeInTheDocument();
  });

  it('does not dispose the cloud session when restart is unsupported before prepare', async () => {
    const cloud = fakeCloud();
    invoke.mockImplementation(async (command: string) => {
      switch (command) {
        case 'native_list_accounts':
          return nativeAccounts;
        case 'native_account_switch_status':
          return idleStatus;
        case 'native_prepare_account_switch':
          throw Object.assign(new Error('mobile restart unsupported'), {
            code: 'RESTART_UNSUPPORTED',
          });
        default:
          throw new Error(`unexpected command: ${command}`);
      }
    });

    render(() => <CloudPanel cloud={cloud} />);
    await screen.findByText('b@example.com');
    fireEvent.click(screen.getByText('切换'));

    await screen.findByText(/mobile restart unsupported|账号切换失败/);
    expect(cloud.quiesceForAccountSwitch).not.toHaveBeenCalled();
    expect(invoked('native_restart_account_recovery')).toBe(false);
    expect(invoked('native_abort_account_switch')).toBe(false);
  });

  it('cold-restarts when a user-cancelled prepare cannot be aborted safely', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const cloud = fakeCloud();
    invoke.mockImplementation(async (command: string) => {
      switch (command) {
        case 'native_list_accounts':
          return nativeAccounts;
        case 'native_account_switch_status':
          return idleStatus;
        case 'native_prepare_account_switch':
          return {
            active: false,
            fromAccountId: 'account-a',
            toAccountId: 'account-b',
            generation: 42,
            phase: 'PREPARED',
            pendingOutbox: 0,
            errorCode: null,
          };
        case 'native_abort_account_switch':
          throw Object.assign(new Error('abort forbidden'), {
            code: 'ACCOUNT_SWITCH_ABORT_FORBIDDEN',
          });
        case 'native_restart_account_recovery':
          return undefined;
        default:
          throw new Error(`unexpected command: ${command}`);
      }
    });

    render(() => <CloudPanel cloud={cloud} />);
    await screen.findByText('b@example.com');
    fireEvent.click(screen.getByText('切换'));

    await waitFor(() => expect(invoked('native_restart_account_recovery')).toBe(true));
    expect(invoked('native_abort_account_switch')).toBe(true);
    expect(cloud.quiesceForAccountSwitch).not.toHaveBeenCalled();
  });

  it('cold-restarts when prepare requires native recovery after it closed the gate', async () => {
    const cloud = fakeCloud();
    invoke.mockImplementation(async (command: string) => {
      switch (command) {
        case 'native_list_accounts':
          return nativeAccounts;
        case 'native_account_switch_status':
          return idleStatus;
        case 'native_prepare_account_switch':
          throw Object.assign(new Error('account recovery required'), {
            code: 'ACCOUNT_RECOVERY_REQUIRED',
          });
        case 'native_restart_account_recovery':
          return undefined;
        default:
          throw new Error(`unexpected command: ${command}`);
      }
    });

    render(() => <CloudPanel cloud={cloud} />);
    await screen.findByText('b@example.com');
    fireEvent.click(screen.getByText('切换'));

    await waitFor(() => expect(invoked('native_restart_account_recovery')).toBe(true));
    expect(cloud.quiesceForAccountSwitch).not.toHaveBeenCalled();
    expect(invoked('native_abort_account_switch')).toBe(false);
  });
});
