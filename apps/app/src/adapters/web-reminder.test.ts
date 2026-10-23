import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebReminderScheduler } from './web-reminder';

class FakeNotification {
  static permission: NotificationPermission = 'granted';
  static requestPermission = vi.fn(async () => 'granted' as NotificationPermission);
  constructor(
    readonly title: string,
    readonly options?: NotificationOptions,
  ) {}
}

describe('WebReminderScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-23T00:00:00Z'));
    FakeNotification.permission = 'granted';
    vi.stubGlobal('Notification', FakeNotification);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('returns permission-denied instead of claiming a schedule without permission', async () => {
    FakeNotification.permission = 'denied';
    const scheduler = new WebReminderScheduler();
    await expect(
      scheduler.schedule({
        reminderId: 'r1',
        fireAtUtc: '2026-10-23T01:00:00Z',
        title: 'task',
      }),
    ).resolves.toMatchObject({ status: 'permission-denied' });
  });

  it('returns skipped-past for a past reminder', async () => {
    const scheduler = new WebReminderScheduler();
    await expect(
      scheduler.schedule({
        reminderId: 'r1',
        fireAtUtc: '2026-10-22T23:00:00Z',
        title: 'task',
      }),
    ).resolves.toEqual({ status: 'skipped-past' });
  });

  it('chunks delays beyond the browser timer maximum', async () => {
    const scheduler = new WebReminderScheduler();
    const result = await scheduler.schedule({
      reminderId: 'r1',
      fireAtUtc: new Date(Date.now() + 3_000_000_000).toISOString(),
      title: 'task',
    });
    expect(result.status).toBe('scheduled');
    expect(vi.getTimerCount()).toBe(1);
    await scheduler.cancel('r1');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('fires a notification at the due time while the page is alive', async () => {
    const notify = vi.fn();
    class NotificationWithSpy extends FakeNotification {
      constructor(title: string, options?: NotificationOptions) {
        super(title, options);
        notify(title);
      }
    }
    vi.stubGlobal('Notification', NotificationWithSpy);
    const scheduler = new WebReminderScheduler();
    await scheduler.schedule({
      reminderId: 'r1',
      fireAtUtc: new Date(Date.now() + 60_000).toISOString(),
      title: 'task',
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(notify).toHaveBeenCalledWith('task');
  });
});
