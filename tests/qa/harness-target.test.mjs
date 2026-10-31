import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  ERROR_CODES,
  EXIT_CODES,
  MTIME_TOLERANCE_MS,
  PARTIAL_EXIT_CODE,
  POLICY_VERSION,
  QA_PRODUCT_NAME,
  SELECTION_MODES,
  gateExitCode,
  resolveHarnessTarget,
} from '../../scripts/qa/native/harness-target.mjs';

// RC2-D.14 Phase C: the QA harness must never validate new code against a
// stale or wrong binary. These tests drive the pure decision module with
// synthetic probes - no installer is executed, no process is launched and no
// network access is needed.

const here = dirname(fileURLToPath(import.meta.url));
const ps1Path = join(here, '..', '..', 'scripts', 'qa', 'native', 'run-windows.ps1');
const modulePath = join(here, '..', '..', 'scripts', 'qa', 'native', 'harness-target.mjs');

const HEAD = 'f9d4d9204b8715ae8969ab90635ae3f21a034114';
const RELEASE_EXE = 'D:\\repo\\apps\\native\\src-tauri\\target\\release\\todo-native.exe';
const INSTALLED_EXE = 'C:\\Users\\qa\\AppData\\Local\\Shishi QA RC2D\\todo-native.exe';
const INSTALLED_EXE_ALT =
  'C:\\Users\\qa\\AppData\\Local\\Programs\\Shishi QA RC2D\\todo-native.exe';
const QA_INSTALLER =
  'D:\\repo\\apps\\native\\src-tauri\\target\\release\\bundle\\nsis\\Shishi QA RC2D_1.0.0-rc2d_x64-setup.exe';
const QA_INSTALLER_OLD =
  'D:\\repo\\apps\\native\\src-tauri\\target\\release\\bundle\\nsis\\Shishi QA RC2D_1.0.0-rc2a_x64-setup.exe';
const DEV_INSTALLER =
  'D:\\repo\\apps\\native\\src-tauri\\target\\release\\bundle\\nsis\\Shishi Dev_0.0.1-dev.1_x64-setup.exe';
const STABLE_INSTALLER =
  'D:\\repo\\apps\\native\\src-tauri\\target\\release\\bundle\\nsis\\Shishi_0.0.1-dev.1_x64-setup.exe';

const T_BASE = Date.parse('2026-10-30T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

const sha = (char) => char.repeat(64);

function exe(overrides = {}) {
  return {
    path: INSTALLED_EXE,
    source: 'installed',
    exists: true,
    productName: QA_PRODUCT_NAME,
    productVersion: '1.0.0-rc2d',
    sha256: sha('a'),
    mtimeMs: T_BASE,
    ...overrides,
  };
}

function installer(overrides = {}) {
  return {
    path: QA_INSTALLER,
    source: 'discovered',
    exists: true,
    productName: QA_PRODUCT_NAME,
    productVersion: '1.0.0-rc2d',
    sha256: sha('b'),
    mtimeMs: T_BASE,
    ...overrides,
  };
}

function probe({
  flags = {},
  paths = {},
  git = {},
  appCandidates = [],
  installerCandidates = [],
} = {}) {
  return {
    schemaVersion: 1,
    flags: { phase: 'resolve', ...flags },
    paths: { appData: 'C:\\Users\\qa\\AppData\\Roaming', ...paths },
    git: { commit: HEAD, branch: 'feat/rc2d14-platform-release-closure', dirty: false, ...git },
    appCandidates,
    installerCandidates,
  };
}

test('DiscoverOnly needs no installer and never requires one', () => {
  const decision = resolveHarnessTarget(
    probe({
      flags: { discoverOnly: true },
      appCandidates: [exe()],
      installerCandidates: [],
    }),
  );
  assert.equal(decision.ok, true, decision.message);
  assert.equal(decision.errorCode, null);
  assert.equal(decision.action, 'discover');
  assert.equal(decision.installer, null);
  assert.equal(decision.selection, SELECTION_MODES.DISCOVERED);
  assert.equal(decision.appExe, INSTALLED_EXE);
});

test('Install path resolves the installed QA executable instead of the release build', () => {
  const decision = resolveHarnessTarget(
    probe({
      flags: { install: true, installer: QA_INSTALLER },
      appCandidates: [
        exe({
          path: RELEASE_EXE,
          source: 'release-build',
          productName: 'Shishi Dev',
          productVersion: '0.0.1-dev.1',
          sha256: sha('c'),
          mtimeMs: T_BASE + HOUR,
        }),
        exe(),
      ],
      installerCandidates: [installer({ source: 'explicit' })],
    }),
  );
  assert.equal(decision.ok, true, decision.message);
  assert.equal(decision.selection, SELECTION_MODES.INSTALLED);
  assert.equal(decision.appExe, INSTALLED_EXE);
  assert.equal(decision.requireInstall, true);
  assert.equal(decision.installer, QA_INSTALLER);
  // The Dev build in the release directory is reported, never selected.
  assert.deepEqual(decision.rejectedCandidates, [{ path: RELEASE_EXE, productName: 'Shishi Dev' }]);
});

test('Install phase defers the target until the installer ran', () => {
  const decision = resolveHarnessTarget(
    probe({
      flags: { install: true, installer: QA_INSTALLER, phase: 'plan' },
      appCandidates: [],
      installerCandidates: [installer({ source: 'explicit' })],
    }),
  );
  assert.equal(decision.ok, true, decision.message);
  assert.equal(decision.action, 'install');
  assert.equal(decision.targetPending, true);
  assert.equal(decision.appExe, null);
  assert.equal(decision.installer, QA_INSTALLER);
  assert.equal(decision.installerSha256, sha('b'));
});

test('Install with no installed executable fails closed instead of using the release build', () => {
  const decision = resolveHarnessTarget(
    probe({
      flags: { install: true, installer: QA_INSTALLER },
      appCandidates: [exe({ path: RELEASE_EXE, source: 'release-build', sha256: sha('c') })],
      installerCandidates: [installer({ source: 'explicit' })],
    }),
  );
  assert.equal(decision.ok, false);
  assert.equal(decision.errorCode, ERROR_CODES.INSTALLED_EXE_NOT_FOUND);
  assert.match(decision.message, /refusing to fall back to the release build/);
  assert.match(decision.message, /-AppExe/);
});

test('Explicit AppExe is accepted and marked as explicitly chosen', () => {
  const decision = resolveHarnessTarget(
    probe({
      flags: { appExe: INSTALLED_EXE, expectedSha256: sha('a'), expectedVersion: '1.0.0-rc2d' },
      appCandidates: [exe()],
    }),
  );
  assert.equal(decision.ok, true, decision.message);
  assert.equal(decision.selection, SELECTION_MODES.EXPLICIT);
  assert.equal(decision.appExe, INSTALLED_EXE);
  assert.equal(decision.provenance.explicitlyChosen, true);
  assert.equal(decision.provenance.expectedSha256, sha('a'));
  assert.equal(decision.provenance.expectedVersion, '1.0.0-rc2d');
});

test('Explicit Installer is accepted for a QA package and recorded in the provenance', () => {
  const decision = resolveHarnessTarget(
    probe({
      flags: { install: true, installer: QA_INSTALLER, phase: 'plan' },
      installerCandidates: [installer({ source: 'explicit' })],
      appCandidates: [],
    }),
  );
  assert.equal(decision.ok, true, decision.message);
  assert.equal(decision.provenance.installer, QA_INSTALLER);
  assert.equal(decision.provenance.installerSha256, sha('b'));
  assert.equal(decision.provenance.installerProductVersion, '1.0.0-rc2d');
});

test('Wrong ProductName is rejected', () => {
  const decision = resolveHarnessTarget(
    probe({
      flags: { appExe: RELEASE_EXE },
      appCandidates: [
        exe({ path: RELEASE_EXE, source: 'explicit', productName: 'Shishi Dev', sha256: sha('c') }),
      ],
    }),
  );
  assert.equal(decision.ok, false);
  assert.equal(decision.errorCode, ERROR_CODES.PRODUCT_NAME_MISMATCH);
  assert.match(decision.message, /refusing non-QA app/);
  assert.match(decision.message, /Shishi QA RC2D/);
  assert.match(decision.message, /never runs against production/);
});

test('Stable package passed as installer is rejected', () => {
  const decision = resolveHarnessTarget(
    probe({
      flags: { discoverOnly: true, installer: STABLE_INSTALLER },
      installerCandidates: [
        installer({
          path: STABLE_INSTALLER,
          source: 'explicit',
          productName: 'Shishi',
          productVersion: '0.0.1-dev.1',
        }),
      ],
      appCandidates: [exe()],
    }),
  );
  assert.equal(decision.ok, false);
  assert.equal(decision.errorCode, ERROR_CODES.INSTALLER_PRODUCT_MISMATCH);
  assert.match(decision.message, /refusing non-QA installer/);
  assert.match(decision.message, /expected ProductName "Shishi QA RC2D"/);
  assert.match(decision.message, /Shishi_0\.0\.1-dev\.1_x64-setup\.exe/);
});

test('Dev package passed as installer is rejected', () => {
  const decision = resolveHarnessTarget(
    probe({
      flags: { discoverOnly: true, installer: DEV_INSTALLER },
      installerCandidates: [
        installer({
          path: DEV_INSTALLER,
          source: 'explicit',
          productName: 'Shishi Dev',
          productVersion: '0.0.1-dev.1',
        }),
      ],
      appCandidates: [exe()],
    }),
  );
  assert.equal(decision.ok, false);
  assert.equal(decision.errorCode, ERROR_CODES.INSTALLER_PRODUCT_MISMATCH);
  assert.match(decision.message, /product="Shishi Dev"/);
  assert.match(decision.message, /never installs a production/);
});

test('Stale QA binary against a newer candidate fails closed with an actionable message', () => {
  const newer = exe({
    path: INSTALLED_EXE,
    source: 'installed',
    sha256: sha('d'),
    mtimeMs: T_BASE + 3 * HOUR,
    productVersion: '1.0.0-rc2e',
  });
  const older = exe({
    path: RELEASE_EXE,
    source: 'explicit',
    sha256: sha('e'),
    mtimeMs: T_BASE,
    productVersion: '1.0.0-rc2d',
  });
  const decision = resolveHarnessTarget(
    probe({ flags: { appExe: RELEASE_EXE }, appCandidates: [older, newer] }),
  );
  assert.equal(decision.ok, false);
  assert.equal(decision.errorCode, ERROR_CODES.STALE_TARGET);
  // Names both candidates with mtime, version and hash.
  assert.match(decision.message, /selected: path=D:\\repo\\apps.*mtime=2026-10-30T12:00:00\.000Z/);
  assert.ok(decision.message.includes(sha('e')), 'selected hash must be named');
  assert.ok(decision.message.includes(sha('d')), 'newer hash must be named');
  assert.ok(decision.message.includes(INSTALLED_EXE), 'newer path must be named');
  assert.match(decision.message, /1\.0\.0-rc2e/);
  // Names the explicit flag the operator should pass.
  assert.ok(decision.message.includes('-AppExe "' + INSTALLED_EXE + '"'));
  assert.ok(decision.message.includes('-AllowStaleTarget'));
  assert.match(
    decision.message,
    /never produce|refusing to produce new-code evidence from a stale binary/,
  );

  const override = resolveHarnessTarget(
    probe({
      flags: { appExe: RELEASE_EXE, allowStaleTarget: true },
      appCandidates: [older, newer],
    }),
  );
  assert.equal(override.ok, true, override.message);
  assert.equal(override.appExe, RELEASE_EXE);
  assert.ok(override.warnings.some((line) => line.includes('-AllowStaleTarget')));
});

test('A stale binary inside the ambiguity window is not stale, it is ambiguous', () => {
  const first = exe({
    path: RELEASE_EXE,
    source: 'release-build',
    sha256: sha('1'),
    mtimeMs: T_BASE,
  });
  const second = exe({
    path: INSTALLED_EXE,
    source: 'installed',
    sha256: sha('2'),
    mtimeMs: T_BASE + Math.floor(MTIME_TOLERANCE_MS / 2),
  });
  const decision = resolveHarnessTarget(probe({ appCandidates: [first, second] }));
  assert.equal(decision.ok, false);
  assert.equal(decision.errorCode, ERROR_CODES.AMBIGUOUS_TARGET);
  assert.match(decision.message, /built at almost the same time/);
});

test('Discovery never silently selects a stale binary: the newest QA build wins', () => {
  const older = exe({
    path: RELEASE_EXE,
    source: 'release-build',
    sha256: sha('3'),
    mtimeMs: T_BASE,
    productVersion: '1.0.0-rc2d',
  });
  const newer = exe({
    path: INSTALLED_EXE,
    source: 'installed',
    sha256: sha('4'),
    mtimeMs: T_BASE + 5 * HOUR,
    productVersion: '1.0.0-rc2e',
  });
  const decision = resolveHarnessTarget(probe({ appCandidates: [older, newer] }));
  assert.equal(decision.ok, true, decision.message);
  assert.equal(decision.selection, SELECTION_MODES.DISCOVERED);
  assert.equal(decision.appExe, INSTALLED_EXE);
  assert.equal(decision.appExeSha256, sha('4'));
  assert.deepEqual(decision.alternatives, [RELEASE_EXE]);
  assert.ok(decision.warnings.some((line) => line.includes('newer QA build available')));
});

test('Missing installer is refused with the packages examined', () => {
  const decision = resolveHarnessTarget(
    probe({
      flags: { install: true },
      installerCandidates: [
        installer({ path: DEV_INSTALLER, productName: 'Shishi Dev', sha256: sha('f') }),
      ],
      appCandidates: [exe()],
    }),
  );
  assert.equal(decision.ok, false);
  assert.equal(decision.errorCode, ERROR_CODES.INSTALLER_REQUIRED);
  assert.match(decision.message, /-Install requires an NSIS installer path/);
  assert.ok(decision.message.includes(DEV_INSTALLER));
  assert.match(decision.message, /-Installer/);
});

test('Multiple candidate installers are reported as ambiguity, not resolved by newest', () => {
  const decision = resolveHarnessTarget(
    probe({
      flags: { install: true },
      installerCandidates: [
        installer({
          path: QA_INSTALLER,
          source: 'discovered',
          sha256: sha('6'),
          mtimeMs: T_BASE + HOUR,
        }),
        installer({
          path: QA_INSTALLER_OLD,
          source: 'discovered',
          sha256: sha('7'),
          mtimeMs: T_BASE,
        }),
      ],
      appCandidates: [exe()],
    }),
  );
  assert.equal(decision.ok, false);
  assert.equal(decision.errorCode, ERROR_CODES.INSTALLER_AMBIGUOUS);
  assert.match(decision.message, /2 QA installers are available; refusing to guess/);
  assert.ok(decision.message.includes(QA_INSTALLER));
  assert.ok(decision.message.includes(QA_INSTALLER_OLD));
  assert.equal(decision.installerCandidates.length, 2);
});

test('Same ProductName with different sha256 is distinguished and a mismatched expected sha is refused', () => {
  const candidateA = exe({
    path: RELEASE_EXE,
    source: 'release-build',
    sha256: sha('8'),
    mtimeMs: T_BASE,
  });
  const candidateB = exe({
    path: INSTALLED_EXE,
    source: 'installed',
    sha256: sha('9'),
    mtimeMs: T_BASE + 4 * HOUR,
  });
  const decision = resolveHarnessTarget(
    probe({
      flags: { appExe: RELEASE_EXE, expectedSha256: sha('9') },
      appCandidates: [candidateA, candidateB],
    }),
  );
  assert.equal(decision.ok, false);
  assert.equal(decision.errorCode, ERROR_CODES.SHA_MISMATCH);
  assert.match(decision.message, /QA executable SHA-256 mismatch/);
  assert.ok(decision.message.includes(sha('9')));
  assert.ok(decision.message.includes(sha('8')));

  // Both binaries share ProductName, so only the hash separates them.
  const ambiguity = resolveHarnessTarget(
    probe({
      appCandidates: [
        exe({ path: RELEASE_EXE, source: 'release-build', sha256: sha('8'), mtimeMs: T_BASE }),
        exe({ path: INSTALLED_EXE, source: 'installed', sha256: sha('9'), mtimeMs: T_BASE + 100 }),
      ],
    }),
  );
  assert.equal(ambiguity.ok, false);
  assert.equal(ambiguity.errorCode, ERROR_CODES.AMBIGUOUS_TARGET);
  assert.ok(ambiguity.message.includes(sha('8')));
  assert.ok(ambiguity.message.includes(sha('9')));
});

test('PARTIAL exit code semantics are encoded once and shared with PowerShell', () => {
  assert.equal(PARTIAL_EXIT_CODE, 2);
  assert.deepEqual(EXIT_CODES, { OK: 0, FAIL: 1, PARTIAL: 2 });
  const decision = resolveHarnessTarget(probe({ appCandidates: [exe()] }));
  assert.deepEqual(decision.exitCodes, { ok: 0, fail: 1, partial: 2 });
  assert.equal(gateExitCode({ status: 'PASS' }), 0);
  assert.equal(gateExitCode({ status: 'BENCH_ONLY' }), 0);
  assert.equal(gateExitCode({ status: 'FAIL' }), 1);
  assert.equal(gateExitCode({ status: 'PARTIAL' }), 2);
  assert.equal(gateExitCode({ status: 'NOT_RUN' }), 2);
  assert.equal(gateExitCode({ status: 'PARTIAL', allowPartial: true }), 0);
  const ps1 = readFileSync(ps1Path, 'utf8');
  assert.ok(
    ps1.includes('exit $PartialExitCode'),
    'run-windows.ps1 must exit with the shared code',
  );
  assert.ok(!ps1.includes('exit 2'), 'run-windows.ps1 must not hard-code the PARTIAL exit code');
});

test('QA evidence root points inside the QA data root, never at production', () => {
  const decision = resolveHarnessTarget(probe({ appCandidates: [exe()] }));
  assert.equal(decision.qa.identifier, 'app.shishi.todo.qa');
  assert.match(decision.qa.dataRoot, /AppData\\Roaming\\app\.shishi\.todo\.qa$/);
  assert.equal(decision.qa.evidenceRoot, join(decision.qa.dataRoot, 'evidence'));
  assert.ok(
    decision.qa.evidenceRoot.toLowerCase().startsWith(decision.qa.dataRoot.toLowerCase() + '\\'),
    'evidence root must live inside the QA data root',
  );
  assert.notEqual(decision.qa.productionDataRoot, decision.qa.dataRoot);
  assert.match(decision.qa.productionDataRoot, /AppData\\Roaming\\app\.shishi\.todo$/);

  const missingRoots = resolveHarnessTarget({
    ...probe({ appCandidates: [exe()] }),
    paths: { appData: '' },
  });
  assert.equal(missingRoots.ok, false);
  assert.equal(missingRoots.errorCode, ERROR_CODES.QA_ROOT_INVALID);
});

test('Git and binary provenance fields are present in the decision output', () => {
  const decision = resolveHarnessTarget(
    probe({
      appCandidates: [exe()],
      installerCandidates: [installer({ source: 'explicit' })],
      flags: { install: true, installer: QA_INSTALLER },
    }),
  );
  assert.equal(decision.ok, true, decision.message);
  assert.equal(decision.policyVersion, POLICY_VERSION);
  assert.equal(decision.git.commit, HEAD);
  assert.equal(decision.git.branch, 'feat/rc2d14-platform-release-closure');
  const provenance = decision.provenance;
  assert.match(provenance.gitCommit, /^[0-9a-f]{40}$/);
  assert.equal(provenance.gitBranch, 'feat/rc2d14-platform-release-closure');
  assert.equal(provenance.appExe, INSTALLED_EXE);
  assert.match(provenance.appExeSha256, /^[0-9a-f]{64}$/);
  assert.equal(provenance.appExeProductName, QA_PRODUCT_NAME);
  assert.equal(provenance.appExeProductVersion, '1.0.0-rc2d');
  assert.equal(provenance.appExeMtime, '2026-10-30T12:00:00.000Z');
  assert.equal(provenance.installer, QA_INSTALLER);
  assert.match(provenance.installerSha256, /^[0-9a-f]{64}$/);
  assert.equal(provenance.selection, SELECTION_MODES.INSTALLED);
  assert.equal(provenance.explicitlyChosen, false);
  assert.equal(provenance.policyVersion, POLICY_VERSION);
});

test('PowerShell 5.1 compatibility: no pwsh-only constructs in run-windows.ps1', () => {
  const ps1 = readFileSync(ps1Path, 'utf8');
  const moduleSource = readFileSync(modulePath, 'utf8');
  assert.match(moduleSource, /PowerShell 5\.1/, 'the policy module must document PS 5.1 support');
  assert.ok(!/pwsh/i.test(ps1), 'run-windows.ps1 must not require pwsh');
  assert.ok(!/-AsHashtable/.test(ps1), 'ConvertFrom-Json -AsHashtable is PowerShell 7 only');
  assert.ok(
    !/ForEach-Object\s+-Parallel/.test(ps1),
    'ForEach-Object -Parallel is PowerShell 7 only',
  );
  assert.ok(!/\$PSStyle/.test(ps1), '$PSStyle is PowerShell 7 only');
  assert.ok(!/\?\?/.test(ps1), 'the null-coalescing operator is PowerShell 7 only');
  assert.ok(ps1.includes('harness-target.mjs'), 'the script must call the policy module');
  for (const parameter of [
    '$RunId',
    '$AppExe',
    '$Installer',
    '$CdpPort',
    '$Build',
    '$Install',
    '$FaultConfig',
    '$PerfTasks',
    '$BenchSizes',
    '$BenchRuns',
    '$AllowPartial',
    '$DiscoverOnly',
    '$KeepRunning',
  ]) {
    assert.ok(ps1.includes(parameter), 'missing existing parameter ' + parameter);
  }
});
