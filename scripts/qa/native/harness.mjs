import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

const artifactRoot = process.env.QA_ARTIFACT_ROOT;
const cdpPort = process.env.QA_CDP_PORT || '9345';
const cdp = `http://127.0.0.1:${cdpPort}`;
if (!artifactRoot) throw new Error('QA_ARTIFACT_ROOT is required');

const screenshotDir = path.join(artifactRoot, 'screenshots');
const logDir = path.join(artifactRoot, 'logs');
fs.mkdirSync(screenshotDir, { recursive: true });
fs.mkdirSync(logDir, { recursive: true });

const provenance = {
  generatedAt: new Date().toISOString(),
  gitCommit: process.env.QA_GIT_COMMIT || 'unknown',
  gitBranch: process.env.QA_GIT_BRANCH || 'unknown',
  appExe: process.env.QA_APP_EXE || 'unknown',
  appExeSha256: process.env.QA_APP_SHA256 || null,
  installer: process.env.QA_INSTALLER || null,
  installerSha256: process.env.QA_INSTALLER_SHA256 || null,
};
fs.writeFileSync(path.join(artifactRoot, 'provenance.json'), JSON.stringify(provenance, null, 2));

const timeline = [];
const tests = [];
const performance = { generatedAt: new Date().toISOString(), samples: [] };
const harnessLog = [];
const started = Date.now();

function log(message) {
  const line = `${new Date().toISOString()} ${message}`;
  harnessLog.push(line);
  console.log(line);
}

function event(name, detail = {}) {
  timeline.push({ at: new Date().toISOString(), elapsedMs: Date.now() - started, name, ...detail });
}

class Skip extends Error {}
const skip = (message) => {
  throw new Skip(message);
};

async function run(name, fn) {
  const begin = Date.now();
  event(`test_start:${name}`);
  try {
    const value = await fn();
    const record = {
      name,
      status: 'PASS',
      durationMs: Date.now() - begin,
      ...(value && typeof value === 'object' ? { detail: value } : {}),
    };
    tests.push(record);
    event(`test_pass:${name}`, { durationMs: record.durationMs });
    log(`PASS ${name} ${record.durationMs}ms`);
    return record;
  } catch (error) {
    if (error instanceof Skip) {
      tests.push({ name, status: 'NOT_RUN', durationMs: Date.now() - begin, detail: error.message });
      event(`test_not_run:${name}`, { reason: error.message });
      log(`NOT_RUN ${name}: ${error.message}`);
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    tests.push({ name, status: 'FAIL', durationMs: Date.now() - begin, error: message });
    event(`test_fail:${name}`, { error: message });
    log(`FAIL ${name}: ${message}`);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function connect() {
  let lastError;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const browser = await chromium.connectOverCDP(cdp, { timeout: 3000 });
      const page = browser
        .contexts()
        .flatMap((context) => context.pages())
        .find((candidate) => candidate.url().includes('tauri.localhost'));
      if (page) return { browser, page };
      await browser.close().catch(() => {});
    } catch (error) {
      lastError = error;
    }
    await sleep(500);
  }
  throw new Error(`CDP unavailable at ${cdp}: ${lastError?.message ?? 'timeout'}`);
}

function unwrap(result, label) {
  if (!result?.ok) throw new Error(`${label} failed: ${JSON.stringify(result?.error)}`);
  return result.value;
}

async function invoke(page, command, args = {}) {
  return page.evaluate(
    async ({ command, args }) => {
      try {
        return { ok: true, value: await window.__TAURI_INTERNALS__.invoke(command, args) };
      } catch (error) {
        return {
          ok: false,
          error: typeof error === 'string' ? error : error?.message ?? String(error),
        };
      }
    },
    { command, args },
  );
}

async function storage(page, action, payload = {}) {
  return invoke(page, 'todo_storage', { request: { action, payload } });
}

const { browser, page } = await connect();
event('cdp_connected', { url: page.url() });
await page.waitForFunction(
  () => document.readyState === 'complete' && Boolean(window.__TAURI_INTERNALS__),
  undefined,
  { timeout: 30000 },
);

// P0 guard: never run credential writes, task imports or fault probes until
// the binary proves it is the QA build. A production binary returns isQa=false.
const identityResult = await invoke(page, 'qa_build_identity');
const identity = identityResult.ok ? identityResult.value : null;
const identityOk =
  identity?.isQa === true &&
  identity.identifier === 'app.shishi.todo.qa' &&
  identity.credentialService === 'app.shishi.todo.rc2d-qa.secure-token' &&
  identity.faultInjectionEnabled === true &&
  String(identity.dataRoot).toLowerCase().endsWith('app.shishi.todo.qa');
if (!identityOk) {
  const message = `QA identity guard failed: ${JSON.stringify(identityResult)}`;
  const failure = {
    generatedAt: new Date().toISOString(),
    status: 'FAIL',
    counts: { PASS: 0, FAIL: 1, NOT_RUN: 0 },
    tests: [{ name: 'qa_build_identity', status: 'FAIL', durationMs: 0, error: message }],
  };
  fs.writeFileSync(path.join(artifactRoot, 'tests.json'), JSON.stringify(failure, null, 2));
  fs.writeFileSync(
    path.join(artifactRoot, 'summary.md'),
    `# RC2-D Native QA Run

- Status: **FAIL**
- ${message}

No destructive QA fixture was executed.
`,
  );
  fs.writeFileSync(path.join(logDir, 'harness.jsonl'), `${message}
`);
  await browser.close().catch(() => {});
  process.exit(1);
}
tests.push({
  name: 'qa_build_identity',
  status: 'PASS',
  durationMs: 0,
  detail: {
    identifier: identity.identifier,
    dataRoot: identity.dataRoot,
    credentialService: identity.credentialService,
  },
});
event('qa_build_identity_verified', { identifier: identity.identifier });

await run('qa_boot_context', async () => {
  const context = unwrap(await invoke(page, 'native_account_context'), 'native_account_context');
  const status = unwrap(await invoke(page, 'native_account_switch_status'), 'native_account_switch_status');
  if (!context?.accountId) throw new Error('missing accountId');
  if (status?.active !== true) throw new Error(`unexpected switch status ${JSON.stringify(status)}`);
  return {
    accountId: context.accountId,
    kind: context.kind,
    switchPhase: status.phase,
    dataRoot: path.join(process.env.APPDATA || '', 'app.shishi.todo.qa'),
  };
});

await run('qa_storage_roundtrip', async () => {
  unwrap(await storage(page, 'initialize'), 'storage initialize');
  const title = `QA roundtrip ${Date.now()}`;
  const created = unwrap(await storage(page, 'create_task', { input: { title } }), 'create_task');
  if (!created?.id) throw new Error('create_task returned no id');
  const loaded = unwrap(await storage(page, 'get_task', { id: created.id }), 'get_task');
  if (loaded?.title !== title) throw new Error('get_task returned another title');
  const counts = unwrap(
    await storage(page, 'get_counts', { localDate: new Date().toISOString().slice(0, 10) }),
    'get_counts',
  );
  return { taskId: created.id, allCount: counts?.all, title };
});

await run('qa_reminder_permission_contract', async () => {
  const permission = unwrap(await invoke(page, 'reminder_permission'), 'reminder_permission');
  if (permission !== 'granted') skip(`desktop notification permission is ${permission}`);
  return { permission };
});

await run('qa_reminder_schedule_cancel', async () => {
  const permission = unwrap(await invoke(page, 'reminder_permission'), 'reminder_permission');
  if (permission !== 'granted') skip(`desktop notification permission is ${permission}`);
  const reminderId = `qa-reminder-${Date.now()}`;
  const fireAtUtc = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const mode = unwrap(
    await invoke(page, 'schedule_reminder', {
      reminderId,
      fireAtUtc,
      title: 'QA reminder',
      body: 'QA isolated reminder',
      exact: false,
    }),
    'schedule_reminder',
  );
  if (!['scheduled', 'exact', 'inexact'].includes(mode)) {
    throw new Error(`unexpected reminder mode ${mode}`);
  }
  unwrap(await invoke(page, 'cancel_reminder', { reminderId }), 'cancel_reminder');
  return { reminderId, mode };
});

await run('qa_credential_namespace', async () => {
  const context = unwrap(await invoke(page, 'native_account_context'), 'context');
  const forbiddenKey = `qa:rc2d:probe:${Date.now()}`;
  const forbidden = await invoke(page, 'secure_token_set', {
    key: forbiddenKey,
    value: 'qa-probe-value-not-a-real-token',
  });
  if (forbidden.ok) throw new Error('non-account credential key was unexpectedly accepted');
  // The active account key is the only key the command policy exposes. The QA
  // credential service namespace is still separate from production.
  const key = `cloud-refresh:${context.accountId}`;
  const value = 'qa-probe-value-not-a-real-token';
  unwrap(await invoke(page, 'secure_token_set', { key, value }), 'secure_token_set');
  const read = unwrap(await invoke(page, 'secure_token_get', { key }), 'secure_token_get');
  if (read !== value) throw new Error('credential readback mismatch');
  unwrap(await invoke(page, 'secure_token_remove', { key }), 'secure_token_remove');
  const removed = unwrap(await invoke(page, 'secure_token_get', { key }), 'secure_token_get_removed');
  if (removed !== null) throw new Error('credential was not removed');
  return {
    service: 'app.shishi.todo.rc2d-qa.secure-token',
    rejectedKey: 'cross-account key',
    activeKey: key,
  };
});

await run('qa_invalid_switch_does_not_change_active_account', async () => {
  const before = unwrap(await invoke(page, 'native_account_context'), 'context before');
  const prepared = await invoke(page, 'native_prepare_account_switch', {
    targetAccountId: '01a1673d-1000-7000-8000-deadbeef0000',
  });
  if (prepared.ok) throw new Error('preparing an unregistered target unexpectedly succeeded');
  const after = unwrap(await invoke(page, 'native_account_context'), 'context after');
  if (after.accountId !== before.accountId) throw new Error('active account changed after rejected switch');
  return { error: prepared.error, activeAccountId: after.accountId };
});

await run('qa_desktop_notification_action_target', async () => {
  skip('covered by Rust unit tests; real toast click requires a logged-in account and desktop interaction');
});

await run('qa_wrong_account_notification_is_rejected', async () => {
  skip('requires two isolated cloud accounts and an interactive toast; not fabricated');
});

await run('qa_fault_injection_prepared_recovery', async () => {
  if (!process.env.QA_FAULT_CONFIG) skip('no fault config was armed');
  const before = unwrap(await invoke(page, 'native_account_context'), 'context before fault');
  const email = `qa-fault-${Date.now()}@example.test`;
  const account = unwrap(
    await invoke(page, 'native_create_account', {
      email,
      apiUrl: 'https://qa.example.test',
    }),
    'native_create_account',
  );
  const prepared = await invoke(page, 'native_prepare_account_switch', {
    targetAccountId: account.id,
  });
  if (prepared.ok) throw new Error('fault point did not abort switch preparation');
  const status = unwrap(await invoke(page, 'native_account_switch_status'), 'switch status');
  // The command path aborts a failed prepare; a raw journal may also be left for
  // startup recovery. Both are safe as long as the active account and gate are
  // restored and the injected point is recorded.
  if (status.phase === 'PREPARED') {
    const abort = await invoke(page, 'native_abort_account_switch');
    if (!abort.ok) throw new Error(`abort after injected prepare failed: ${abort.error}`);
  }
  const after = unwrap(await invoke(page, 'native_account_context'), 'context after abort');
  if (after.accountId !== before.accountId) throw new Error('active account changed during fault recovery');
  return {
    faultPoint: 'switch_prepared_persisted',
    error: prepared.error,
    journalPhaseAfterRecovery: status.phase,
    accountId: account.id,
  };
});

await run('qa_fault_evidence', async () => {
  const configPath = process.env.QA_FAULT_CONFIG;
  if (!configPath || !fs.existsSync(configPath)) {
    skip('no --rc2d-fault-config run was requested');
  }
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const evidencePath = config.evidencePath || process.env.QA_FAULT_EVIDENCE;
  if (!evidencePath || !fs.existsSync(evidencePath)) {
    throw new Error('fault config was armed but no evidence file was written');
  }
  fs.copyFileSync(evidencePath, path.join(artifactRoot, 'fault-evidence.jsonl'));
  const lines = fs.readFileSync(evidencePath, 'utf8').split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) throw new Error('fault evidence file exists but is empty');
  let parsed = 0;
  for (const line of lines) {
    const item = JSON.parse(line);
    if (!item.eventId || !item.point || !item.result) throw new Error('malformed fault evidence');
    parsed += 1;
  }
  return { evidenceFile: 'fault-evidence.jsonl', records: parsed };
});

const perfTasks = Number(process.env.QA_PERF_TASKS || 0);
if (perfTasks > 0) {
  await run('qa_performance_create_tasks', async () => {
    unwrap(await storage(page, 'initialize'), 'storage initialize');
    const begin = Date.now();
    let lastCount;
    for (let index = 0; index < perfTasks; index += 1) {
      unwrap(
        await storage(page, 'create_task', {
          input: { title: `QA perf ${perfTasks} task ${String(index).padStart(6, '0')}` },
        }),
        `create_task ${index}`,
      );
    }
    const elapsedMs = Date.now() - begin;
    lastCount = unwrap(
      await storage(page, 'get_counts', { localDate: new Date().toISOString().slice(0, 10) }),
      'get_counts',
    );
    performance.samples.push({
      scenario: `create_${perfTasks}`,
      iterations: 1,
      tasks: perfTasks,
      elapsedMs,
      p50Ms: elapsedMs,
      p95Ms: elapsedMs,
      allCount: lastCount?.all,
    });
    return { tasks: perfTasks, elapsedMs, perTaskMs: elapsedMs / perfTasks };
  });
}

try {
  await page.screenshot({ path: path.join(screenshotDir, 'qa-final.png'), fullPage: false });
  event('screenshot_saved', { file: 'screenshots/qa-final.png' });
} catch (error) {
  log(`screenshot failed: ${error.message}`);
}

const counts = {
  PASS: tests.filter((test) => test.status === 'PASS').length,
  FAIL: tests.filter((test) => test.status === 'FAIL').length,
  NOT_RUN: tests.filter((test) => test.status === 'NOT_RUN').length,
};
const status = counts.FAIL > 0 ? 'FAIL' : counts.NOT_RUN > 0 ? 'PARTIAL' : 'PASS';
const summary = [
  '# RC2-D Native QA Run',
  '',
  `- Run: \`${process.env.QA_RUN_ID || 'unknown'}\``,
  `- App: \`${process.env.QA_APP_EXE || 'unknown'}\``,
  `- Status: **${status}**`,
  `- Tests: ${counts.PASS} PASS / ${counts.FAIL} FAIL / ${counts.NOT_RUN} NOT_RUN`,
  `- Duration: ${Date.now() - started} ms`,
  '',
  '## Tests',
  '',
  '| Test | Status | Duration | Detail |',
  '| --- | --- | ---: | --- |',
  ...tests.map((test) => {
    const detail = test.error || test.detail?.reason || test.detail?.message || '';
    return `| ${test.name} | ${test.status} | ${test.durationMs} ms | ${String(detail).replace(/\|/g, '\\|').slice(0, 160)} |`;
  }),
  '',
  'NOT_RUN is not a pass. Real toast click and two-account notification routing require an interactive desktop account fixture.',
].join('\n');

fs.writeFileSync(path.join(artifactRoot, 'tests.json'), JSON.stringify({ generatedAt: new Date().toISOString(), status, counts, tests }, null, 2));
fs.writeFileSync(path.join(artifactRoot, 'timeline.json'), JSON.stringify(timeline, null, 2));
fs.writeFileSync(path.join(artifactRoot, 'performance.json'), JSON.stringify(performance, null, 2));
fs.writeFileSync(path.join(artifactRoot, 'summary.md'), summary);
fs.writeFileSync(path.join(logDir, 'harness.jsonl'), `${harnessLog.join('\n')}\n`);

await browser.close().catch(() => {});
process.exit(counts.FAIL > 0 ? 1 : 0);
