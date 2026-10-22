#!/usr/bin/env node
/** Real shared-list smoke against a local API with AUTH_DEV_CODE=246810. */
import { randomUUID } from 'node:crypto';

const base = (process.env.API_URL ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
const code = process.env.SMOKE_CODE ?? '246810';

async function json(path, init = {}, token) {
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
  if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${path}: ${response.status} ${text}`);
  return body;
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

const suffix = Math.random().toString(36).slice(2, 8);
const emailA = `shared-a-${suffix}@example.com`;
const emailB = `shared-b-${suffix}@example.com`;
const a = await login(emailA);
const b = await login(emailB);
const authA = a.access_token;
const authB = b.access_token;

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

console.log(
  JSON.stringify(
    {
      listId: list.id,
      members: snapshotA.members.length,
      tasks: snapshotA.tasks.length,
      revision: snapshotA.revision,
      conflictRejected: true,
    },
    null,
    2,
  ),
);
