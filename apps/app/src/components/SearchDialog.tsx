import { For, Show, createEffect, createSignal, onCleanup, onMount } from 'solid-js';
import { CalendarDays, Check, Circle, Search, X } from 'lucide-solid';
import { formatDueDate, type TaskList, type TaskWithSteps } from '@todo/domain';
import type { TaskRepository } from '@todo/application';
import { Modal } from './Modal';

interface SearchDialogProps {
  open: boolean;
  lists: TaskList[];
  today: string;
  repository: TaskRepository;
  onClose: () => void;
  onOpenTask: (task: TaskWithSteps) => void;
}

export function SearchDialog(props: SearchDialogProps) {
  const [query, setQuery] = createSignal('');
  const [results, setResults] = createSignal<TaskWithSteps[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [activeIndex, setActiveIndex] = createSignal(-1);
  let inputRef: HTMLInputElement | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;

  const run = async (value: string) => {
    const current = ++generation;
    if (!value.trim()) {
      setResults([]);
      setActiveIndex(-1);
      setLoading(false);
      return;
    }
    setLoading(true);
    const page = await props.repository.listTasks({
      view: 'all',
      search: value,
      includeCompleted: true,
      limit: 80,
    });
    if (current !== generation) return;
    setResults(page.items);
    setActiveIndex(page.items.length > 0 ? 0 : -1);
    setLoading(false);
  };

  createEffect(() => {
    if (!props.open) return;
    const value = query();
    if (timer) clearTimeout(timer);
    setLoading(Boolean(value.trim()));
    timer = setTimeout(() => void run(value), 60);
    onCleanup(() => {
      if (timer) clearTimeout(timer);
    });
  });

  onMount(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!props.open) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        inputRef?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    onCleanup(() => window.removeEventListener('keydown', onKey));
  });

  const listName = (task: TaskWithSteps) =>
    task.listId ? (props.lists.find((list) => list.id === task.listId)?.name ?? '清单') : '收件箱';

  return (
    <Modal
      open={props.open}
      onClose={props.onClose}
      size="md"
      bare
      class="search-modal"
      ariaLabel="搜索任务"
    >
      <div class="search-box">
        <Search size={19} class="search-box__icon" />
        <input
          ref={inputRef}
          type="search"
          value={query()}
          onInput={(event) => setQuery(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setActiveIndex((index) =>
                results().length ? Math.min(results().length - 1, index + 1) : -1,
              );
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              setActiveIndex((index) => Math.max(0, index - 1));
            } else if (event.key === 'Enter' && activeIndex() >= 0) {
              const task = results()[activeIndex()];
              if (task) {
                event.preventDefault();
                props.onOpenTask(task);
                props.onClose();
              }
            }
          }}
          placeholder="搜索标题或备注…"
          aria-label="搜索任务"
          autofocus
        />
        <Show when={query()}>
          <button
            type="button"
            class="icon-button icon-button--small"
            onClick={() => {
              setQuery('');
              inputRef?.focus();
            }}
            aria-label="清除搜索"
          >
            <X size={15} />
          </button>
        </Show>
        <kbd>Esc</kbd>
      </div>

      <div class="search-results" aria-live="polite">
        <Show when={!query().trim()}>
          <div class="search-empty">
            <div class="search-empty__icon">
              <Search size={24} />
            </div>
            <h3>搜索所有任务</h3>
            <p>输入关键词，在标题与备注中查找。中文单字也可以搜到。</p>
            <div class="search-suggestions">
              <span>试试搜索</span>
              <button type="button" onClick={() => setQuery('工作')}>
                工作
              </button>
              <button type="button" onClick={() => setQuery('今天')}>
                今天
              </button>
            </div>
          </div>
        </Show>
        <Show when={query().trim() && loading()}>
          <div class="search-loading">
            <span class="spinner" /> 正在搜索…
          </div>
        </Show>
        <Show when={query().trim() && !loading() && results().length === 0}>
          <div class="search-empty search-empty--compact">
            <h3>没有找到「{query()}」</h3>
            <p>换一个关键词，或检查任务是否已被删除。</p>
          </div>
        </Show>
        <Show when={results().length > 0}>
          <div class="search-result-count">
            找到 {results().length} 项<Show when={results().length >= 80}>（仅显示前 80 项）</Show>
          </div>
          <ul class="search-result-list">
            <For each={results()}>
              {(task) => {
                const due = () => formatDueDate(task.dueOn, props.today);
                return (
                  <li>
                    <button
                      type="button"
                      class="search-result"
                      classList={{
                        'search-result--active': activeIndex() === results().indexOf(task),
                      }}
                      onMouseEnter={() => setActiveIndex(results().indexOf(task))}
                      onClick={() => {
                        props.onOpenTask(task);
                        props.onClose();
                      }}
                    >
                      <span
                        class="search-result__check"
                        classList={{ 'search-result__check--done': task.status === 'completed' }}
                      >
                        <Show when={task.status === 'completed'} fallback={<Circle size={13} />}>
                          <Check size={12} stroke-width={3} />
                        </Show>
                      </span>
                      <span class="search-result__body">
                        <span class="search-result__title">{task.title}</span>
                        <span class="search-result__meta">
                          <span>{listName(task)}</span>
                          <Show when={due()}>
                            <span class={`search-due search-due--${due()!.tone}`}>
                              <CalendarDays size={11} /> {due()!.label}
                            </span>
                          </Show>
                          <Show when={task.note.trim()}>
                            <span class="search-result__note">
                              {task.note.replace(/\s+/g, ' ').slice(0, 42)}
                            </span>
                          </Show>
                        </span>
                      </span>
                    </button>
                  </li>
                );
              }}
            </For>
          </ul>
        </Show>
      </div>
      <footer class="search-footer">
        <span>
          <kbd>↵</kbd> 打开
        </span>
        <span>
          <kbd>Esc</kbd> 关闭
        </span>
        <span class="search-footer__privacy">搜索只在本机进行</span>
      </footer>
    </Modal>
  );
}
