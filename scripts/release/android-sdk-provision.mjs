/**
 * RC2-D.15 Phase C - ONE Android SDK provisioning step.
 *
 * The proven smoke path (.github/workflows/android-smoke.yml) provisions
 * `platforms;android-37` explicitly because the pinned tauri CLI 2.12.4 Gradle
 * template compiles against compileSdk 37, which is not in the Android stable
 * channel; the release path (.github/workflows/release-dev.yml) did not, and the
 * two workflows drifted. A shell snippet inside a workflow is not shareable, so
 * the provisioning logic lives here and BOTH workflows call the same entry
 * point:
 *
 *   node scripts/release/android-sdk-provision.mjs provision
 *   node scripts/release/android-sdk-provision.mjs check-platform   (after the build)
 *
 * This module owns the whole SDK provisioning contract: the pinned package list
 * (identical to the android-actions/setup-android input both workflows pass),
 * the compile-SDK platform the CLI template needs, the channel fallback, and -
 * the rule that matters - the gate that decides whether the job may report a
 * build result at all.
 *
 * Rule: a provisioning warning is NEVER a passing build. `provision` records
 * what it achieved in a status file; `check-platform` runs after the build and
 * fails unless `platforms;android-37` is really installed. A warning alone can
 * therefore never be laundered into a PASS - the platform has to be proven
 * present, whichever step put it there.
 *
 * Everything here is offline: the pure functions are unit-tested from
 * tests/release/, and the two CLI commands are the only ones that touch an SDK.
 */

import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The pinned package list; identical to the setup-android input in both workflows. */
export const ANDROID_SDK_PACKAGES = Object.freeze([
  'platforms;android-35',
  'build-tools;35.0.0',
  'ndk;27.0.12077973',
]);

/** The package list exactly as it appears in a workflow file today. */
export const ANDROID_SDK_PACKAGE_LIST = ANDROID_SDK_PACKAGES.join(' ');

/** tauri-cli 2.12.4 pins compileSdk 37 in the Gradle project it generates. */
export const ANDROID_COMPILE_SDK = 37;
export const ANDROID_COMPILE_SDK_PACKAGE = 'platforms;android-' + ANDROID_COMPILE_SDK;

/** The one entry point both workflows must call. */
export const ANDROID_PROVISION_ENTRY = 'node scripts/release/android-sdk-provision.mjs provision';
export const ANDROID_PROVISION_GATE_ENTRY =
  'node scripts/release/android-sdk-provision.mjs check-platform';

/** android-37 is not in the stable channel yet, so the stable channel is tried first. */
export const PROVISION_CHANNELS = Object.freeze([
  Object.freeze({ label: 'stable', args: Object.freeze([]) }),
  Object.freeze({ label: 'preview', args: Object.freeze(['--channel=3']) }),
]);

export const PROVISION_STATUS_FILE = '.android-sdk-provision.json';
export const PROVISION_STATUS_OK = 'ok';
export const PROVISION_STATUS_DEGRADED = 'degraded';
export const PROVISION_STATUS_FAILED = 'failed';
export const PROVISION_STATUS_UNKNOWN = 'unknown';
export const PROVISION_STATUSES = Object.freeze([
  PROVISION_STATUS_OK,
  PROVISION_STATUS_DEGRADED,
  PROVISION_STATUS_FAILED,
  PROVISION_STATUS_UNKNOWN,
]);

export const PROVISIONED_BY_STEP = 'shared-step';
export const PROVISIONED_BY_AGP = 'agp-auto-download';
export const PROVISIONED_BY_UNKNOWN = 'unknown';

export class AndroidSdkProvisionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AndroidSdkProvisionError';
  }
}

function fail(message) {
  throw new AndroidSdkProvisionError(message);
}

/** "platforms;android-35" -> "platforms/android-35" (the path under ANDROID_HOME). */
export function packageDirOf(pkg) {
  const parts = String(pkg ?? '')
    .trim()
    .split(';');
  if (parts.length === 0 || parts[0] === '') return null;
  return parts.join('/');
}

/* ---------------------------------------------------------------------------
 * Pure decisions
 * ------------------------------------------------------------------------- */

/** The full provisioning plan, so a test can pin the package list and the channels. */
export function describeProvisionPlan({
  packages = ANDROID_SDK_PACKAGES,
  compileSdkPackage = ANDROID_COMPILE_SDK_PACKAGE,
  channels = PROVISION_CHANNELS,
} = {}) {
  if (!Array.isArray(packages) || packages.length === 0) {
    fail('the provisioning plan needs at least one pinned package');
  }
  return {
    packages: [...packages],
    compileSdk: String(compileSdkPackage),
    channels: channels.map((channel) => ({ label: channel.label, args: [...channel.args] })),
    checks: [...packages, String(compileSdkPackage)].map((pkg) => ({
      package: pkg,
      dir: packageDirOf(pkg),
    })),
  };
}

/**
 * What the provisioning step achieved.
 *   every pinned package present + android-37 present      -> ok
 *   every pinned package present, android-37 unattainable   -> degraded (a warning)
 *   any pinned package missing                             -> failed (the job is red)
 */
export function decideProvisionResult({
  required = [],
  compileSdkInstalled = false,
  channelsTried = PROVISION_CHANNELS.map((channel) => channel.label),
} = {}) {
  const missing = required
    .filter((entry) => entry.present !== true)
    .map((entry) => String(entry.package));
  const failures = missing.map(
    (pkg) => 'pinned package ' + pkg + ' could not be installed from the stable channel',
  );
  if (failures.length > 0) {
    return { status: PROVISION_STATUS_FAILED, degraded: false, failures, notes: [], missing };
  }
  if (compileSdkInstalled === true) {
    return {
      status: PROVISION_STATUS_OK,
      degraded: false,
      failures: [],
      notes: [ANDROID_COMPILE_SDK_PACKAGE + ' was provisioned explicitly'],
      missing,
    };
  }
  return {
    status: PROVISION_STATUS_DEGRADED,
    degraded: true,
    failures: [],
    notes: [
      ANDROID_COMPILE_SDK_PACKAGE +
        ' is unavailable from every channel tried (' +
        channelsTried.join(', ') +
        '): AGP may still auto-download it during the build, but that is not proven here and a ' +
        'provisioning warning is never a passing build - check-platform decides',
    ],
    missing,
  };
}

/**
 * The gate that runs AFTER the build, before the job may report a result.
 * A PASS needs the platform directory, not a warning.
 */
export function decideProvisionGate({
  status = PROVISION_STATUS_UNKNOWN,
  compileSdkPresent = false,
  compileSdk = ANDROID_COMPILE_SDK,
  gradleCompileSdk = null,
} = {}) {
  const failures = [];
  const notes = [];
  if (status === PROVISION_STATUS_FAILED) {
    failures.push('the shared provisioning step failed: a pinned package is missing');
  }
  if (compileSdkPresent !== true) {
    failures.push(
      'platforms;android-' +
        compileSdk +
        ' is not installed under the Android SDK after the build: a provisioning warning is ' +
        'never a passing build, so this job cannot report a result',
    );
  }
  if (gradleCompileSdk !== null && gradleCompileSdk !== compileSdk) {
    failures.push(
      'the generated Gradle project compiles against SDK ' +
        gradleCompileSdk +
        ' but this release is proven against compileSdk ' +
        compileSdk,
    );
  }
  let provisionedBy = PROVISIONED_BY_UNKNOWN;
  if (compileSdkPresent === true) {
    if (status === PROVISION_STATUS_OK) {
      provisionedBy = PROVISIONED_BY_STEP;
      notes.push(ANDROID_COMPILE_SDK_PACKAGE + ' was provisioned by the shared step');
    } else if (status === PROVISION_STATUS_DEGRADED) {
      provisionedBy = PROVISIONED_BY_AGP;
      notes.push(
        'the provisioning step warned and ' +
          ANDROID_COMPILE_SDK_PACKAGE +
          ' is present anyway (AGP auto-download); the platform is proven present here and the ' +
          'warning stays recorded as a warning, it is not reported as a provisioning success',
      );
    } else {
      notes.push(
        'the provisioning step recorded no status (' +
          status +
          '); only the platform presence is proven',
      );
    }
  }
  return {
    ok: failures.length === 0,
    failures,
    notes,
    provisionedBy: failures.length === 0 ? provisionedBy : PROVISIONED_BY_UNKNOWN,
    compileSdk: Number(compileSdk),
  };
}

/** The compileSdk a generated Gradle project declares, or null when it declares none. */
export function readCompileSdk(text) {
  const match = /\bcompileSdk(?:Version)?\b\s*(?:=|\()\s*(\d+)/.exec(String(text ?? ''));
  return match ? Number.parseInt(match[1], 10) : null;
}

/**
 * The static wiring of one workflow file: which provisioning entry points it
 * calls and which setup-android package lists it passes. Two workflows diverge
 * exactly when these differ, so the CI regression compares them.
 */
export function describeProvisioningWiring(text) {
  const entries = [];
  const gates = [];
  const packageLists = [];
  const inline = [];
  const hardcoded = [];
  for (const [index, raw] of String(text ?? '')
    .split(/\r?\n/)
    .entries()) {
    const line = raw.trim();
    if (line.startsWith('#')) continue;
    if (line.includes(ANDROID_PROVISION_ENTRY)) entries.push(ANDROID_PROVISION_ENTRY);
    else if (line.includes(ANDROID_PROVISION_GATE_ENTRY)) gates.push(ANDROID_PROVISION_GATE_ENTRY);
    const packages = /^packages:\s*(.+)$/.exec(line);
    if (packages) {
      packageLists.push(packages[1].trim().replace(/^['"]|['"]$/g, ''));
    }
    if (/\bsdkmanager\b/.test(line)) {
      inline.push({ line: index + 1, text: line });
    }
    if (line.includes(ANDROID_COMPILE_SDK_PACKAGE) && !line.includes('android-sdk-provision')) {
      hardcoded.push({ line: index + 1, text: line });
    }
  }
  return {
    entries: [...new Set(entries)],
    gates: [...new Set(gates)],
    packageLists: [...new Set(packageLists)],
    inline,
    hardcoded,
  };
}

/**
 * Every problem that would let the two workflows drift apart again. Zero
 * problems is the CI regression the release pipeline depends on.
 */
export function lintProvisioningWiring(workflows = []) {
  if (!Array.isArray(workflows) || workflows.length === 0) {
    fail('lintProvisioningWiring needs the workflow files to compare');
  }
  const problems = [];
  const lists = [];
  for (const workflow of workflows) {
    const path = String(workflow?.path ?? '(workflow)');
    const wiring = describeProvisioningWiring(workflow?.text ?? '');
    if (wiring.entries.length === 0) {
      problems.push(
        path +
          ': does not call the shared provisioning entry point (' +
          ANDROID_PROVISION_ENTRY +
          ')',
      );
    }
    if (wiring.gates.length === 0) {
      problems.push(
        path + ': does not run the provisioning gate (' + ANDROID_PROVISION_GATE_ENTRY + ')',
      );
    }
    for (const entry of wiring.inline) {
      problems.push(
        path +
          ':' +
          entry.line +
          ' provisions the SDK inline (sdkmanager) instead of through the shared step',
      );
    }
    for (const entry of wiring.hardcoded) {
      problems.push(
        path +
          ':' +
          entry.line +
          ' hardcodes ' +
          ANDROID_COMPILE_SDK_PACKAGE +
          ' outside the shared provisioning step',
      );
    }
    for (const list of wiring.packageLists) {
      lists.push(list);
      if (list !== ANDROID_SDK_PACKAGE_LIST) {
        problems.push(
          path +
            ': passes the setup-android package list ' +
            JSON.stringify(list) +
            ' but the shared step declares ' +
            JSON.stringify(ANDROID_SDK_PACKAGE_LIST),
        );
      }
    }
  }
  if (lists.length > 0 && new Set(lists).size > 1) {
    problems.push('the workflows pass different setup-android package lists: ' + lists.join(' | '));
  }
  return problems;
}

/* ---------------------------------------------------------------------------
 * CLI
 * ------------------------------------------------------------------------- */

function sdkDir() {
  const dir = String(process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? '').trim();
  if (dir === '') {
    fail('ANDROID_HOME/ANDROID_SDK_ROOT is unset: android-actions/setup-android did not run');
  }
  return dir;
}

function sdkManager(dir) {
  const candidates =
    process.platform === 'win32'
      ? [join(dir, 'cmdline-tools', 'latest', 'bin', 'sdkmanager.bat'), 'sdkmanager.bat']
      : [join(dir, 'cmdline-tools', 'latest', 'bin', 'sdkmanager'), 'sdkmanager'];
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['--version'], {
      encoding: 'utf8',
      shell: process.platform === 'win32',
    });
    if (!probe.error && probe.status === 0) return candidate;
  }
  fail(
    'sdkmanager is not runnable from ' +
      dir +
      ' and is not on PATH: android-actions/setup-android did not install the command-line tools',
  );
}

function installed(dir, pkg) {
  const relative = packageDirOf(pkg);
  return relative !== null && existsSync(join(dir, relative));
}

function installPackage(bin, dir, pkg, extraArgs = []) {
  const result = spawnSync(
    bin,
    ['--sdk_root=' + dir, '--install', pkg, ...extraArgs],
    {
      encoding: 'utf8',
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  if (result.error) return false;
  return result.status === 0;
}

function writeGithubOutput(values) {
  const path = process.env.GITHUB_OUTPUT;
  const lines = Object.entries(values)
    .map(([key, value]) => key + '=' + value)
    .join('\n');
  if (typeof path !== 'string' || path === '') {
    console.log(lines);
    return;
  }
  appendFileSync(path, lines + '\n');
}

function appendStepSummary(lines) {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (typeof path !== 'string' || path === '') {
    for (const line of lines) console.log(line);
    return;
  }
  appendFileSync(path, lines.join('\n') + '\n');
}

function provisionCommand(options) {
  const dir = sdkDir();
  const bin = sdkManager(dir);
  const plan = describeProvisionPlan();
  console.log(
    'provisioning Android SDK under ' +
      dir +
      ': ' +
      plan.packages.join(' ') +
      ' + ' +
      plan.compileSdk,
  );
  const required = [];
  for (const pkg of plan.packages) {
    let present = installed(dir, pkg);
    if (!present) {
      console.log('installing ' + pkg);
      installPackage(bin, dir, pkg);
      present = installed(dir, pkg);
    }
    required.push({ package: pkg, present });
    console.log((present ? 'present ' : 'MISSING ') + pkg);
  }

  let compileSdkInstalled = installed(dir, plan.compileSdk);
  const channelsTried = [];
  if (!compileSdkInstalled) {
    for (const channel of plan.channels) {
      channelsTried.push(channel.label);
      console.log('installing ' + plan.compileSdk + ' from the ' + channel.label + ' channel');
      installPackage(bin, dir, plan.compileSdk, channel.args);
      compileSdkInstalled = installed(dir, plan.compileSdk);
      if (compileSdkInstalled) {
        console.log(plan.compileSdk + ' installed from the ' + channel.label + ' channel');
        break;
      }
    }
  } else {
    channelsTried.push('already-installed');
  }

  const decision = decideProvisionResult({ required, compileSdkInstalled, channelsTried });
  for (const note of decision.notes) console.log('note: ' + note);
  for (const failure of decision.failures) console.error('::error::' + failure);
  if (decision.status === PROVISION_STATUS_DEGRADED) {
    for (const note of decision.notes) console.log('::warning::' + note);
  }

  const record = {
    schemaVersion: 1,
    step: 'android-sdk-provision',
    sdkRoot: dir,
    status: decision.status,
    compileSdk: ANDROID_COMPILE_SDK,
    packages: plan.packages.map((pkg) => ({ package: pkg, installed: installed(dir, pkg) })),
    compileSdkInstalled,
    channelsTried,
    notes: decision.notes,
  };
  const statusPath = resolve(process.cwd(), options?.status ?? PROVISION_STATUS_FILE);
  writeFileSync(statusPath, JSON.stringify(record, null, 2) + '\n');
  console.log('status recorded in ' + statusPath);
  writeGithubOutput({
    'compile-sdk': String(ANDROID_COMPILE_SDK),
    'compile-sdk-installed': String(compileSdkInstalled),
    status: decision.status,
    degraded: String(decision.degraded),
    'status-file': statusPath,
  });
  appendStepSummary([
    '## Android SDK provisioning',
    '',
    '| fact | value |',
    '| --- | --- |',
    '| status | ' + decision.status + ' |',
    '| packages | ' + plan.packages.join(', ') + ' |',
    '| ' + plan.compileSdk + ' | ' + (compileSdkInstalled ? 'installed' : 'missing') + ' |',
    '',
    'A degraded status is a warning, not a result: the build job still has to prove the platform.',
  ]);
  for (const group of ['platforms', 'ndk', 'build-tools']) {
    let entries = [];
    try {
      entries = readdirSync(join(dir, group));
    } catch {
      entries = [];
    }
    console.log('android ' + group + ': ' + (entries.join(' ') || '(none)'));
  }
  if (decision.status === PROVISION_STATUS_FAILED) {
    fail(decision.failures.join('; '));
  }
  console.log('provisioning status: ' + decision.status);
}

function checkPlatformCommand(options) {
  const dir = sdkDir();
  const statusPath = resolve(process.cwd(), options?.status ?? PROVISION_STATUS_FILE);
  let status = PROVISION_STATUS_UNKNOWN;
  let channelsTried = [];
  if (existsSync(statusPath)) {
    try {
      const record = JSON.parse(readFileSync(statusPath, 'utf8').replace(/^\uFEFF/, ''));
      if (PROVISION_STATUSES.includes(record?.status)) status = record.status;
      if (Array.isArray(record?.channelsTried)) channelsTried = record.channelsTried;
    } catch {
      status = PROVISION_STATUS_UNKNOWN;
    }
  } else {
    console.log('::warning::the provisioning step recorded no status file at ' + statusPath);
  }
  const gradleFile = String(options?.['gradle-file'] ?? '').trim();
  let gradleCompileSdk = null;
  if (gradleFile !== '' && existsSync(resolve(process.cwd(), gradleFile))) {
    gradleCompileSdk = readCompileSdk(readFileSync(resolve(process.cwd(), gradleFile), 'utf8'));
  }
  const compileSdkPresent = installed(dir, ANDROID_COMPILE_SDK_PACKAGE);
  const gate = decideProvisionGate({
    status,
    compileSdkPresent,
    compileSdk: ANDROID_COMPILE_SDK,
    gradleCompileSdk,
  });
  for (const note of gate.notes) console.log('note: ' + note);
  const present = installed(dir, ANDROID_COMPILE_SDK_PACKAGE);
  appendStepSummary([
    '## Android SDK gate',
    '',
    '| fact | value |',
    '| --- | --- |',
    '| provisioning status | ' + status + ' |',
    '| channels tried | ' + (channelsTried.join(', ') || '(none)') + ' |',
    '| ' + ANDROID_COMPILE_SDK_PACKAGE + ' present | ' + (present ? 'yes' : 'no') + ' |',
    '| provisioned by | ' + gate.provisionedBy + ' |',
    '| gradle compileSdk | ' + (gradleCompileSdk === null ? '(not found)' : gradleCompileSdk) + ' |',
    '',
    'A provisioning warning is never a passing build: this gate is what turns the platform presence',
    'into evidence, and it fails when the platform is missing.',
  ]);
  writeGithubOutput({
    'provisioned-by': gate.provisionedBy,
    'compile-sdk-present': String(gate.failures.length === 0),
  });
  if (!gate.ok) {
    for (const failure of gate.failures) console.error('::error::' + failure);
    fail(gate.failures.join('; '));
  }
  console.log(
    'OK provisioning gate: ' +
      ANDROID_COMPILE_SDK_PACKAGE +
      ' present, provisioned by ' +
      gate.provisionedBy,
  );
}

function lintCommand(positional) {
  const paths =
    positional.length > 0
      ? positional
      : ['.github/workflows/release-dev.yml', '.github/workflows/android-smoke.yml'];
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const problems = lintProvisioningWiring(
    paths.map((path) => ({ path, text: readFileSync(resolve(root, path), 'utf8') })),
  );
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem);
    fail(problems.length + ' provisioning wiring problem(s) in ' + paths.length + ' file(s)');
  }
  console.log('OK provisioning wiring: ' + paths.length + ' workflow file(s) share one step');
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  const positional = [];
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const body = token.slice(2);
    const equals = body.indexOf('=');
    if (equals === -1) {
      options[body] = rest[index + 1];
      index += 1;
    } else {
      options[body.slice(0, equals)] = body.slice(equals + 1);
    }
  }
  return { command, options, positional };
}

const COMMANDS = {
  provision: (_positional, options) => provisionCommand(options),
  'check-platform': (_positional, options) => checkPlatformCommand(options),
  'lint-workflows': (positional) => lintCommand(positional),
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { command, options, positional } = parseArgs(process.argv.slice(2));
  const handler = COMMANDS[command];
  if (!handler) {
    console.error(
      '::error::unknown command ' +
        JSON.stringify(command ?? '') +
        ' (expected ' +
        Object.keys(COMMANDS).join(', ') +
        ')',
    );
    process.exitCode = 1;
  } else {
    try {
      handler(positional, options);
    } catch (error) {
      if (error instanceof AndroidSdkProvisionError) {
        console.error('::error::' + error.message);
        process.exitCode = 1;
      } else {
        throw error;
      }
    }
  }
}
