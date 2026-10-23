import { describe, expect, it, vi } from 'vitest';
import { reconcileReminders, reminderFingerprint } from './reconcile';
import type { ReminderCandidate } from './reconcile';

const task = (overrides: Partial<ReminderCandidate> = {}): ReminderCandidate => ({
  id: 'task-1',
  status: 'open',
  remindAt: '2026-10-24T09:00:00Z',
  title: '准备周会',
  note: '',
  ...overrides,
});

const scheduled = () => ({ status: 'scheduled' as const });

describe('reconcileReminders', () => {
  it('schedules a new reminder and records the fingerprint', async () => {
    const schedule = vi.fn(async () => scheduled());
    const result = await reconcileReminders({
      tasks: [task()],
      scheduled: new Map(),
      schedule,
      cancel: vi.fn(),
    });
    expect(schedule).toHaveBeenCalledTimes(1);
    expect(result.scheduled).toEqual(['task-1']);
    expect(result.nextScheduled.get('task-1')).toBe(reminderFingerprint(task()));
  });

  it('does not reschedule an unchanged reminder on a normal task edit', async () => {
    const schedule = vi.fn(async () => scheduled());
    const result = await reconcileReminders({
      tasks: [task()],
      scheduled: new Map([['task-1', reminderFingerprint(task())]]),
      schedule,
      cancel: vi.fn(),
    });
    expect(schedule).not.toHaveBeenCalled();
    expect(result.unchanged).toEqual(['task-1']);
  });

  it('cancels reminders for completed tasks and reports failures', async () => {
    const cancel = vi.fn(async () => {});
    const result = await reconcileReminders({
      tasks: [task({ status: 'completed' })],
      scheduled: new Map([['task-1', reminderFingerprint(task())]]),
      schedule: vi.fn(),
      cancel,
    });
    expect(cancel).toHaveBeenCalledWith('task-1');
    expect(result.cancelled).toEqual(['task-1']);
    expect(result.nextScheduled.has('task-1')).toBe(false);
  });

  it('reports permission/outside-window/scheduling failures as issues', async () => {
    const result = await reconcileReminders({
      tasks: [task()],
      scheduled: new Map(),
      schedule: vi.fn(async () => ({ status: 'permission-denied' as const, message: 'denied' })),
      cancel: vi.fn(),
    });
    expect(result.scheduled).toEqual([]);
    expect(result.issues).toEqual([
      expect.objectContaining({ reminderId: 'task-1', status: 'permission-denied' }),
    ]);
  });

  it('does not treat a partial batch as fully successful', async () => {
    const result = await reconcileReminders({
      tasks: [task(), task({ id: 'task-2', title: '另一个' })],
      scheduled: new Map(),
      schedule: vi
        .fn()
        .mockResolvedValueOnce({ status: 'scheduled' as const })
        .mockResolvedValueOnce({ status: 'failed' as const, message: 'boom' }),
      cancel: vi.fn(),
    });
    expect(result.scheduled).toEqual(['task-1']);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({ reminderId: 'task-2', status: 'failed' });
  });

  it('keeps a cancellation retryable when the platform cancel fails', async () => {
    const result = await reconcileReminders({
      tasks: [],
      scheduled: new Map([['task-1', 'old']]),
      schedule: vi.fn(),
      cancel: vi.fn(async () => {
        throw new Error('platform busy');
      }),
    });
    expect(result.nextScheduled.has('task-1')).toBe(true);
    expect(result.issues[0]).toMatchObject({ status: 'cancel-failed' });
  });
});
