/**
 * Public domain model. Dates that represent calendar days are always
 * `YYYY-MM-DD`; instants are always ISO-8601 strings in UTC.
 */
export type Id = string;
export type DateOnly = string;
export type Instant = string;
export type TaskStatus = 'open' | 'completed';
export type SmartView = 'my-day' | 'important' | 'planned' | 'calendar' | 'all' | 'completed';

export interface TaskList {
  id: Id;
  name: string;
  color: string | null;
  icon: string | null;
  rank: string;
  createdAt: Instant;
  updatedAt: Instant;
  deletedAt: Instant | null;
}

export type RecurrenceFrequency = 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'yearly';

export interface Recurrence {
  frequency: RecurrenceFrequency;
  /** Calendar interval. 1 means every day/week/month/year. */
  interval?: number;
  /** ISO weekdays, Monday = 1, Sunday = 7. Used by weekly. */
  weekdays?: number[];
  /** 1-31. Used by monthly and yearly (with month). */
  monthDay?: number;
  /** Month 1-12 for yearly rules. */
  month?: number;
  /**
   * calendar follows the scheduled date. completion counts from the day the
   * task was completed. The latter is intentionally a separate mode.
   */
  anchorMode?: 'calendar' | 'completion';
}

export interface Task {
  id: Id;
  listId: Id | null;
  title: string;
  note: string;
  tags?: string[];
  status: TaskStatus;
  important: boolean;
  dueOn: DateOnly | null;
  remindAt: Instant | null;
  remindTimezone: string | null;
  rank: string;
  seriesId: Id | null;
  occurrenceKey: string | null;
  recurrence: Recurrence | null;
  completedAt: Instant | null;
  createdAt: Instant;
  updatedAt: Instant;
  deletedAt: Instant | null;
}

export interface Step {
  id: Id;
  taskId: Id;
  title: string;
  isCompleted: boolean;
  rank: string;
  createdAt: Instant;
  updatedAt: Instant;
  deletedAt: Instant | null;
}

export interface DayPlan {
  id: Id;
  taskId: Id;
  localDate: DateOnly;
  rank: string;
  createdAt: Instant;
  updatedAt: Instant;
  deletedAt: Instant | null;
}

export interface TaskWithSteps extends Task {
  steps: Step[];
  dayPlanDates: DateOnly[];
}

export interface NewTask {
  title: string;
  listId?: Id | null;
  note?: string;
  tags?: string[];
  important?: boolean;
  dueOn?: DateOnly | null;
  remindAt?: Instant | null;
  remindTimezone?: string | null;
  recurrence?: Recurrence | null;
  rank?: string;
  /** Adds the freshly created task to this day in the same operation. */
  planDate?: DateOnly | null;
}

export interface TaskPatch {
  title?: string;
  listId?: Id | null;
  note?: string;
  tags?: string[];
  status?: TaskStatus;
  important?: boolean;
  dueOn?: DateOnly | null;
  remindAt?: Instant | null;
  remindTimezone?: string | null;
  recurrence?: Recurrence | null;
  rank?: string;
  completedAt?: Instant | null;
}

export interface NewList {
  name: string;
  color?: string | null;
  icon?: string | null;
}

export interface ListPatch {
  name?: string;
  color?: string | null;
  icon?: string | null;
  rank?: string;
}

export interface NewStep {
  taskId: Id;
  title: string;
}

export interface StepPatch {
  title?: string;
  isCompleted?: boolean;
  rank?: string;
}

export type TaskView = SmartView | 'list';

export interface TaskQuery {
  view: TaskView;
  listId?: Id | null;
  search?: string;
  /** All selected tags must be present. */
  tags?: string[];
  /** Local calendar date for my-day queries. */
  localDate?: DateOnly;
  /** Planned view can additionally restrict to a range. */
  dueFrom?: DateOnly;
  dueTo?: DateOnly;
  includeCompleted?: boolean;
  limit?: number;
}

export interface ChangeSubscription {
  (entityIds: Id[]): void;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export class DomainError extends Error {
  constructor(
    readonly code:
      'VALIDATION_FAILED' | 'NOT_FOUND' | 'CONFLICT' | 'INVALID_DATE' | 'INVALID_RECURRENCE',
    message: string,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}
