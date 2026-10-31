/**
 * Notification-activation navigation transaction.
 *
 * A navigation may only be acknowledged once the detail view has confirmed that
 * it rendered the requested task. Every attempt carries a monotonically
 * increasing generation; a newer attempt, an account switch or an AbortSignal
 * abort invalidates older ones, and a stale attempt never commits UI state nor
 * resolves `true`.
 *
 * All framework contact is injected, so the transaction has no DOM selector, no
 * timer and no polling: the view layer feeds a render signal and the navigator
 * resolves on it.
 */

/** What the detail view has on screen, reported after a render pass. */
export interface DetailRenderReport {
  /** Task id the detail view currently shows; null when it shows none. */
  taskId: string | null;
  /** Generation of the commit that produced this render, 0 when it had none. */
  generation: number;
}

export interface TaskNavigatorDeps<Task> {
  /** Loads the task detail; null means the target no longer exists. */
  getTask(taskId: string): Promise<Task | null>;
  readSelectedId(): string | null;
  readSelectedTask(): Task | null;
  /** Commits the selection together with the generation that owns it. */
  commitSelection(task: Task, id: string, generation: number): void;
  /** Puts a previously shown selection back; must not steal a newer view. */
  restoreSelection(previousId: string | null, previousTask: Task | null): void;
  /** Reactive accessor fed by the view layer: is this task on screen right now. */
  isDetailRendered(taskId: string): boolean;
  /** Framework hook: the view reports every render that changed what is shown. */
  subscribeToDetailConfirmation(listener: (report: DetailRenderReport) => void): () => void;
  readAccountId(): string;
  notifyError(error: unknown): void;
}

export interface TaskNavigator {
  /** Resolves true only for a render-confirmed navigation the caller may ACK. */
  navigateToTask(taskId: string, signal?: AbortSignal): Promise<boolean>;
  /** Invalidate every in-flight navigation (account switch, host teardown). */
  invalidateAll(): void;
  dispose(): void;
  /** Generation of the most recent attempt; diagnostics and tests. */
  currentGeneration(): number;
}

interface Transaction<Task> {
  readonly generation: number;
  readonly taskId: string;
  readonly accountId: string;
  readonly previousId: string | null;
  readonly previousTask: Task | null;
  committed: boolean;
  settled: boolean;
  removeAbortListener: () => void;
  resolve: (opened: boolean) => void;
  readonly promise: Promise<boolean>;
}

function deferred(): { promise: Promise<boolean>; resolve: (value: boolean) => void } {
  let resolve: (value: boolean) => void = () => {};
  const promise = new Promise<boolean>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

export function createTaskNavigator<Task>(deps: TaskNavigatorDeps<Task>): TaskNavigator {
  let generation = 0;
  let disposed = false;
  const active = new Map<number, Transaction<Task>>();

  /**
   * Settles one attempt exactly once. A committed attempt that no longer owns
   * the view is rolled back; an attempt superseded by a newer owner is not, so
   * a late failure can never take the selection away from it.
   */
  const settle = (transaction: Transaction<Task>, opened: boolean, rollback: boolean): void => {
    if (transaction.settled) return;
    transaction.settled = true;
    active.delete(transaction.generation);
    transaction.removeAbortListener();
    if (rollback && transaction.committed && deps.readSelectedId() === transaction.taskId) {
      deps.restoreSelection(transaction.previousId, transaction.previousTask);
    }
    transaction.resolve(opened);
  };

  const unsubscribe = deps.subscribeToDetailConfirmation((report) => {
    if (disposed) return;
    for (const transaction of [...active.values()]) {
      if (deps.readAccountId() !== transaction.accountId) {
        settle(transaction, false, false);
        continue;
      }
      if (report.taskId === transaction.taskId) {
        if (report.generation >= transaction.generation) settle(transaction, true, false);
        continue;
      }
      // The view rendered another task, or nothing at all: the attempt no longer
      // owns the detail panel, so it is superseded and rolled back at most.
      settle(transaction, false, true);
    }
  });

  const advance = async (transaction: Transaction<Task>): Promise<void> => {
    const { taskId } = transaction;
    let task: Task | null;
    try {
      task = await deps.getTask(taskId);
    } catch (error) {
      settle(transaction, false, false);
      if (!disposed) deps.notifyError(error);
      return;
    }
    if (transaction.settled || disposed) return;
    if (deps.readAccountId() !== transaction.accountId) {
      settle(transaction, false, false);
      return;
    }
    const currentId = deps.readSelectedId();
    if (currentId !== transaction.previousId && currentId !== taskId) {
      // Someone else took the view while this attempt was loading.
      settle(transaction, false, false);
      return;
    }
    if (!task) {
      // Deleted or unreachable target: never commit, the caller ACKs rejected.
      settle(transaction, false, false);
      return;
    }
    transaction.committed = true;
    try {
      deps.commitSelection(task, taskId, transaction.generation);
    } catch (error) {
      transaction.committed = false;
      settle(transaction, false, false);
      if (!disposed) deps.notifyError(error);
      return;
    }
    if (transaction.settled) return;
    if (deps.readSelectedId() === taskId && deps.isDetailRendered(taskId)) {
      settle(transaction, true, false);
    }
  };

  const navigateToTask = (taskId: string, signal?: AbortSignal): Promise<boolean> => {
    if (disposed || signal?.aborted) return Promise.resolve(false);
    const attempt = ++generation;
    for (const older of [...active.values()]) settle(older, false, true);
    if (deps.readSelectedId() === taskId && deps.isDetailRendered(taskId)) {
      // Duplicate activation of the confirmed target: no second commit needed.
      return Promise.resolve(true);
    }

    const pending = deferred();
    const transaction: Transaction<Task> = {
      generation: attempt,
      taskId,
      accountId: deps.readAccountId(),
      previousId: deps.readSelectedId(),
      previousTask: deps.readSelectedTask(),
      committed: false,
      settled: false,
      removeAbortListener: () => {},
      resolve: pending.resolve,
      promise: pending.promise,
    };
    active.set(attempt, transaction);
    if (signal) {
      const onAbort = () => settle(transaction, false, true);
      signal.addEventListener('abort', onAbort, { once: true });
      transaction.removeAbortListener = () => signal.removeEventListener('abort', onAbort);
    }
    // The returned promise settles on confirmation, abort or supersession; it is
    // intentionally not chained to the load, so an abort resolves immediately.
    void advance(transaction);
    return transaction.promise;
  };

  const invalidateAll = (): void => {
    for (const transaction of [...active.values()]) settle(transaction, false, false);
  };

  const dispose = (): void => {
    if (disposed) return;
    invalidateAll();
    disposed = true;
    unsubscribe();
  };

  return { navigateToTask, invalidateAll, dispose, currentGeneration: () => generation };
}
