#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { verifyQaExecutable, verifyRunningProcess } from './qa-executable.mjs';

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
const cdpPort = Number(arg('cdp-port', false) ?? 9349);
const resultPath = path.join(artifactRoot, 'credential-failure.json');
// The native QA evidence writer only accepts an approved QA location, and the
// app is spawned with its install directory as the working directory, so the
// evidence file must live inside the QA application data root. This matches
// run-windows.ps1, which also points evidencePath at the QA root. The script's
// own artifacts (result, fault config) stay under --artifact-root.
const qaEvidenceRoot = process.env.APPDATA
  ? path.join(process.env.APPDATA, 'app.shishi.todo.qa', 'evidence')
  : null;
if (!qaEvidenceRoot) {
  throw new Error(
    'APPDATA is required: QA evidence must be written inside the QA application data root',
  );
}
fs.mkdirSync(qaEvidenceRoot, { recursive: true });
const evidencePath = path.join(qaEvidenceRoot, 'credential-fault-evidence.jsonl');
const configPath = path.join(artifactRoot, 'credential-fault-config.json');
const startedAt = new Date();
const timeline = [];
let child;
let browser;

const event = (name, detail = {}) =>
  timeline.push({ at: new Date().toISOString(), name, ...detail });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const result = {
  schemaVersion: 1,
  status: 'NOT_RUN',
  reason: null,
  accountId: null,
  activeKey: null,
  crossAccountKey: null,
  checks: {},
  timeline,
  startedAt: startedAt.toISOString(),
  finishedAt: null,
};

try {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(artifactRoot, 'manifest.json'), 'utf8').replace(/^\uFEFF/, ''),
  );
  const verified = verifyQaExecutable({
    appExe,
    artifactRoot,
    expectedHead: process.env.QA_EXPECTED_HEAD,
  });
  appExe = verified.realPath;
  fs.writeFileSync(
    configPath,
    JSON.stringify(
      {
        evidencePath,
        credentialBackend: 'os',
        rules: [
          {
            point: 'CREDENTIAL_SET',
            action: { type: 'error', code: 'QA_CRED_FAIL', message: 'injected set failure' },
          },
          {
            point: 'CREDENTIAL_GET',
            action: { type: 'error', code: 'QA_CRED_FAIL', message: 'injected get failure' },
          },
          {
            point: 'CREDENTIAL_DELETE',
            action: { type: 'error', code: 'QA_CRED_FAIL', message: 'injected delete failure' },
          },
        ],
      },
      null,
      2,
    ),
  );
  child = spawn(appExe, ['--rc2d-fault-config', configPath], {
    cwd: path.dirname(appExe),
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${cdpPort}`,
    },
    stdio: 'ignore',
    windowsHide: false,
  });
  event('app_started', { pid: child.pid });

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
    } catch {}
    await sleep(500);
  }
  if (!page) throw new Error('QA WebView CDP unavailable');
  verifyRunningProcess(child.pid, appExe);
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
          return { ok: false, error };
        }
      },
      { command, args },
    );
  const unwrap = (response, label) => {
    if (!response?.ok) throw new Error(`${label}: ${JSON.stringify(response?.error)}`);
    return response.value;
  };
  const identity = unwrap(await invoke('qa_build_identity'), 'identity');
  if (identity?.isQa !== true) throw new Error('not a QA build');
  const context = unwrap(await invoke('native_account_context'), 'context');
  result.accountId = context.accountId;
  result.activeKey = `cloud-refresh:${context.accountId}`;
  result.crossAccountKey = 'cloud-refresh:cross-account-test';
  event('identity_verified', { accountId: context.accountId });

  const set = await invoke('secure_token_set', {
    key: result.activeKey,
    value: 'qa-injected-failure-token',
  });
  result.checks.set = set;
  const cross = await invoke('secure_token_get', { key: result.crossAccountKey });
  result.checks.crossAccountRead = cross;
  const remove = await invoke('secure_token_remove', { key: result.activeKey });
  result.checks.remove = remove;

  const expectedStorage = (response) =>
    response?.ok === false && response?.error?.code === 'SECURE_STORAGE';
  const expectedCross = (response) =>
    response?.ok === false && response?.error?.code === 'CROSS_ACCOUNT_TOKEN';
  result.status =
    expectedStorage(set) &&
    expectedCross(cross) &&
    expectedStorage(remove) &&
    fs.existsSync(evidencePath)
      ? 'PASS'
      : 'FAIL';
  result.reason =
    result.status === 'PASS' ? null : 'injected credential errors or account ACL did not match';
  event('checks_completed');
} catch (error) {
  result.status = 'NOT_RUN';
  result.reason = error instanceof Error ? error.message : String(error);
} finally {
  try {
    if (browser) await browser.close();
  } catch {}
  try {
    if (child?.pid) process.kill(child.pid);
  } catch {}
  result.finishedAt = new Date().toISOString();
  fs.writeFileSync(resultPath, JSON.stringify(result, null, 2));
}

console.log(JSON.stringify(result, null, 2));
if (result.status === 'FAIL') process.exit(1);
