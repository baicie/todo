import { For, Show, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import {
  CalendarCheck2,
  CalendarDays,
  CheckCircle2,
  Inbox,
  ListTodo,
  Sparkles,
  Star,
  Sun,
} from 'lucide-solid';
import { dueBucket, type TaskList, type TaskWithSteps } from '@todo/domain';
import type { AppView } from '../types';
import { SMART_TITLES } from '../types';
import { SuggestionRow, TaskRow } from './TaskRow';

interface TaskListProps {
  view: AppView;
  tasks: TaskWithSteps[];
  suggestions: TaskWithSteps[];
  lists: TaskList[];
  today: string;
  selectedId: string | null;
  onSelect: (task: TaskWithSteps) => void;
  onToggle: (task: TaskWithSteps) => void;
  onStar: (task: TaskWithSteps) => void;
  onPlan: (task: TaskWithSteps) => void;
  onUnplan: (task: TaskWithSteps) => void;
}

type FlatItem =
  | { kind: 'task'; task: TaskWithSteps }
  | { kind: 'group'; id: string; title: string; count: number };

function EmptyState(props: { view: AppView; listName?: string; listColor?: string }) {
  const icon = () => {
    if (props.view.kind === 'list') return Inbox;
    if (props.view.id === 'my-day') return Sun;
    if (props.view.id === 'important') return Star;
    if (props.view.id === 'planned') return CalendarDays;
    if (props.view.id === 'completed') return CheckCircle2;
    return ListTodo;
  };
  const title = () => {
    if (props.view.kind === 'list') return '这个清单还是空的';
    if (props.view.id === 'my-day') return '今天，从一件小事开始';
    if (props.view.id === 'important') return '没有标记为重要的任务';
    if (props.view.id === 'planned') return '还没有安排日期的任务';
    if (props.view.id === 'completed') return '完成的任务会出现在这里';
    return '收件箱已清空';
  };
  const description = () => {
    if (props.view.kind === 'list') return '在上面的输入框写下第一件事，按 Enter 保存。';
    if (props.view.id === 'my-day') return '从下方建议中挑选，或添加一件今天真正想完成的事。';
    if (props.view.id === 'important') return '点击任务右侧的星标，把真正重要的事留在这里。';
    if (props.view.id === 'planned') return '为任务设置截止日期，它就会自动进入计划视图。';
    if (props.view.id === 'completed') return '每一次勾选，都是把一件小事真正放下。';
    return '暂时没有待办。给自己留一点空白也很好。';
  };
  return (
    <div class="empty-state">
      <div class="empty-state__art" aria-hidden="true">
        <span class="empty-state__halo" />
        <span class="empty-state__card empty-state__card--back" />
        <span class="empty-state__card empty-state__card--front">
          <span class="empty-state__line empty-state__line--wide" />
          <span class="empty-state__line" />
          <span class="empty-state__line empty-state__line--short" />
          <span class="empty-state__check" style={{ color: props.listColor }}>
            <CheckCircle2 size={28} />
          </span>
        </span>
      </div>
      <h2>{title()}</h2>
      <p>{description()}</p>
    </div>
  );
}

export function TaskList(props: TaskListProps) {
  const isMyDay = () => props.view.kind === 'smart' && props.view.id === 'my-day';
  const isPlanned = () => props.view.kind === 'smart' && props.view.id === 'planned';
  const showLists = () =>
    props.view.kind === 'smart' &&
    (props.view.id === 'important' ||
      props.view.id === 'planned' ||
      props.view.id === 'all' ||
      props.view.id === 'completed');

  const groups = createMemo(() => {
    if (!isPlanned()) return [];
    const buckets: Array<{
      id: 'overdue' | 'today' | 'upcoming';
      title: string;
      tasks: TaskWithSteps[];
    }> = [
      { id: 'overdue', title: '已逾期', tasks: [] },
      { id: 'today', title: '今天', tasks: [] },
      { id: 'upcoming', title: '接下来', tasks: [] },
    ];
    for (const task of props.tasks) {
      const bucket = dueBucket(task, props.today);
      const target = buckets.find((item) => item.id === bucket);
      target?.tasks.push(task);
    }
    return buckets.filter((bucket) => bucket.tasks.length > 0);
  });

  const flatItems = createMemo<FlatItem[]>(() => {
    if (!isPlanned()) {
      return props.tasks.map((task) => ({ kind: 'task' as const, task }));
    }
    return groups().flatMap((group) => [
      {
        kind: 'group' as const,
        id: group.id,
        title: group.title,
        count: group.tasks.length,
      },
      ...group.tasks.map((task) => ({ kind: 'task' as const, task })),
    ]);
  });

  const [scrollTop, setScrollTop] = createSignal(0);
  const [viewportHeight, setViewportHeight] = createSignal(700);
  let scrollRef: HTMLDivElement | undefined;

  const VIRTUAL_ROW_HEIGHT = 58;
  const VIRTUAL_GROUP_HEIGHT = 40;
  const OVERSCAN = 6;

  const offsets = createMemo(() => {
    let position = 0;
    return flatItems().map((item) => {
      const start = position;
      position += item.kind === 'group' ? VIRTUAL_GROUP_HEIGHT : VIRTUAL_ROW_HEIGHT;
      return start;
    });
  });

  const totalHeight = createMemo(() => {
    let total = 0;
    for (const item of flatItems()) {
      total += item.kind === 'group' ? VIRTUAL_GROUP_HEIGHT : VIRTUAL_ROW_HEIGHT;
    }
    return total;
  });

  const visibleItems = createMemo(() => {
    const items = flatItems();
    const positions = offsets();
    const height = totalHeight();
    if (items.length === 0 || height === 0) return [];
    const start = Math.max(0, Math.floor((scrollTop() / height) * items.length) - OVERSCAN);
    const end = Math.min(
      items.length,
      Math.ceil(((scrollTop() + viewportHeight()) / height) * items.length) + OVERSCAN,
    );
    return items.slice(start, end).map((item, index) => ({
      item,
      index: start + index,
      top: positions[start + index] ?? 0,
    }));
  });

  onMount(() => {
    if (!scrollRef) return;
    const update = () => setViewportHeight(scrollRef?.clientHeight ?? 700);
    update();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(scrollRef);
    window.addEventListener('resize', update);
    onCleanup(() => {
      observer?.disconnect();
      window.removeEventListener('resize', update);
    });
  });

  const groupHeader = (item: Extract<FlatItem, { kind: 'group' }>, virtual = false) => (
    <div
      class="task-group__header task-group__header--inline"
      classList={{ 'task-group__header--virtual': virtual }}
    >
      <span
        class="task-group__dot"
        classList={{
          'task-group__dot--danger': item.id === 'overdue',
          'task-group__dot--today': item.id === 'today',
        }}
      />
      <h2>{item.title}</h2>
      <span>{item.count}</span>
    </div>
  );

  const row = (task: TaskWithSteps) => (
    <TaskRow
      task={task}
      today={props.today}
      lists={props.lists}
      selected={props.selectedId === task.id}
      showList={showLists()}
      onSelect={() => props.onSelect(task)}
      onToggle={() => props.onToggle(task)}
      onStar={() => props.onStar(task)}
      onPlan={() => props.onPlan(task)}
      onUnplan={() => props.onUnplan(task)}
    />
  );

  const title = () =>
    props.view.kind === 'smart'
      ? SMART_TITLES[props.view.id]
      : (props.lists.find((list) => list.id === props.view.id)?.name ?? '清单');

  return (
    <div class="task-list">
      <Show when={props.tasks.length > 0}>
        <div class="task-list__summary">
          <span>
            {props.tasks.length} 项
            {props.view.kind === 'smart' && props.view.id === 'completed' ? '已完成' : '待办'}
          </span>
          <span class="task-list__summary-hint">
            {flatItems().length > 300 ? '已开启虚拟滚动 · 点击任务打开详情' : '点击任务打开详情'}
          </span>
        </div>
      </Show>

      <Show when={props.tasks.length === 0}>
        <EmptyState
          view={props.view}
          listName={title()}
          listColor={
            props.view.kind === 'list'
              ? (props.lists.find((list) => list.id === props.view.id)?.color ?? undefined)
              : undefined
          }
        />
      </Show>

      <Show when={props.tasks.length > 0}>
        <Show
          when={flatItems().length > 300}
          fallback={
            <div class="task-list__rows">
              <For each={flatItems()}>
                {(item) => (item.kind === 'group' ? groupHeader(item) : row(item.task))}
              </For>
            </div>
          }
        >
          <div
            class="task-list__virtual-scroll"
            ref={(element) => {
              scrollRef = element;
              setViewportHeight(element.clientHeight);
            }}
            onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
          >
            <div
              class="task-list__rows task-list__rows--virtual"
              style={{ height: `${totalHeight()}px` }}
            >
              <For each={visibleItems()}>
                {(virtualItem) => (
                  <div
                    class="task-list__virtual-item"
                    style={{ transform: `translateY(${virtualItem.top}px)` }}
                  >
                    <Show when={virtualItem.item.kind === 'group'}>
                      {groupHeader(virtualItem.item as Extract<FlatItem, { kind: 'group' }>, true)}
                    </Show>
                    <Show when={virtualItem.item.kind === 'task'}>
                      {row((virtualItem.item as Extract<FlatItem, { kind: 'task' }>).task)}
                    </Show>
                  </div>
                )}
              </For>
            </div>
          </div>
        </Show>
      </Show>

      <Show when={isMyDay() && props.suggestions.length > 0}>
        <section class="suggestions" aria-labelledby="suggestions-title">
          <div class="suggestions__header">
            <div class="suggestions__title">
              <span class="suggestions__icon">
                <Sparkles size={15} />
              </span>
              <div>
                <h2 id="suggestions-title">今天还可以做</h2>
                <p>从其他清单里挑选，不会改变任务原来的归属。</p>
              </div>
            </div>
          </div>
          <div class="suggestions__list">
            <For each={props.suggestions}>
              {(task) => (
                <SuggestionRow
                  task={task}
                  today={props.today}
                  lists={props.lists}
                  onPlan={() => props.onPlan(task)}
                  onSelect={() => props.onSelect(task)}
                />
              )}
            </For>
          </div>
        </section>
      </Show>

      <Show
        when={
          props.tasks.length > 0 && props.view.kind === 'smart' && props.view.id === 'completed'
        }
      >
        <div class="completed-note">
          <CalendarCheck2 size={15} />
          完成记录保存在本机，可随时导出。
        </div>
      </Show>
    </div>
  );
}
