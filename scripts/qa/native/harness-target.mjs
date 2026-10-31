#!/usr/bin/env node
/**
 * RC2-D.14 Phase C - QA harness target selection policy.
 *
 * Why this file exists: run-windows.ps1 used to pick a QA executable with an
 * implicit preference order (repository release build first, installed QA build
 * second) and only ever checked ProductName. A stale release binary - older
 * than the installed QA build, or built from another commit - could therefore
 * provide the evidence for "new code passes". This module owns the decision so
 * it is pure, documented and unit tested; run-windows.ps1 only probes the file
 * system, calls this module through the node executable, and executes the
 * decision.
 *
 * Selection policy (fail closed - a doubtful target is never a silent pass):
 *
 *   1. Installer gate (always evaluated, -Install or not):
 *        explicit -Installer   -> ProductName must be "Shishi QA RC2D", plus the
 *                                 optional -ExpectedInstallerSha256.
 *        -Install only         -> exactly one QA package in the bundle dir; zero
 *                                 is INSTALLER_REQUIRED, two or more is
 *                                 INSTALLER_AMBIGUOUS (never "newest wins").
 *      A Dev/Stable/production package is refused, never installed.
 *   2. Target:
 *        explicit -AppExe     -> wins, but must exist, must be ProductName
 *                                 "Shishi QA RC2D", must satisfy the optional
 *                                 -ExpectedSha256 / -ExpectedVersion.
 *        -Install (no -AppExe)-> the freshly installed QA executable is the
 *                                 target; a missing installed executable is
 *                                 INSTALLED_EXE_NOT_FOUND instead of a silent
 *                                 fall back to the release build.
 *        neither (discovery)  -> every existing QA candidate is listed, the
 *                                 newest QA build wins (mtime, path as a stable
 *                                 tie break) and non-QA candidates are reported
 *                                 as rejected. Two QA candidates built at the
 *                                 same time with different content are
 *                                 AMBIGUOUS_TARGET - the operator is asked for
 *                                 -AppExe instead of a coin flip.
 *   3. Freshness (every selection mode): if another available QA executable has
 *      different content (sha256) and a newer mtime, the selected binary is
 *      stale for new-code acceptance and the run fails closed with STALE_TARGET
 *      unless -AllowStaleTarget was passed deliberately. Discovery can never
 *      trip this rule by construction (it selects the newest build), which is
 *      exactly the guarantee the old preference order did not have.
 *   4. Provenance: the decision always carries git commit/branch, the binary
 *      path, sha256, ProductVersion and ProductName, the installer path and
 *      sha256 when one is used, and whether the target was explicit or
 *      discovered. run-windows.ps1 copies those into environment.json,
 *      provenance.json and manifest.json.
 *
 * Exit code semantics encoded here as EXIT_CODES so PowerShell and the tests
 * share one definition: 0 ok, 1 failure, 2 PARTIAL/NOT_RUN evidence without
 * -AllowPartial (exit 2 is not a pass).
 *
 * PowerShell compatibility: run-windows.ps1 invokes this file through the node
 * executable and only uses Windows PowerShell 5.1 constructs. Nothing here
 * requires pwsh.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const POLICY_VERSION = 'harness-target/v1';
export const QA_PRODUCT_NAME = 'Shishi QA RC2D';
export const QA_IDENTIFIER = 'app.shishi.todo.qa';
export const QA_DATA_ROOT_DIRNAME = 'app.shishi.todo.qa';
export const PRODUCTION_DATA_ROOT_DIRNAME = 'app.shishi.todo';
export const QA_EVIDENCE_DIRNAME = 'evidence';

/** Shared with run-windows.ps1: 0 ok, 1 failure, 2 PARTIAL/NOT_RUN evidence. */
export const EXIT_CODES = Object.freeze({ OK: 0, FAIL: 1, PARTIAL: 2 });
export const PARTIAL_EXIT_CODE = EXIT_CODES.PARTIAL;

/**
 * Two builds written inside the same window cannot be ordered by mtime, so a
 * different sha256 in that window is reported as ambiguity instead of a guess.
 */
export const MTIME_TOLERANCE_MS = 2000;

export const SELECTION_MODES = Object.freeze({
  EXPLICIT: 'explicit',
  INSTALLED: 'installed',
  DISCOVERED: 'discovered',
});

export const PHASES = Object.freeze({ PLAN: 'plan', RESOLVE: 'resolve' });

export const ERROR_CODES = Object.freeze({
  PROBE_INVALID: 'PROBE_INVALID',
  QA_ROOT_INVALID: 'QA_ROOT_INVALID',
  INSTALLER_REQUIRED: 'INSTALLER_REQUIRED',
  INSTALLER_NOT_FOUND: 'INSTALLER_NOT_FOUND',
  INSTALLER_PRODUCT_MISMATCH: 'INSTALLER_PRODUCT_MISMATCH',
  INSTALLER_SHA_MISMATCH: 'INSTALLER_SHA_MISMATCH',
  INSTALLER_VERSION_MISMATCH: 'INSTALLER_VERSION_MISMATCH',
  INSTALLER_AMBIGUOUS: 'INSTALLER_AMBIGUOUS',
  APP_EXE_NOT_FOUND: 'APP_EXE_NOT_FOUND',
  PRODUCT_NAME_MISMATCH: 'PRODUCT_NAME_MISMATCH',
  SHA_MISMATCH: 'SHA_MISMATCH',
  VERSION_MISMATCH: 'VERSION_MISMATCH',
  NO_QA_TARGET: 'NO_QA_TARGET',
  AMBIGUOUS_TARGET: 'AMBIGUOUS_TARGET',
  INSTALLED_EXE_NOT_FOUND: 'INSTALLED_EXE_NOT_FOUND',
  INSTALLED_EXE_AMBIGUOUS: 'INSTALLED_EXE_AMBIGUOUS',
  STALE_TARGET: 'STALE_TARGET',
});

export class HarnessTargetError extends Error {
  constructor(message) {
    super(message);
    this.name = 'HarnessTargetError';
  }
}

function isSha256(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function sha256OrNull(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return isSha256(normalized) ? normalized : null;
}

function pathKey(value) {
  return String(value || '')
    .replace(/[\\/]+/g, '/')
    .toLowerCase();
}

function insideRoot(root, target) {
  const rootKey = pathKey(root).replace(/\/+$/, '');
  const targetKey = pathKey(target);
  return targetKey.length > rootKey.length && targetKey.indexOf(rootKey + '/') === 0;
}

function formatTime(ms) {
  if (!Number.isFinite(ms)) return 'unknown';
  return new Date(ms).toISOString();
}

function describeCandidate(candidate) {
  const parts = [
    'path=' + candidate.path,
    'source=' + candidate.source,
    'mtime=' + formatTime(candidate.mtimeMs),
    'version=' + (candidate.productVersion || 'unknown'),
    'product=' +
      (candidate.productName === null ? 'unknown' : JSON.stringify(candidate.productName)),
    'sha256=' + (candidate.sha256 || 'unknown'),
  ];
  return parts.join(' ');
}

/** One numbered line per candidate: paths, mtimes, versions and hashes. */
export function renderCandidateTable(candidates) {
  if (!candidates || candidates.length === 0) return '  (none)';
  return candidates
    .map((candidate, index) => '  ' + (index + 1) + '. ' + describeCandidate(candidate))
    .join('\n');
}

function normalizeCandidate(raw, kind) {
  if (!raw || typeof raw !== 'object') {
    throw new HarnessTargetError(kind + ' candidate is not an object');
  }
  const path = typeof raw.path === 'string' ? raw.path : '';
  if (!path) throw new HarnessTargetError(kind + ' candidate has no path');
  const mtimeMs =
    typeof raw.mtimeMs === 'number' && Number.isFinite(raw.mtimeMs) ? raw.mtimeMs : null;
  return {
    kind,
    path,
    source: typeof raw.source === 'string' && raw.source ? raw.source : 'unknown',
    exists: raw.exists !== false,
    productName: typeof raw.productName === 'string' ? raw.productName : null,
    productVersion: typeof raw.productVersion === 'string' ? raw.productVersion : null,
    sha256: sha256OrNull(raw.sha256),
    mtimeMs,
    sizeBytes: Number.isFinite(raw.sizeBytes) ? raw.sizeBytes : null,
  };
}

function normalizeFlags(raw) {
  const flags = raw && typeof raw === 'object' ? raw : {};
  const text = (value) => {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  };
  return {
    discoverOnly: flags.discoverOnly === true,
    install: flags.install === true,
    build: flags.build === true,
    allowPartial: flags.allowPartial === true,
    allowStaleTarget: flags.allowStaleTarget === true,
    keepRunning: flags.keepRunning === true,
    phase: flags.phase === PHASES.PLAN ? PHASES.PLAN : PHASES.RESOLVE,
    appExe: text(flags.appExe),
    installer: text(flags.installer),
    expectedSha256: text(flags.expectedSha256),
    expectedVersion: text(flags.expectedVersion),
    expectedInstallerSha256: text(flags.expectedInstallerSha256),
  };
}

function normalizeProbe(raw) {
  if (!raw || typeof raw !== 'object') throw new HarnessTargetError('probe must be an object');
  const flags = normalizeFlags(raw.flags);
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  const gitRaw = raw.git && typeof raw.git === 'object' ? raw.git : {};
  const appCandidates = (Array.isArray(raw.appCandidates) ? raw.appCandidates : []).map(
    (candidate) => normalizeCandidate(candidate, 'app'),
  );
  const installerCandidates = (
    Array.isArray(raw.installerCandidates) ? raw.installerCandidates : []
  ).map((candidate) => normalizeCandidate(candidate, 'installer'));
  const seen = new Set();
  const uniqueApp = appCandidates.filter((candidate) => {
    const key = pathKey(candidate.path);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const appData = typeof paths.appData === 'string' && paths.appData ? paths.appData : null;
  const dataRoot =
    typeof paths.qaDataRoot === 'string' && paths.qaDataRoot
      ? paths.qaDataRoot
      : appData
        ? join(appData, QA_DATA_ROOT_DIRNAME)
        : null;
  const productionDataRoot =
    typeof paths.productionDataRoot === 'string' && paths.productionDataRoot
      ? paths.productionDataRoot
      : appData
        ? join(appData, PRODUCTION_DATA_ROOT_DIRNAME)
        : null;
  return {
    flags,
    appCandidates: uniqueApp,
    installerCandidates,
    git: {
      commit: typeof gitRaw.commit === 'string' && gitRaw.commit ? gitRaw.commit : 'unknown',
      branch: typeof gitRaw.branch === 'string' && gitRaw.branch ? gitRaw.branch : 'unknown',
      dirty: gitRaw.dirty === true,
    },
    paths: {
      repoRoot: typeof paths.repoRoot === 'string' ? paths.repoRoot : null,
      bundleDir: typeof paths.bundleDir === 'string' ? paths.bundleDir : null,
      releaseExe: typeof paths.releaseExe === 'string' ? paths.releaseExe : null,
    },
    qa: {
      identifier: QA_IDENTIFIER,
      dataRoot,
      evidenceRoot: dataRoot ? join(dataRoot, QA_EVIDENCE_DIRNAME) : null,
      productionDataRoot,
    },
  };
}

/**
 * PARTIAL/NOT_RUN is not a pass: it only exits 0 when -AllowPartial says the
 * run is investigative. Kept here so the PowerShell gate and its test share one
 * definition.
 */
export function gateExitCode(options) {
  const settings = options || {};
  const value = typeof settings.status === 'string' ? settings.status.toUpperCase() : '';
  if (value === 'PASS' || value === 'BENCH_ONLY') return EXIT_CODES.OK;
  if (value === 'FAIL') return EXIT_CODES.FAIL;
  if (settings.allowPartial === true) return EXIT_CODES.OK;
  return EXIT_CODES.PARTIAL;
}

function byNewest(a, b) {
  const left = Number.isFinite(a.mtimeMs) ? a.mtimeMs : -Infinity;
  const right = Number.isFinite(b.mtimeMs) ? b.mtimeMs : -Infinity;
  if (left !== right) return right - left;
  return pathKey(a.path) < pathKey(b.path) ? -1 : 1;
}

function baseDecision() {
  return {
    schemaVersion: 1,
    policyVersion: POLICY_VERSION,
    productName: QA_PRODUCT_NAME,
    identifier: QA_IDENTIFIER,
    toleranceMs: MTIME_TOLERANCE_MS,
    exitCodes: { ok: EXIT_CODES.OK, fail: EXIT_CODES.FAIL, partial: EXIT_CODES.PARTIAL },
  };
}

function refuse(code, message, extra) {
  return Object.assign(
    {},
    baseDecision(),
    {
      ok: false,
      errorCode: code,
      exitCode: EXIT_CODES.FAIL,
      message,
    },
    extra || {},
  );
}

function resolveInstaller(context) {
  const flags = context.flags;
  const candidates = context.candidates;
  if (flags.installer) {
    const explicit =
      candidates.find((candidate) => pathKey(candidate.path) === pathKey(flags.installer)) || null;
    if (!explicit || explicit.exists === false) {
      return {
        ok: false,
        errorCode: ERROR_CODES.INSTALLER_NOT_FOUND,
        message:
          'installer not found: ' +
          flags.installer +
          '\nQA packages available:\n' +
          renderCandidateTable(candidates),
      };
    }
    if (explicit.productName !== QA_PRODUCT_NAME) {
      return {
        ok: false,
        errorCode: ERROR_CODES.INSTALLER_PRODUCT_MISMATCH,
        message:
          'refusing non-QA installer ' +
          describeCandidate(explicit) +
          '\nexpected ProductName "' +
          QA_PRODUCT_NAME +
          '"; QA harness never installs a production/Dev/Stable package',
      };
    }
    if (
      flags.expectedInstallerSha256 &&
      explicit.sha256 !== sha256OrNull(flags.expectedInstallerSha256)
    ) {
      return {
        ok: false,
        errorCode: ERROR_CODES.INSTALLER_SHA_MISMATCH,
        message:
          'installer SHA-256 mismatch: expected ' +
          flags.expectedInstallerSha256.toLowerCase() +
          ' but ' +
          explicit.path +
          ' has ' +
          (explicit.sha256 || 'unknown'),
      };
    }
    return { ok: true, installer: explicit, mode: SELECTION_MODES.EXPLICIT };
  }

  if (!flags.install) return { ok: true, installer: null, mode: null };

  const qaPackages = candidates.filter(
    (candidate) => candidate.exists !== false && candidate.productName === QA_PRODUCT_NAME,
  );
  if (qaPackages.length === 0) {
    return {
      ok: false,
      errorCode: ERROR_CODES.INSTALLER_REQUIRED,
      message:
        '-Install requires an NSIS installer path: no QA (' +
        QA_PRODUCT_NAME +
        ') package was found.\nPass -Installer "<path to Shishi QA RC2D setup.exe>". Packages examined:\n' +
        renderCandidateTable(candidates),
    };
  }
  if (qaPackages.length > 1) {
    const sorted = qaPackages.slice().sort(byNewest);
    return {
      ok: false,
      errorCode: ERROR_CODES.INSTALLER_AMBIGUOUS,
      message:
        qaPackages.length +
        ' QA installers are available; refusing to guess which build to install.\n' +
        'Pass -Installer "<path>" explicitly.\nQA packages:\n' +
        renderCandidateTable(sorted),
    };
  }
  return { ok: true, installer: qaPackages[0], mode: SELECTION_MODES.DISCOVERED };
}

function checkExpected(candidate, flags) {
  if (flags.expectedSha256 && candidate.sha256 !== sha256OrNull(flags.expectedSha256)) {
    return {
      errorCode: ERROR_CODES.SHA_MISMATCH,
      message:
        'QA executable SHA-256 mismatch: expected ' +
        flags.expectedSha256.toLowerCase() +
        ' but ' +
        candidate.path +
        ' has ' +
        (candidate.sha256 || 'unknown') +
        ' (' +
        describeCandidate(candidate) +
        ')',
    };
  }
  if (flags.expectedVersion && candidate.productVersion !== flags.expectedVersion) {
    return {
      errorCode: ERROR_CODES.VERSION_MISMATCH,
      message:
        'QA executable ProductVersion mismatch: expected ' +
        flags.expectedVersion +
        ' but ' +
        candidate.path +
        ' reports ' +
        (candidate.productVersion || 'unknown'),
    };
  }
  return null;
}

function findTie(sorted, distinct) {
  const newest = sorted[0];
  return (
    sorted.find(
      (candidate) =>
        candidate !== newest &&
        candidate.sha256 !== newest.sha256 &&
        Math.abs((candidate.mtimeMs || 0) - (newest.mtimeMs || 0)) <= MTIME_TOLERANCE_MS,
    ) || null
  );
}

function resolveTarget(context) {
  const flags = context.flags;
  const candidates = context.candidates;

  if (flags.appExe) {
    const explicit =
      candidates.find((candidate) => pathKey(candidate.path) === pathKey(flags.appExe)) || null;
    if (!explicit || explicit.exists === false) {
      return {
        ok: false,
        errorCode: ERROR_CODES.APP_EXE_NOT_FOUND,
        message:
          '-AppExe path does not exist: ' +
          flags.appExe +
          '\nCandidates examined:\n' +
          renderCandidateTable(candidates),
      };
    }
    if (explicit.productName !== QA_PRODUCT_NAME) {
      return {
        ok: false,
        errorCode: ERROR_CODES.PRODUCT_NAME_MISMATCH,
        message:
          'refusing non-QA app ' +
          describeCandidate(explicit) +
          '\nexpected ProductName "' +
          QA_PRODUCT_NAME +
          '"; QA harness never runs against production',
      };
    }
    const expected = checkExpected(explicit, flags);
    if (expected) return Object.assign({ ok: false }, expected);
    return { ok: true, target: explicit, selection: SELECTION_MODES.EXPLICIT };
  }

  if (flags.install) {
    if (context.phase === PHASES.PLAN) {
      // The installed executable only exists after the installer ran, so the
      // target is resolved in a second call once the install finished.
      return { ok: true, target: null, selection: SELECTION_MODES.INSTALLED, pending: true };
    }
    const installed = candidates.filter(
      (candidate) => candidate.exists !== false && candidate.source === 'installed',
    );
    if (installed.length === 0) {
      return {
        ok: false,
        errorCode: ERROR_CODES.INSTALLED_EXE_NOT_FOUND,
        message:
          'the install finished but no QA executable was found at the expected install locations; ' +
          'refusing to fall back to the release build.\nPass -AppExe "<installed todo-native.exe>".\n' +
          'Candidates examined:\n' +
          renderCandidateTable(candidates),
      };
    }
    const sorted = installed.slice().sort(byNewest);
    const newest = sorted[0];
    if (newest.productName !== QA_PRODUCT_NAME) {
      return {
        ok: false,
        errorCode: ERROR_CODES.PRODUCT_NAME_MISMATCH,
        message:
          'refusing non-QA installed app ' +
          describeCandidate(newest) +
          '\nexpected ProductName "' +
          QA_PRODUCT_NAME +
          '"; QA harness never runs against production',
      };
    }
    if (findTie(sorted)) {
      return {
        ok: false,
        errorCode: ERROR_CODES.INSTALLED_EXE_AMBIGUOUS,
        message:
          'several installed QA executables were written at the same time and differ; ' +
          'refusing to guess.\nPass -AppExe "<path>".\nInstalled candidates:\n' +
          renderCandidateTable(sorted),
      };
    }
    const expected = checkExpected(newest, flags);
    if (expected) return Object.assign({ ok: false }, expected);
    return {
      ok: true,
      target: newest,
      selection: SELECTION_MODES.INSTALLED,
      alternatives: sorted.slice(1),
    };
  }

  const qaCandidates = candidates.filter(
    (candidate) => candidate.exists !== false && candidate.productName === QA_PRODUCT_NAME,
  );
  if (qaCandidates.length === 0) {
    return {
      ok: false,
      errorCode: ERROR_CODES.NO_QA_TARGET,
      message:
        'no QA executable found (ProductName "' +
        QA_PRODUCT_NAME +
        '"). Build with -Build or pass -AppExe.\nCandidates examined:\n' +
        renderCandidateTable(candidates),
    };
  }
  const sorted = qaCandidates.slice().sort(byNewest);
  if (findTie(sorted)) {
    return {
      ok: false,
      errorCode: ERROR_CODES.AMBIGUOUS_TARGET,
      message:
        'QA executables were built at almost the same time and differ; refusing to guess.\n' +
        'Pass -AppExe "<path>".\nQA candidates:\n' +
        renderCandidateTable(sorted),
    };
  }
  const expected = checkExpected(sorted[0], flags);
  if (expected) return Object.assign({ ok: false }, expected);
  return {
    ok: true,
    target: sorted[0],
    selection: SELECTION_MODES.DISCOVERED,
    alternatives: sorted.slice(1),
  };
}

/**
 * Freshness guard: a target with different content than a newer available QA
 * build is stale for new-code acceptance. Discovery selects the newest build so
 * it can never trip this rule; an explicit or installed target that is older
 * than the newest available QA build fails closed unless -AllowStaleTarget.
 */
function checkFreshness(context) {
  const target = context.target;
  const comparison = context.candidates.filter(
    (candidate) =>
      candidate.exists !== false &&
      candidate.productName === QA_PRODUCT_NAME &&
      pathKey(candidate.path) !== pathKey(target.path) &&
      candidate.sha256 !== target.sha256 &&
      Number.isFinite(candidate.mtimeMs) &&
      Number.isFinite(target.mtimeMs),
  );
  if (comparison.length === 0) return { stale: false, newer: null };
  const sorted = comparison.slice().sort(byNewest);
  const newest = sorted[0];
  if (!(target.mtimeMs + MTIME_TOLERANCE_MS < newest.mtimeMs)) {
    return { stale: false, newer: newest };
  }
  if (context.flags.allowStaleTarget) return { stale: false, newer: newest, overridden: true };
  return { stale: true, newer: newest, candidates: sorted };
}

function buildProvenance(context) {
  const flags = context.flags;
  const target = context.target;
  const installer = context.installer;
  return {
    policyVersion: POLICY_VERSION,
    gitCommit: context.git.commit,
    gitBranch: context.git.branch,
    gitDirty: context.git.dirty,
    selection: context.selection,
    explicitlyChosen: context.selection === SELECTION_MODES.EXPLICIT,
    appExe: target ? target.path : null,
    appExeSource: target ? target.source : null,
    appExeSha256: target ? target.sha256 : null,
    appExeProductName: target ? target.productName : null,
    appExeProductVersion: target ? target.productVersion : null,
    appExeMtime: target ? formatTime(target.mtimeMs) : null,
    installer: installer ? installer.path : null,
    installerSha256: installer ? installer.sha256 : null,
    installerProductName: installer ? installer.productName : null,
    installerProductVersion: installer ? installer.productVersion : null,
    expectedSha256: flags.expectedSha256 ? flags.expectedSha256.toLowerCase() : null,
    expectedVersion: flags.expectedVersion || null,
    allowStaleTarget: flags.allowStaleTarget,
  };
}

/** Pure decision function: a probe document in, a JSON decision out. */
export function resolveHarnessTarget(rawProbe) {
  let probe;
  try {
    probe = normalizeProbe(rawProbe);
  } catch (error) {
    return refuse(
      ERROR_CODES.PROBE_INVALID,
      error instanceof Error ? error.message : String(error),
    );
  }
  const flags = probe.flags;
  const git = probe.git;
  const qa = probe.qa;

  if (!qa.dataRoot || !qa.evidenceRoot) {
    return refuse(
      ERROR_CODES.QA_ROOT_INVALID,
      'APPDATA is required: QA evidence must be written inside the QA data root (' +
        QA_DATA_ROOT_DIRNAME +
        ')',
    );
  }
  if (!insideRoot(qa.dataRoot, qa.evidenceRoot)) {
    return refuse(
      ERROR_CODES.QA_ROOT_INVALID,
      'QA evidence root ' + qa.evidenceRoot + ' is not inside the QA data root ' + qa.dataRoot,
    );
  }
  if (qa.productionDataRoot && pathKey(qa.productionDataRoot) === pathKey(qa.dataRoot)) {
    return refuse(ERROR_CODES.QA_ROOT_INVALID, 'QA and production data roots are not isolated');
  }

  const installerResult = resolveInstaller({ flags, candidates: probe.installerCandidates });
  if (!installerResult.ok) {
    return refuse(installerResult.errorCode, installerResult.message, {
      installerCandidates: probe.installerCandidates.slice().sort(byNewest),
      git,
    });
  }

  const targetResult = resolveTarget({
    flags,
    candidates: probe.appCandidates,
    phase: flags.phase,
  });
  if (!targetResult.ok) {
    return refuse(targetResult.errorCode, targetResult.message, {
      selection: flags.appExe ? SELECTION_MODES.EXPLICIT : null,
      installer: installerResult.installer,
      candidates: probe.appCandidates.slice().sort(byNewest),
      git,
    });
  }

  const warnings = [];
  const rejected = probe.appCandidates.filter(
    (candidate) => candidate.exists !== false && candidate.productName !== QA_PRODUCT_NAME,
  );
  if (rejected.length > 0) {
    warnings.push(
      'ignored non-QA candidate(s): ' +
        rejected
          .map((candidate) => candidate.path + ' ([' + candidate.productName + '])')
          .join(', '),
    );
  }

  if (targetResult.pending) {
    return Object.assign({}, baseDecision(), {
      ok: true,
      errorCode: null,
      exitCode: EXIT_CODES.OK,
      action: 'install',
      targetPending: true,
      discoverOnly: flags.discoverOnly,
      selection: SELECTION_MODES.INSTALLED,
      appExe: null,
      installer: installerResult.installer ? installerResult.installer.path : null,
      installerSha256: installerResult.installer ? installerResult.installer.sha256 : null,
      requireInstall: true,
      qa,
      git,
      warnings,
      provenance: buildProvenance({
        flags,
        target: null,
        installer: installerResult.installer,
        selection: SELECTION_MODES.INSTALLED,
        git,
      }),
    });
  }

  const target = targetResult.target;
  const freshness = checkFreshness({ flags, target, candidates: probe.appCandidates });
  if (freshness.stale) {
    return refuse(
      ERROR_CODES.STALE_TARGET,
      'the selected QA executable is older than the newest available QA build; ' +
        'refusing to produce new-code evidence from a stale binary.\n' +
        'selected: ' +
        describeCandidate(target) +
        '\nnewer available: ' +
        describeCandidate(freshness.newer) +
        '\nnewer candidates:\n' +
        renderCandidateTable(freshness.candidates) +
        '\nPass -AppExe "' +
        freshness.newer.path +
        '" to test that build, or -AllowStaleTarget to keep the older binary deliberately.',
      {
        selection: targetResult.selection,
        candidates: probe.appCandidates.slice().sort(byNewest),
        git,
      },
    );
  }
  if (freshness.overridden) {
    warnings.push(
      'target is older than a newer QA build and -AllowStaleTarget was passed: selected ' +
        target.path +
        ' but ' +
        freshness.newer.path +
        ' is newer',
    );
  }
  if (freshness.newer) {
    warnings.push(
      'newer QA build available and not selected: ' +
        freshness.newer.path +
        ' (mtime ' +
        formatTime(freshness.newer.mtimeMs) +
        '); selected ' +
        target.path,
    );
  }

  return Object.assign({}, baseDecision(), {
    ok: true,
    errorCode: null,
    exitCode: EXIT_CODES.OK,
    action: flags.discoverOnly ? 'discover' : 'run',
    targetPending: false,
    discoverOnly: flags.discoverOnly,
    selection: targetResult.selection,
    requireInstall: flags.install === true,
    appExe: target.path,
    appExeSha256: target.sha256,
    appExeProductName: target.productName,
    appExeProductVersion: target.productVersion,
    appExeMtime: formatTime(target.mtimeMs),
    appExeSource: target.source,
    installer: installerResult.installer ? installerResult.installer.path : null,
    installerSha256: installerResult.installer ? installerResult.installer.sha256 : null,
    installerProductVersion: installerResult.installer
      ? installerResult.installer.productVersion
      : null,
    alternatives: (targetResult.alternatives || []).map((candidate) => candidate.path),
    rejectedCandidates: rejected.map((candidate) => ({
      path: candidate.path,
      productName: candidate.productName,
    })),
    qa,
    git,
    warnings,
    provenance: buildProvenance({
      flags,
      target,
      installer: installerResult.installer,
      selection: targetResult.selection,
      git,
    }),
  });
}

function parseArgs(argv) {
  const args = { input: null, output: null };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--input' && argv[index + 1]) {
      args.input = argv[index + 1];
      index += 1;
    } else if (value === '--output' && argv[index + 1]) {
      args.output = argv[index + 1];
      index += 1;
    }
  }
  return args;
}

/**
 * CLI contract used by run-windows.ps1: read the probe JSON written by the
 * script, write the decision JSON, print it, and exit 0/1 so PowerShell can
 * branch on the exit code as well as on the JSON payload.
 */
export function main(argv) {
  const args = parseArgs(argv || process.argv.slice(2));
  if (!args.input) {
    const decision = refuse(
      ERROR_CODES.PROBE_INVALID,
      'usage: node harness-target.mjs --input <probe.json> [--output <decision.json>]',
    );
    console.log(JSON.stringify(decision, null, 2));
    return EXIT_CODES.FAIL;
  }
  let probe;
  try {
    probe = JSON.parse(readFileSync(args.input, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    const decision = refuse(
      ERROR_CODES.PROBE_INVALID,
      'cannot read probe ' +
        args.input +
        ': ' +
        (error instanceof Error ? error.message : String(error)),
    );
    if (args.output) writeFileSync(args.output, JSON.stringify(decision, null, 2));
    console.log(JSON.stringify(decision, null, 2));
    return EXIT_CODES.FAIL;
  }
  const decision = resolveHarnessTarget(probe);
  const text = JSON.stringify(decision, null, 2);
  if (args.output) writeFileSync(args.output, text);
  console.log(text);
  return decision.ok ? EXIT_CODES.OK : EXIT_CODES.FAIL;
}

const invokedDirectly = (() => {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  process.exitCode = main();
}
