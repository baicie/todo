#!/usr/bin/env node
/**
 * Production smoke test for the To Do API.
 *
 * Health and observability checks always run. Authenticated checks run when
 * SMOKE_EMAIL and SMOKE_CODE are supplied; in development SMOKE_CODE defaults
 * to AUTH_DEV_CODE (246810).
 *
 * Usage:
 *   API_URL=https://todo.example.com SMOKE_EMAIL=ops@example.com SMOKE_CODE=123456 \
 *     node scripts/ops/smoke.mjs
 */
import { randomUUID } from 'node:crypto';
import process from 'node:process';

const apiUrl = (process.env.API_URL ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
const email = process.env.SMOKE_EMAIL;
const code =
  process.env.SMOKE_CODE ?? (process.env.APP_ENV === 'production' ? undefined : '246810');
const checks = [];
let failed = false;

async function request(path, options = {}) {
  const started = Date.now();
  const response = await fetch(`${apiUrl}${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(options.headers ?? {}),
    },
  });
  const text = await response.text();
  return { response, text, latencyMs: Date.now() - started };
}

async function check(name, fn) {
  try {
    const detail = await fn();
    checks.push({ name, ok: true, ...detail });
  } catch (error) {
    failed = true;
    checks.push({ name, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

await check('healthz', async () => {
  const { response, text } = await request('/healthz');
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = JSON.parse(text);
  if (body.status !== 'ok') throw new Error('status is not ok');
  return { status: response.status };
});

await check('readyz', async () => {
  const { response, text } = await request('/readyz');
  const body = JSON.parse(text);
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${body.status ?? 'not ready'}`);
  if (body.status !== 'ready') throw new Error('status is not ready');
  return { status: response.status, checks: body.checks };
});

await check('metrics', async () => {
  const { response, text } = await request('/metrics');
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if (!text.includes('todo_http_requests_total')) throw new Error('metrics payload missing');
  return { status: response.status };
});

await check('request-id', async () => {
  const { response } = await request('/healthz');
  const requestId = response.headers.get('x-request-id');
  if (!requestId) throw new Error('missing x-request-id response header');
  return { requestId };
});

if (email) {
  await check('auth-and-export', async () => {
    if (!code) throw new Error('SMOKE_CODE is required when SMOKE_EMAIL is set');
    const requested = await request('/api/v1/auth/code/request', {
      method: 'POST',
      body: JSON.stringify({ email }),
    });
    if (requested.response.status !== 202) {
      throw new Error(`code/request returned ${requested.response.status}`);
    }
    const deviceId = randomUUID();
    const verified = await request('/api/v1/auth/code/verify', {
      method: 'POST',
      body: JSON.stringify({
        email,
        code,
        device_id: deviceId,
        platform: 'web',
        device_name: 'ops-smoke',
      }),
    });
    const tokens = JSON.parse(verified.text);
    if (!verified.response.ok || !tokens.access_token) {
      throw new Error(`code/verify returned ${verified.response.status}`);
    }
    const authorization = { authorization: `Bearer ${tokens.access_token}` };
    const exported = await request('/api/v1/export', { headers: authorization });
    if (!exported.response.ok) throw new Error(`export returned ${exported.response.status}`);
    const sync = await request('/api/v1/sync', {
      method: 'POST',
      headers: authorization,
      body: JSON.stringify({
        device_id: deviceId,
        cursor: '0',
        ops: [],
        limit: 1,
      }),
    });
    if (sync.response.status !== 200) {
      throw new Error(`sync returned ${sync.response.status}`);
    }
    const push = await request('/api/v1/push/config', { headers: authorization });
    if (!push.response.ok) throw new Error(`push/config returned ${push.response.status}`);
    return {
      exportStatus: exported.response.status,
      syncStatus: sync.response.status,
      pushStatus: push.response.status,
    };
  });
}

console.log(JSON.stringify({ apiUrl, checked: checks.length, failed, checks }, null, 2));
if (failed) process.exit(1);
