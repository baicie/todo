import type {
  ReminderPermission,
  ReminderScheduler,
  ReminderScheduleResult,
} from '@todo/application';

async function invokeCommand<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(command, args);
}

export class TauriReminderScheduler implements ReminderScheduler {
  async schedule(input: {
    reminderId: string;
    fireAtUtc: string;
    title: string;
    body?: string;
  }): Promise<ReminderScheduleResult> {
    try {
      const mode = await invokeCommand<string>('schedule_reminder', {
        reminderId: input.reminderId,
        fireAtUtc: input.fireAtUtc,
        title: input.title,
        body: input.body ?? '',
      });
      switch (mode) {
        case 'exact':
        case 'inexact':
        case 'scheduled':
          return { status: 'scheduled', mode };
        case 'past':
        case 'skipped-past':
          return { status: 'skipped-past' };
        case 'outside-window':
          return { status: 'outside-window', message: '提醒超出系统预调度窗口' };
        case 'capacity-exceeded':
          return { status: 'capacity-exceeded', message: '系统提醒队列已满' };
        case 'permission-denied':
          return { status: 'permission-denied', message: '系统通知权限未授予' };
        default:
          return { status: 'failed', message: `未知调度结果: ${mode}` };
      }
    } catch (error) {
      return { status: 'failed', message: error instanceof Error ? error.message : '调度失败' };
    }
  }

  async cancel(reminderId: string): Promise<void> {
    await invokeCommand('cancel_reminder', { reminderId });
  }

  async rescheduleUpcoming(): Promise<void> {
    await invokeCommand('reschedule_reminders');
  }

  async getPermission(): Promise<ReminderPermission> {
    try {
      const result = await invokeCommand<string>('reminder_permission');
      return result === 'granted' || result === 'denied' ? result : 'prompt';
    } catch {
      return 'prompt';
    }
  }

  async requestPermission(): Promise<ReminderPermission> {
    try {
      const { isPermissionGranted, requestPermission } =
        await import('@tauri-apps/plugin-notification');
      if (await isPermissionGranted()) return 'granted';
      const result = await requestPermission();
      return result === 'default' ? 'prompt' : result;
    } catch {
      return 'prompt';
    }
  }
}
