import { cleanup, render } from '@solidjs/testing-library';
import { Show, createSignal } from 'solid-js';
import { afterEach, describe, expect, it } from 'vitest';
import type { TaskList, TaskWithSteps } from '@todo/domain';
import type { DetailRenderReport } from '../lib/task-navigation';
import { DetailPanel } from './DetailPanel';

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

const lists: TaskList[] = [];

const callbacks = {
  lists,
  today: '2026-01-05',
  timeZone: 'Asia/Shanghai',
  onClose: () => {},
  onToggle: () => {},
  onPatch: async () => {},
  onDelete: () => {},
  onAddStep: async () => {},
  onPatchStep: async () => {},
  onDeleteStep: async () => {},
  onPlan: async () => {},
  onReorder: async () => {},
};

function collector(): {
  reports: Array<DetailRenderReport | null>;
  onRenderedDetail: (report: DetailRenderReport | null) => void;
} {
  const reports: Array<DetailRenderReport | null> = [];
  return { reports, onRenderedDetail: (report) => reports.push(report) };
}

describe('DetailPanel render confirmation', () => {
  afterEach(() => cleanup());

  it('reports the task it committed after mount', () => {
    const { reports, onRenderedDetail } = collector();
    const { getByRole } = render(() => (
      <DetailPanel
        {...callbacks}
        task={makeTask('a')}
        navigationGeneration={7}
        onRenderedDetail={onRenderedDetail}
      />
    ));

    // The report is about the component's own output, so the output must exist.
    expect(getByRole('textbox', { name: '任务标题' })).toHaveValue('标题 a');
    expect(reports).toEqual([{ taskId: 'a', generation: 7 }]);
  });

  it('reports the rendered task id, not the one the caller expects', () => {
    const { reports, onRenderedDetail } = collector();
    render(() => (
      <DetailPanel
        {...callbacks}
        task={makeTask('b')}
        navigationGeneration={3}
        onRenderedDetail={onRenderedDetail}
      />
    ));

    expect(reports).toEqual([{ taskId: 'b', generation: 3 }]);
    expect(reports.some((report) => report?.taskId === 'a')).toBe(false);
  });

  it('re-reports when the panel is reused for another task', () => {
    const { reports, onRenderedDetail } = collector();
    const [current, setCurrent] = createSignal(makeTask('a'));
    render(() => (
      <DetailPanel
        {...callbacks}
        task={current()}
        navigationGeneration={1}
        onRenderedDetail={onRenderedDetail}
      />
    ));
    expect(reports).toEqual([{ taskId: 'a', generation: 1 }]);

    setCurrent(makeTask('b'));

    expect(reports).toEqual([
      { taskId: 'a', generation: 1 },
      { taskId: 'b', generation: 1 },
    ]);
    // Nothing after the switch may still claim the previous task.
    expect(reports.slice(2)).toEqual([]);
  });

  it('re-reports when only the navigation generation changes', () => {
    const { reports, onRenderedDetail } = collector();
    const [generation, setGeneration] = createSignal(0);
    const task = makeTask('a');
    render(() => (
      <DetailPanel
        {...callbacks}
        task={task}
        navigationGeneration={generation()}
        onRenderedDetail={onRenderedDetail}
      />
    ));
    expect(reports).toEqual([{ taskId: 'a', generation: 0 }]);

    setGeneration(4);

    expect(reports).toEqual([
      { taskId: 'a', generation: 0 },
      { taskId: 'a', generation: 4 },
    ]);
  });

  it('reports null when it unmounts', () => {
    const { reports, onRenderedDetail } = collector();
    const view = render(() => (
      <DetailPanel
        {...callbacks}
        task={makeTask('a')}
        navigationGeneration={2}
        onRenderedDetail={onRenderedDetail}
      />
    ));
    expect(reports).toEqual([{ taskId: 'a', generation: 2 }]);

    view.unmount();

    expect(reports).toEqual([{ taskId: 'a', generation: 2 }, null]);
  });

  it('reports null on unmount and ignores a queued microtask afterwards', async () => {
    const { reports, onRenderedDetail } = collector();
    const [open, setOpen] = createSignal(true);
    const [generation, setGeneration] = createSignal(1);
    render(() => (
      <Show when={open()}>
        <DetailPanel
          {...callbacks}
          task={makeTask('a')}
          navigationGeneration={generation()}
          onRenderedDetail={onRenderedDetail}
        />
      </Show>
    ));
    expect(reports).toEqual([{ taskId: 'a', generation: 1 }]);

    // A microtask queued before the teardown must never confirm after it.
    queueMicrotask(() => setGeneration(2));
    setOpen(false);
    await Promise.resolve();
    await Promise.resolve();

    expect(reports).toEqual([{ taskId: 'a', generation: 1 }, null]);
  });
});
