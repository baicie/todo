import { For, Show, createMemo, createSignal } from 'solid-js';
import { ChevronLeft, ChevronRight, CalendarDays } from 'lucide-solid';
import type { TaskWithSteps } from '@todo/domain';

interface CalendarViewProps {
  tasks: TaskWithSteps[];
  today: string;
  onSelect: (task: TaskWithSteps) => void;
}

function monthFromDate(date: string): { year: number; month: number } {
  const parsed = new Date(`${date}T00:00:00Z`);
  return { year: parsed.getUTCFullYear(), month: parsed.getUTCMonth() };
}

function dateKey(year: number, month: number, day: number): string {
  return `${year}-${(month + 1).toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
}

export function CalendarView(props: CalendarViewProps) {
  const initial = monthFromDate(props.today);
  const [year, setYear] = createSignal(initial.year);
  const [month, setMonth] = createSignal(initial.month);

  const days = createMemo(() => {
    const first = new Date(Date.UTC(year(), month(), 1));
    const mondayOffset = (first.getUTCDay() + 6) % 7;
    const count = new Date(Date.UTC(year(), month() + 1, 0)).getUTCDate();
    const cells: Array<{ day: number; date: string } | null> = Array.from(
      { length: mondayOffset },
      () => null,
    );
    for (let day = 1; day <= count; day += 1) {
      cells.push({ day, date: dateKey(year(), month(), day) });
    }
    while (cells.length % 7 !== 0) cells.push(null);
    return cells;
  });

  const byDate = createMemo(() => {
    const map = new Map<string, TaskWithSteps[]>();
    for (const task of props.tasks) {
      if (!task.dueOn) continue;
      const list = map.get(task.dueOn) ?? [];
      list.push(task);
      map.set(task.dueOn, list);
    }
    return map;
  });

  const move = (delta: number) => {
    const next = new Date(Date.UTC(year(), month() + delta, 1));
    setYear(next.getUTCFullYear());
    setMonth(next.getUTCMonth());
  };

  const goToday = () => {
    const current = monthFromDate(props.today);
    setYear(current.year);
    setMonth(current.month);
  };

  const monthLabel = () =>
    new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long' }).format(
      new Date(Date.UTC(year(), month(), 1)),
    );

  return (
    <section class="calendar-view" aria-label="任务日历">
      <div class="calendar-view__header">
        <div>
          <h2>{monthLabel()}</h2>
          <p>按截止日期查看任务；点击任务打开详情。</p>
        </div>
        <div class="calendar-view__nav">
          <button type="button" class="icon-button" aria-label="上个月" onClick={() => move(-1)}>
            <ChevronLeft size={17} />
          </button>
          <button type="button" class="secondary-button" onClick={goToday}>
            今天
          </button>
          <button type="button" class="icon-button" aria-label="下个月" onClick={() => move(1)}>
            <ChevronRight size={17} />
          </button>
        </div>
      </div>

      <div class="calendar-weekdays" aria-hidden="true">
        <For each={['一', '二', '三', '四', '五', '六', '日']}>{(day) => <span>{day}</span>}</For>
      </div>
      <div class="calendar-grid">
        <For each={days()}>
          {(cell) => (
            <Show
              when={cell}
              fallback={<div class="calendar-cell calendar-cell--blank" aria-hidden="true" />}
            >
              {(current) => {
                const tasks = () => byDate().get(current().date) ?? [];
                return (
                  <div
                    class="calendar-cell"
                    classList={{ 'calendar-cell--today': current().date === props.today }}
                  >
                    <span class="calendar-cell__day">{current().day}</span>
                    <div class="calendar-cell__tasks">
                      <For each={tasks().slice(0, 3)}>
                        {(task) => (
                          <button
                            type="button"
                            class="calendar-task"
                            classList={{ 'calendar-task--done': task.status === 'completed' }}
                            onClick={() => props.onSelect(task)}
                            title={task.title}
                          >
                            {task.status === 'completed' ? '✓ ' : ''}
                            {task.title}
                          </button>
                        )}
                      </For>
                      <Show when={tasks().length > 3}>
                        <span class="calendar-more">+{tasks().length - 3}</span>
                      </Show>
                    </div>
                  </div>
                );
              }}
            </Show>
          )}
        </For>
      </div>
      <Show when={props.tasks.length === 0}>
        <p class="calendar-empty">
          <CalendarDays size={15} /> 本月没有带截止日期的任务
        </p>
      </Show>
    </section>
  );
}
