import { For, Show, createMemo } from 'solid-js';
import { CheckCircle2, Clock3, Inbox, ListTodo } from 'lucide-solid';
import type { TaskList, TaskWithSteps } from '@todo/domain';
import { Modal } from './Modal';

interface WeeklyReviewDialogProps {
  open: boolean;
  tasks: TaskWithSteps[];
  lists: TaskList[];
  today: string;
  onClose: () => void;
}

function daysAgo(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() - days);
  return value.toISOString().slice(0, 10);
}

export function WeeklyReviewDialog(props: WeeklyReviewDialogProps) {
  const since = createMemo(() => daysAgo(props.today, 7));
  const completed = createMemo(() => {
    const start = `${since()}T00:00:00.000Z`;
    return props.tasks.filter(
      (task) => task.status === 'completed' && task.completedAt && task.completedAt >= start,
    );
  });
  const overdue = createMemo(() =>
    props.tasks.filter((task) => task.status === 'open' && task.dueOn && task.dueOn < props.today),
  );
  const noDate = createMemo(() =>
    props.tasks.filter((task) => task.status === 'open' && !task.dueOn),
  );
  const byList = createMemo(() => {
    const map = new Map<string, number>();
    for (const task of completed()) {
      const key = task.listId ?? '';
      map.set(key, (map.get(key) ?? 0) + 1);
    }
    return [...map.entries()]
      .map(([id, count]) => ({
        name: id ? (props.lists.find((list) => list.id === id)?.name ?? '清单') : '收件箱',
        count,
      }))
      .sort((a, b) => b.count - a.count);
  });
  const nextWeek = createMemo(() => {
    const end = daysAgo(props.today, -7);
    return props.tasks
      .filter(
        (task) =>
          task.status === 'open' && task.dueOn && task.dueOn >= props.today && task.dueOn <= end,
      )
      .sort((a, b) => (a.dueOn ?? '').localeCompare(b.dueOn ?? ''));
  });

  return (
    <Modal
      open={props.open}
      onClose={props.onClose}
      title="每周回顾"
      description={`${since()} 至 ${props.today}`}
      size="md"
      class="weekly-review"
    >
      <div class="review-stats">
        <div>
          <CheckCircle2 size={17} />
          <strong>{completed().length}</strong>
          <span>本周完成</span>
        </div>
        <div>
          <Clock3 size={17} />
          <strong>{overdue().length}</strong>
          <span>已逾期</span>
        </div>
        <div>
          <Inbox size={17} />
          <strong>{noDate().length}</strong>
          <span>无日期</span>
        </div>
      </div>

      <section class="review-section">
        <h3>完成分布</h3>
        <Show when={byList().length > 0} fallback={<p>本周还没有完成记录。</p>}>
          <For each={byList()}>
            {(item) => (
              <div class="review-bar">
                <span>{item.name}</span>
                <span class="review-bar__track">
                  <span style={{ width: `${Math.max(8, item.count * 12)}%` }} />
                </span>
                <strong>{item.count}</strong>
              </div>
            )}
          </For>
        </Show>
      </section>

      <section class="review-section">
        <h3>
          <ListTodo size={15} /> 接下来 7 天
        </h3>
        <Show when={nextWeek().length > 0} fallback={<p>接下来 7 天没有到期任务。</p>}>
          <For each={nextWeek()}>
            {(task) => (
              <div class="review-task">
                <span>{task.title}</span>
                <time>{task.dueOn}</time>
              </div>
            )}
          </For>
        </Show>
      </section>
    </Modal>
  );
}
