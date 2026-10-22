import { For, Show, createSignal, createUniqueId } from 'solid-js';
import { Bookmark, SlidersHorizontal, Tag, X } from 'lucide-solid';
import type { SavedView, TaskFilter } from '../types';

interface TaskFilterBarProps {
  filter: TaskFilter;
  availableTags: string[];
  savedViews: SavedView[];
  onChange: (filter: TaskFilter) => void;
  onSave: (name: string) => void;
  onApplySaved: (view: SavedView) => void;
  onDeleteSaved: (id: string) => void;
}

function activeCount(filter: TaskFilter): number {
  return filter.tags.length + (filter.status === 'all' ? 0 : 1) + (filter.due === 'all' ? 0 : 1);
}

export function TaskFilterBar(props: TaskFilterBarProps) {
  const [saveName, setSaveName] = createSignal('');
  const saveInputId = createUniqueId();

  const toggleTag = (tag: string) => {
    const selected = props.filter.tags.includes(tag);
    props.onChange({
      ...props.filter,
      tags: selected
        ? props.filter.tags.filter((item) => item !== tag)
        : [...props.filter.tags, tag],
    });
  };

  return (
    <div class="task-filterbar">
      <div class="task-filterbar__main">
        <details class="filter-menu">
          <summary class="filter-trigger">
            <SlidersHorizontal size={15} />
            筛选
            <Show when={activeCount(props.filter) > 0}>
              <span class="filter-count">{activeCount(props.filter)}</span>
            </Show>
          </summary>
          <div class="filter-popover">
            <section>
              <h4>
                <Tag size={14} /> 标签
              </h4>
              <Show
                when={props.availableTags.length > 0}
                fallback={<p class="filter-hint">还没有标签。在任务详情或快速添加中用 #标签。</p>}
              >
                <div class="filter-tags">
                  <For each={props.availableTags}>
                    {(tag) => (
                      <button
                        type="button"
                        class="filter-tag"
                        classList={{ 'filter-tag--active': props.filter.tags.includes(tag) }}
                        aria-pressed={props.filter.tags.includes(tag)}
                        onClick={() => toggleTag(tag)}
                      >
                        #{tag}
                      </button>
                    )}
                  </For>
                </div>
              </Show>
            </section>

            <section class="filter-row">
              <label>
                状态
                <select
                  value={props.filter.status}
                  onChange={(event) =>
                    props.onChange({
                      ...props.filter,
                      status: event.currentTarget.value as TaskFilter['status'],
                    })
                  }
                >
                  <option value="all">全部</option>
                  <option value="open">未完成</option>
                  <option value="completed">已完成</option>
                </select>
              </label>
              <label>
                截止
                <select
                  value={props.filter.due}
                  onChange={(event) =>
                    props.onChange({
                      ...props.filter,
                      due: event.currentTarget.value as TaskFilter['due'],
                    })
                  }
                >
                  <option value="all">全部</option>
                  <option value="today">今天</option>
                  <option value="overdue">已逾期</option>
                  <option value="none">无日期</option>
                </select>
              </label>
            </section>

            <section class="filter-save">
              <label for={saveInputId}>保存为视图</label>
              <div>
                <input
                  id={saveInputId}
                  value={saveName()}
                  placeholder="例如：本周工作"
                  onInput={(event) => setSaveName(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      if (saveName().trim()) {
                        props.onSave(saveName().trim());
                        setSaveName('');
                      }
                    }
                  }}
                />
                <button
                  type="button"
                  class="secondary-button"
                  disabled={!saveName().trim()}
                  onClick={() => {
                    props.onSave(saveName().trim());
                    setSaveName('');
                  }}
                >
                  保存
                </button>
              </div>
            </section>
          </div>
        </details>

        <For each={props.filter.tags}>
          {(tag) => (
            <button
              type="button"
              class="filter-chip"
              onClick={() => toggleTag(tag)}
              aria-label={`移除标签筛选 ${tag}`}
            >
              #{tag} <X size={11} />
            </button>
          )}
        </For>

        <Show when={activeCount(props.filter) > 0}>
          <button
            type="button"
            class="text-button"
            onClick={() => props.onChange({ tags: [], status: 'all', due: 'all' })}
          >
            清除筛选
          </button>
        </Show>
      </div>

      <Show when={props.savedViews.length > 0}>
        <div class="saved-views" aria-label="保存的视图">
          <Bookmark size={13} />
          <For each={props.savedViews}>
            {(view) => (
              <span class="saved-view">
                <button type="button" onClick={() => props.onApplySaved(view)}>
                  {view.name}
                </button>
                <button
                  type="button"
                  aria-label={`删除保存视图 ${view.name}`}
                  onClick={() => props.onDeleteSaved(view.id)}
                >
                  <X size={10} />
                </button>
              </span>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
