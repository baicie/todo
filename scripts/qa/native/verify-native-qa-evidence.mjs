#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { validateManualEvidence } from './manual-evidence.mjs';

const args = process.argv.slice(2);
const rootIndex = args.indexOf('--artifact-root');
const headIndex = args.indexOf('--expected-head');
if (rootIndex < 0 || !args[rootIndex + 1]) {
  console.error('usage: verify-native-qa-evidence --artifact-root <dir> [--expected-head <sha>]');
  process.exit(2);
}
const artifactRoot = args[rootIndex + 1];
const expectedHead = headIndex >= 0 ? args[headIndex + 1] : undefined;
const errors = [];

function readJson(name) {
  return JSON.parse(readFileSync(join(artifactRoot, name), 'utf8').replace(/^\uFEFF/, ''));
}

const manualResult = validateManualEvidence(artifactRoot, expectedHead);
errors.push(...manualResult.errors);

let manifest;
let platform;
try {
  manifest = readJson('manifest.json');
  platform = readJson('platform-results.json');
} catch (error) {
  errors.push(`manifest/platform-results unreadable: ${error.message}`);
}
if (manifest && platform) {
  for (const key of ['runId', 'gitCommit', 'appExeSha256', 'installerSha256']) {
    if ((platform[key === 'gitCommit' ? 'headSha' : key] ?? null) !== (manifest[key] ?? null)) {
      errors.push(`platform-results ${key} does not match manifest`);
    }
  }
  const manualStatuses = new Map(
    (manualResult.manual?.scenarios ?? []).map((item) => [item.id, item.status]),
  );
  if (platform.scenarios?.length !== manualStatuses.size) {
    errors.push('platform-results scenario count does not match manual evidence');
  }
  for (const item of platform.scenarios ?? []) {
    if (manualStatuses.get(item.id) !== item.status) {
      errors.push(`platform-results status mismatch for ${item.id}`);
    }
  }
}

const sumsPath = join(artifactRoot, 'sha256sums.txt');
const rootReal = realpathSync(artifactRoot);
if (!existsSync(sumsPath)) {
  errors.push('sha256sums.txt missing');
} else {
  const lines = readFileSync(sumsPath, 'utf8').split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    const match = /^([0-9a-f]{64})  (.+)$/i.exec(line);
    if (!match) {
      errors.push(`invalid sha256sums line: ${line}`);
      continue;
    }
    const [, expected, rel] = match;
    const normalized = normalize(rel);
    if (isAbsolute(normalized) || normalized === '..' || normalized.startsWith(`..${sep}`)) {
      errors.push(`unsafe evidence path: ${rel}`);
      continue;
    }
    const target = resolve(rootReal, normalized);
    const within = relative(rootReal, target);
    if (within === '' || within.startsWith(`..${sep}`) || within === '..' || isAbsolute(within)) {
      errors.push(`evidence escapes artifact root: ${rel}`);
      continue;
    }
    if (!existsSync(target)) {
      errors.push(`evidence missing: ${rel}`);
      continue;
    }
    if (lstatSync(target).isSymbolicLink()) {
      errors.push(`evidence symlink rejected: ${rel}`);
      continue;
    }
    const actual = createHash('sha256').update(readFileSync(target)).digest('hex');
    if (actual !== expected.toLowerCase()) errors.push(`evidence hash mismatch: ${rel}`);
  }
}

const allPass =
  manualResult.ok && manualResult.manual?.scenarios?.every((item) => item.status === 'PASS');
const windowsReady = platform?.windowsPlatformReady === true && allPass;
if (platform?.windowsPlatformReady === true && !allPass) {
  errors.push('windowsPlatformReady is true but not all scenarios have valid PASS evidence');
}
if (platform?.platformReleaseReady === true && !windowsReady) {
  errors.push('platformReleaseReady is true while windowsPlatformReady is not established');
}

const result = {
  schemaVersion: 1,
  ok: errors.length === 0,
  runId: manualResult.manual?.runId ?? null,
  headSha: manualResult.manifest?.gitCommit ?? null,
  evidenceVerified: errors.length === 0,
  scenarioCount: manualResult.manual?.scenarios?.length ?? 0,
  passCount: manualResult.manual?.scenarios?.filter((item) => item.status === 'PASS').length ?? 0,
  windowsPlatformReady: windowsReady,
  errors,
};
console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exit(1);
