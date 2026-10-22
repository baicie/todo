import { For, Show, createEffect, createSignal, onCleanup, onMount } from 'solid-js';
import { Check, LoaderCircle, Plus, RefreshCw, Share2, Trash2, UserPlus } from 'lucide-solid';
import type { CloudController } from '../sync/cloud';
import { Modal } from './Modal';

interface SharedListSummary {
  id: string;
  name: string;
  role: 'owner' | 'editor' | 'viewer';
  revision: number;
}

interface SharedTask {
  id: string;
  title: string;
  note: string;
  status: 'open' | 'completed';
  important: boolean;
  due_on: string | null;
  rank: string;
}

interface SharedMember {
  user_id: string;
  email: string;
  role: 'owner' | 'editor' | 'viewer';
}

interface SharedSnapshot {
  list: SharedListSummary;
  tasks: SharedTask[];
  members: SharedMember[];
  revision: number;
}

interface SharedListsDialogProps {
  open: boolean;
  cloud: CloudController;
  onClose: () => void;
}

function unwrapLists(value: unknown): SharedListSummary[] {
  if (Array.isArray(value)) return value as SharedListSummary[];
  if (value && typeof value === 'object' && Array.isArray((value as { lists?: unknown }).lists)) {
    return (value as { lists: SharedListSummary[] }).lists;
  }
  return [];
}

export function SharedListsDialog(props: SharedListsDialogProps) {
  const [lists, setLists] = createSignal<SharedListSummary[]>([]);
  const [selected, setSelected] = createSignal<SharedSnapshot | null>(null);
  const [busy, setBusy] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [newList, setNewList] = createSignal('');
  const [newTask, setNewTask] = createSignal('');
  const [inviteEmail, setInviteEmail] = createSignal('');
  let poll: ReturnType<typeof setInterval> | undefined;

  const canEdit = () => {
    const role = selected()?.list.role;
    return role === 'owner' || role === 'editor';
  };

  const loadLists = async () => {
    try {
      setError(null);
      const response = await props.cloud.sharedRequest<unknown>('/lists');
      setLists(unwrapLists(response));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '共享清单加载失败');
    }
  };

  const loadSnapshot = async (id: string) => {
    try {
      setError(null);
      setSelected(await props.cloud.sharedRequest<SharedSnapshot>(`/lists/${id}`));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '共享清单打开失败');
    }
  };

  const createList = async () => {
    const name = newList().trim();
    if (!name || busy()) return;
    setBusy('create-list');
    try {
      const created = await props.cloud.sharedRequest<SharedListSummary>('/lists', {
        method: 'POST',
        body: JSON.stringify({ name }),
      });
      setNewList('');
      await loadLists();
      await loadSnapshot(created.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '创建共享清单失败');
    } finally {
      setBusy(null);
    }
  };

  const addTask = async () => {
    const current = selected();
    const title = newTask().trim();
    if (!current || !title || busy()) return;
    setBusy('add-task');
    try {
      await props.cloud.sharedRequest(`/lists/${current.list.id}/tasks`, {
        method: 'POST',
        body: JSON.stringify({ title, revision: current.revision }),
      });
      setNewTask('');
      await loadSnapshot(current.list.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '添加共享任务失败');
    } finally {
      setBusy(null);
    }
  };

  const toggleTask = async (task: SharedTask) => {
    const current = selected();
    if (!current || !canEdit() || busy()) return;
    setBusy(task.id);
    try {
      await props.cloud.sharedRequest(`/lists/${current.list.id}/tasks/${task.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          status: task.status === 'completed' ? 'open' : 'completed',
          revision: current.revision,
        }),
      });
      await loadSnapshot(current.list.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '更新任务失败');
      await loadSnapshot(current.list.id);
    } finally {
      setBusy(null);
    }
  };

  const removeTask = async (task: SharedTask) => {
    const current = selected();
    if (!current || !canEdit() || !window.confirm(`删除共享任务「${task.title}」？`)) return;
    setBusy(task.id);
    try {
      await props.cloud.sharedRequest(`/lists/${current.list.id}/tasks/${task.id}`, {
        method: 'DELETE',
        headers: { 'If-Match': String(current.revision) },
      });
      await loadSnapshot(current.list.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '删除任务失败');
    } finally {
      setBusy(null);
    }
  };

  const invite = async () => {
    const current = selected();
    const email = inviteEmail().trim();
    if (!current || !email || current.list.role !== 'owner') return;
    setBusy('invite');
    try {
      await props.cloud.sharedRequest(`/lists/${current.list.id}/members`, {
        method: 'POST',
        body: JSON.stringify({ email, role: 'editor', revision: current.revision }),
      });
      setInviteEmail('');
      await loadSnapshot(current.list.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '邀请成员失败');
    } finally {
      setBusy(null);
    }
  };

  onMount(() => {
    poll = setInterval(() => {
      const current = selected();
      if (props.open && current && document.visibilityState === 'visible') {
        void loadSnapshot(current.list.id);
      }
    }, 15_000);
  });

  createEffect(() => {
    if (props.open) {
      setSelected(null);
      void loadLists();
    }
  });

  onCleanup(() => {
    if (poll) clearInterval(poll);
  });

  return (
    <Modal
      open={props.open}
      onClose={props.onClose}
      title="共享清单"
      description="在线协作 v1 · 与账号同步，不写入个人任务列表"
      size="lg"
      class="shared-modal"
    >
      <div class="shared-layout">
        <aside class="shared-sidebar">
          <div class="shared-sidebar__heading">
            <span>我的共享</span>
            <button
              type="button"
              class="icon-button icon-button--small"
              aria-label="刷新共享清单"
              onClick={() => void loadLists()}
            >
              <RefreshCw size={14} />
            </button>
          </div>
          <Show
            when={lists().length > 0}
            fallback={<p class="shared-empty">还没有共享清单，创建一个邀请同事吧。</p>}
          >
            <For each={lists()}>
              {(list) => (
                <button
                  type="button"
                  class="shared-list-item"
                  classList={{ 'shared-list-item--active': selected()?.list.id === list.id }}
                  onClick={() => void loadSnapshot(list.id)}
                >
                  <Share2 size={14} />
                  <span>{list.name}</span>
                  <small>
                    {list.role === 'owner' ? '所有者' : list.role === 'editor' ? '可编辑' : '只读'}
                  </small>
                </button>
              )}
            </For>
          </Show>
          <div class="shared-create">
            <input
              value={newList()}
              placeholder="新共享清单"
              aria-label="新共享清单名称"
              onInput={(event) => setNewList(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void createList();
              }}
            />
            <button
              type="button"
              class="icon-button icon-button--small"
              aria-label="创建共享清单"
              disabled={!newList().trim() || Boolean(busy())}
              onClick={() => void createList()}
            >
              <Plus size={15} />
            </button>
          </div>
        </aside>

        <section class="shared-main">
          <Show when={error()}>
            <div class="cloud-banner cloud-banner--error" role="alert">
              {error()}
            </div>
          </Show>
          <Show
            when={selected()}
            fallback={
              <div class="shared-placeholder">
                <Share2 size={26} />
                <p>选择左侧共享清单开始协作</p>
              </div>
            }
          >
            {(snapshot) => (
              <>
                <div class="shared-main__header">
                  <div>
                    <h3>{snapshot().list.name}</h3>
                    <span>
                      revision {snapshot().revision} · {snapshot().list.role}
                    </span>
                  </div>
                  <span class="shared-online">在线</span>
                </div>

                <Show when={canEdit()}>
                  <form
                    class="shared-add"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void addTask();
                    }}
                  >
                    <input
                      value={newTask()}
                      placeholder="添加共享任务"
                      aria-label="添加共享任务"
                      onInput={(event) => setNewTask(event.currentTarget.value)}
                    />
                    <button
                      type="submit"
                      class="primary-button"
                      disabled={!newTask().trim() || Boolean(busy())}
                    >
                      <Plus size={14} /> 添加
                    </button>
                  </form>
                </Show>

                <div class="shared-tasks">
                  <Show
                    when={snapshot().tasks.length > 0}
                    fallback={<p class="shared-empty">暂无任务</p>}
                  >
                    <For each={snapshot().tasks}>
                      {(task) => (
                        <div
                          class="shared-task"
                          classList={{ 'shared-task--done': task.status === 'completed' }}
                        >
                          <button
                            type="button"
                            class="task-check"
                            aria-label={task.status === 'completed' ? '标记为未完成' : '标记为完成'}
                            disabled={!canEdit() || busy() === task.id}
                            onClick={() => void toggleTask(task)}
                          >
                            <Show
                              when={busy() === task.id}
                              fallback={task.status === 'completed' ? <Check size={12} /> : null}
                            >
                              <LoaderCircle size={12} class="spin-icon" />
                            </Show>
                          </button>
                          <span>{task.title}</span>
                          <Show when={task.due_on}>
                            <small>{task.due_on}</small>
                          </Show>
                          <Show when={canEdit()}>
                            <button
                              type="button"
                              class="icon-button icon-button--small danger-text"
                              aria-label={`删除共享任务 ${task.title}`}
                              onClick={() => void removeTask(task)}
                            >
                              <Trash2 size={13} />
                            </button>
                          </Show>
                        </div>
                      )}
                    </For>
                  </Show>
                </div>

                <div class="shared-members">
                  <div class="shared-members__heading">
                    <h4>成员</h4>
                    <span>{snapshot().members.length} 人</span>
                  </div>
                  <For each={snapshot().members}>
                    {(member) => (
                      <div class="shared-member">
                        <span>{member.email}</span>
                        <small>{member.role}</small>
                      </div>
                    )}
                  </For>
                  <Show when={snapshot().list.role === 'owner'}>
                    <div class="shared-create">
                      <input
                        type="email"
                        value={inviteEmail()}
                        placeholder="邀请成员邮箱"
                        aria-label="邀请成员邮箱"
                        onInput={(event) => setInviteEmail(event.currentTarget.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') void invite();
                        }}
                      />
                      <button
                        type="button"
                        class="secondary-button"
                        disabled={!inviteEmail().trim() || busy() === 'invite'}
                        onClick={() => void invite()}
                      >
                        <UserPlus size={14} /> 邀请
                      </button>
                    </div>
                  </Show>
                </div>
              </>
            )}
          </Show>
        </section>
      </div>
    </Modal>
  );
}
