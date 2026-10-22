import { For, Show, createSignal } from 'solid-js';
import {
  BarChart3,
  CalendarDays,
  CheckSquare2,
  ListTodo,
  Plus,
  Search,
  Settings2,
  Share2,
  Star,
  Sun,
  X,
} from 'lucide-solid';
import type { ViewCounts } from '@todo/application';
import type { TaskList } from '@todo/domain';
import type { AppView } from '../types';
import { SMART_TITLES } from '../types';

interface SidebarProps {
  view: AppView;
  lists: TaskList[];
  counts: ViewCounts;
  open: boolean;
  syncLabel: string;
  syncTone: 'local' | 'synced' | 'syncing' | 'error' | 'offline';
  onSelect: (view: AppView) => void;
  onSearch: () => void;
  onAddList: (name: string) => Promise<void>;
  onOpenSettings: () => void;
  onOpenReview: () => void;
  onOpenShared: () => void;
  onClose: () => void;
}

const SMART_ITEMS = [
  { id: 'my-day' as const, icon: Sun, className: 'nav-icon--sun' },
  { id: 'important' as const, icon: Star, className: 'nav-icon--star' },
  { id: 'planned' as const, icon: CalendarDays, className: 'nav-icon--calendar' },
  { id: 'calendar' as const, icon: CalendarDays, className: 'nav-icon--calendar' },
  { id: 'all' as const, icon: ListTodo, className: 'nav-icon--all' },
];

export function Sidebar(props: SidebarProps) {
  const [adding, setAdding] = createSignal(false);
  const [name, setName] = createSignal('');
  let inputRef: HTMLInputElement | undefined;

  const submit = async () => {
    const value = name().trim();
    if (!value) {
      setAdding(false);
      return;
    }
    await props.onAddList(value);
    setName('');
    setAdding(false);
  };

  const countFor = (id: (typeof SMART_ITEMS)[number]['id']): number => {
    if (id === 'my-day') return props.counts.myDay;
    if (id === 'important') return props.counts.important;
    if (id === 'planned' || id === 'calendar') return props.counts.planned;
    return props.counts.all;
  };

  const active = (kind: AppView['kind'], id: string) =>
    props.view.kind === kind && props.view.id === id;

  return (
    <aside class="sidebar" classList={{ 'sidebar--open': props.open }} aria-label="主导航">
      <div class="sidebar__top">
        <div class="brand">
          <div class="brand__mark" aria-hidden="true">
            <CheckSquare2 size={20} stroke-width={2.5} />
          </div>
          <div>
            <div class="brand__name">拾事</div>
            <div class="brand__tagline">把今天过清楚</div>
          </div>
          <button class="icon-button sidebar__close" onClick={props.onClose} aria-label="关闭导航">
            <X size={18} />
          </button>
        </div>

        <button type="button" class="search-trigger" onClick={props.onSearch}>
          <Search size={17} />
          <span>搜索任务</span>
          <kbd>{navigator.platform.toLowerCase().includes('mac') ? '⌘' : 'Ctrl'} K</kbd>
        </button>
      </div>

      <nav class="sidebar__nav" aria-label="应用导航">
        <div class="nav-section">
          <For each={SMART_ITEMS}>
            {(item) => (
              <button
                type="button"
                class="nav-item"
                classList={{ 'nav-item--active': active('smart', item.id) }}
                onClick={() => {
                  props.onSelect({ kind: 'smart', id: item.id });
                  props.onClose();
                }}
                aria-current={active('smart', item.id) ? 'page' : undefined}
              >
                <item.icon size={18} class={item.className} />
                <span>{SMART_TITLES[item.id]}</span>
                <Show when={countFor(item.id) > 0}>
                  <span class="nav-item__count">{countFor(item.id)}</span>
                </Show>
              </button>
            )}
          </For>
          <button
            type="button"
            class="nav-item"
            classList={{ 'nav-item--active': active('smart', 'completed') }}
            onClick={() => {
              props.onSelect({ kind: 'smart', id: 'completed' });
              props.onClose();
            }}
            aria-current={active('smart', 'completed') ? 'page' : undefined}
          >
            <CheckSquare2 size={18} class="nav-icon--completed" />
            <span>{SMART_TITLES.completed}</span>
            <Show when={props.counts.completed > 0}>
              <span class="nav-item__count">{props.counts.completed}</span>
            </Show>
          </button>
          <button
            type="button"
            class="nav-item"
            onClick={() => {
              props.onOpenShared();
              props.onClose();
            }}
          >
            <Share2 size={18} />
            <span>共享清单</span>
          </button>
        </div>

        <div class="nav-section nav-section--lists">
          <div class="nav-section__heading">
            <span>我的清单</span>
            <button
              type="button"
              class="icon-button icon-button--small"
              aria-label="新建清单"
              onClick={() => {
                setAdding(true);
                queueMicrotask(() => inputRef?.focus());
              }}
            >
              <Plus size={16} />
            </button>
          </div>
          <For each={props.lists}>
            {(list) => (
              <button
                type="button"
                class="nav-item"
                classList={{ 'nav-item--active': active('list', list.id) }}
                onClick={() => {
                  props.onSelect({ kind: 'list', id: list.id });
                  props.onClose();
                }}
                aria-current={active('list', list.id) ? 'page' : undefined}
              >
                <span
                  class="list-dot"
                  classList={{ 'list-dot--outline': !list.color }}
                  style={list.color ? { '--list-color': list.color } : undefined}
                />
                <span class="nav-item__label">{list.name}</span>
                <Show when={(props.counts.lists[list.id] ?? 0) > 0}>
                  <span class="nav-item__count">{props.counts.lists[list.id]}</span>
                </Show>
              </button>
            )}
          </For>
          <Show when={adding()}>
            <form
              class="list-create"
              onSubmit={(event) => {
                event.preventDefault();
                void submit();
              }}
            >
              <span class="list-dot list-dot--outline" />
              <input
                ref={inputRef}
                value={name()}
                onInput={(event) => setName(event.currentTarget.value)}
                onBlur={() => void submit()}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    setName('');
                    setAdding(false);
                  }
                }}
                placeholder="清单名称"
                aria-label="清单名称"
                maxlength={120}
              />
            </form>
          </Show>
          <Show when={!adding()}>
            <button type="button" class="nav-item nav-item--muted" onClick={() => setAdding(true)}>
              <Plus size={17} />
              <span>新建清单</span>
            </button>
          </Show>
        </div>
      </nav>

      <div class="sidebar__footer">
        <div class="sync-pill" title={props.syncLabel}>
          <span class={`sync-pill__dot sync-pill__dot--${props.syncTone}`} />
          <span>{props.syncLabel}</span>
        </div>
        <button type="button" class="nav-item nav-item--muted" onClick={props.onOpenReview}>
          <BarChart3 size={18} />
          <span>每周回顾</span>
        </button>
        <button type="button" class="nav-item nav-item--muted" onClick={props.onOpenSettings}>
          <Settings2 size={18} />
          <span>设置与数据</span>
        </button>
      </div>
    </aside>
  );
}
