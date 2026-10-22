import type { ReminderPermission, ReminderScheduler } from '@todo/application';

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
  }): Promise<void> {
    await invokeCommand('schedule_reminder', {
      reminderId: input.reminderId,
      fireAtUtc: input.fireAtUtc,
      title: input.title,
      body: input.body ?? '',
    });
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
