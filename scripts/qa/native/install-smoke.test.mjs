/**
 * Refusal-path tests for install-smoke.ps1.
 *
 * The smoke installs and uninstalls real software, so the most important thing
 * to prove is that it REFUSES to run outside an authorized, ephemeral,
 * GitHub-hosted Windows runner - before the installer is ever started.
 *
 * These tests only ever exercise a refusal or `-PreflightOnly`; none of them
 * installs anything. They run on the native-qa Windows job (the only place a
 * PowerShell host exists); elsewhere they skip.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, 'install-smoke.ps1');
const WORKFLOW = join(here, '..', '..', '..', '.github', 'workflows', 'native-qa.yml');
const COMMIT = 'a'.repeat(40);
const TOKEN = 'github-actions:native-qa:install-smoke';

const windows = process.platform === 'win32';
const skip = windows ? false : 'install-smoke.ps1 only runs on Windows';

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'install-smoke-test-'));
}

/**
 * Runs the script with a controlled environment. `ci` says which GitHub
 * variables to set; anything not listed is removed so the test cannot inherit
 * an accidental GITHUB_ACTIONS from the caller.
 */
function run({ args = [], ci = {}, temp = true } = {}) {
  const dir = tempDir();
  const out = join(dir, 'result.json');
  const installer = join(dir, 'dummy-setup.exe');
  writeFileSync(installer, 'not a real installer');

  const env = { ...process.env };
  for (const key of [
    'GITHUB_ACTIONS',
    'RUNNER_ENVIRONMENT',
    'GITHUB_WORKFLOW_REF',
    'RUNNER_TEMP',
    'RUNNER_OS',
    'RUNNER_NAME',
    // The runner exports a PowerShell 7 PSModulePath. Windows PowerShell 5.1
    // inherits it, cannot find its own modules, and fails on cmdlets such as
    // Get-FileHash. Removing it lets the child compute its default.
    'PSModulePath',
  ]) {
    delete env[key];
  }
  Object.assign(env, ci);
  if (temp && !('RUNNER_TEMP' in ci)) env.RUNNER_TEMP = dir;

  const result = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      SCRIPT,
      '-Installer',
      installer,
      '-ExpectedCommit',
      COMMIT,
      '-OutFile',
      out,
      ...args,
    ],
    { env, encoding: 'utf8', timeout: 120000 },
  );

  let report = null;
  try {
    report = JSON.parse(readFileSync(out, 'utf8').replace(/^﻿/, ''));
  } catch {
    // A refusal that never reached the try block (e.g. bad parameter binding)
    // leaves no report; the assertions below then fail on status.
  }
  rmSync(dir, { recursive: true, force: true });
  return {
    status: result.status,
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
    report,
  };
}

function assertBlocked(reply, pattern) {
  assert.notEqual(reply.status, 0, 'a refused run must exit non-zero: ' + reply.stdout);
  assert.ok(reply.report, 'the refusal must still write the JSON report: ' + reply.stderr);
  assert.equal(reply.report.status, 'BLOCKED');
  assert.equal(reply.report.installExitCode, null, 'the installer must never be started');
  assert.equal(reply.report.uninstallExitCode, null, 'the uninstaller must never be started');
  assert.match(reply.report.error, pattern);
}

test('the workflow passes the explicit authorization marker', () => {
  const workflow = readFileSync(WORKFLOW, 'utf8');
  assert.ok(
    workflow.includes(`-CiAuthorization "${TOKEN}"`),
    'native-qa.yml must pass the marker explicitly; a present RUNNER_TEMP is not authorization',
  );
});

test('refuses a missing authorization marker', { skip }, () => {
  assertBlocked(
    run({ ci: { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted' } }),
    /CI authorization marker/,
  );
});

test('refuses an empty authorization marker', { skip }, () => {
  assertBlocked(
    run({
      args: ['-CiAuthorization', ''],
      ci: { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted' },
    }),
    /CI authorization marker/,
  );
});

test('refuses a wrong authorization marker', { skip }, () => {
  assertBlocked(
    run({
      args: ['-CiAuthorization', 'yes-please'],
      ci: { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted' },
    }),
    /not the one native-qa\.yml passes/,
  );
});

test('refuses an authorized marker outside GitHub Actions', { skip }, () => {
  assertBlocked(
    run({ args: ['-CiAuthorization', TOKEN], ci: { RUNNER_ENVIRONMENT: 'github-hosted' } }),
    /GITHUB_ACTIONS=true/,
  );
});

test('refuses a self-hosted runner', { skip }, () => {
  assertBlocked(
    run({
      args: ['-CiAuthorization', TOKEN],
      ci: {
        GITHUB_ACTIONS: 'true',
        RUNNER_ENVIRONMENT: 'self-hosted',
        GITHUB_WORKFLOW_REF: 'baicie/todo/.github/workflows/native-qa.yml@refs/heads/main',
      },
    }),
    /GitHub-hosted ephemeral runner/,
  );
});

test('refuses a different workflow', { skip }, () => {
  assertBlocked(
    run({
      args: ['-CiAuthorization', TOKEN],
      ci: {
        GITHUB_ACTIONS: 'true',
        RUNNER_ENVIRONMENT: 'github-hosted',
        GITHUB_WORKFLOW_REF: 'baicie/todo/.github/workflows/release-dev.yml@refs/tags/x',
      },
    }),
    /native-qa\.yml/,
  );
});

test('refuses when RUNNER_TEMP is missing', { skip }, () => {
  assertBlocked(
    run({
      args: ['-CiAuthorization', TOKEN],
      temp: false,
      ci: {
        GITHUB_ACTIONS: 'true',
        RUNNER_ENVIRONMENT: 'github-hosted',
        GITHUB_WORKFLOW_REF: 'baicie/todo/.github/workflows/native-qa.yml@refs/heads/main',
      },
    }),
    /RUNNER_TEMP/,
  );
});

test('preflight reaches the clean-runner check without installing', { skip }, () => {
  // On a clean hosted runner this returns PREFLIGHT_ONLY; on a dirty developer
  // machine it returns BLOCKED. Either way the installer must not run.
  const reply = run({
    args: ['-CiAuthorization', TOKEN, '-PreflightOnly'],
    ci: {
      GITHUB_ACTIONS: 'true',
      RUNNER_ENVIRONMENT: 'github-hosted',
      GITHUB_WORKFLOW_REF: 'baicie/todo/.github/workflows/native-qa.yml@refs/heads/main',
    },
  });
  assert.ok(reply.report, reply.stderr);
  assert.ok(
    ['PREFLIGHT_ONLY', 'BLOCKED'].includes(reply.report.status),
    `unexpected status ${reply.report.status}: ${reply.report.error}`,
  );
  assert.equal(reply.report.installExitCode, null);
  assert.equal(reply.report.checks.ciContext, true);
  // A dirty host must name why; a clean one must have proven the runner is clean.
  if (reply.report.status === 'BLOCKED') {
    assert.match(reply.report.error, /runner is not clean/);
  } else {
    assert.equal(reply.report.checks.cleanRunner, true);
  }
});
