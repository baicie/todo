import type { ReminderPermission, ReminderScheduler } from '@todo/application';

/**
 * Browser reminders only run while the page is alive. The UI states this
 * limitation explicitly; native clients use the OS scheduler bridge.
 */
export class WebReminderScheduler implements ReminderScheduler {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  async getPermission(): Promise<ReminderPermission> {
    if (typeof Notification === 'undefined') return 'denied';
    if (Notification.permission === 'default') return 'prompt';
    return Notification.permission;
  }

  async requestPermission(): Promise<ReminderPermission> {
    if (typeof Notification === 'undefined') return 'denied';
    const result = await Notification.requestPermission();
    return result === 'default' ? 'prompt' : result;
  }

  async schedule(input: {
    reminderId: string;
    fireAtUtc: string;
    title: string;
    body?: string;
  }): Promise<void> {
    this.cancelTimer(input.reminderId);
    const fireAt = new Date(input.fireAtUtc).getTime();
    const delay = fireAt - Date.now();
    if (!Number.isFinite(delay) || delay <= 0) return;
    if (delay > 2_147_000_000) return;
    const timer = setTimeout(() => {
      this.timers.delete(input.reminderId);
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        try {
          new Notification(input.title, {
            body: input.body ?? '该完成这项任务了',
            icon: '/icon.svg',
            tag: input.reminderId,
          });
        } catch {
          // Some browsers only allow notifications from a service worker.
        }
      }
    }, delay);
    this.timers.set(input.reminderId, timer);
  }

  async cancel(reminderId: string): Promise<void> {
    this.cancelTimer(reminderId);
  }

  async rescheduleUpcoming(): Promise<void> {
    // The UI re-schedules individual tasks after each local query. This method
    // exists so a future service-worker/Web Push adapter can implement a queue.
  }

  private cancelTimer(reminderId: string): void {
    const timer = this.timers.get(reminderId);
    if (timer) clearTimeout(timer);
    this.timers.delete(reminderId);
  }
}
