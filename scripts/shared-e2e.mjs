#!/usr/bin/env node
/**
 * Real shared-list E2E against a local API backed by PostgreSQL.
 *
 * Two accounts cover the owner/editor flows, a third covers invitation abuse.
 * Every assertion here is made through the HTTP API only: permission and
 * revision checks are the server's, not a client flag's.
 *
 * Requires AUTH_DEV_CODE (default 246810) and a development/test AppEnv.
 * Usage: API_URL=http://127.0.0.1:8787 SMOKE_CODE=246810 node scripts/shared-e2e.mjs
 */
import { randomUUID } from 'node:crypto';

const base = (process.env.API_URL ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
const code = process.env.SMOKE_CODE ?? '246810';

const must = (condition, message) => {
  if (!condition) throw new Error(message);
};

/** Sends a request and returns the status and parsed body without throwing. */
async function send(path, init = {}, token) {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: response.status, body, text };
}

async function json(path, init = {}, token) {
  const reply = await send(path, init, token);
  if (reply.status < 200 || reply.status >= 300) {
    throw new Error(`${init.method ?? 'GET'} ${path}: ${reply.status} ${reply.text}`);
  }
  return reply.body;
}

async function login(email) {
  await json('/api/v1/auth/code/request', {
    method: 'POST',
    body: JSON.stringify({ email }),
  });
  return json('/api/v1/auth/code/verify', {
    method: 'POST',
    body: JSON.stringify({
      email,
      code,
      device_id: randomUUID(),
      platform: 'web',
      device_name: 'shared-smoke',
    }),
  });
}

const expectCode = (reply, status, codeName, context) => {
  must(
    reply.status === status && reply.body?.code === codeName,
    `${context}: expected ${status} ${codeName}, got ${reply.status} ${reply.text}`,
  );
};

const suffix = Math.random().toString(36).slice(2, 8);
const emailA = `shared-a-${suffix}@example.com`;
const emailB = `shared-b-${suffix}@example.com`;
const emailC = `shared-c-${suffix}@example.com`;
const a = await login(emailA);
const b = await login(emailB);
const c = await login(emailC);
const authA = a.access_token;
const authB = b.access_token;
const authC = c.access_token;

const list = await json(
  '/api/v1/shared/lists',
  {
    method: 'POST',
    body: JSON.stringify({ name: 'Smoke 共享清单' }),
  },
  authA,
);
const invite = await json(
  `/api/v1/shared/lists/${list.id}/members`,
  {
    method: 'POST',
    body: JSON.stringify({ email: emailB, role: 'editor', revision: list.revision }),
  },
  authA,
);
// Membership only exists after B accepts the pending invitation.
const invitationsB = await json('/api/v1/shared/invitations', {}, authB);
const acceptedInvitation = invitationsB.find((item) => item.id === invite.id);
if (!acceptedInvitation) throw new Error('pending invitation not visible to invitee');
const accepted = await json(
  `/api/v1/shared/invitations/${invite.id}/accept`,
  { method: 'POST', body: JSON.stringify({ op_id: randomUUID() }) },
  authB,
);
if (accepted.id !== list.id) throw new Error('accept did not return the shared list');
const snapshotB = await json(`/api/v1/shared/lists/${list.id}`, {}, authB);
const task = await json(
  `/api/v1/shared/lists/${list.id}/tasks`,
  {
    method: 'POST',
    body: JSON.stringify({ title: 'B 创建的任务', revision: snapshotB.revision }),
  },
  authB,
);
const snapshotA = await json(`/api/v1/shared/lists/${list.id}`, {}, authA);
let conflict = null;
try {
  await json(
    `/api/v1/shared/lists/${list.id}/tasks/${task.id}`,
    {
      method: 'PATCH',
      body: JSON.stringify({ title: 'stale', revision: snapshotB.revision }),
    },
    authA,
  );
} catch (error) {
  conflict = String(error.message);
}
if (!conflict?.includes('409')) throw new Error('expected revision conflict from stale write');
if (!snapshotA.tasks.some((item) => item.id === task.id))
  throw new Error('editor task not visible to owner');
if (invite.role !== 'editor') throw new Error('invite did not return editor role');
// Removing B turns every later request into 403 SHARED_LIST_ACCESS_REVOKED.
await json(
  `/api/v1/shared/lists/${list.id}/members/${snapshotA.members.find((member) => member.email === emailB).user_id}`,
  { method: 'DELETE', headers: { 'if-match': `"${snapshotA.revision}"` } },
  authA,
);
let revoked = null;
try {
  await json(`/api/v1/shared/lists/${list.id}`, {}, authB);
} catch (error) {
  revoked = String(error.message);
}
if (!revoked?.includes('403')) throw new Error('expected 403 for a removed member');

// --- Multi-session integrity on a second list -------------------------------
const second = await json(
  '/api/v1/shared/lists',
  { method: 'POST', body: JSON.stringify({ name: 'E2E 并发与回放' }) },
  authA,
);
const list2 = `/api/v1/shared/lists/${second.id}`;
const inviteB2 = await json(
  `${list2}/members`,
  {
    method: 'POST',
    body: JSON.stringify({ email: emailB, role: 'editor', revision: second.revision }),
    headers: { 'if-match': `"${second.revision}"` },
  },
  authA,
);
await json(
  `/api/v1/shared/invitations/${inviteB2.id}/accept`,
  { method: 'POST', body: JSON.stringify({ op_id: randomUUID() }) },
  authB,
);
let current = await json(list2, {}, authA);

// A lost acknowledgement: the create lands, then the same op_id is replayed
// after another member has written, so the receipt's revision is not adjacent.
const createOp = randomUUID();
const taskId = randomUUID();
const created = await json(
  `${list2}/tasks`,
  {
    method: 'POST',
    headers: { 'if-match': `"${current.revision}"` },
    body: JSON.stringify({
      id: taskId,
      title: '只应出现一次',
      note: 'ack lost',
      op_id: createOp,
      revision: current.revision,
    }),
  },
  authA,
);
must(created.id === taskId, 'create returned a different task id');
must(created.revision === current.revision + 1, 'create did not bump the revision once');
const createdRevision = created.revision;
await json(
  `${list2}/tasks`,
  {
    method: 'POST',
    headers: { 'if-match': `"${createdRevision}"` },
    body: JSON.stringify({ title: 'B 的并发任务', revision: createdRevision }),
  },
  authB,
);
current = await json(list2, {}, authA);
must(current.revision === createdRevision + 1, 'editor write did not bump the revision');
const replay = await send(
  `${list2}/tasks`,
  {
    method: 'POST',
    headers: { 'if-match': `"${createdRevision}"` },
    body: JSON.stringify({
      id: taskId,
      title: '被篡改的标题',
      op_id: createOp,
      revision: createdRevision,
    }),
  },
  authA,
);
if (replay.status !== 200 || replay.body?.id !== taskId || replay.body?.title !== '只应出现一次') {
  throw new Error(
    `replayed intent after a lost ack must return the original task: ${replay.status} ${replay.text}`,
  );
}
const afterReplay = await json(list2, {}, authA);
must(
  afterReplay.revision === current.revision,
  'a replayed receipt must not bump the list revision',
);
must(
  afterReplay.tasks.filter((item) => item.id === taskId).length === 1,
  'the replayed create duplicated the task',
);

// Another actor cannot reuse the op_id.
const stolen = await send(
  `${list2}/tasks/${taskId}`,
  {
    method: 'PATCH',
    body: JSON.stringify({ title: 'stolen', op_id: createOp, revision: afterReplay.revision }),
  },
  authB,
);
expectCode(stolen, 409, 'OP_ID_CONFLICT', 'another actor reusing an op_id');

// Two members write against the same revision: exactly one wins, one sees 409.
const before = await json(list2, {}, authA);
const [writeA, writeB] = await Promise.all([
  send(
    `${list2}/tasks/${taskId}`,
    {
      method: 'PATCH',
      body: JSON.stringify({ status: 'completed', revision: before.revision }),
    },
    authA,
  ),
  send(
    `${list2}/tasks/${taskId}`,
    {
      method: 'PATCH',
      body: JSON.stringify({ important: true, revision: before.revision }),
    },
    authB,
  ),
]);
const outcomes = [writeA, writeB].map((reply) => reply.status).sort((x, y) => x - y);
must(
  outcomes[0] === 200 && outcomes[1] === 409,
  `concurrent writes must yield one 200 and one 409, got ${outcomes.join(',')}`,
);
const loser = writeA.status === 409 ? writeA : writeB;
must(
  loser.body?.code === 'REVISION_CONFLICT' && loser.body?.current_revision === before.revision + 1,
  `losing write must report REVISION_CONFLICT with the current revision, got ${loser.text}`,
);

// A pending invitation may only be answered by its own address.
current = await json(list2, {}, authA);
const inviteC = await json(
  `${list2}/members`,
  {
    method: 'POST',
    headers: { 'if-match': `"${current.revision}"` },
    body: JSON.stringify({ email: emailC, role: 'viewer', revision: current.revision }),
  },
  authA,
);
for (const action of ['accept', 'decline']) {
  const abuse = await send(
    `/api/v1/shared/invitations/${inviteC.id}/${action}`,
    { method: 'POST', body: JSON.stringify({ op_id: randomUUID() }) },
    authB,
  );
  expectCode(abuse, 404, 'SHARED_INVITATION_NOT_FOUND', `another account ${action}ing an invite`);
}
const cInbox = await json('/api/v1/shared/invitations', {}, authC);
must(
  cInbox.some((item) => item.id === inviteC.id),
  'invitee cannot see its own pending invitation',
);
await json(
  `/api/v1/shared/invitations/${inviteC.id}/accept`,
  { method: 'POST', body: JSON.stringify({ op_id: randomUUID() }) },
  authC,
);
current = await json(list2, {}, authC);
must(current.list.role === 'viewer', 'accepted viewer role not reported by the snapshot');
const viewerWrite = await send(
  `${list2}/tasks`,
  {
    method: 'POST',
    body: JSON.stringify({ title: 'viewer write', revision: current.revision }),
  },
  authC,
);
expectCode(viewerWrite, 403, 'SHARED_LIST_FORBIDDEN', 'viewer write');

// Logging out revokes the access token for shared routes immediately.
await json('/api/v1/auth/logout', { method: 'POST', body: JSON.stringify({}) }, authA);
const stale = await send('/api/v1/shared/lists', {}, authA);
must(stale.status === 401, `a logged-out token must be rejected, got ${stale.status}`);
const stillB = await send('/api/v1/shared/lists', {}, authB);
must(stillB.status === 200, `another session must survive A's logout, got ${stillB.status}`);

console.log(
  JSON.stringify(
    {
      listId: list.id,
      members: snapshotA.members.length,
      tasks: snapshotA.tasks.length,
      revision: snapshotA.revision,
      conflictRejected: true,
      lostAckReplayedOnce: true,
      opIdConflict: true,
      concurrentWrite: 'one-200-one-409',
      crossAccountInvitation: 'hidden-and-refused',
      viewerWrite: 'forbidden',
      logoutRevokesAccessToken: true,
    },
    null,
    2,
  ),
);
