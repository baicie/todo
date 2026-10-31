import { cleanup, render } from '@solidjs/testing-library';
import { Show, batch, createEffect, createRoot, createSignal, untrack } from 'solid-js';
import { afterEach, describe, expect, it } from 'vitest';
import type { TaskList, TaskWithSteps } from '@todo/domain';
import { DetailPanel } from '../components/DetailPanel';
import {
  createTaskNavigator,
  type DetailRenderReport,
  type TaskNavigator,
} from './task-navigation';

function makeTask(id: string, overrides: Partial<TaskWithSteps> = {}): TaskWithSteps {
  return {
    id,
    listId: null,
    title: `标题 ${id}`,
    note: '',
    tags: [],
    status: 'open',
    important: false,
    dueOn: null,
    remindAt: null,
    remindTimezone: null,
    rank: 'a0',
    seriesId: null,
    occurrenceKey: null,
    recurrence: null,
    completedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    deletedAt: null,
    steps: [],
    dayPlanDates: [],
    ...overrides,
  };
}

const panelProps = {
  lists: [] as TaskList[],
  today: '2026-01-05',
  timeZone: 'Asia/Shanghai',
  onToggle: () => {},
  onPatch: async () => {},
  onDelete: () => {},
  onAddStep: async () => {},
  onPatchStep: async () => {},
  onDeleteStep: async () => {},
  onPlan: async () => {},
  onReorder: async () => {},
};

/** Flushes pending microtasks only; no sleeps, no timers. */
async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

const disposers: Array<() => void> = [];

/**
 * A miniature of the App wiring: the same signals, the same navigator factory
 * and the real DetailPanel as the confirming party. Only the platform is mocked.
 */
function mountWiring(options: { getTask: (taskId: string) => Promise<TaskWithSteps | null> }) {
  const [selectedId, setSelectedId] = createSignal<string | null>(null);
  const [selectedTask, setSelectedTask] = createSignal<TaskWithSteps | null>(null);
  const [generation, setGeneration] = createSignal(0);
  // Written by the detail component's own report and by nothing else.
  const [renderedDetail, setRenderedDetail] = createSignal<DetailRenderReport | null>(null);
  /** Fault injection: what the panel is handed when it diverges from App state. */
  const [panelOverride, setPanelOverride] = createSignal<TaskWithSteps | null>(null);
  const loads: string[] = [];

  const shownTask = () => panelOverride() ?? selectedTask();
  const close = () =>
    batch(() => {
      setSelectedId(null);
      setSelectedTask(null);
    });

  const navigator: TaskNavigator = createTaskNavigator<TaskWithSteps>({
    getTask: (taskId) => {
      loads.push(taskId);
      return options.getTask(taskId);
    },
    readSelectedId: () => selectedId(),
    readSelectedTask: () => selectedTask(),
    commitSelection: (task, id, committedGeneration) =>
      batch(() => {
        setGeneration(committedGeneration);
        setSelectedTask(task);
        setSelectedId(id);
      }),
    restoreSelection: (previousId, previousTask) =>
      batch(() => {
        setGeneration(0);
        setSelectedTask(previousTask);
        setSelectedId(previousId);
      }),
    isDetailRendered: (taskId) => renderedDetail()?.taskId === taskId,
    subscribeToDetailConfirmation: (listener) =>
      createRoot((disposeRoot) => {
        createEffect(() => {
          const current = renderedDetail();
          listener(current ?? { taskId: null, generation: untrack(generation) });
        });
        return disposeRoot;
      }),
    readAccountId: () => 'account-a',
    notifyError: () => {},
  });
  disposers.push(() => navigator.dispose());

  const view = render(() => (
    <Show when={shownTask()}>
      {(task) => (
        <DetailPanel
          {...panelProps}
          task={task()}
          navigationGeneration={generation()}
          onRenderedDetail={setRenderedDetail}
          onClose={close}
        />
      )}
    </Show>
  ));

  return {
    navigator,
    view,
    loads,
    close,
    selectedId,
    renderedDetail,
    setPanelOverride,
  };
}

const DETAIL_ASIDE = { role: 'complementary' as const, name: '任务详情' };

describe('detail panel to navigator confirmation', () => {
  afterEach(() => {
    while (disposers.length) disposers.pop()?.();
    cleanup();
  });

  it('confirms a navigation only after the panel committed the task', async () => {
    const load = deferred<TaskWithSteps | null>();
    const wiring = mountWiring({ getTask: () => load.promise });

    const opened = wiring.navigator.navigateToTask('a');
    let settled = false;
    void opened.then(() => {
      settled = true;
    });
    await flush();
    // Nothing has rendered yet, so nothing may be acknowledged.
    expect(settled).toBe(false);
    expect(wiring.renderedDetail()).toBeNull();

    load.resolve(makeTask('a'));

    await expect(opened).resolves.toBe(true);
    expect(wiring.renderedDetail()).toEqual({ taskId: 'a', generation: 1 });
    expect(wiring.view.getByRole('textbox', { name: '任务标题' })).toHaveValue('标题 a');
  });

  it('refuses to confirm when the panel renders a task the App never committed', async () => {
    const wiring = mountWiring({ getTask: async (taskId) => makeTask(taskId) });
    // App state and the panel disagree: the panel keeps rendering "b".
    wiring.setPanelOverride(makeTask('b'));

    await expect(wiring.navigator.navigateToTask('a')).resolves.toBe(false);

    expect(wiring.renderedDetail()?.taskId).toBe('b');
    expect(wiring.selectedId()).toBeNull();
    expect(wiring.view.getByRole('textbox', { name: '任务标题' })).toHaveValue('标题 b');
  });

  it('reports nothing once the panel is closed and confirms a reopen from scratch', async () => {
    const wiring = mountWiring({ getTask: async (taskId) => makeTask(taskId) });
    await expect(wiring.navigator.navigateToTask('a')).resolves.toBe(true);
    expect(wiring.view.getByRole(DETAIL_ASIDE.role, { name: DETAIL_ASIDE.name })).toBeTruthy();

    wiring.close();

    expect(wiring.renderedDetail()).toBeNull();
    expect(wiring.view.queryByRole(DETAIL_ASIDE.role, { name: DETAIL_ASIDE.name })).toBeNull();

    // A closed panel cannot ACK the same task: the navigator must commit again.
    await expect(wiring.navigator.navigateToTask('a')).resolves.toBe(true);
    expect(wiring.loads).toEqual(['a', 'a']);
    expect(wiring.renderedDetail()).toEqual({ taskId: 'a', generation: 2 });
  });
});
