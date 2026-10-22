import { For, Show, createMemo } from 'solid-js';
import {
  CalendarDays,
  Check,
  ChevronRight,
  Circle,
  Clock3,
  ListChecks,
  Star,
  Sun,
} from 'lucide-solid';
import { formatDueDate, formatReminderTime, type TaskList, type TaskWithSteps } from '@todo/domain';

interface TaskRowProps {
  task: TaskWithSteps;
  today: string;
  lists: TaskList[];
  selected?: boolean;
  showList?: boolean;
  suggestion?: boolean;
  onSelect: () => void;
  onToggle: () => void;
  onStar: () => void;
  onPlan?: () => void;
  onUnplan?: () => void;
}

export function TaskRow(props: TaskRowProps) {
  const due = createMemo(() => formatDueDate(props.task.dueOn, props.today));
  const list = createMemo(() =>
    props.task.listId ? props.lists.find((item) => item.id === props.task.listId) : null,
  );
  const completedSteps = createMemo(
    () => props.task.steps.filter((step) => step.isCompleted).length,
  );
  const isCompleted = () => props.task.status === 'completed';

  return (
    <div
      class="task-row"
      classList={{
        'task-row--completed': isCompleted(),
        'task-row--selected': props.selected,
        'task-row--suggestion': props.suggestion,
      }}
    >
      <button
        type="button"
        class="task-check"
        classList={{ 'task-check--done': isCompleted() }}
        aria-label={isCompleted() ? '标记为未完成' : '标记为完成'}
        onClick={props.onToggle}
      >
        <Check size={13} stroke-width={3} />
      </button>

      <button
        type="button"
        class="task-row__body"
        onClick={props.onSelect}
        onKeyDown={(event) => {
          if (event.key === ' ') {
            event.preventDefault();
            props.onToggle();
          }
        }}
      >
        <span class="sr-only">{isCompleted() ? '已完成' : '未完成'}，打开详情</span>
        <span class="task-row__title-line">
          <span class="task-row__title">{props.task.title}</span>
          <Show when={props.task.important}>
            <Star size={13} class="task-row__important" fill="currentColor" />
          </Show>
        </span>
        <Show
          when={
            due() ||
            props.task.remindAt ||
            props.task.steps.length > 0 ||
            (props.showList && list())
          }
        >
          <span class="task-row__meta">
            <Show when={due()}>
              <span class={`meta-chip meta-chip--${due()!.tone}`}>
                <CalendarDays size={12} />
                {due()!.label}
              </span>
            </Show>
            <Show when={props.task.remindAt}>
              <span class="meta-chip">
                <Clock3 size={12} />
                {formatReminderTime(
                  props.task.remindAt!,
                  props.task.remindTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
                )}
              </span>
            </Show>
            <Show when={props.task.steps.length > 0}>
              <span class="meta-chip meta-chip--steps">
                <ListChecks size={12} />
                {completedSteps()}/{props.task.steps.length}
              </span>
            </Show>
            <Show when={props.showList && list()}>
              <span class="meta-chip meta-chip--list">
                <span
                  class="list-dot list-dot--tiny"
                  style={{ '--list-color': list()!.color ?? 'var(--text-tertiary)' }}
                />
                {list()!.name}
              </span>
            </Show>
          </span>
        </Show>
        <Show when={(props.task.tags ?? []).length > 0}>
          <span class="task-row__tags">
            <For each={(props.task.tags ?? []).slice(0, 4)}>
              {(tag) => <span class="tag-chip">#{tag}</span>}
            </For>
            <Show when={(props.task.tags ?? []).length > 4}>
              <span class="tag-chip tag-chip--muted">+{(props.task.tags ?? []).length - 4}</span>
            </Show>
          </span>
        </Show>
      </button>

      <div class="task-row__actions">
        <Show when={props.suggestion}>
          <button
            type="button"
            class="task-row__suggestion-action"
            aria-label="加入我的一天"
            title="加入我的一天"
            onClick={(event) => {
              event.stopPropagation();
              props.onPlan?.();
            }}
          >
            <Sun size={16} />
            <span>加入</span>
          </button>
        </Show>
        <Show when={!props.suggestion}>
          <Show when={props.onUnplan && props.task.dayPlanDates.includes(props.today)}>
            <button
              type="button"
              class="icon-button icon-button--small task-row__hover-action"
              aria-label="从我的一天移除"
              title="从我的一天移除"
              onClick={(event) => {
                event.stopPropagation();
                props.onUnplan?.();
              }}
            >
              <Sun size={15} />
            </button>
          </Show>
          <button
            type="button"
            class="icon-button icon-button--small task-row__star"
            classList={{ 'task-row__star--on': props.task.important }}
            aria-label={props.task.important ? '取消重要' : '标记重要'}
            title={props.task.important ? '取消重要' : '标记重要'}
            onClick={(event) => {
              event.stopPropagation();
              props.onStar();
            }}
          >
            <Star size={16} fill={props.task.important ? 'currentColor' : 'none'} />
          </button>
          <ChevronRight size={15} class="task-row__chevron" aria-hidden="true" />
        </Show>
      </div>
    </div>
  );
}

export function SuggestionRow(props: {
  task: TaskWithSteps;
  today: string;
  lists: TaskList[];
  onPlan: () => void;
  onSelect: () => void;
}) {
  return (
    <TaskRow
      task={props.task}
      today={props.today}
      lists={props.lists}
      showList
      suggestion
      onSelect={props.onSelect}
      onToggle={() => {}}
      onStar={() => {}}
      onPlan={props.onPlan}
    />
  );
}
