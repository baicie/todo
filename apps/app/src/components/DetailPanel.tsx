import { For, Show, createEffect, createSignal, on, onCleanup, onMount } from 'solid-js';
import {
  ArrowDown,
  ArrowUp,
  Bookmark,
  CalendarDays,
  Check,
  Clock3,
  Folder,
  ListChecks,
  Plus,
  Repeat2,
  Star,
  Sun,
  Tag,
  Trash2,
  X,
} from 'lucide-solid';
import {
  describeRecurrence,
  formatDateLong,
  formatReminderTime,
  instantToLocalInput,
  isDateOnly,
  normalizeTags,
  todayInTimeZone,
  weekdayIso,
  zonedDateTimeToUtc,
  type Recurrence,
  type Step,
  type StepPatch,
  type TaskList,
  type TaskPatch,
  type TaskWithSteps,
} from '@todo/domain';
import type { DetailRenderReport } from '../lib/task-navigation';

interface DetailPanelProps {
  task: TaskWithSteps;
  lists: TaskList[];
  today: string;
  timeZone: string;
  onClose: () => void;
  onToggle: () => void;
  onPatch: (patch: TaskPatch) => Promise<void>;
  onSaveTemplate?: (task: TaskWithSteps) => void;
  onDelete: () => void;
  onAddStep: (title: string) => Promise<void>;
  onPatchStep: (id: string, patch: StepPatch) => Promise<void>;
  onDeleteStep: (id: string) => Promise<void>;
  onPlan: (planned: boolean) => Promise<void>;
  onReorder: (direction: 'up' | 'down') => Promise<void>;
  /** Generation of the navigator commit that owns this selection; 0 when none. */
  navigationGeneration?: number;
  /** Reports what this panel committed to its rendered output; null once it is torn down. */
  onRenderedDetail?: (report: DetailRenderReport | null) => void;
}

export function DetailPanel(props: DetailPanelProps) {
  const [title, setTitle] = createSignal(props.task.title);
  const [note, setNote] = createSignal(props.task.note);
  const [stepTitle, setStepTitle] = createSignal('');
  const [savingStep, setSavingStep] = createSignal(false);
  let titleRef: HTMLTextAreaElement | undefined;
  let noteRef: HTMLTextAreaElement | undefined;
  let noteTimer: ReturnType<typeof setTimeout> | undefined;
  let lastSavedNote = props.task.note;

  const resize = (element?: HTMLTextAreaElement) => {
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${element.scrollHeight}px`;
  };

  /**
   * Confirmation contract: the detail component is the only party that may
   * confirm a notification navigation. It reports from its own lifecycle and
   * always reports its own `props.task.id`, so an App-side selection change can
   * never stand in for a rendered task.
   *
   * "Rendered" means this component committed the task into its output. Whether
   * that output is visible is a separate question: occlusion by a modal, a
   * backdrop or the mobile layout is explicitly out of scope for the ACK and is
   * covered by the Playwright visibility assertion instead. No selector, no
   * timer and no polling live here.
   */
  let detached = false;
  const reportRender = (report: DetailRenderReport | null) => {
    // A torn-down panel may still have a queued effect or microtask behind it;
    // the null report is the last thing it is allowed to emit.
    if (detached && report) return;
    props.onRenderedDetail?.(report);
  };
  const renderedReport = (): DetailRenderReport => ({
    taskId: props.task.id,
    generation: props.navigationGeneration ?? 0,
  });

  onMount(() => reportRender(renderedReport()));

  createEffect(
    on(
      () => [props.task.id, props.navigationGeneration] as const,
      () => reportRender(renderedReport()),
      { defer: true },
    ),
  );

  onCleanup(() => {
    detached = true;
    reportRender(null);
  });

  createEffect(
    on(
      () => props.task.id,
      () => {
        setTitle(props.task.title);
        setNote(props.task.note);
        lastSavedNote = props.task.note;
        queueMicrotask(() => resize(titleRef));
      },
    ),
  );

  createEffect(
    on(
      () => props.task.updatedAt,
      () => {
        if (document.activeElement !== titleRef) {
          setTitle(props.task.title);
          queueMicrotask(() => resize(titleRef));
        }
        if (document.activeElement !== noteRef) {
          setNote(props.task.note);
          lastSavedNote = props.task.note;
        }
      },
    ),
  );

  onMount(() => queueMicrotask(() => resize(titleRef)));

  const commitTitle = async () => {
    const cleaned = title().replace(/\s+/g, ' ').trim();
    if (!cleaned) {
      setTitle(props.task.title);
      return;
    }
    if (cleaned !== props.task.title) await props.onPatch({ title: cleaned });
  };

  const saveNote = async () => {
    if (note() === lastSavedNote) return;
    lastSavedNote = note();
    await props.onPatch({ note: note() });
  };

  const updateNote = (value: string) => {
    setNote(value);
    if (noteTimer) clearTimeout(noteTimer);
    noteTimer = setTimeout(() => void saveNote(), 700);
  };

  onCleanup(() => {
    if (noteTimer) clearTimeout(noteTimer);
  });

  const submitStep = async (event: SubmitEvent) => {
    event.preventDefault();
    const value = stepTitle().trim();
    if (!value || savingStep()) return;
    setSavingStep(true);
    try {
      await props.onAddStep(value);
      setStepTitle('');
    } finally {
      setSavingStep(false);
    }
  };

  const dueValue = () => props.task.dueOn ?? '';
  const reminderValue = () =>
    instantToLocalInput(props.task.remindAt, props.task.remindTimezone ?? props.timeZone);

  const changeDue = async (value: string) => {
    if (!value) {
      await props.onPatch({ dueOn: null, recurrence: null, remindAt: null });
      return;
    }
    if (!isDateOnly(value)) return;
    await props.onPatch({ dueOn: value });
  };

  const changeReminder = async (value: string) => {
    if (!value) {
      await props.onPatch({ remindAt: null });
      return;
    }
    try {
      const instant = zonedDateTimeToUtc(value, props.timeZone);
      await props.onPatch({ remindAt: instant, remindTimezone: props.timeZone });
    } catch {
      // Invalid partial input is ignored until a complete value exists.
    }
  };

  const changeRecurrence = async (value: string) => {
    if (!value) {
      await props.onPatch({ recurrence: null });
      return;
    }
    let dueOn = props.task.dueOn;
    if (!dueOn) {
      dueOn = props.today;
      await props.onPatch({ dueOn });
    }
    const [year, month, day] = dueOn.split('-').map(Number);
    let recurrence: Recurrence;
    switch (value) {
      case 'daily':
        recurrence = { frequency: 'daily', interval: 1, anchorMode: 'calendar' };
        break;
      case 'weekdays':
        recurrence = { frequency: 'weekdays', interval: 1, anchorMode: 'calendar' };
        break;
      case 'weekly':
        recurrence = {
          frequency: 'weekly',
          interval: 1,
          weekdays: [weekdayIso(dueOn)],
          anchorMode: 'calendar',
        };
        break;
      case 'monthly':
        recurrence = {
          frequency: 'monthly',
          interval: 1,
          monthDay: day,
          anchorMode: 'calendar',
        };
        break;
      default:
        recurrence = {
          frequency: 'yearly',
          interval: 1,
          monthDay: day,
          month,
          anchorMode: 'calendar',
        };
    }
    await props.onPatch({ dueOn, recurrence });
  };

  const recurrenceValue = () => props.task.recurrence?.frequency ?? '';

  const stepDone = (step: Step) => step.isCompleted;
  const totalSteps = () => props.task.steps.length;
  const completedSteps = () => props.task.steps.filter(stepDone).length;
  const isPlannedToday = () => props.task.dayPlanDates.includes(props.today);
  const completedDate = () =>
    props.task.completedAt
      ? new Intl.DateTimeFormat('zh-CN', {
          month: 'long',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          timeZone: props.timeZone,
        }).format(new Date(props.task.completedAt))
      : '';

  return (
    <aside class="detail" aria-label="任务详情">
      <div class="detail__topbar">
        <span class="detail__eyebrow">任务详情</span>
        <div class="detail__top-actions">
          <button
            type="button"
            class="icon-button"
            onClick={() => props.onSaveTemplate?.(props.task)}
            aria-label="保存为模板"
            title="保存为模板"
          >
            <Bookmark size={17} />
          </button>
          <button
            type="button"
            class="icon-button"
            classList={{ 'icon-button--active': props.task.important }}
            onClick={() => void props.onPatch({ important: !props.task.important })}
            aria-label={props.task.important ? '取消重要' : '标记重要'}
            title={props.task.important ? '取消重要' : '标记重要'}
          >
            <Star size={18} fill={props.task.important ? 'currentColor' : 'none'} />
          </button>
          <button
            type="button"
            class="icon-button detail__close"
            onClick={props.onClose}
            aria-label="关闭详情"
          >
            <X size={19} />
          </button>
        </div>
      </div>

      <div class="detail__scroll">
        <div class="detail__main">
          <div class="detail__title-line">
            <button
              type="button"
              class="task-check task-check--large"
              classList={{ 'task-check--done': props.task.status === 'completed' }}
              onClick={props.onToggle}
              aria-label={props.task.status === 'completed' ? '标记为未完成' : '标记为完成'}
            >
              <Check size={15} stroke-width={3} />
            </button>
            <textarea
              ref={titleRef}
              class="detail__title"
              classList={{ 'detail__title--done': props.task.status === 'completed' }}
              value={title()}
              rows={2}
              aria-label="任务标题"
              onInput={(event) => {
                setTitle(event.currentTarget.value);
                resize(event.currentTarget);
              }}
              onBlur={() => void commitTitle()}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  event.currentTarget.blur();
                }
                if (event.key === 'Escape') {
                  setTitle(props.task.title);
                  event.currentTarget.blur();
                }
              }}
            />
          </div>

          <Show when={props.task.status === 'completed'}>
            <div class="completed-banner">
              <Check size={14} />
              已完成于 {completedDate()}
            </div>
          </Show>

          <div class="detail__quick-actions">
            <button
              type="button"
              class="detail-action"
              classList={{ 'detail-action--active': isPlannedToday() }}
              onClick={() => void props.onPlan(!isPlannedToday())}
            >
              <Sun size={16} />
              {isPlannedToday() ? '已在我的一天' : '加入我的一天'}
            </button>
            <Show when={props.task.dueOn}>
              <span class="detail-action detail-action--static">
                <CalendarDays size={16} />
                {formatDateLong(props.task.dueOn!, 'zh-CN', { weekday: undefined })}
              </span>
            </Show>
          </div>

          <section class="detail-section steps-section" aria-labelledby="steps-title">
            <div class="detail-section__heading">
              <h2 id="steps-title">
                <ListChecks size={16} /> 子步骤
              </h2>
              <Show when={totalSteps() > 0}>
                <span class="detail-section__count">
                  {completedSteps()}/{totalSteps()}
                </span>
              </Show>
            </div>
            <Show when={totalSteps() > 0}>
              <div class="steps-progress" aria-hidden="true">
                <span
                  style={{
                    width: `${totalSteps() ? (completedSteps() / totalSteps()) * 100 : 0}%`,
                  }}
                />
              </div>
            </Show>
            <div class="step-list">
              <For each={props.task.steps}>
                {(step) => (
                  <div class="step-row" classList={{ 'step-row--done': step.isCompleted }}>
                    <button
                      type="button"
                      class="step-check"
                      classList={{ 'step-check--done': step.isCompleted }}
                      aria-label={step.isCompleted ? '标记子步骤未完成' : '完成子步骤'}
                      onClick={() =>
                        void props.onPatchStep(step.id, { isCompleted: !step.isCompleted })
                      }
                    >
                      <Check size={10} stroke-width={3} />
                    </button>
                    <input
                      class="step-row__title"
                      value={step.title}
                      aria-label="子步骤标题"
                      onChange={(event) => {
                        const value = event.currentTarget.value.trim();
                        if (value && value !== step.title) {
                          void props.onPatchStep(step.id, { title: value });
                        }
                      }}
                    />
                    <button
                      type="button"
                      class="icon-button icon-button--small step-row__delete"
                      aria-label="删除子步骤"
                      onClick={() => void props.onDeleteStep(step.id)}
                    >
                      <X size={14} />
                    </button>
                  </div>
                )}
              </For>
            </div>
            <form class="step-add" onSubmit={(event) => void submitStep(event)}>
              <Plus size={15} />
              <input
                value={stepTitle()}
                onInput={(event) => setStepTitle(event.currentTarget.value)}
                placeholder="添加子步骤"
                aria-label="添加子步骤"
                maxlength={1000}
              />
              <Show when={stepTitle().trim()}>
                <button type="submit" class="text-button" disabled={savingStep()}>
                  添加
                </button>
              </Show>
            </form>
          </section>

          <section class="detail-section meta-section" aria-labelledby="meta-title">
            <h2 id="meta-title" class="sr-only">
              任务信息
            </h2>
            <div class="meta-field">
              <div class="meta-field__label">
                <CalendarDays size={16} />
                <span>截止日期</span>
              </div>
              <input
                type="date"
                class="meta-input"
                value={dueValue()}
                aria-label="截止日期"
                onChange={(event) => void changeDue(event.currentTarget.value)}
              />
            </div>

            <div class="meta-field meta-field--stacked">
              <div class="meta-field__label">
                <Clock3 size={16} />
                <span>提醒</span>
              </div>
              <div class="meta-field__control">
                <input
                  type="datetime-local"
                  class="meta-input"
                  value={reminderValue()}
                  aria-label="提醒时间"
                  onChange={(event) => void changeReminder(event.currentTarget.value)}
                />
                <Show when={props.task.remindAt}>
                  <span class="meta-field__hint">
                    {formatReminderTime(
                      props.task.remindAt!,
                      props.task.remindTimezone ?? props.timeZone,
                    )}{' '}
                    · 网页端仅在页面打开时提醒
                  </span>
                </Show>
              </div>
            </div>

            <div class="meta-field">
              <div class="meta-field__label">
                <Repeat2 size={16} />
                <span>重复</span>
              </div>
              <select
                class="meta-input"
                value={recurrenceValue()}
                aria-label="重复规则"
                onChange={(event) => void changeRecurrence(event.currentTarget.value)}
              >
                <option value="">不重复</option>
                <option value="daily">每天</option>
                <option value="weekdays">每个工作日</option>
                <option value="weekly">每周</option>
                <option value="monthly">每月</option>
                <option value="yearly">每年</option>
              </select>
            </div>
            <Show when={props.task.recurrence}>
              <p class="recurrence-note">{describeRecurrence(props.task.recurrence)}</p>
            </Show>

            <div class="meta-field">
              <div class="meta-field__label">
                <Folder size={16} />
                <span>清单</span>
              </div>
              <select
                class="meta-input"
                value={props.task.listId ?? ''}
                aria-label="所属清单"
                onChange={(event) =>
                  void props.onPatch({ listId: event.currentTarget.value || null })
                }
              >
                <option value="">收件箱</option>
                <For each={props.lists}>
                  {(list) => <option value={list.id}>{list.name}</option>}
                </For>
              </select>
            </div>

            <div class="meta-field meta-field--stacked">
              <div class="meta-field__label">
                <Tag size={16} />
                <span>标签</span>
              </div>
              <div class="meta-field__control">
                <input
                  class="meta-input"
                  aria-label="标签"
                  placeholder="工作, 本周重点"
                  value={(props.task.tags ?? []).join(', ')}
                  onBlur={(event) => {
                    const tags = normalizeTags(event.currentTarget.value.split(/[,，]/));
                    const current = props.task.tags ?? [];
                    if (JSON.stringify(tags) !== JSON.stringify(current)) {
                      void props.onPatch({ tags });
                    }
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') event.currentTarget.blur();
                  }}
                />
                <span class="meta-field__hint">逗号分隔，最多 20 个</span>
              </div>
            </div>
          </section>

          <section class="detail-section notes-section" aria-labelledby="notes-title">
            <h2 id="notes-title">备注</h2>
            <textarea
              ref={noteRef}
              class="notes-input"
              value={note()}
              rows={4}
              placeholder="补充一点上下文、链接或想法…"
              aria-label="备注"
              onInput={(event) => updateNote(event.currentTarget.value)}
              onBlur={() => {
                if (noteTimer) clearTimeout(noteTimer);
                void saveNote();
              }}
            />
            <div class="notes-footer">
              <span>纯文本保存</span>
              <span>{note().length} 字</span>
            </div>
          </section>
        </div>

        <footer class="detail__footer">
          <div class="detail__footer-left">
            <div class="detail__dates">
              <span>创建于 {formatDateLong(props.task.createdAt.slice(0, 10))}</span>
            </div>
            <div class="detail__reorder" aria-label="调整任务顺序">
              <button
                type="button"
                class="icon-button icon-button--small"
                aria-label="上移任务"
                title="上移任务（Alt + ↑）"
                onClick={() => void props.onReorder('up')}
              >
                <ArrowUp size={14} />
              </button>
              <button
                type="button"
                class="icon-button icon-button--small"
                aria-label="下移任务"
                title="下移任务（Alt + ↓）"
                onClick={() => void props.onReorder('down')}
              >
                <ArrowDown size={14} />
              </button>
            </div>
          </div>
          <button type="button" class="danger-button" onClick={props.onDelete}>
            <Trash2 size={15} />
            删除任务
          </button>
        </footer>
      </div>
    </aside>
  );
}
