import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const STATUSES = new Set(['NOT_RUN', 'PASS', 'FAIL', 'PARTIAL']);
const canonical = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'manual-scenarios.json'), 'utf8'),
);
const canonicalIds = new Set(canonical.map((scenario) => scenario.id));

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function sameNullable(a, b) {
  return (a ?? null) === (b ?? null);
}

function isInside(root, candidate) {
  const rel = relative(root, candidate);
  return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel);
}

/**
 * Validate a finalized manual-platform.json against its run manifest and
 * artifact root. This proves integrity/schema/provenance only; it cannot prove
 * that a human actually clicked a Toast. Callers must still label real
 * interaction vs. simulation at execution time.
 */
export function validateManualEvidence(artifactRoot, expectedHead) {
  const errors = [];
  const root = realpathSync(resolve(artifactRoot));
  const manifestPath = join(root, 'manifest.json');
  const manualPath = join(root, 'manual-platform.json');
  let manifest;
  let manual;

  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    return { ok: false, errors: [`manifest.json unreadable: ${error.message}`], root };
  }
  try {
    manual = JSON.parse(readFileSync(manualPath, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    return { ok: false, errors: [`manual-platform.json unreadable: ${error.message}`], root };
  }

  const require = (condition, message) => {
    if (!condition) errors.push(message);
  };
  const validIso = (value) => typeof value === 'string' && !Number.isNaN(Date.parse(value));
  const manifestRunId = manifest.runId;
  const manifestHead = manifest.gitCommit;
  const manifestAppHash = manifest.appExeSha256;
  const manifestInstallerHash = manifest.installerSha256 ?? null;

  require(Number(manual.schemaVersion) === 2, 'manual evidence schemaVersion must be 2');
  require(typeof manifestRunId === 'string' && manifestRunId.length > 0, 'manifest runId');
  require(typeof manifestHead === 'string' &&
    /^[0-9a-f]{40}$/i.test(manifestHead), 'manifest HEAD');
  require(/^[0-9a-f]{64}$/i.test(manifestAppHash ?? ''), 'manifest appExeSha256');
  if (expectedHead) {
    require(String(manifestHead).toLowerCase() ===
      String(
        expectedHead,
      ).toLowerCase(), `manifest HEAD ${manifestHead} does not match expected ${expectedHead}`);
  }
  require(manual.runId === manifestRunId, 'manual runId does not match manifest');
  require(manual.gitCommit === manifestHead, 'manual gitCommit does not match manifest HEAD');
  require(sameNullable(
    manual.appExeSha256,
    manifestAppHash,
  ), 'manual appExeSha256 does not match manifest');
  require(sameNullable(
    manual.installerSha256,
    manifestInstallerHash,
  ), 'manual installerSha256 does not match manifest');

  const seen = new Set();
  require(Array.isArray(manual.scenarios), 'manual scenarios must be an array');
  require(manual.scenarios?.length ===
    canonicalIds.size, `scenario count must match canonical inventory (${canonicalIds.size})`);
  for (const scenario of manual.scenarios ?? []) {
    const id = scenario.id;
    require(typeof id === 'string' && id.length > 0, 'scenario id missing');
    require(!seen.has(id), `duplicate scenario id: ${id}`);
    require(canonicalIds.has(id), `unknown scenario id: ${id}`);
    seen.add(id);
    require(STATUSES.has(scenario.status), `${id}: invalid status`);
    require(typeof scenario.expected === 'string' &&
      scenario.expected.length > 0, `${id}: expected`);
    require(scenario.runId === manifestRunId, `${id}: runId mismatch`);
    require(scenario.headSha === manifestHead, `${id}: HEAD mismatch`);
    require(sameNullable(
      scenario.appExeSha256,
      manifestAppHash,
    ), `${id}: app binary hash mismatch`);
    require(sameNullable(
      scenario.installerSha256,
      manifestInstallerHash,
    ), `${id}: installer hash mismatch`);
    require(validIso(scenario.startedAt), `${id}: startedAt invalid`);
    require(validIso(scenario.finishedAt), `${id}: finishedAt invalid`);
    if (validIso(scenario.startedAt) && validIso(scenario.finishedAt)) {
      require(Date.parse(scenario.finishedAt) >=
        Date.parse(scenario.startedAt), `${id}: finishedAt precedes startedAt`);
    }

    const evidenceList = scenario.evidence ?? [];
    require(Array.isArray(evidenceList), `${id}: evidence must be an array`);
    for (const evidence of evidenceList) {
      require(typeof evidence?.path === 'string' &&
        evidence.path.length > 0, `${id}: evidence path`);
      require(/^[0-9a-f]{64}$/i.test(evidence?.sha256 ?? ''), `${id}: evidence sha256 missing`);
      if (typeof evidence?.path !== 'string' || evidence.path.length === 0) continue;
      const normalized = normalize(evidence.path);
      require(!isAbsolute(normalized) &&
        normalized !== '..' &&
        !normalized.startsWith(`..${sep}`), `${id}: evidence path traversal`);
      const target = resolve(root, normalized);
      require(isInside(root, target), `${id}: evidence escapes artifact root`);
      try {
        const info = lstatSync(target);
        require(!info.isSymbolicLink(), `${id}: evidence symlink rejected`);
        require(info.isFile(), `${id}: evidence is not a file`);
        const real = realpathSync(target);
        require(isInside(root, real), `${id}: evidence realpath escapes root`);
        if (info.isFile() && /^[0-9a-f]{64}$/i.test(evidence.sha256 ?? '')) {
          require(sha256(real) === String(evidence.sha256).toLowerCase(), `${id}: evidence hash`);
        }
      } catch (error) {
        errors.push(`${id}: evidence file missing or unreadable: ${error.message}`);
      }
    }

    if (scenario.status === 'PASS') {
      require(typeof scenario.observed === 'string' &&
        scenario.observed.trim().length > 0, `${id}: PASS observed`);
      require(evidenceList.length > 0, `${id}: PASS requires at least one evidence file`);
      require(/^[0-9a-f]{40}$/i.test(scenario.headSha ?? ''), `${id}: PASS HEAD invalid`);
      require(!expectedHead || scenario.headSha === expectedHead, `${id}: PASS expected HEAD`);
    } else if (scenario.status === 'FAIL' || scenario.status === 'PARTIAL') {
      require(typeof scenario.observed === 'string' &&
        scenario.observed.trim().length > 0, `${id}: observed`);
      require(typeof scenario.reason === 'string' &&
        scenario.reason.trim().length > 0, `${id}: reason`);
    } else {
      require(scenario.observed == null ||
        typeof scenario.observed === 'string', `${id}: observed type`);
    }
  }

  if (seen.size !== manual.scenarios?.length) {
    errors.push('scenario IDs must be unique');
  }
  for (const id of canonicalIds) {
    if (!seen.has(id)) errors.push(`missing canonical scenario id: ${id}`);
  }

  return { ok: errors.length === 0, errors, root, manifest, manual };
}
