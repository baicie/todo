import { For, Show, createMemo, createSignal } from 'solid-js';
import {
  AlertTriangle,
  Check,
  Inbox,
  LoaderCircle,
  Mail,
  Plus,
  RefreshCw,
  Share2,
  Trash2,
  UserPlus,
  X,
} from 'lucide-solid';
import type { SharedInviteRole } from '@todo/contracts';
import type { SharedSyncController } from '../sync/shared-controller';
import {
  sharedErrorMessage,
  sharedRejectionReason,
  type SharedListView,
  type SharedSyncStatus,
} from '../sync/shared-sync';
import type { SharedOpRecord, SharedTaskRecord } from '../sync/shared-store';
import { Modal } from './Modal';

interface SharedListsDialogProps {
  open: boolean;
  shared: SharedSyncController;
  onClose: () => void;
}

const STATUS_LABELS: Record<SharedSyncStatus, string> = {
  idle: '已同步',
  syncing: '同步中',
  offline: '离线',
  error: '同步失败',
};

function clockTime(value: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

/** Human label for a queued edit, using the live task when it still exists. */
function opLabel(op: SharedOpRecord, tasks: SharedTaskRecord[]): string {
  const task = tasks.find((item) => item.id === op.taskId);
  const title = task?.title || op.patch.title || '任务';
  if (op.kind === 'create') return `添加「${title}」`;
  if (op.kind === 'delete') return `删除「${title}」`;
  const fields = Object.keys(op.patch);
  const names = fields
    .map((field) =>
      field === 'title'
        ? '标题'
        : field === 'note'
          ? '备注'
          : field === 'status'
            ? '状态'
            : field === 'important'
              ? '重要'
              : field === 'due_on'
                ? '截止日期'
                : field,
    )
    .join('、');
  return `修改「${title}」的${names}`;
}

export function SharedListsDialog(props: SharedListsDialogProps) {
  const [selectedId, setSelectedId] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [newList, setNewList] = createSignal('');
  const [newTask, setNewTask] = createSignal('');
  const [inviteEmail, setInviteEmail] = createSignal('');
  const [inviteRole, setInviteRole] = createSignal<SharedInviteRole>('editor');
  const [notice, setNotice] = createSignal<string | null>(null);

  const lists = () => props.shared.view().lists;
  const invitations = () => props.shared.view().invitations;
  const selected = createMemo<SharedListView | null>(
    () => lists().find((item) => item.record.id === selectedId()) ?? null,
  );
  const engine = () => props.shared.engine;
  const editable = () => selected()?.editable ?? false;

  const run = async (key: string, action: () => Promise<void>) => {
    if (busy()) return;
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (cause) {
      setError(sharedErrorMessage(cause, '操作失败'));
    } finally {
      setBusy(null);
    }
  };

  const syncNow = () =>
    run('sync', async () => {
      await engine().syncNow();
      const state = props.shared.state();
      if (state.error) setError(state.error);
    });

  const createList = () => {
    const name = newList().trim();
    if (!name) return;
    void run('create-list', async () => {
      const id = await engine().createList(name);
      setNewList('');
      setSelectedId(id);
    });
  };

  const addTask = () => {
    const current = selected();
    const title = newTask().trim();
    if (!current || !title) return;
    void run('add-task', async () => {
      await engine().createTask(current.record.id, { title });
      setNewTask('');
    });
  };

  const toggleTask = (task: SharedTaskRecord) =>
    run(task.id, async () => {
      const current = selected();
      if (!current) return;
      await engine().updateTask(current.record.id, task.id, {
        status: task.status === 'completed' ? 'open' : 'completed',
      });
    });

  const removeTask = (task: SharedTaskRecord) => {
    const current = selected();
    if (!current || !window.confirm(`删除共享任务「${task.title}」？`)) return;
    void run(task.id, () => engine().deleteTask(current.record.id, task.id));
  };

  const invite = () => {
    const current = selected();
    const email = inviteEmail().trim();
    if (!current || !email) return;
    void run('invite', async () => {
      const invitation = await engine().invite(current.record.id, email, inviteRole());
      setInviteEmail('');
      setNotice(`已邀请 ${invitation.email}，对方登录后接受即可加入`);
    });
  };

  const accept = (invitationId: string, listName: string) =>
    run(`accept:${invitationId}`, async () => {
      const id = await engine().acceptInvitation(invitationId);
      setSelectedId(id);
      setNotice(`已加入「${listName}」`);
    });

  const decline = (invitationId: string) =>
    run(`decline:${invitationId}`, () => engine().declineInvitation(invitationId));

  const discard = (opId: string) => {
    const current = selected();
    if (!current) return;
    void run(`discard:${opId}`, () => engine().discardOp(current.record.id, opId));
  };

  const retry = (opId: string) => {
    const current = selected();
    if (!current) return;
    void run(`retry:${opId}`, () => engine().retryOp(current.record.id, opId));
  };

  const removeLocal = () => {
    const current = selected();
    if (!current || !window.confirm('删除本机副本后需要重新加入才能看到这个清单，继续？')) return;
    void run('remove-local', async () => {
      await engine().removeLocalCopy(current.record.id);
      setSelectedId(null);
    });
  };

  const status = () => {
    const current = selected();
    const engineState = props.shared.state();
    if (!props.shared.connected()) return { tone: 'offline', label: '未连接云端' };
    const pending = current?.pending ?? 0;
    if (engineState.status === 'offline') {
      return { tone: 'offline', label: '离线，稍后自动重试' };
    }
    if (engineState.status === 'error') return { tone: 'error', label: '同步失败' };
    if (engineState.status === 'syncing') return { tone: 'syncing', label: '同步中' };
    if (pending > 0) return { tone: 'syncing', label: `${pending} 项待同步` };
    return { tone: 'online', label: STATUS_LABELS.idle };
  };

  return (
    <Modal
      open={props.open}
      onClose={props.onClose}
      title="共享清单"
      description="与账号同步，不写入个人任务列表 · 离线修改会在联网后自动发送"
      size="lg"
      class="shared-modal"
    >
      <div class="shared-layout">
        <aside class="shared-sidebar">
          <div class="shared-sidebar__heading">
            <span>邀请</span>
            <span class="shared-badge">{invitations().length}</span>
          </div>
          <Show
            when={invitations().length > 0}
            fallback={<p class="shared-empty">没有待处理的邀请</p>}
          >
            <div class="shared-invitations">
              <For each={invitations()}>
                {(invitation) => (
                  <div class="shared-invitation">
                    <div class="shared-invitation__title">
                      <Inbox size={13} />
                      <span>{invitation.list_name}</span>
                      <small>{invitation.role === 'editor' ? '可编辑' : '只读'}</small>
                    </div>
                    <p>来自 {invitation.invited_by_email}</p>
                    <div class="shared-invitation__actions">
                      <button
                        type="button"
                        class="primary-button"
                        disabled={Boolean(busy())}
                        onClick={() => void accept(invitation.id, invitation.list_name)}
                      >
                        <Show
                          when={busy() === `accept:${invitation.id}`}
                          fallback={<Check size={13} />}
                        >
                          <LoaderCircle size={13} class="spin-icon" />
                        </Show>
                        接受
                      </button>
                      <button
                        type="button"
                        class="secondary-button"
                        disabled={Boolean(busy())}
                        onClick={() => void decline(invitation.id)}
                      >
                        <X size={13} /> 拒绝
                      </button>
                    </div>
                  </div>
                )}
              </For>
            </div>
          </Show>

          <div class="shared-sidebar__heading">
            <span>我的共享</span>
            <button
              type="button"
              class="icon-button icon-button--small"
              aria-label="刷新共享清单"
              disabled={busy() === 'sync' || !props.shared.connected()}
              onClick={() => void syncNow()}
            >
              <Show when={busy() === 'sync'} fallback={<RefreshCw size={14} />}>
                <LoaderCircle size={14} class="spin-icon" />
              </Show>
            </button>
          </div>
          <Show
            when={lists().length > 0}
            fallback={<p class="shared-empty">还没有共享清单，创建一个邀请同事吧。</p>}
          >
            <For each={lists()}>
              {(item) => (
                <button
                  type="button"
                  class="shared-list-item"
                  classList={{ 'shared-list-item--active': selectedId() === item.record.id }}
                  onClick={() => setSelectedId(item.record.id)}
                >
                  <Share2 size={14} />
                  <span>{item.record.summary.name}</span>
                  <small>
                    {item.record.access === 'revoked'
                      ? '已移出'
                      : item.record.access === 'deleted'
                        ? '已删除'
                        : item.record.summary.role === 'owner'
                          ? '所有者'
                          : item.record.summary.role === 'editor'
                            ? '可编辑'
                            : '只读'}
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
              disabled={!props.shared.connected()}
              onInput={(event) => setNewList(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') createList();
              }}
            />
            <button
              type="button"
              class="icon-button icon-button--small"
              aria-label="创建共享清单"
              disabled={!newList().trim() || Boolean(busy()) || !props.shared.connected()}
              onClick={() => createList()}
            >
              <Plus size={15} />
            </button>
          </div>
        </aside>

        <section class="shared-main">
          <Show when={!props.shared.connected()}>
            <div class="cloud-banner cloud-banner--warning">
              <AlertTriangle size={14} />
              未连接云端账号。请在「设置 → 同步」登录后使用共享清单；本机已有的共享内容仍可查看。
            </div>
          </Show>
          <Show when={error()}>
            <div class="cloud-banner cloud-banner--error" role="alert">
              {error()}
            </div>
          </Show>
          <Show when={notice()}>
            <div class="cloud-banner shared-banner--notice" role="status">
              {notice()}
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
            {(current) => (
              <>
                <div class="shared-main__header">
                  <div>
                    <h3>{current().record.summary.name}</h3>
                    <span>
                      {current().record.summary.role === 'owner'
                        ? '所有者'
                        : current().record.summary.role === 'editor'
                          ? '可编辑成员'
                          : '只读成员'}
                      {' · '}
                      {current().tasks.length} 项任务
                      <Show when={current().record.syncedAt}>
                        {' · '}
                        最近同步 {clockTime(current().record.syncedAt)}
                      </Show>
                    </span>
                  </div>
                  <span class={`shared-status shared-status--${status().tone}`}>
                    {status().label}
                  </span>
                </div>

                <Show when={current().record.access !== 'active'}>
                  <div class="cloud-banner cloud-banner--warning shared-banner">
                    <AlertTriangle size={14} />
                    <span>
                      {current().record.access === 'revoked'
                        ? '你已被移出这个共享清单，本地内容只读，之后的修改不会再发送。'
                        : '这个共享清单已被所有者删除，本地内容只读。'}
                    </span>
                    <button
                      type="button"
                      class="secondary-button"
                      disabled={busy() === 'remove-local'}
                      onClick={() => removeLocal()}
                    >
                      <Trash2 size={13} /> 删除本机副本
                    </button>
                  </div>
                </Show>
                <Show when={current().record.error}>
                  <div class="cloud-banner cloud-banner--warning">{current().record.error}</div>
                </Show>

                <Show when={current().record.access === 'active'}>
                  <form
                    class="shared-add"
                    onSubmit={(event) => {
                      event.preventDefault();
                      addTask();
                    }}
                  >
                    <input
                      value={newTask()}
                      placeholder={current().editable ? '添加共享任务' : '只读成员无法添加任务'}
                      aria-label="添加共享任务"
                      disabled={!current().editable}
                      onInput={(event) => setNewTask(event.currentTarget.value)}
                    />
                    <button
                      type="submit"
                      class="primary-button"
                      disabled={!current().editable || !newTask().trim() || Boolean(busy())}
                    >
                      <Plus size={14} /> 添加
                    </button>
                  </form>
                </Show>

                <div class="shared-tasks">
                  <Show
                    when={current().tasks.length > 0}
                    fallback={<p class="shared-empty">暂无任务</p>}
                  >
                    <For each={current().tasks}>
                      {(task) => (
                        <div
                          class="shared-task"
                          classList={{ 'shared-task--done': task.status === 'completed' }}
                        >
                          <button
                            type="button"
                            class="task-check"
                            aria-label={task.status === 'completed' ? '标记为未完成' : '标记为完成'}
                            disabled={!current().editable || busy() === task.id}
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
                          <Show when={task.pending}>
                            <small class="shared-task__pending">待同步</small>
                          </Show>
                          <Show when={task.due_on}>
                            <small>{task.due_on}</small>
                          </Show>
                          <Show when={current().editable}>
                            <button
                              type="button"
                              class="icon-button icon-button--small danger-text"
                              aria-label={`删除共享任务 ${task.title}`}
                              onClick={() => removeTask(task)}
                            >
                              <Trash2 size={13} />
                            </button>
                          </Show>
                        </div>
                      )}
                    </For>
                  </Show>
                </div>

                <Show when={current().rejected.length > 0}>
                  <div class="shared-rejected">
                    <div class="shared-members__heading">
                      <h4>未发送的修改</h4>
                      <span>{current().rejected.length} 项</span>
                    </div>
                    <For each={current().rejected}>
                      {(op) => (
                        <div class="shared-rejected__item">
                          <div>
                            <span>{opLabel(op, current().tasks)}</span>
                            <small>{sharedRejectionReason(op.errorCode)}</small>
                          </div>
                          <Show
                            when={op.errorCode === 'SHARED_EDIT_CONFLICT' && current().editable}
                          >
                            <button
                              type="button"
                              class="secondary-button"
                              disabled={Boolean(busy())}
                              onClick={() => retry(op.opId)}
                            >
                              重新应用
                            </button>
                          </Show>
                          <button
                            type="button"
                            class="secondary-button"
                            disabled={Boolean(busy())}
                            onClick={() => discard(op.opId)}
                          >
                            放弃
                          </button>
                        </div>
                      )}
                    </For>
                  </div>
                </Show>

                <div class="shared-members">
                  <div class="shared-members__heading">
                    <h4>成员</h4>
                    <span>{current().record.snapshot?.members.length ?? 0} 人</span>
                  </div>
                  <For each={current().record.snapshot?.members ?? []}>
                    {(member) => (
                      <div class="shared-member">
                        <span>{member.email}</span>
                        <small>{member.role}</small>
                      </div>
                    )}
                  </For>
                  <Show
                    when={
                      current().record.summary.role === 'owner' &&
                      (current().record.snapshot?.invitations.length ?? 0) > 0
                    }
                  >
                    <div class="shared-pending">
                      <div class="shared-members__heading">
                        <h4>待接受</h4>
                      </div>
                      <For each={current().record.snapshot?.invitations ?? []}>
                        {(invitation) => (
                          <div class="shared-member shared-member--pending">
                            <span>
                              <Mail size={12} /> {invitation.email}
                            </span>
                            <small>{invitation.role === 'editor' ? '可编辑' : '只读'}</small>
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>
                  <Show when={current().record.summary.role === 'owner'}>
                    <div class="shared-invite">
                      <input
                        type="email"
                        value={inviteEmail()}
                        placeholder="邀请成员邮箱"
                        aria-label="邀请成员邮箱"
                        onInput={(event) => setInviteEmail(event.currentTarget.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') invite();
                        }}
                      />
                      <select
                        aria-label="邀请角色"
                        value={inviteRole()}
                        onChange={(event) =>
                          setInviteRole(event.currentTarget.value as SharedInviteRole)
                        }
                      >
                        <option value="editor">可编辑</option>
                        <option value="viewer">只读</option>
                      </select>
                      <button
                        type="button"
                        class="secondary-button"
                        disabled={!inviteEmail().trim() || Boolean(busy())}
                        onClick={() => invite()}
                      >
                        <Show when={busy() === 'invite'} fallback={<UserPlus size={14} />}>
                          <LoaderCircle size={14} class="spin-icon" />
                        </Show>
                        邀请
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
