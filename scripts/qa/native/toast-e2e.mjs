#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { verifyQaExecutable, verifyRunningProcess } from './qa-executable.mjs';
import { classifyDriverResult } from './toast-result.mjs';

function arg(name, required = true) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0 || !process.argv[index + 1]) {
    if (required) throw new Error(`missing --${name}`);
    return undefined;
  }
  return process.argv[index + 1];
}

let appExe = path.resolve(arg('app-exe'));
const artifactRoot = path.resolve(arg('artifact-root'));
const scenarioId = arg('scenario', false) ?? 'running-app-activation';
const cdpPort = Number(arg('cdp-port', false) ?? 9346);
const driver = path.join(import.meta.dirname, 'windows-toast-driver.ps1');
const diagnostic = path.join(import.meta.dirname, 'windows-notification-diagnostic.ps1');
const scenarioPath = path.join(artifactRoot, 'platform-scenario.json');
const screenshotRel = 'screenshots/toast-driver.png';
const screenshotPath = path.join(artifactRoot, screenshotRel);
const startedAt = new Date();

fs.mkdirSync(path.join(artifactRoot, 'screenshots'), { recursive: true });
const timeline = [];
const event = (name, detail = {}) =>
  timeline.push({ at: new Date().toISOString(), name, ...detail });
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let child;
let driverProcess;
let browser;
let result = {
  scenarioId,
  status: 'NOT_RUN',
  observed: null,
  reason: null,
  error: null,
  taskId: null,
  taskTitle: null,
  driver: null,
  driverStatus: null,
  driverReadyAt: null,
  notificationScheduledAt: null,
  notificationObservedAt: null,
  invokeAt: null,
  taskOpenedAt: null,
  evidence: [],
};

try {
  const manifest = readJson(path.join(artifactRoot, 'manifest.json'));
  const environment = readJson(path.join(artifactRoot, 'environment.json'));
  if (environment.productionDataRootPresentAfter === true) {
    throw new Error('production data root was present; refusing real platform run');
  }
  const verified = verifyQaExecutable({
    appExe,
    artifactRoot,
    expectedHead: process.env.QA_EXPECTED_HEAD,
  });
  appExe = verified.realPath;
  event('qa_executable_verified', { sha256: verified.sha256, productName: verified.productName });
  event('starting_qa_app', { appExe });
  child = spawn(appExe, [], {
    cwd: path.dirname(appExe),
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${cdpPort}`,
    },
    stdio: 'ignore',
    windowsHide: false,
  });
  event('started_qa_app', { pid: child.pid });

  let page;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`, { timeout: 2000 });
      page = browser
        .contexts()
        .flatMap((context) => context.pages())
        .find((candidate) => candidate.url().includes('tauri.localhost'));
      if (page) break;
      await browser.close().catch(() => {});
      browser = undefined;
    } catch {
      // retry
    }
    await sleep(500);
  }
  if (!page) throw new Error(`QA WebView CDP unavailable on ${cdpPort}`);
  verifyRunningProcess(child.pid, appExe);
  event('qa_process_path_verified', { pid: child.pid });
  event('cdp_connected');
  await page.waitForFunction(
    () => document.readyState === 'complete' && Boolean(window.__TAURI_INTERNALS__),
    undefined,
    { timeout: 30000 },
  );

  const invoke = async (command, args = {}) =>
    page.evaluate(
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
  const unwrap = (response, label) => {
    if (!response?.ok) throw new Error(`${label}: ${JSON.stringify(response?.error)}`);
    return response.value;
  };

  const runMarker = manifest.runId;
  if (!runMarker) throw new Error('manifest runId missing; cannot attribute Toast');
  const identity = unwrap(await invoke('qa_build_identity'), 'qa_build_identity');
  if (
    identity?.isQa !== true ||
    identity.identifier !== 'app.shishi.todo.qa' ||
    identity.credentialService !== 'app.shishi.todo.rc2d-qa.secure-token'
  ) {
    throw new Error(`not a QA build: ${JSON.stringify(identity)}`);
  }
  const permission = unwrap(await invoke('reminder_permission'), 'reminder_permission');
  if (permission !== 'granted') {
    result.status = 'NOT_RUN';
    result.reason = `desktop notification permission is ${permission}; operator must grant it`;
    event('permission_not_granted', { permission });
  } else {
    unwrap(
      await invoke('todo_storage', { request: { action: 'initialize', payload: {} } }),
      'storage initialize',
    );
    const title = `QA Toast ${runMarker} ${Date.now()}`;
    const task = unwrap(
      await invoke('todo_storage', {
        request: { action: 'create_task', payload: { input: { title } } },
      }),
      'create_task',
    );
    if (!task?.id) throw new Error('create_task returned no task');
    result.taskId = task.id;
    result.taskTitle = title;
    const driverResultPath = path.join(artifactRoot, 'toast-driver-result.json');
    const readyPath = path.join(artifactRoot, 'toast-driver-ready.txt');
    fs.rmSync(driverResultPath, { force: true });
    fs.rmSync(readyPath, { force: true });
    driverProcess = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-File',
        driver,
        '-Mode',
        'Click',
        '-ArtifactRoot',
        artifactRoot,
        '-OutFile',
        driverResultPath,
        '-ReadyFile',
        readyPath,
        '-RunMarker',
        runMarker,
        '-TimeoutSeconds',
        '40',
      ],
      { stdio: 'ignore', windowsHide: true },
    );
    event('toast_driver_started', { pid: driverProcess.pid });
    const readyDeadline = Date.now() + 15000;
    while (!fs.existsSync(readyPath)) {
      if (driverProcess.exitCode !== null) {
        throw new Error(`Toast driver exited before READY (exit ${driverProcess.exitCode})`);
      }
      if (Date.now() > readyDeadline)
        throw new Error('Toast driver did not reach READY within 15s');
      await sleep(100);
    }
    result.driverReadyAt = new Date().toISOString();
    event('toast_driver_ready', { readyAt: result.driverReadyAt });

    const fireAtUtc = new Date(Date.now() + 1200).toISOString();
    const mode = unwrap(
      await invoke('schedule_reminder', {
        reminderId: task.id,
        fireAtUtc,
        title,
        body: `QA isolated Toast fixture ${runMarker}`,
        exact: false,
      }),
      'schedule_reminder',
    );
    result.notificationScheduledAt = new Date().toISOString();
    event('toast_scheduled', { fireAtUtc, mode, taskId: task.id });

    const driverExitCode = await new Promise((resolve, reject) => {
      if (driverProcess.exitCode !== null) {
        resolve(driverProcess.exitCode);
        return;
      }
      driverProcess.once('exit', (code) => resolve(code));
      driverProcess.once('error', reject);
    });
    event('toast_driver_exit', { code: driverExitCode });
    if (!fs.existsSync(driverResultPath)) {
      throw new Error(`Toast driver produced no result (exit ${driverExitCode})`);
    }
    result.driver = readJson(driverResultPath);
    const driverOutcome = classifyDriverResult(result.driver);
    result.driverStatus = driverOutcome.status;
    result.notificationObservedAt = result.driver.notificationObservedAt ?? null;
    result.invokeAt = result.driver.invokeAt ?? null;

    const platformDiagnosticPath = path.join(artifactRoot, 'notification-platform.json');
    const diagnosticRun = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-File',
        diagnostic,
        '-OutFile',
        platformDiagnosticPath,
        '-Identifier',
        'app.shishi.todo.qa',
      ],
      { stdio: 'ignore' },
    );
    event('notification_platform_diagnostic', { code: diagnosticRun.status });
    if (fs.existsSync(platformDiagnosticPath)) {
      result.platformDiagnostic = readJson(platformDiagnosticPath);
    }
    if (driverOutcome.kind === 'fail') {
      result.status = 'FAIL';
      result.reason = driverOutcome.reason;
      result.error = driverOutcome.reason;
    } else if (driverOutcome.kind === 'not_run') {
      result.status = 'NOT_RUN';
      const added = result.platformDiagnostic?.lastNotificationAddedTime;
      result.reason =
        driverOutcome.reason +
        (added
          ? `; Windows platform recorded notification at ${added}`
          : '; Windows platform timestamp unavailable');
    } else {
      // The driver only invoked UIA. The app must now show the expected task.
      let opened = false;
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const detail = await page.evaluate(
          () => document.querySelector('aside.detail .detail__title')?.textContent?.trim() ?? null,
        );
        if (detail === title) {
          opened = true;
          result.taskOpenedAt = new Date().toISOString();
          break;
        }
        await sleep(300);
      }
      if (!opened) {
        result.status = 'FAIL';
        result.reason = 'Toast button was invoked but the QA task detail did not open';
      } else if (!fs.existsSync(screenshotPath)) {
        result.status = 'FAIL';
        result.reason = 'task opened but no Toast-window screenshot evidence exists';
      } else {
        result.status = 'PASS';
        result.observed = `Real Windows Toast action clicked; task detail opened: ${title}`;
        result.evidence.push({
          path: screenshotRel,
          sha256: sha256(screenshotPath),
          kind: 'screenshot',
        });
        result.reason = null;
      }
    }
  }
} catch (error) {
  result.status = 'FAIL';
  result.error = error instanceof Error ? error.message : String(error);
} finally {
  try {
    if (browser) await browser.close();
  } catch {}
  try {
    if (driverProcess && driverProcess.exitCode === null) {
      process.kill(driverProcess.pid);
    }
  } catch {}
  try {
    if (child && child.pid) {
      process.kill(child.pid);
      event('qa_app_killed', { pid: child.pid });
    }
  } catch {}
}

const finishedAt = new Date();
const scenarioRecord = {
  scenarioId,
  status: result.status,
  observed: result.observed,
  reason: result.reason,
  error: result.error,
  taskId: result.taskId,
  taskTitle: result.taskTitle,
  platformDiagnostic: result.platformDiagnostic ?? null,
  driverReadyAt: result.driverReadyAt,
  notificationScheduledAt: result.notificationScheduledAt,
  notificationObservedAt: result.notificationObservedAt,
  invokeAt: result.invokeAt,
  taskOpenedAt: result.taskOpenedAt,
  driverStatus: result.driverStatus,
  driver: result.driver,
  evidence: result.evidence,
  startedAt: startedAt.toISOString(),
  finishedAt: finishedAt.toISOString(),
  timeline,
};
fs.writeFileSync(scenarioPath, JSON.stringify(scenarioRecord, null, 2));

// Only PASS overwrites the canonical manual record. NOT_RUN/FAIL preserve the
// all-NOT_RUN manifest and append a separate platform-scenario diagnostic.
if (result.status === 'PASS') {
  const manualPath = path.join(artifactRoot, 'manual-platform.json');
  const manual = readJson(manualPath);
  const manifest = readJson(path.join(artifactRoot, 'manifest.json'));
  const scenario = manual.scenarios.find((item) => item.id === scenarioId);
  if (!scenario) throw new Error(`canonical scenario missing: ${scenarioId}`);
  scenario.status = 'PASS';
  scenario.observed = result.observed;
  scenario.evidence = result.evidence;
  scenario.reason = null;
  scenario.startedAt = startedAt.toISOString();
  scenario.finishedAt = finishedAt.toISOString();
  scenario.runId = manual.runId;
  scenario.headSha = manifest.gitCommit;
  scenario.appExeSha256 = manifest.appExeSha256;
  scenario.installerSha256 = manifest.installerSha256 ?? null;
  fs.writeFileSync(manualPath, JSON.stringify(manual, null, 2));
  const sumsPath = path.join(artifactRoot, 'sha256sums.txt');
  if (fs.existsSync(sumsPath)) {
    const line = `${sha256(screenshotPath)}  ${screenshotRel}`;
    const sums = fs.readFileSync(sumsPath, 'utf8');
    if (!sums.includes(screenshotRel)) {
      fs.appendFileSync(sumsPath, `${sums.endsWith('\n') ? '' : '\n'}${line}\n`);
    }
  }
}
console.log(JSON.stringify(scenarioRecord, null, 2));
if (result.status === 'FAIL') process.exit(1);
