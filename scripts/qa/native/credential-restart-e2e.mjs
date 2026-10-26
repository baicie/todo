#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { verifyQaExecutable, verifyRunningProcess } from './qa-executable.mjs';

const arg = (name, required = true) => {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0 || !process.argv[index + 1]) {
    if (required) throw new Error(`missing --${name}`);
    return undefined;
  }
  return process.argv[index + 1];
};

let appExe = path.resolve(arg('app-exe'));
const artifactRoot = path.resolve(arg('artifact-root'));
const cdpPort = Number(arg('cdp-port', false) ?? 9348);
const resultPath = path.join(artifactRoot, 'credential-restart.json');
const startedAt = new Date();
const timeline = [];
let child;
let browser;

const event = (name, detail = {}) =>
  timeline.push({ at: new Date().toISOString(), name, ...detail });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function start() {
  child = spawn(appExe, [], {
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
  if (!page) throw new Error(`QA WebView CDP unavailable on ${cdpPort}`);
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
  const identity = unwrap(await invoke('qa_build_identity'), 'qa_build_identity');
  verifyRunningProcess(child.pid, appExe);
  event('qa_process_path_verified', { pid: child.pid });
  if (
    identity?.isQa !== true ||
    identity.identifier !== 'app.shishi.todo.qa' ||
    identity.credentialService !== 'app.shishi.todo.rc2d-qa.secure-token'
  ) {
    throw new Error(`not a QA build: ${JSON.stringify(identity)}`);
  }
  const context = unwrap(await invoke('native_account_context'), 'native_account_context');
  event('qa_identity_verified', { accountId: context.accountId });
  return { invoke, unwrap, accountId: context.accountId };
}

async function stop() {
  try {
    if (browser) await browser.close();
  } catch {}
  browser = undefined;
  try {
    if (child?.pid) process.kill(child.pid);
  } catch {}
  child = undefined;
  await sleep(1200);
}

const manifestPath = path.join(artifactRoot, 'manifest.json');
const manifest = fs.existsSync(manifestPath)
  ? JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''))
  : {};
const result = {
  schemaVersion: 1,
  runId: manifest.runId ?? null,
  headSha: manifest.gitCommit ?? null,
  appExeSha256: manifest.appExeSha256 ?? null,
  installerSha256: manifest.installerSha256 ?? null,
  status: 'NOT_RUN',
  reason: null,
  error: null,
  accountId: null,
  credentialService: null,
  restartedRead: false,
  timeline,
  startedAt: startedAt.toISOString(),
  finishedAt: null,
};
let key;
try {
  const verified = verifyQaExecutable({
    appExe,
    artifactRoot,
    expectedHead: process.env.QA_EXPECTED_HEAD,
  });
  appExe = verified.realPath;
  event('qa_executable_verified', { sha256: verified.sha256, productName: verified.productName });
  const first = await start();
  result.accountId = first.accountId;
  result.credentialService = 'app.shishi.todo.rc2d-qa.secure-token';
  key = `cloud-refresh:${first.accountId}`;
  const value = `qa-restart-token-${Date.now()}`;
  first.unwrap(await first.invoke('secure_token_set', { key, value }), 'secure_token_set');
  event('credential_written');
  await stop();
  event('first_process_stopped');

  const second = await start();
  const read = second.unwrap(await second.invoke('secure_token_get', { key }), 'secure_token_get');
  if (read !== value) {
    result.status = 'FAIL';
    result.reason = 'credential did not survive a real process restart';
  } else {
    result.status = 'PASS';
    result.restartedRead = true;
    result.reason = null;
    event('credential_restart_readback_ok');
  }
  second.unwrap(await second.invoke('secure_token_remove', { key }), 'secure_token_remove');
  const removed = second.unwrap(
    await second.invoke('secure_token_get', { key }),
    'secure_token_get_removed',
  );
  if (removed !== null) throw new Error('QA credential was not removed after restart test');
  await stop();
} catch (error) {
  result.status = 'NOT_RUN';
  result.reason = error instanceof Error ? error.message : String(error);
  try {
    if (child?.pid) process.kill(child.pid);
  } catch {}
}
result.finishedAt = new Date().toISOString();
fs.writeFileSync(resultPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
if (result.status === 'FAIL') process.exit(1);
