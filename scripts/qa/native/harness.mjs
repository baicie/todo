import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import {
  assertNoUnobservableClaims,
  buildLayerReport,
  deliveryClaims,
  layerSummary,
  notificationAdvanced,
  notificationDeltaMs,
  NOTIFICATIONS_SETTINGS_KEY,
  pollUntil,
  readAppendedText,
  readNotificationSettings,
  reminderAttemptLines,
  setLayer,
} from './reminder-observer.mjs';

const artifactRoot = process.env.QA_ARTIFACT_ROOT;
const cdpPort = process.env.QA_CDP_PORT || '9345';
const cdp = `http://127.0.0.1:${cdpPort}`;
if (!artifactRoot) throw new Error('QA_ARTIFACT_ROOT is required');

const screenshotDir = path.join(artifactRoot, 'screenshots');
const logDir = path.join(artifactRoot, 'logs');
fs.mkdirSync(screenshotDir, { recursive: true });
fs.mkdirSync(logDir, { recursive: true });

// RC2-D.15 Phase B: Windows records notifications per AUMID under the user's
// notification settings key, and run-windows.ps1 redirects the QA app's stderr
// into this log directory, so both sides of "did a reminder actually reach the
// platform" are observable without a screen.
const QA_NOTIFICATION_AUMID = 'app.shishi.todo.qa';
const appStderrPath = path.join(logDir, 'app.stderr.log');

// RC2-D.14 Phase C: evidence is only meaningful when the binary it exercised
// is recorded together with how it was chosen (explicit -AppExe, freshly
// installed QA build, or discovered). run-windows.ps1 exports these from the
// harness-target.mjs decision and writes that decision next to this file.
const provenance = {
  generatedAt: new Date().toISOString(),
  policyVersion: process.env.QA_TARGET_POLICY || 'unknown',
  gitCommit: process.env.QA_GIT_COMMIT || 'unknown',
  gitBranch: process.env.QA_GIT_BRANCH || 'unknown',
  targetSelection: process.env.QA_TARGET_SELECTION || 'unknown',
  targetExplicitlyChosen: process.env.QA_TARGET_EXPLICIT === 'True',
  appExe: process.env.QA_APP_EXE || 'unknown',
  appExeProductName: process.env.QA_APP_PRODUCT_NAME || null,
  appExeProductVersion: process.env.QA_APP_PRODUCT_VERSION || null,
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
      tests.push({
        name,
        status: 'NOT_RUN',
        durationMs: Date.now() - begin,
        detail: error.message,
      });
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
          error: typeof error === 'string' ? error : (error?.message ?? String(error)),
        };
      }
    },
    { command, args },
  );
}

async function storage(page, action, payload = {}) {
  return invoke(page, 'todo_storage', { request: { action, payload } });
}

function currentLogOffset(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

// One machine-readable block per reminder case: every layer with its status and
// the evidence that justifies it. The interaction layers are asserted to stay
// NOT_RUN here instead of trusting each call site.
function recordReminderLayers(test, layers, extra = {}) {
  assertNoUnobservableClaims(layers);
  const payload = {
    generatedAt: new Date().toISOString(),
    test,
    aumid: QA_NOTIFICATION_AUMID,
    registryKey: NOTIFICATIONS_SETTINGS_KEY + '\\' + QA_NOTIFICATION_AUMID,
    summary: layerSummary(layers),
    deliveryClaims: deliveryClaims(layers),
    layers,
    ...extra,
  };
  const file = test + '.layers.json';
  fs.writeFileSync(path.join(artifactRoot, file), JSON.stringify(payload, null, 2));
  log(test + ' layers: ' + payload.summary);
  if (payload.deliveryClaims.length > 0) {
    log(test + ' delivery claims: ' + payload.deliveryClaims.join(', '));
  }
  event(test + '_layers', { file, deliveryClaims: payload.deliveryClaims });
  return payload;
}

// A bounded, state-polling observation window. It probes the per-AUMID registry
// counter and the app's own platform diagnostics, and returns the moment either
// side says something instead of sleeping for the whole bound.
async function observeReminderDelivery({ baseline, stderrOffset, timeoutMs, stopOnAttempt }) {
  const result = await pollUntil({
    timeoutMs,
    intervalMs: 2500,
    probe: () => {
      const settings = readNotificationSettings(QA_NOTIFICATION_AUMID);
      const appended = readAppendedText(appStderrPath, stderrOffset);
      return {
        settings,
        advanced: notificationAdvanced(baseline, settings),
        deltaMs: notificationDeltaMs(baseline, settings),
        attemptLines: reminderAttemptLines(appended.text),
        stderrPresent: appended.exists,
      };
    },
    satisfied: (state) => state.advanced || (stopOnAttempt && state.attemptLines.length > 0),
  });
  return {
    satisfied: result.satisfied,
    polls: result.polls,
    elapsedMs: result.elapsedMs,
    settings: result.last.settings,
    advanced: result.last.advanced,
    deltaMs: result.last.deltaMs,
    attemptLines: result.last.attemptLines,
    stderrPresent: result.last.stderrPresent,
  };
}

// Remove only what the current case created, and report whether it worked.
async function cleanupReminderFixtures({ reminderId, taskId }) {
  const cleanup = { reminderCancelled: false, taskDeleted: false };
  if (reminderId) {
    const cancelled = await invoke(page, 'cancel_reminder', { reminderId });
    cleanup.reminderCancelled = cancelled.ok === true;
    cleanup.cancelDetail = cancelled.ok ? 'ok' : cancelled.error;
  }
  if (taskId) {
    const deleted = await storage(page, 'delete_task', { id: taskId });
    cleanup.taskDeleted = deleted.ok === true;
    if (!deleted.ok) cleanup.deleteDetail = deleted.error;
  }
  return cleanup;
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
  fs.writeFileSync(
    path.join(logDir, 'harness.jsonl'),
    `${message}
`,
  );
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
  const status = unwrap(
    await invoke(page, 'native_account_switch_status'),
    'native_account_switch_status',
  );
  if (!context?.accountId) throw new Error('missing accountId');
  if (status?.active !== true)
    throw new Error(`unexpected switch status ${JSON.stringify(status)}`);
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

// RC2-D.15 Phase B: qa_reminder_schedule_cancel only proves the queue accepts
// and drops an entry. These cases observe the per-AUMID counter Windows writes
// when it accepts a notification, so delivery stops being NOT_RUN by default.
// A changed counter is evidence for OS_NOTIFICATION_OBSERVED and nothing more:
// no path in this harness can see a banner, the notification center or a click,
// so those four layers stay NOT_RUN even when a toast is accepted.
const REMINDER_FIRE_LEAD_MS = 20000;
const REMINDER_OBSERVATION_BOUND_MS = 120000;
const REMINDER_CANCEL_LEAD_MS = 10000;
const REMINDER_TIMEOUT_CASE_LEAD_MS = 90000;
const REMINDER_TIMEOUT_CASE_BOUND_MS = 20000;

await run('qa_reminder_fires_toast', async () => {
  const layers = buildLayerReport();
  const evidence = {
    aumid: QA_NOTIFICATION_AUMID,
    reminderLeadMs: REMINDER_FIRE_LEAD_MS,
    observationBoundMs: REMINDER_OBSERVATION_BOUND_MS,
  };
  let primaryError = null;
  try {
    const permission = unwrap(await invoke(page, 'reminder_permission'), 'reminder_permission');
    evidence.permission = permission;
    if (permission !== 'granted') {
      skip('desktop notification permission is ' + permission + '; no toast can reach Windows');
    }
    const context = unwrap(await invoke(page, 'native_account_context'), 'native_account_context');
    const baseline = readNotificationSettings(QA_NOTIFICATION_AUMID);
    evidence.registryBefore = baseline;
    if (!baseline.exists) throw new Error('cannot read ' + baseline.key + ': ' + baseline.error);
    if (!baseline.lastNotificationAddedTimeTicks) {
      throw new Error('LastNotificationAddedTime is absent, so no before/after change can be proven');
    }
    const stderrOffset = currentLogOffset(appStderrPath);
    const scheduledAtMs = Date.now();
    const fireAtMs = scheduledAtMs + REMINDER_FIRE_LEAD_MS;
    const fireAtUtc = new Date(fireAtMs).toISOString();
    const title = 'QA reminder fires ' + scheduledAtMs;
    const task = unwrap(await storage(page, 'create_task', { input: { title } }), 'create_task');
    evidence.taskId = task.id;
    evidence.scheduledAt = new Date(scheduledAtMs).toISOString();
    evidence.fireAtUtc = fireAtUtc;
    evidence.reminderId = 'account:' + context.accountId + ':' + task.id;
    const mode = unwrap(
      await invoke(page, 'schedule_reminder', {
        reminderId: task.id,
        fireAtUtc,
        title,
        body: 'QA fire-toast probe',
        exact: false,
      }),
      'schedule_reminder',
    );
    evidence.scheduleMode = mode;
    if (!['scheduled', 'exact', 'inexact'].includes(mode)) {
      setLayer(layers, 'REMINDER_SCHEDULED', 'FAIL', 'schedule_reminder returned ' + mode + ' for a future fireAtUtc ' + fireAtUtc);
      throw new Error('schedule_reminder returned ' + mode + ' instead of arming a future reminder');
    }
    setLayer(layers, 'REMINDER_SCHEDULED', 'PASS', 'armed ' + evidence.reminderId + ' for ' + fireAtUtc + ' (mode ' + mode + '); deliberately not cancelled');
    // No cancel here on purpose: the assertion is that the platform fires it.
    const observation = await observeReminderDelivery({
      baseline,
      stderrOffset,
      timeoutMs: REMINDER_OBSERVATION_BOUND_MS,
      stopOnAttempt: true,
    });
    evidence.observation = {
      satisfied: observation.satisfied,
      polls: observation.polls,
      elapsedMs: observation.elapsedMs,
      appStderrPresent: observation.stderrPresent,
    };
    evidence.filetimeBaselineHex = baseline.lastNotificationAddedTimeHex;
    evidence.filetimeAfterHex = observation.settings.lastNotificationAddedTimeHex;
    evidence.filetimeDeltaMs = observation.deltaMs;
    evidence.notificationAddedAt = observation.settings.lastNotificationAddedAt;
    evidence.notificationAddedAfterFireMs =
      observation.settings.lastNotificationAddedAtMs === null
        ? null
        : observation.settings.lastNotificationAddedAtMs - fireAtMs;
    evidence.registryAfter = observation.settings;
    evidence.appAttemptLines = observation.attemptLines;
    const permissionAfter = await invoke(page, 'reminder_permission');
    const contextAfter = await invoke(page, 'native_account_context');
    evidence.cdpAfter = {
      permission: permissionAfter.ok ? permissionAfter.value : permissionAfter.error,
      accountId: contextAfter.ok ? contextAfter.value?.accountId : contextAfter.error,
    };
    if (observation.advanced) {
      setLayer(layers, 'NATIVE_TRIGGER_FIRED', 'PASS', 'the scheduler thread ran: Windows recorded a notification at ' + observation.settings.lastNotificationAddedAt + ', ' + evidence.notificationAddedAfterFireMs + ' ms after the fire instant ' + fireAtUtc);
      setLayer(layers, 'WINDOWS_API_ACCEPTED', 'PASS', 'Windows advanced LastNotificationAddedTime for ' + QA_NOTIFICATION_AUMID + ': ' + baseline.lastNotificationAddedTimeHex + ' -> ' + observation.settings.lastNotificationAddedTimeHex + ' within ' + observation.elapsedMs + ' ms');
      setLayer(layers, 'OS_NOTIFICATION_OBSERVED', 'PASS', 'per-AUMID counter moved by ' + observation.deltaMs + ' ms and read ' + observation.settings.lastNotificationAddedAt + ' (' + observation.polls + ' polls)');
    } else if (observation.attemptLines.length > 0) {
      const reason = observation.attemptLines.join(' | ');
      setLayer(layers, 'NATIVE_TRIGGER_FIRED', 'PASS', 'the timer thread ran and attempted the platform call: ' + reason);
      setLayer(layers, 'WINDOWS_API_ACCEPTED', 'FAIL', 'the app reported a platform rejection instead of an accepted toast: ' + reason);
      setLayer(layers, 'OS_NOTIFICATION_OBSERVED', 'FAIL', 'LastNotificationAddedTime stayed ' + baseline.lastNotificationAddedTimeHex + ' over ' + observation.polls + ' polls in ' + observation.elapsedMs + ' ms');
      throw new Error('the reminder never reached Windows: ' + reason);
    } else {
      setLayer(layers, 'NATIVE_TRIGGER_FIRED', 'NOT_RUN', 'no observable side effect within ' + observation.elapsedMs + ' ms: the in-process reminder queue has no readback, so a silent trigger cannot be told apart from a trigger that never ran');
      setLayer(layers, 'WINDOWS_API_ACCEPTED', 'FAIL', 'LastNotificationAddedTime stayed ' + baseline.lastNotificationAddedTimeHex + ' for the whole ' + observation.elapsedMs + ' ms window after the fire instant ' + fireAtUtc);
      setLayer(layers, 'OS_NOTIFICATION_OBSERVED', 'FAIL', 'no notification was added for ' + QA_NOTIFICATION_AUMID + ' within the ' + REMINDER_OBSERVATION_BOUND_MS + ' ms bound of a ' + REMINDER_FIRE_LEAD_MS + ' ms deadline');
      throw new Error('no Windows notification appeared within ' + observation.elapsedMs + ' ms (baseline ' + baseline.lastNotificationAddedTimeHex + ', after ' + (observation.settings.lastNotificationAddedTimeHex ?? 'unreadable') + ')');
    }
  } catch (error) {
    primaryError = error;
  }
  const cleanup = await cleanupReminderFixtures({ reminderId: evidence.taskId, taskId: evidence.taskId });
  const report = recordReminderLayers('qa_reminder_fires_toast', layers, { ...evidence, cleanup });
  if (primaryError) throw primaryError;
  if (cleanup.reminderCancelled !== true || cleanup.taskDeleted !== true) {
    throw new Error('QA fixture cleanup incomplete: ' + JSON.stringify(cleanup));
  }
  return { message: report.summary, layers, ...evidence };
});

await run('qa_reminder_cancelled_before_fire', async () => {
  const layers = buildLayerReport();
  const evidence = { aumid: QA_NOTIFICATION_AUMID, cancelLeadMs: REMINDER_CANCEL_LEAD_MS };
  let primaryError = null;
  try {
    const permission = unwrap(await invoke(page, 'reminder_permission'), 'reminder_permission');
    evidence.permission = permission;
    if (permission !== 'granted') skip('desktop notification permission is ' + permission);
    const baseline = readNotificationSettings(QA_NOTIFICATION_AUMID);
    evidence.registryBefore = baseline;
    if (!baseline.exists || !baseline.lastNotificationAddedTimeTicks) {
      throw new Error('cannot read a baseline LastNotificationAddedTime: ' + baseline.key + ' ' + (baseline.error ?? ''));
    }
    const stderrOffset = currentLogOffset(appStderrPath);
    const title = 'QA cancelled reminder ' + Date.now();
    const task = unwrap(await storage(page, 'create_task', { input: { title } }), 'create_task');
    evidence.taskId = task.id;
    const fireAtUtc = new Date(Date.now() + REMINDER_CANCEL_LEAD_MS).toISOString();
    evidence.fireAtUtc = fireAtUtc;
    const mode = unwrap(
      await invoke(page, 'schedule_reminder', {
        reminderId: task.id,
        fireAtUtc,
        title,
        body: 'must never reach Windows',
        exact: false,
      }),
      'schedule_reminder',
    );
    evidence.scheduleMode = mode;
    if (!['scheduled', 'exact', 'inexact'].includes(mode)) {
      setLayer(layers, 'REMINDER_SCHEDULED', 'FAIL', 'schedule_reminder returned ' + mode + ' for ' + fireAtUtc);
      throw new Error('schedule_reminder returned ' + mode + ' instead of arming the reminder');
    }
    // cancel_reminder verifies the platform queue no longer reports the entry,
    // so a successful unwrap is proof the reminder is gone.
    unwrap(await invoke(page, 'cancel_reminder', { reminderId: task.id }), 'cancel_reminder');
    evidence.cancelledAt = new Date().toISOString();
    setLayer(layers, 'REMINDER_SCHEDULED', 'PASS', 'armed for ' + fireAtUtc + ' (mode ' + mode + ') and cancelled at ' + evidence.cancelledAt + '; cancel_reminder verified no residual queue entry');
    const observation = await observeReminderDelivery({
      baseline,
      stderrOffset,
      timeoutMs: REMINDER_CANCEL_LEAD_MS + 12000,
      stopOnAttempt: false,
    });
    evidence.observation = {
      satisfied: observation.satisfied,
      polls: observation.polls,
      elapsedMs: observation.elapsedMs,
      appStderrPresent: observation.stderrPresent,
    };
    evidence.filetimeBaselineHex = baseline.lastNotificationAddedTimeHex;
    evidence.filetimeAfterHex = observation.settings.lastNotificationAddedTimeHex;
    evidence.appAttemptLines = observation.attemptLines;
    evidence.passedFireInstant = Date.now() > Date.parse(fireAtUtc);
    setLayer(layers, 'NATIVE_TRIGGER_FIRED', 'NOT_RUN', 'the reminder was cancelled before its fire instant, so no trigger was expected and none is claimed');
    setLayer(layers, 'WINDOWS_API_ACCEPTED', 'NOT_RUN', 'a cancelled reminder is never meant to reach the Windows notification API');
    if (observation.advanced || observation.attemptLines.length > 0) {
      const detail = observation.advanced
        ? 'LastNotificationAddedTime moved ' + baseline.lastNotificationAddedTimeHex + ' -> ' + observation.settings.lastNotificationAddedTimeHex
        : 'the app logged an attempt: ' + observation.attemptLines.join(' | ');
      setLayer(layers, 'OS_NOTIFICATION_OBSERVED', 'FAIL', 'a cancelled reminder still produced delivery evidence: ' + detail);
      throw new Error('a cancelled reminder still produced delivery evidence: ' + detail);
    }
    setLayer(layers, 'OS_NOTIFICATION_OBSERVED', 'NOT_RUN', 'not observed and not claimed: LastNotificationAddedTime stayed ' + baseline.lastNotificationAddedTimeHex + ' over ' + observation.polls + ' polls in ' + observation.elapsedMs + ' ms, past the fire instant');
    if (!evidence.passedFireInstant) {
      throw new Error('the observation window closed before the fire instant, so "no delivery" was not proven');
    }
  } catch (error) {
    primaryError = error;
  }
  const cleanup = await cleanupReminderFixtures({ reminderId: evidence.taskId, taskId: evidence.taskId });
  const report = recordReminderLayers('qa_reminder_cancelled_before_fire', layers, { ...evidence, cleanup });
  if (primaryError) throw primaryError;
  if (cleanup.taskDeleted !== true) {
    throw new Error('QA fixture cleanup incomplete: ' + JSON.stringify(cleanup));
  }
  return { message: report.summary, layers, ...evidence };
});

await run('qa_reminder_past_fire_time', async () => {
  const layers = buildLayerReport();
  const evidence = { aumid: QA_NOTIFICATION_AUMID, pastOffsetMs: 60000 };
  let primaryError = null;
  try {
    const permission = unwrap(await invoke(page, 'reminder_permission'), 'reminder_permission');
    evidence.permission = permission;
    if (permission !== 'granted') skip('desktop notification permission is ' + permission);
    const baseline = readNotificationSettings(QA_NOTIFICATION_AUMID);
    evidence.registryBefore = baseline;
    if (!baseline.exists || !baseline.lastNotificationAddedTimeTicks) {
      throw new Error('cannot read a baseline LastNotificationAddedTime: ' + baseline.key + ' ' + (baseline.error ?? ''));
    }
    const stderrOffset = currentLogOffset(appStderrPath);
    const title = 'QA past reminder ' + Date.now();
    const task = unwrap(await storage(page, 'create_task', { input: { title } }), 'create_task');
    evidence.taskId = task.id;
    const fireAtUtc = new Date(Date.now() - 60000).toISOString();
    evidence.fireAtUtc = fireAtUtc;
    const result = await invoke(page, 'schedule_reminder', {
      reminderId: task.id,
      fireAtUtc,
      title,
      body: 'fire time already passed',
      exact: false,
    });
    const observedBehaviour = result.ok ? String(result.value) : 'error:' + result.error;
    evidence.observedPastBehaviour = observedBehaviour;
    // DesktopTimerAdapter::schedule (apps/native/src-tauri/src/reminders.rs:144-148)
    // drops a past fire time and answers "skipped-past"; it does not fire
    // immediately. Assert that observed contract instead of assuming either.
    if (observedBehaviour !== 'skipped-past') {
      setLayer(layers, 'REMINDER_SCHEDULED', 'FAIL', 'a past fire time produced ' + observedBehaviour + ' instead of the documented skipped-past refusal');
      throw new Error('expected the skipped-past refusal for a past fire time, observed ' + observedBehaviour);
    }
    setLayer(layers, 'REMINDER_SCHEDULED', 'NOT_RUN', 'refused by design: schedule_reminder returned skipped-past for ' + fireAtUtc + ', so nothing was armed and no delivery is claimed');
    const observation = await observeReminderDelivery({
      baseline,
      stderrOffset,
      timeoutMs: 10000,
      stopOnAttempt: false,
    });
    evidence.observation = {
      satisfied: observation.satisfied,
      polls: observation.polls,
      elapsedMs: observation.elapsedMs,
      appStderrPresent: observation.stderrPresent,
    };
    evidence.filetimeBaselineHex = baseline.lastNotificationAddedTimeHex;
    evidence.filetimeAfterHex = observation.settings.lastNotificationAddedTimeHex;
    evidence.appAttemptLines = observation.attemptLines;
    setLayer(layers, 'NATIVE_TRIGGER_FIRED', 'NOT_RUN', 'nothing was armed, so no trigger was expected; no platform attempt appeared in ' + observation.elapsedMs + ' ms');
    setLayer(layers, 'WINDOWS_API_ACCEPTED', 'NOT_RUN', 'nothing was armed, so the Windows notification API was never asked to accept a toast');
    if (observation.advanced || observation.attemptLines.length > 0) {
      const detail = observation.advanced
        ? 'LastNotificationAddedTime moved ' + baseline.lastNotificationAddedTimeHex + ' -> ' + observation.settings.lastNotificationAddedTimeHex
        : 'the app logged an attempt: ' + observation.attemptLines.join(' | ');
      setLayer(layers, 'OS_NOTIFICATION_OBSERVED', 'FAIL', 'a refused past fire time still produced delivery evidence: ' + detail);
      throw new Error('a past fire time produced delivery evidence even though schedule_reminder reported skipped-past: ' + detail);
    }
    setLayer(layers, 'OS_NOTIFICATION_OBSERVED', 'NOT_RUN', 'not observed and not claimed: LastNotificationAddedTime stayed ' + baseline.lastNotificationAddedTimeHex + ' over ' + observation.polls + ' polls in ' + observation.elapsedMs + ' ms, so the past fire time did not fire immediately');
  } catch (error) {
    primaryError = error;
  }
  const cleanup = await cleanupReminderFixtures({ reminderId: evidence.taskId, taskId: evidence.taskId });
  const report = recordReminderLayers('qa_reminder_past_fire_time', layers, { ...evidence, cleanup });
  if (primaryError) throw primaryError;
  if (cleanup.taskDeleted !== true) {
    throw new Error('QA fixture cleanup incomplete: ' + JSON.stringify(cleanup));
  }
  return { message: report.summary, layers, ...evidence };
});

await run('qa_reminder_observation_timeout', async () => {
  const layers = buildLayerReport();
  const evidence = {
    aumid: QA_NOTIFICATION_AUMID,
    fireLeadMs: REMINDER_TIMEOUT_CASE_LEAD_MS,
    observationBoundMs: REMINDER_TIMEOUT_CASE_BOUND_MS,
  };
  let primaryError = null;
  try {
    const permission = unwrap(await invoke(page, 'reminder_permission'), 'reminder_permission');
    evidence.permission = permission;
    if (permission !== 'granted') skip('desktop notification permission is ' + permission);
    const baseline = readNotificationSettings(QA_NOTIFICATION_AUMID);
    evidence.registryBefore = baseline;
    if (!baseline.exists || !baseline.lastNotificationAddedTimeTicks) {
      throw new Error('cannot read a baseline LastNotificationAddedTime: ' + baseline.key + ' ' + (baseline.error ?? ''));
    }
    const stderrOffset = currentLogOffset(appStderrPath);
    const title = 'QA timeout reminder ' + Date.now();
    const task = unwrap(await storage(page, 'create_task', { input: { title } }), 'create_task');
    evidence.taskId = task.id;
    const fireAtMs = Date.now() + REMINDER_TIMEOUT_CASE_LEAD_MS;
    const fireAtUtc = new Date(fireAtMs).toISOString();
    evidence.fireAtUtc = fireAtUtc;
    const mode = unwrap(
      await invoke(page, 'schedule_reminder', {
        reminderId: task.id,
        fireAtUtc,
        title,
        body: 'bound expires before this fires',
        exact: false,
      }),
      'schedule_reminder',
    );
    evidence.scheduleMode = mode;
    if (!['scheduled', 'exact', 'inexact'].includes(mode)) {
      setLayer(layers, 'REMINDER_SCHEDULED', 'FAIL', 'schedule_reminder returned ' + mode + ' for ' + fireAtUtc);
      throw new Error('schedule_reminder returned ' + mode + ' instead of arming the reminder');
    }
    setLayer(layers, 'REMINDER_SCHEDULED', 'PASS', 'armed for ' + fireAtUtc + ' (mode ' + mode + '), ' + REMINDER_TIMEOUT_CASE_LEAD_MS + ' ms out, with a ' + REMINDER_TIMEOUT_CASE_BOUND_MS + ' ms observation bound');
    const observation = await observeReminderDelivery({
      baseline,
      stderrOffset,
      timeoutMs: REMINDER_TIMEOUT_CASE_BOUND_MS,
      stopOnAttempt: false,
    });
    evidence.observation = {
      satisfied: observation.satisfied,
      polls: observation.polls,
      elapsedMs: observation.elapsedMs,
      appStderrPresent: observation.stderrPresent,
    };
    evidence.filetimeBaselineHex = baseline.lastNotificationAddedTimeHex;
    evidence.filetimeAfterHex = observation.settings.lastNotificationAddedTimeHex;
    evidence.appAttemptLines = observation.attemptLines;
    evidence.fireInstantInsideWindow = Date.now() >= fireAtMs;
    evidence.timedOut = observation.satisfied === false;
    if (observation.advanced || observation.attemptLines.length > 0) {
      const detail = observation.advanced
        ? 'LastNotificationAddedTime moved ' + baseline.lastNotificationAddedTimeHex + ' -> ' + observation.settings.lastNotificationAddedTimeHex
        : 'the app logged an attempt: ' + observation.attemptLines.join(' | ');
      setLayer(layers, 'NATIVE_TRIGGER_FIRED', 'PASS', detail);
      setLayer(layers, 'WINDOWS_API_ACCEPTED', observation.advanced ? 'PASS' : 'FAIL', detail);
      setLayer(layers, 'OS_NOTIFICATION_OBSERVED', observation.advanced ? 'PASS' : 'FAIL', detail);
      throw new Error('the timeout case observed something inside its bound, its premise no longer holds: ' + detail);
    }
    setLayer(layers, 'NATIVE_TRIGGER_FIRED', 'NOT_RUN', 'the ' + observation.elapsedMs + ' ms bound closed ' + Math.max(0, fireAtMs - Date.now()) + ' ms before the fire instant ' + fireAtUtc + ', so the timer never became due');
    setLayer(layers, 'WINDOWS_API_ACCEPTED', 'NOT_RUN', 'the fire instant was still in the future, so the Windows notification API was never called');
    setLayer(layers, 'OS_NOTIFICATION_OBSERVED', 'NOT_RUN', 'timeout, not a delivery claim: LastNotificationAddedTime stayed ' + baseline.lastNotificationAddedTimeHex + ' over ' + observation.polls + ' polls in ' + observation.elapsedMs + ' ms');
    if (observation.satisfied) throw new Error('the bound ended satisfied but no layer was set');
    if (evidence.fireInstantInsideWindow) {
      throw new Error('the fire instant fell inside the observation window, so this case did not exercise a timeout');
    }
    if (observation.elapsedMs > REMINDER_TIMEOUT_CASE_BOUND_MS + 10000) {
      throw new Error('the polling loop overran its bound: ' + observation.elapsedMs + ' ms');
    }
    if (observation.polls < 2) {
      throw new Error('the state loop polled only ' + observation.polls + ' time(s), so nothing was polled');
    }
  } catch (error) {
    primaryError = error;
  }
  const cleanup = await cleanupReminderFixtures({ reminderId: evidence.taskId, taskId: evidence.taskId });
  const report = recordReminderLayers('qa_reminder_observation_timeout', layers, {
    ...evidence,
    cleanup,
    deliveryClaimed: false,
  });
  if (primaryError) throw primaryError;
  if (cleanup.reminderCancelled !== true || cleanup.taskDeleted !== true) {
    throw new Error('QA fixture cleanup incomplete: ' + JSON.stringify(cleanup));
  }
  return { message: report.summary, layers, ...evidence };
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
  const removed = unwrap(
    await invoke(page, 'secure_token_get', { key }),
    'secure_token_get_removed',
  );
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
  if (after.accountId !== before.accountId)
    throw new Error('active account changed after rejected switch');
  return { error: prepared.error, activeAccountId: after.accountId };
});

await run('qa_desktop_notification_action_target', async () => {
  skip(
    'covered by Rust unit tests; real toast click requires a logged-in account and desktop interaction',
  );
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
  if (prepared.ok) {
    // Never leave a PREPARED journal or a closed gate behind on a failed
    // expectation; clean up before failing the test.
    await invoke(page, 'native_abort_account_switch');
    throw new Error('fault point unexpectedly allowed switch preparation');
  }
  const status = unwrap(await invoke(page, 'native_account_switch_status'), 'switch status');
  // The command path aborts a failed prepare; a raw journal may also be left for
  // startup recovery. Both are safe as long as the active account and gate are
  // restored and the injected point is recorded.
  if (status.phase === 'PREPARED') {
    const abort = await invoke(page, 'native_abort_account_switch');
    if (!abort.ok) throw new Error(`abort after injected prepare failed: ${abort.error}`);
  }
  const after = unwrap(await invoke(page, 'native_account_context'), 'context after abort');
  if (after.accountId !== before.accountId)
    throw new Error('active account changed during fault recovery');
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
  const points = [];
  for (const line of lines) {
    const item = JSON.parse(line);
    if (!item.eventId || !item.point || !item.result) throw new Error('malformed fault evidence');
    points.push(item.point);
    parsed += 1;
  }
  const configuredPoints = (config.rules || []).map((rule) =>
    String(rule.point || '').toLowerCase(),
  );
  if (configuredPoints.length > 0 && !configuredPoints.some((point) => points.includes(point))) {
    throw new Error('fault evidence has no record for any configured rule point');
  }
  return {
    evidenceFile: 'fault-evidence.jsonl',
    records: parsed,
    configuredPoints,
    observedPoints: [...new Set(points)],
  };
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
  `- Target: ${provenance.targetSelection} (version ${provenance.appExeProductVersion || 'unknown'}, sha256 ${provenance.appExeSha256 || 'unknown'})`,
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
  'Reminder delivery layers are written to qa_reminder_*.layers.json. A changed LastNotificationAddedTime justifies OS_NOTIFICATION_OBSERVED only; NOTIFICATION_CENTER_VISIBLE, BANNER_VISIBLE, CLICK_ACTIVATED and DETAIL_OPENED_ACK stay NOT_RUN because nothing here can see a banner or a click.',
].join('\n');

fs.writeFileSync(
  path.join(artifactRoot, 'tests.json'),
  JSON.stringify({ generatedAt: new Date().toISOString(), status, counts, tests }, null, 2),
);
fs.writeFileSync(path.join(artifactRoot, 'timeline.json'), JSON.stringify(timeline, null, 2));
fs.writeFileSync(path.join(artifactRoot, 'performance.json'), JSON.stringify(performance, null, 2));
fs.writeFileSync(path.join(artifactRoot, 'summary.md'), summary);
fs.writeFileSync(path.join(logDir, 'harness.jsonl'), `${harnessLog.join('\n')}\n`);

await browser.close().catch(() => {});
process.exit(counts.FAIL > 0 ? 1 : 0);
