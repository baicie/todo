import { batch, createEffect, createRoot, createSignal } from 'solid-js';
import { describe, expect, it, vi } from 'vitest';
import {
  createTaskNavigator,
  type DetailRenderReport,
  type TaskNavigatorDeps,
} from './task-navigation';

interface TestTask {
  id: string;
  title: string;
}

interface PendingLoad {
  taskId: string;
  resolve: (task: TestTask | null) => void;
}

/** Flushes pending microtasks only; no sleeps, no timers. */
async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

function createHarness() {
  const commits: Array<{ id: string; generation: number }> = [];
  const restores: Array<{ previousId: string | null; previousTitle: string | null }> = [];
  const notifyError = vi.fn();
  const listeners = new Set<(report: DetailRenderReport) => void>();
  const loads: PendingLoad[] = [];
  let selectedId: string | null = null;
  let selectedTask: TestTask | null = null;
  let rendered: DetailRenderReport | null = null;
  let commitGeneration = 0;
  let accountId = 'account-a';
  let renderOnCommit = true;

  const task = (id: string): TestTask => ({ id, title: `title-${id}` });

  const report = (next: DetailRenderReport): void => {
    rendered = next;
    for (const listener of [...listeners]) listener(next);
  };

  const deps: TaskNavigatorDeps<TestTask> = {
    getTask: (taskId) =>
      new Promise<TestTask | null>((resolve) => {
        loads.push({ taskId, resolve });
      }),
    readSelectedId: () => selectedId,
    readSelectedTask: () => selectedTask,
    commitSelection: (selected, id, generation) => {
      commits.push({ id, generation });
      commitGeneration = generation;
      selectedId = id;
      selectedTask = selected;
      // Solid renders synchronously inside the commit, so the detail view
      // reports its render before commitSelection returns.
      if (renderOnCommit) report({ taskId: id, generation });
    },
    restoreSelection: (previousId, previousTask) => {
      restores.push({ previousId, previousTitle: previousTask?.title ?? null });
      selectedId = previousId;
      selectedTask = previousTask;
      report({ taskId: previousId, generation: commitGeneration });
    },
    isDetailRendered: (taskId) => rendered?.taskId === taskId,
    subscribeToDetailConfirmation: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    readAccountId: () => accountId,
    notifyError,
  };

  const navigator = createTaskNavigator(deps);

  const pendingLoad = (index: number): PendingLoad => {
    const load = loads[index];
    if (!load) throw new Error(`expected a pending getTask at index ${index}`);
    return load;
  };

  return {
    navigator,
    commits,
    restores,
    notifyError,
    loads,
    task,
    pendingLoad,
    readSelectedId: () => selectedId,
    readSelectedTask: () => selectedTask,
    renderedReport: () => rendered,
    /** Resolves the getTask promise the navigator is awaiting. */
    async resolveLoad(index: number, value: TestTask | null): Promise<void> {
      pendingLoad(index).resolve(value);
      await flush();
    },
    /** The user clicks a task: the id changes, the panel still shows the old one. */
    selectManually(id: string): void {
      selectedId = id;
      report({ taskId: null, generation: commitGeneration });
    },
    /** The detail panel finished rendering a task. */
    renderDetail(id: string): void {
      selectedTask = task(id);
      report({ taskId: id, generation: commitGeneration });
    },
    /** The detail panel rendered nothing (render failure / deleted target). */
    reportEmptyDetail(): void {
      report({ taskId: null, generation: commitGeneration });
    },
    setRenderOnCommit(value: boolean): void {
      renderOnCommit = value;
    },
    switchAccount(id: string): void {
      accountId = id;
    },
  };
}

describe('task navigation transaction', () => {
  it('supersedes a slow load when the user selects another task meanwhile', async () => {
    const harness = createHarness();
    const opened = harness.navigator.navigateToTask('a');

    harness.selectManually('b');
    await harness.resolveLoad(0, harness.task('a'));

    expect(await opened).toBe(false);
    expect(harness.commits).toHaveLength(0);
    expect(harness.readSelectedId()).toBe('b');
  });

  it('never commits a deleted task and leaves the previous selection untouched', async () => {
    const harness = createHarness();
    harness.selectManually('prev');
    harness.renderDetail('prev');

    const opened = harness.navigator.navigateToTask('gone');
    await harness.resolveLoad(0, null);

    expect(await opened).toBe(false);
    expect(harness.commits).toHaveLength(0);
    expect(harness.restores).toHaveLength(0);
    expect(harness.readSelectedId()).toBe('prev');
  });

  it('invalidates the attempt when the account switched during the load', async () => {
    const harness = createHarness();
    const opened = harness.navigator.navigateToTask('a');

    harness.switchAccount('account-b');
    await harness.resolveLoad(0, harness.task('a'));

    expect(await opened).toBe(false);
    expect(harness.commits).toHaveLength(0);
    expect(harness.readSelectedId()).toBeNull();
  });

  it('does not commit when aborted after the data resolved but before the commit', async () => {
    const harness = createHarness();
    const controller = new AbortController();
    const opened = harness.navigator.navigateToTask('a', controller.signal);

    harness.pendingLoad(0).resolve(harness.task('a'));
    controller.abort();
    await flush();

    expect(await opened).toBe(false);
    expect(harness.commits).toHaveLength(0);
    expect(harness.readSelectedId()).toBeNull();
  });

  it('resolves false on abort during the render and never commits late', async () => {
    const harness = createHarness();
    harness.setRenderOnCommit(false);
    const controller = new AbortController();
    const opened = harness.navigator.navigateToTask('a', controller.signal);
    await harness.resolveLoad(0, harness.task('a'));
    expect(harness.commits).toHaveLength(1);

    controller.abort();
    await flush();

    expect(await opened).toBe(false);
    expect(harness.commits).toHaveLength(1);
    expect(harness.restores).toEqual([{ previousId: null, previousTitle: null }]);
    expect(harness.readSelectedId()).toBeNull();
  });

  it('does not steal the selection back when the user picks another task', async () => {
    const harness = createHarness();
    harness.setRenderOnCommit(false);
    const opened = harness.navigator.navigateToTask('a');
    await harness.resolveLoad(0, harness.task('a'));

    harness.selectManually('b');
    harness.renderDetail('b');
    await flush();

    expect(await opened).toBe(false);
    expect(harness.commits).toHaveLength(1);
    expect(harness.restores).toHaveLength(0);
    expect(harness.readSelectedId()).toBe('b');
    expect(harness.readSelectedTask()?.id).toBe('b');
  });

  it('resolves a duplicate activation of the confirmed target without a second commit', async () => {
    const harness = createHarness();
    const first = harness.navigator.navigateToTask('a');
    await harness.resolveLoad(0, harness.task('a'));
    expect(await first).toBe(true);

    const second = harness.navigator.navigateToTask('a');

    expect(await second).toBe(true);
    expect(harness.commits).toHaveLength(1);
    expect(harness.loads).toHaveLength(1);
  });

  it('rolls back to the previous selection when the detail never confirms', async () => {
    const harness = createHarness();
    harness.selectManually('prev');
    harness.renderDetail('prev');
    harness.setRenderOnCommit(false);

    const opened = harness.navigator.navigateToTask('a');
    await harness.resolveLoad(0, harness.task('a'));
    expect(harness.commits).toHaveLength(1);

    harness.reportEmptyDetail();
    await flush();

    expect(await opened).toBe(false);
    expect(harness.restores).toEqual([{ previousId: 'prev', previousTitle: 'title-prev' }]);
    expect(harness.readSelectedId()).toBe('prev');
    expect(harness.readSelectedTask()?.id).toBe('prev');
  });

  it('lets only the newest of two consecutive activations win', async () => {
    const harness = createHarness();
    const first = harness.navigator.navigateToTask('a');
    const second = harness.navigator.navigateToTask('b');

    expect(await first).toBe(false);
    await harness.resolveLoad(1, harness.task('b'));

    expect(await second).toBe(true);
    expect(harness.commits).toEqual([{ id: 'b', generation: 2 }]);
    expect(harness.readSelectedId()).toBe('b');
    expect(harness.navigator.currentGeneration()).toBe(2);
  });
});

describe('task navigation abort and teardown', () => {
  it('resolves false immediately on abort instead of waiting for the load', async () => {
    const harness = createHarness();
    const controller = new AbortController();
    const opened = harness.navigator.navigateToTask('a', controller.signal);

    controller.abort();

    expect(await opened).toBe(false);
    expect(harness.commits).toHaveLength(0);
    // The load is still pending: the render confirmation never arrived.
    expect(harness.loads).toHaveLength(1);
  });

  it('reports false without committing when the repository rejects', async () => {
    const notifyError = vi.fn();
    const commitSelection = vi.fn();
    const restoreSelection = vi.fn();
    const navigator = createTaskNavigator<TestTask>({
      getTask: () => Promise.reject(new Error('repository offline')),
      readSelectedId: () => null,
      readSelectedTask: () => null,
      commitSelection,
      restoreSelection,
      isDetailRendered: () => false,
      subscribeToDetailConfirmation: () => () => {},
      readAccountId: () => 'account-a',
      notifyError,
    });

    expect(await navigator.navigateToTask('a')).toBe(false);
    expect(commitSelection).not.toHaveBeenCalled();
    expect(restoreSelection).not.toHaveBeenCalled();
    expect(notifyError).toHaveBeenCalledTimes(1);
  });

  it('invalidates a committed navigation without rolling back over a new view', async () => {
    const harness = createHarness();
    harness.setRenderOnCommit(false);
    const opened = harness.navigator.navigateToTask('a');
    await harness.resolveLoad(0, harness.task('a'));
    expect(harness.commits).toHaveLength(1);

    harness.navigator.invalidateAll();

    expect(await opened).toBe(false);
    expect(harness.restores).toHaveLength(0);
    expect(harness.readSelectedId()).toBe('a');
  });

  it('settles pending work and rejects new navigations after dispose', async () => {
    const harness = createHarness();
    const opened = harness.navigator.navigateToTask('a');

    harness.navigator.dispose();
    expect(await opened).toBe(false);
    expect(await harness.navigator.navigateToTask('b')).toBe(false);
    expect(harness.commits).toHaveLength(0);
  });
});

describe('task navigation view wiring', () => {
  it('confirms the navigation from a Solid effect inside the commit batch', async () => {
    const [selectedId, setSelectedId] = createSignal<string | null>(null);
    const [selectedTask, setSelectedTask] = createSignal<TestTask | null>(null);
    const [rendered, setRendered] = createSignal<DetailRenderReport | null>(null);
    const restored: Array<string | null> = [];
    const commits: string[] = [];
    let committedGeneration = 0;

    // Mirrors App.tsx: the render signal is published by an effect that runs
    // after the framework render pass, and the navigator resolves on it.
    const disposeRenderEffect = createRoot((disposeRoot) => {
      createEffect(() => {
        const task = selectedTask();
        const id = selectedId();
        const next: DetailRenderReport | null =
          task && id && task.id === id ? { taskId: id, generation: committedGeneration } : null;
        setRendered((previous) =>
          previous?.taskId === next?.taskId && previous?.generation === next?.generation
            ? previous
            : next,
        );
      });
      return disposeRoot;
    });

    const navigator = createTaskNavigator<TestTask>({
      getTask: async (id) => ({ id, title: `title-${id}` }),
      readSelectedId: () => selectedId(),
      readSelectedTask: () => selectedTask(),
      commitSelection: (task, id, generation) => {
        commits.push(id);
        committedGeneration = generation;
        batch(() => {
          setSelectedTask(task);
          setSelectedId(id);
        });
      },
      restoreSelection: (previousId, previousTask) => {
        restored.push(previousId);
        batch(() => {
          setSelectedTask(previousTask);
          setSelectedId(previousId);
        });
      },
      isDetailRendered: (taskId) => rendered()?.taskId === taskId,
      subscribeToDetailConfirmation: (listener) =>
        createRoot((disposeRoot) => {
          createEffect(() => {
            const current = rendered();
            listener(current ?? { taskId: null, generation: committedGeneration });
          });
          return disposeRoot;
        }),
      readAccountId: () => 'account-a',
      notifyError: () => {},
    });

    await expect(navigator.navigateToTask('a')).resolves.toBe(true);
    expect(commits).toEqual(['a']);
    expect(selectedId()).toBe('a');
    expect(rendered()).toEqual({ taskId: 'a', generation: 1 });

    // A second task rolls the first one back only when it owns the view.
    await expect(navigator.navigateToTask('b')).resolves.toBe(true);
    expect(commits).toEqual(['a', 'b']);
    expect(restored).toEqual([]);
    expect(selectedId()).toBe('b');

    navigator.dispose();
    disposeRenderEffect();
  });
});
