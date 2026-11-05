import { createHash } from 'node:crypto';
import {
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
  unlinkSync,
} from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';

import { QA_IDENTIFIER, QA_PRODUCT_NAME as QA_PRODUCT, qaInstallRoots } from './qa-identity.mjs';

export class QaExecutableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'QaExecutableError';
  }
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function canonical(path, context) {
  const absolute = resolve(path);
  let info;
  try {
    info = lstatSync(absolute);
  } catch {
    throw new QaExecutableError(`${context} path does not exist: ${absolute}`);
  }
  if (info.isSymbolicLink()) throw new QaExecutableError(`${context} path is a symlink`);
  if (!info.isFile()) throw new QaExecutableError(`${context} path is not a regular file`);
  return realpathSync(absolute);
}

function defaultQaRoots() {
  return [
    resolve('apps/native/src-tauri/target/release'),
    ...qaInstallRoots(process.env.LOCALAPPDATA),
  ];
}

/**
 * Pure containment predicate for a `path.relative()` result.
 *
 * `relative` uses the HOST separator, so an escape is `..` followed by `sep`:
 * `\` on Windows, `/` everywhere else. The original hardcoded the Windows form,
 * which made this check always TRUE on the Linux CI runner - every path counted
 * as inside every root, disabling the allowed-roots gate entirely.
 *
 * Takes `sep` as a parameter so the POSIX shape stays testable on Windows and
 * vice versa; `inside` passes the host separator.
 */
export function isContained(rel, sep) {
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`);
}

function inside(root, target) {
  const rel = relative(resolve(root), resolve(target));
  // `isAbsolute` covers the other escape shape (a different drive or root).
  return isContained(rel, sep) && !isAbsolute(rel);
}

function readPeProductName(exePath) {
  const out = join(tmpdir(), `shishi-qa-pe-${process.pid}-${Date.now()}.txt`);
  const escapedExe = exePath.replaceAll("'", "''");
  const escapedOut = out.replaceAll("'", "''");
  const script =
    `(Get-Item -LiteralPath '${escapedExe}').VersionInfo.ProductName | ` +
    `Set-Content -LiteralPath '${escapedOut}' -Encoding UTF8`;
  const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    stdio: 'ignore',
    windowsHide: true,
  });
  try {
    if (run.status !== 0) throw new QaExecutableError('could not read PE ProductName');
    return readFileSync(out, 'utf8')
      .replace(/^\uFEFF/, '')
      .trim();
  } finally {
    try {
      unlinkSync(out);
    } catch {}
  }
}

function readJson(path, context) {
  try {
    return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new QaExecutableError(`${context} unreadable: ${error.message}`);
  }
}

/**
 * Verify every launch gate before the caller is allowed to spawn. This is
 * intentionally pure with respect to the app process: it never spawns the QA
 * executable. The caller must call it before spawn() and must not catch failures
 * as retryable.
 */
export function verifyQaExecutable({
  appExe,
  artifactRoot,
  expectedHead,
  productReader = readPeProductName,
  allowedRoots = defaultQaRoots(),
}) {
  const realExe = canonical(appExe, 'QA executable');
  if (!allowedRoots.some((root) => inside(root, realExe))) {
    throw new QaExecutableError(`QA executable is outside allowed QA roots: ${realExe}`);
  }
  if (basename(realExe).toLowerCase() !== 'todo-native.exe') {
    throw new QaExecutableError(`unexpected QA executable name: ${basename(realExe)}`);
  }

  const root = resolve(artifactRoot);
  const manifest = readJson(join(root, 'manifest.json'), 'manifest');
  const environment = readJson(join(root, 'environment.json'), 'environment');
  const provenance = readJson(join(root, 'provenance.json'), 'provenance');

  if (typeof manifest.runId !== 'string' || !manifest.runId) {
    throw new QaExecutableError('manifest runId is missing');
  }
  if (typeof manifest.gitCommit !== 'string' || !/^[0-9a-f]{40}$/i.test(manifest.gitCommit)) {
    throw new QaExecutableError('manifest HEAD is invalid');
  }
  if (expectedHead && manifest.gitCommit.toLowerCase() !== expectedHead.toLowerCase()) {
    throw new QaExecutableError(
      `manifest HEAD ${manifest.gitCommit} does not match expected ${expectedHead}`,
    );
  }
  if (provenance.gitCommit !== manifest.gitCommit) {
    throw new QaExecutableError('provenance HEAD does not match manifest');
  }
  if (environment.qaIdentifier !== QA_IDENTIFIER) {
    throw new QaExecutableError('environment QA identifier mismatch');
  }
  if (environment.productionDataRootPresent === true) {
    throw new QaExecutableError('production data root was present before launch');
  }
  if (
    environment.productionDataRoot &&
    environment.qaDataRoot &&
    resolve(environment.productionDataRoot).toLowerCase() ===
      resolve(environment.qaDataRoot).toLowerCase()
  ) {
    throw new QaExecutableError('QA and production data roots are not isolated');
  }
  if (typeof manifest.appExeSha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(manifest.appExeSha256)) {
    throw new QaExecutableError('manifest app hash is missing');
  }
  const actualHash = sha256(realExe);
  if (actualHash !== manifest.appExeSha256.toLowerCase()) {
    throw new QaExecutableError('QA executable SHA-256 does not match manifest');
  }
  const productName = productReader(realExe);
  if (productName !== QA_PRODUCT) {
    throw new QaExecutableError(`QA ProductName mismatch: ${productName}`);
  }

  const manifestExe = manifest.appExe ? resolve(manifest.appExe) : null;
  if (manifestExe && manifestExe.toLowerCase() !== realExe.toLowerCase()) {
    throw new QaExecutableError('launch path differs from manifest appExe path');
  }

  return {
    realPath: realExe,
    sha256: actualHash,
    productName,
    manifest,
    environment,
    provenance,
  };
}

export function verifyRunningProcess(pid, expectedPath) {
  const realExpected = realpathSync(resolve(expectedPath)).toLowerCase();
  const out = join(tmpdir(), `shishi-qa-pid-${process.pid}-${pid}.txt`);
  const script =
    `(Get-Process -Id ${Number(pid)} -ErrorAction Stop).Path | ` +
    `Set-Content -LiteralPath '${out.replaceAll("'", "''")}' -Encoding UTF8`;
  const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    stdio: 'ignore',
    windowsHide: true,
  });
  try {
    if (run.status !== 0) throw new QaExecutableError(`could not resolve launched PID ${pid}`);
    const actual = realpathSync(
      readFileSync(out, 'utf8')
        .replace(/^\uFEFF/, '')
        .trim(),
    ).toLowerCase();
    if (actual !== realExpected) {
      throw new QaExecutableError(`launched PID path mismatch: ${actual}`);
    }
    return actual;
  } finally {
    try {
      unlinkSync(out);
    } catch {}
  }
}
