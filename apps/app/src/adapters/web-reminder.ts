import type {
  ReminderPermission,
  ReminderReconcileReport,
  ReminderScheduler,
  ReminderScheduleResult,
} from '@todo/application';

const MAX_TIMEOUT = 2_147_000_000;

interface PendingReminder {
  reminderId: string;
  fireAtUtc: string;
  title: string;
  body?: string;
}

/**
 * Browser reminders only run while the page is alive. The UI states this
 * limitation explicitly; native clients use the OS scheduler bridge.
 *
 * Long delays are split into chunks because setTimeout values larger than a
 * signed 32-bit integer are clamped to an immediate timer by browsers.
 */
export class WebReminderScheduler implements ReminderScheduler {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private pending = new Map<string, PendingReminder>();

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
  }): Promise<ReminderScheduleResult> {
    this.cancelTimer(input.reminderId);
    const fireAt = new Date(input.fireAtUtc).getTime();
    const delay = fireAt - Date.now();
    if (!Number.isFinite(delay)) {
      return { status: 'failed', message: '提醒时间无效' };
    }
    if (delay <= 0) return { status: 'skipped-past' };
    if ((await this.getPermission()) !== 'granted') {
      return { status: 'permission-denied', message: '浏览器通知权限未授予' };
    }

    this.pending.set(input.reminderId, { ...input });
    this.arm(input.reminderId);
    return { status: 'scheduled', mode: 'page-alive' };
  }

  async cancel(reminderId: string): Promise<void> {
    this.cancelTimer(reminderId);
  }

  async rescheduleUpcoming(): Promise<ReminderReconcileReport> {
    for (const id of this.pending.keys()) this.arm(id);
    return {
      scheduled: 0,
      cancelled: 0,
      unchanged: this.pending.size,
      skippedPast: 0,
      outsideWindow: 0,
      capacityExceeded: 0,
      permissionDenied: 0,
      failed: [],
    };
  }

  private arm(reminderId: string): void {
    const pending = this.pending.get(reminderId);
    if (!pending) return;
    this.cancelTimer(reminderId, false);
    const remaining = new Date(pending.fireAtUtc).getTime() - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0) {
      this.fire(reminderId, pending);
      return;
    }
    const timer = setTimeout(
      () => this.arm(reminderId),
      Math.min(Math.ceil(remaining), MAX_TIMEOUT),
    );
    this.timers.set(reminderId, timer);
  }

  private fire(reminderId: string, pending: PendingReminder): void {
    this.pending.delete(reminderId);
    this.timers.delete(reminderId);
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    try {
      new Notification(pending.title, {
        body: pending.body ?? '该完成这项任务了',
        icon: '/icon.svg',
        tag: reminderId,
      });
    } catch {
      // Some browsers only allow notifications from a service worker.
    }
  }

  private cancelTimer(reminderId: string, clearPending = true): void {
    const timer = this.timers.get(reminderId);
    if (timer) clearTimeout(timer);
    this.timers.delete(reminderId);
    if (clearPending) this.pending.delete(reminderId);
  }
}
