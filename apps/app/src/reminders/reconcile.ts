import type { ReminderScheduleResult } from '@todo/application';

export interface ReminderCandidate {
  id: string;
  status: 'open' | 'completed';
  remindAt: string | null;
  title: string;
  note: string;
}

export interface ReminderIssue {
  reminderId: string;
  status: ReminderScheduleResult['status'] | 'cancel-failed';
  message?: string;
}

export interface ReminderReconcileResult {
  nextScheduled: Map<string, string>;
  scheduled: string[];
  cancelled: string[];
  unchanged: string[];
  issues: ReminderIssue[];
}

export function reminderFingerprint(task: ReminderCandidate): string {
  return `${task.remindAt ?? ''}\u0000${task.title}\u0000${task.note.slice(0, 120)}`;
}

/**
 * Reconciles only reminders whose content or time changed. The caller owns
 * persistence/data changes; scheduler and cancel failures are reported instead
 * of being silently treated as success.
 */
export async function reconcileReminders(input: {
  tasks: ReminderCandidate[];
  scheduled: Map<string, string>;
  schedule: (task: ReminderCandidate) => Promise<ReminderScheduleResult>;
  cancel: (id: string) => Promise<void>;
}): Promise<ReminderReconcileResult> {
  const active = new Map(
    input.tasks
      .filter((task) => task.status === 'open' && task.remindAt)
      .map((task) => [task.id, task]),
  );
  const nextScheduled = new Map(input.scheduled);
  const scheduled: string[] = [];
  const cancelled: string[] = [];
  const unchanged: string[] = [];
  const issues: ReminderIssue[] = [];

  for (const [id] of input.scheduled) {
    if (active.has(id)) continue;
    try {
      await input.cancel(id);
      nextScheduled.delete(id);
      cancelled.push(id);
    } catch (error) {
      issues.push({
        reminderId: id,
        status: 'cancel-failed',
        message: error instanceof Error ? error.message : '取消提醒失败',
      });
    }
  }

  for (const task of active.values()) {
    const fingerprint = reminderFingerprint(task);
    if (nextScheduled.get(task.id) === fingerprint) {
      unchanged.push(task.id);
      continue;
    }

    let result: ReminderScheduleResult;
    try {
      result = await input.schedule(task);
    } catch (error) {
      result = {
        status: 'failed',
        message: error instanceof Error ? error.message : '调度失败',
      };
    }

    if (result.status === 'scheduled') {
      nextScheduled.set(task.id, fingerprint);
      scheduled.push(task.id);
      continue;
    }

    // A changed reminder may still have the old platform entry. Cancel it so
    // the next reconcile can retry cleanly.
    try {
      await input.cancel(task.id);
    } catch (error) {
      issues.push({
        reminderId: task.id,
        status: 'cancel-failed',
        message: error instanceof Error ? error.message : '取消旧提醒失败',
      });
    }
    nextScheduled.delete(task.id);
    issues.push({
      reminderId: task.id,
      status: result.status,
      message: result.message,
    });
  }

  return { nextScheduled, scheduled, cancelled, unchanged, issues };
}
