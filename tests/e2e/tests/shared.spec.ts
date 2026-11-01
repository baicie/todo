import { expect, test, type Page, type Route } from '@playwright/test';
import { openApp } from './helpers';

/**
 * Shared-list browser flows against a mocked API (`page.route`). The mock keeps
 * a tiny in-memory server that enforces the same rules as the real one:
 * `If-Match` revisions, `op_id` receipts, editor-only writes and the revoked
 * member's 403. Nothing here touches a real database.
 */

const API = 'http://127.0.0.1:8787';
const NOW = '2026-11-01T00:00:00.000Z';

interface TaskRow {
  id: string;
  list_id: string;
  title: string;
  note: string;
  status: 'open' | 'completed';
  important: boolean;
  due_on: string | null;
  rank: string;
  revision: number;
  created_at: string;
  updated_at: string;
}

interface SummaryRow {
  id: string;
  owner_id: string;
  name: string;
  color: string | null;
  icon: string | null;
  rank: string;
  revision: number;
  role: 'owner' | 'editor' | 'viewer';
  created_at: string;
  updated_at: string;
}

interface InvitationRow {
  id: string;
  list_id: string;
  list_name: string;
  email: string;
  role: 'editor' | 'viewer';
  status: 'pending' | 'accepted' | 'declined' | 'revoked';
  invited_by: string;
  invited_by_email: string;
  revision: number;
  created_at: string;
  updated_at: string;
}

const ME = '019a0000-0000-7000-8000-000000000010';
const OWNER = '019a0000-0000-7000-8000-000000000001';

class MockSharedApi {
  lists = new Map<string, SummaryRow>();
  tasks = new Map<string, TaskRow>();
  invitations: InvitationRow[] = [];
  receipts = new Map<string, number>();
  calls: Array<{ method: string; path: string; revision: number | null }> = [];
  /** While true, shared requests fail like an offline network. */
  offline = false;
  /** The next PATCH answers 409 once, as a concurrent write would. */
  conflictOnce = false;
  /** Lists that vanished from the index because the member was removed. */
  revoked = new Set<string>();

  addList(name: string, role: SummaryRow['role'] = 'owner'): SummaryRow {
    const id = `019a1000-0000-7000-8000-${String(this.lists.size + 1).padStart(12, '0')}`;
    const list: SummaryRow = {
      id,
      owner_id: OWNER,
      name,
      color: null,
      icon: null,
      rank: 'a0',
      revision: 1,
      role,
      created_at: NOW,
      updated_at: NOW,
    };
    this.lists.set(id, list);
    return list;
  }

  addTask(listId: string, title: string): TaskRow {
    const id = `019a2000-0000-7000-8000-${String(this.tasks.size + 1).padStart(12, '0')}`;
    const task: TaskRow = {
      id,
      list_id: listId,
      title,
      note: '',
      status: 'open',
      important: false,
      due_on: null,
      rank: 'a0',
      revision: this.lists.get(listId)?.revision ?? 1,
      created_at: NOW,
      updated_at: NOW,
    };
    this.tasks.set(id, task);
    return task;
  }

  bump(listId: string): number {
    const list = this.lists.get(listId);
    const next = (list?.revision ?? 1) + 1;
    if (list) this.lists.set(listId, { ...list, revision: next });
    return next;
  }

  private json(status: number, body: unknown): { status: number; body: string } {
    return { status, body: JSON.stringify(body) };
  }

  private error(status: number, code: string, message: string) {
    return this.json(status, { code, message });
  }

  private expected(request: Route): number | null {
    const raw = request.request().headers()['if-match'];
    if (!raw) return null;
    const value = Number(raw.replaceAll('"', ''));
    return Number.isFinite(value) ? value : null;
  }

  async handle(route: Route): Promise<void> {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace('/api/v1/shared', '');
    const method = request.method();
    const body = request.postDataJSON?.() ?? {};
    this.calls.push({ method, path, revision: this.expected(route) });
    if (this.offline) {
      await route.abort('internetdisconnected');
      return;
    }
    const respond = async (result: { status: number; body: string }) => {
      await route.fulfill({
        status: result.status,
        contentType: 'application/json',
        body: result.body,
      });
    };

    if (path === '/lists' && method === 'GET')
      return respond(this.json(200, [...this.lists.values()]));
    if (path === '/lists' && method === 'POST') {
      return respond(this.json(200, this.addList(String(body.name))));
    }
    if (path === '/invitations' && method === 'GET') {
      return respond(this.json(200, this.invitations));
    }
    const answer = /^\/invitations\/([^/]+)\/(accept|decline)$/.exec(path);
    if (answer) {
      const invitation = this.invitations.find((item) => item.id === answer[1]);
      if (!invitation) return respond(this.error(404, 'SHARED_INVITATION_NOT_FOUND', 'missing'));
      this.invitations = this.invitations.filter((item) => item.id !== invitation.id);
      const list = this.lists.get(invitation.list_id);
      if (!list) return respond(this.error(404, 'SHARED_LIST_NOT_FOUND', 'missing'));
      if (answer[2] === 'decline') return respond(this.json(204, null));
      const summary = { ...list, role: invitation.role, revision: this.bump(list.id) };
      this.lists.set(list.id, summary);
      return respond(this.json(200, summary));
    }
    const snapshot = /^\/lists\/([^/]+)$/.exec(path);
    if (snapshot && method === 'GET') {
      if (this.revoked.has(snapshot[1]!)) {
        return respond(this.error(403, 'SHARED_LIST_ACCESS_REVOKED', 'removed'));
      }
      const list = this.lists.get(snapshot[1]!);
      if (!list) return respond(this.error(404, 'SHARED_LIST_NOT_FOUND', 'missing'));
      return respond(
        this.json(200, {
          list,
          members: [{ user_id: OWNER, email: 'owner@example.com', role: 'owner', created_at: NOW }],
          invitations: this.invitations.filter((item) => item.list_id === list.id),
          tasks: [...this.tasks.values()].filter((task) => task.list_id === list.id),
          steps: [],
          revision: list.revision,
        }),
      );
    }
    const collection = /^\/lists\/([^/]+)\/tasks$/.exec(path);
    if (collection && method === 'POST') {
      const list = this.lists.get(collection[1]!);
      if (!list) return respond(this.error(404, 'SHARED_LIST_NOT_FOUND', 'missing'));
      if (list.role === 'viewer') {
        return respond(this.error(403, 'SHARED_LIST_FORBIDDEN', 'viewer'));
      }
      if (this.receipts.has(String(body.op_id))) {
        return respond(this.json(200, this.tasks.get(String(body.id)) ?? {}));
      }
      const expected = this.expected(route);
      if (expected !== null && expected !== list.revision) {
        return respond(this.error(409, 'REVISION_CONFLICT', 'stale'));
      }
      const revision = this.bump(list.id);
      const task: TaskRow = {
        id: String(body.id),
        list_id: list.id,
        title: String(body.title),
        note: String(body.note ?? ''),
        status: 'open',
        important: Boolean(body.important),
        due_on: (body.due_on as string | null) ?? null,
        rank: 'a0',
        revision,
        created_at: NOW,
        updated_at: NOW,
      };
      this.tasks.set(task.id, task);
      this.receipts.set(String(body.op_id), revision);
      return respond(this.json(200, task));
    }
    const single = /^\/lists\/([^/]+)\/tasks\/([^/]+)$/.exec(path);
    if (single && (method === 'PATCH' || method === 'DELETE')) {
      const list = this.lists.get(single[1]!);
      if (!list) return respond(this.error(404, 'SHARED_LIST_NOT_FOUND', 'missing'));
      if (list.role === 'viewer') {
        return respond(this.error(403, 'SHARED_LIST_FORBIDDEN', 'viewer'));
      }
      if (this.receipts.has(String(body.op_id))) return respond(this.json(204, null));
      if (this.conflictOnce) {
        // Another member wrote first; their change is now part of the snapshot.
        this.conflictOnce = false;
        return respond(this.error(409, 'REVISION_CONFLICT', 'stale'));
      }
      const expected = this.expected(route);
      if (expected !== null && expected !== list.revision) {
        return respond(this.error(409, 'REVISION_CONFLICT', 'stale'));
      }
      const revision = this.bump(list.id);
      if (method === 'DELETE') {
        this.tasks.delete(single[2]!);
        this.receipts.set(String(body.op_id), revision);
        return respond(this.json(204, null));
      }
      const task = this.tasks.get(single[2]!);
      if (!task) return respond(this.error(404, 'SHARED_TASK_NOT_FOUND', 'missing'));
      const next: TaskRow = {
        ...task,
        ...(body.title !== undefined ? { title: String(body.title) } : {}),
        ...(body.status !== undefined ? { status: body.status as TaskRow['status'] } : {}),
        revision,
      };
      this.tasks.set(next.id, next);
      this.receipts.set(String(body.op_id), revision);
      return respond(this.json(200, next));
    }
    const members = /^\/lists\/([^/]+)\/members$/.exec(path);
    if (members && method === 'POST') {
      const list = this.lists.get(members[1]!);
      if (!list) return respond(this.error(404, 'SHARED_LIST_NOT_FOUND', 'missing'));
      const revision = this.bump(list.id);
      const invitation: InvitationRow = {
        id: `019a3000-0000-7000-8000-${String(this.invitations.length + 1).padStart(12, '0')}`,
        list_id: list.id,
        list_name: list.name,
        email: String(body.email),
        role: body.role as InvitationRow['role'],
        status: 'pending',
        invited_by: OWNER,
        invited_by_email: 'owner@example.com',
        revision,
        created_at: NOW,
        updated_at: NOW,
      };
      this.invitations.push(invitation);
      return respond(this.json(200, invitation));
    }
    return respond(this.error(404, 'NOT_FOUND', path));
  }
}

async function signIn(page: Page): Promise<void> {
  await page.getByRole('button', { name: '设置与数据' }).click();
  await page.getByRole('button', { name: '同步', exact: true }).click();
  await page.getByLabel('API 地址').fill(API);
  await page.getByLabel('邮箱').fill('shared-e2e@example.com');
  await page.getByRole('button', { name: '发送登录验证码' }).click();
  await page.getByLabel('验证码').fill('246810');
  await page.getByRole('button', { name: '验证并连接' }).click();
  await page.locator('.cloud-merge').getByRole('button', { name: '合并本机与云端' }).click();
  await expect(page.locator('.cloud-account-card')).toContainText('已同步');
  await page.getByRole('button', { name: '关闭' }).click();
}

async function openShared(page: Page): Promise<void> {
  await page.locator('.sidebar').getByRole('button', { name: '共享清单' }).click();
  await expect(page.getByRole('dialog')).toContainText('共享清单');
}

async function mockAuth(page: Page, api: MockSharedApi): Promise<void> {
  await page.route(`${API}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/v1/auth/code/request') {
      await route.fulfill({ status: 202, body: '' });
      return;
    }
    if (url.pathname === '/api/v1/auth/code/verify') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ access_token: 'e2e-access-token', expires_in: 900 }),
      });
      return;
    }
    if (url.pathname === '/api/v1/sync/bootstrap') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          entities: [],
          snapshot_cursor: '0',
          next_page: null,
          has_more: false,
        }),
      });
      return;
    }
    if (url.pathname === '/api/v1/sync') {
      const body = route.request().postDataJSON() as { ops: Array<{ op_id: string }> };
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ack: body.ops.map((op, index) => ({
            op_id: op.op_id,
            server_seq: index + 1,
            status: 'applied',
          })),
          changes: [],
          next_cursor: String(body.ops.length),
          has_more: false,
          server_time: NOW,
        }),
      });
      return;
    }
    if (url.pathname.startsWith('/api/v1/shared')) {
      await api.handle(route);
      return;
    }
    if (url.pathname === '/api/v1/auth/logout') {
      await route.fulfill({ status: 204, body: '' });
      return;
    }
    await route.fulfill({ status: 404, body: '{}' });
  });
}

test('shared lists sync edits made offline and show pending work until replayed', async ({
  page,
  context,
}) => {
  const api = new MockSharedApi();
  const list = api.addList('周末采购');
  api.addTask(list.id, '买牛奶');
  await mockAuth(page, api);
  await openApp(page);
  await signIn(page);
  await openShared(page);

  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: /周末采购/ }).click();
  await expect(dialog).toContainText('买牛奶');
  await expect(dialog.locator('.shared-status')).toContainText('已同步');

  // Go offline, keep editing: the task shows immediately as pending.
  api.offline = true;
  await context.setOffline(true);
  const input = dialog.getByRole('textbox', { name: '添加共享任务' });
  await input.fill('买面包');
  await input.press('Enter');
  const row = dialog.locator('.shared-task').filter({ hasText: '买面包' });
  await expect(row).toBeVisible();
  await expect(row.locator('.shared-task__pending')).toBeVisible();
  await expect(dialog.locator('.shared-status')).toContainText('离线');

  // Back online: the queued create is replayed with its op_id.
  api.offline = false;
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(row.locator('.shared-task__pending')).toHaveCount(0, { timeout: 15_000 });
  await expect(dialog.locator('.shared-status')).toContainText('已同步');
  expect([...api.tasks.values()].map((task) => task.title)).toContain('买面包');
  const writes = api.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/tasks'));
  expect(writes.length).toBeGreaterThan(0);
});

test('a 409 conflict is rebased and retried without losing the local edit', async ({ page }) => {
  const api = new MockSharedApi();
  const list = api.addList('冲突清单');
  api.addTask(list.id, '待办一');
  await mockAuth(page, api);
  await openApp(page);
  await signIn(page);
  await openShared(page);

  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: /冲突清单/ }).click();
  await expect(dialog).toContainText('待办一');
  // Let the first poll settle before the concurrent write is injected.
  await expect(dialog.locator('.shared-status')).toContainText('已同步');

  api.conflictOnce = true;
  const check = dialog.getByRole('button', { name: '标记为完成' }).first();
  await check.click();
  await expect(dialog.locator('.shared-task--done')).toHaveCount(1, { timeout: 15_000 });
  // The retry succeeds: the server sees the write and nothing is left rejected.
  await expect
    .poll(() => [...api.tasks.values()][0]?.status, { timeout: 15_000 })
    .toBe('completed');
  await expect
    .poll(() => api.calls.filter((call) => call.method === 'PATCH').length, { timeout: 15_000 })
    .toBeGreaterThanOrEqual(2);
  await expect(dialog.getByText('未发送的修改')).toHaveCount(0);
  await expect(dialog.locator('.shared-status')).toContainText('已同步');
});

test('invitations can be accepted and declined from the shared dialog', async ({ page }) => {
  const api = new MockSharedApi();
  const incoming = api.addList('同事的清单');
  api.lists.delete(incoming.id);
  api.invitations.push(
    {
      id: '019a3000-0000-7000-8000-000000000101',
      list_id: incoming.id,
      list_name: incoming.name,
      email: 'shared-e2e@example.com',
      role: 'editor',
      status: 'pending',
      invited_by: OWNER,
      invited_by_email: 'owner@example.com',
      revision: 1,
      created_at: NOW,
      updated_at: NOW,
    },
    {
      id: '019a3000-0000-7000-8000-000000000102',
      list_id: incoming.id,
      list_name: '不需要的清单',
      email: 'shared-e2e@example.com',
      role: 'viewer',
      status: 'pending',
      invited_by: OWNER,
      invited_by_email: 'owner@example.com',
      revision: 1,
      created_at: NOW,
      updated_at: NOW,
    },
  );
  api.lists.set(incoming.id, { ...incoming, role: 'editor' });
  api.invitations[0]!.list_id = incoming.id;
  await mockAuth(page, api);
  await openApp(page);
  await signIn(page);
  await openShared(page);

  const dialog = page.getByRole('dialog');
  const invitation = dialog.locator('.shared-invitation').filter({ hasText: '同事的清单' });
  await expect(invitation).toContainText('owner@example.com');
  await expect(invitation).toContainText('可编辑');
  await invitation.getByRole('button', { name: '接受' }).click();
  await expect(dialog.locator('.shared-invitation')).toHaveCount(1);
  await expect(dialog.getByRole('button', { name: /同事的清单/ })).toBeVisible();

  await dialog
    .locator('.shared-invitation')
    .filter({ hasText: '不需要的清单' })
    .getByRole('button', { name: '拒绝' })
    .click();
  await expect(dialog.locator('.shared-invitation')).toHaveCount(0);
  expect(api.invitations).toHaveLength(0);
});

test('viewers and removed members get read-only shared lists', async ({ page }) => {
  const api = new MockSharedApi();
  const viewerList = api.addList('只读分享', 'viewer');
  api.addTask(viewerList.id, '只读任务');
  const revoked = api.addList('会被移除');
  api.addTask(revoked.id, '历史任务');
  await mockAuth(page, api);
  await openApp(page);
  await signIn(page);
  await openShared(page);

  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: /只读分享/ }).click();
  const addInput = dialog.getByRole('textbox', { name: '添加共享任务' });
  await expect(addInput).toBeDisabled();
  await expect(dialog.getByRole('button', { name: '标记为完成' })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: '邀请成员邮箱' })).toHaveCount(0);

  await expect(dialog.getByLabel('邀请成员邮箱')).toHaveCount(0);
  await expect(dialog.getByText('只读成员')).toBeVisible();

  // Membership removed while the dialog is open: the copy turns read-only.
  api.lists.delete(revoked.id);
  api.revoked.add(revoked.id);
  await dialog.getByRole('button', { name: '刷新共享清单' }).click();
  await expect(dialog.locator('.shared-list-item').filter({ hasText: '会被移除' })).toContainText(
    '已移出',
    { timeout: 15_000 },
  );
  await dialog.getByRole('button', { name: /会被移除/ }).click();
  await expect(dialog).toContainText('你已被移出这个共享清单');
  await expect(dialog).toContainText('历史任务');
  await expect(dialog.getByRole('textbox', { name: '添加共享任务' })).toHaveCount(0);

  // Deleting the local copy removes it from the sidebar.
  page.once('dialog', (confirmation) => void confirmation.accept());
  await dialog.getByRole('button', { name: '删除本机副本' }).click();
  await expect(dialog.locator('.shared-list-item').filter({ hasText: '会被移除' })).toHaveCount(0);
});
