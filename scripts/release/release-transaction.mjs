/**
 * RC2-D.11 — the transactional publish protocol of the dev pre-release.
 *
 * .github/workflows/release-dev.yml publishes through this module so that no
 * remote state is modified before every read-only validation has passed:
 *
 *   read-only                              | write
 *   ---------------------------------------+------------------------------------
 *   guard-workflow (no network)            | create the release as a DRAFT
 *   verify-assets pre/final (disk only)    |   (softprops/action-gh-release,
 *   check-existing (gh api GET)            |    draft: true)
 *   verify-draft   (gh api GET)            | publish-draft (gh api PATCH
 *   verify-published (gh api GET)          |   draft=false prerelease=true)
 *
 * Every refusal is decided by a pure function of facts the caller gathered, so
 * the whole matrix is testable without a network (tests/release/):
 *
 *   decideExistingRelease({ built, remote })  create-draft | publish-draft
 *                                             | noop | refuse
 *   decidePublishOutcome({ built, remote })   publish | stay-draft
 *   verifyPublishedRelease({ built, remote }) ok | failures
 *   verifyRemoteAssets({...})                 name + size + sha256 comparison
 *   verifyProvenance({ built, remote })       release target + manifest commit
 *   guardWorkflowProvenance({...})            github.workflow_sha vs TagCommitSHA
 *
 * Identity model: the release manifest is the identity document. Two builds may
 * only share a tag when the tag commit, the version, the channel, the app
 * identifier and every asset (name + size + sha256) are identical, i.e. the
 * release is a byte-identical repeat of the same build. A tag is immutable:
 * anything else is refused by name instead of being overwritten, renamed or
 * repaired in place.
 *
 * Hash sources, in priority order, are (1) the digest GitHub reports for an
 * upload, (2) the asset table recorded by the published manifest, (3) the
 * published SHA256SUMS.txt. A checksum file cannot checksum itself, so
 * SUMS_NAME is exempt from (1)-(3): its own size, and the checksum file's
 * coverage of every other asset, are what get verified instead.
 *
 * The toolchain-*.json files that the build jobs upload are carried by the
 * release but are not part of the release contract; they are passed in as
 * allowed extras so that any OTHER unexpected remote asset still fails closed.
 */

import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MANIFEST_NAME,
  SUMS_NAME,
  expectedReleaseAssets,
  normalizeVersion,
  parseSha256Sums,
  readArtifactInventory,
} from './release-context.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const HEX64_PATTERN = /^[0-9a-f]{64}$/;
const ASSETS_PER_PAGE = 100;
const OCTET_STREAM = 'Accept: application/octet-stream';

export const DECISION_CREATE_DRAFT = 'create-draft';
export const DECISION_PUBLISH_DRAFT = 'publish-draft';
export const DECISION_NOOP = 'noop';
export const DECISION_REFUSE = 'refuse';

export const OUTCOME_PUBLISH = 'publish';
export const OUTCOME_STAY_DRAFT = 'stay-draft';

/** The remote asset whose own sha256 has no remote record, by construction. */
export const HASH_UNVERIFIABLE_BY_DESIGN = Object.freeze([SUMS_NAME]);

export class ReleaseTransactionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ReleaseTransactionError';
  }
}

function fail(message) {
  throw new ReleaseTransactionError(message);
}

function shaOf(value) {
  const text = String(value ?? '')
    .trim()
    .toLowerCase();
  return SHA_PATTERN.test(text) ? text : null;
}

function hexOf(value) {
  const text = String(value ?? '')
    .trim()
    .toLowerCase();
  return HEX64_PATTERN.test(text) ? text : null;
}

/** "sha256:<hex>" (GitHub asset digest) or a bare hex digest. */
function digestOf(digest) {
  if (typeof digest !== 'string') return null;
  const text = digest.trim().toLowerCase();
  if (text.startsWith('sha256:')) return hexOf(text.slice('sha256:'.length));
  return hexOf(text);
}

/**
 * The built side of every comparison: the manifest that was just written plus
 * the local artifact inventory (size + sha256 for every published file).
 */
export function describeBuiltRelease({ manifest, inventory } = {}) {
  if (!manifest || typeof manifest !== 'object') fail('the release manifest is missing');
  const version = normalizeVersion(manifest.release?.version);
  const expected = expectedReleaseAssets(version);
  const byName = new Map();
  for (const file of inventory ?? []) {
    const name = typeof file?.name === 'string' && file.name !== '' ? file.name : null;
    if (!name) fail('the local artifact inventory has an entry without a name');
    if (byName.has(name)) fail('the local artifact inventory carries ' + name + ' twice');
    byName.set(name, file);
  }
  const assets = expected.map((name) => {
    const file = byName.get(name);
    if (!file) {
      fail('the local artifact set has no ' + name + ' (run verify-assets --stage final first)');
    }
    const sha256 = hexOf(file.sha256);
    if (!sha256) fail('the local artifact ' + name + ' has no sha256');
    if (!Number.isFinite(file.size) || file.size <= 0)
      fail('the local artifact ' + name + ' is empty');
    return { name, size: file.size, sha256 };
  });
  return {
    tag: String(manifest.release?.tag ?? version),
    version,
    channel: String(manifest.release?.channel ?? ''),
    identifier: String(manifest.app?.identifier ?? ''),
    tagCommitSHA: shaOf(manifest.commit?.tagSHA),
    manifest,
    assets,
    extras: [...byName.keys()].filter((name) => !expected.includes(name)).sort(),
  };
}

function assertBuiltRelease(built) {
  if (!built || typeof built !== 'object') {
    fail('the built release description is missing (build it with describeBuiltRelease)');
  }
  for (const key of ['tag', 'version', 'channel', 'identifier']) {
    if (typeof built[key] !== 'string' || built[key] === '') {
      fail('the built release description has no ' + key);
    }
  }
  if (!shaOf(built.tagCommitSHA)) fail('the built release description has no TagCommitSHA');
  if (!Array.isArray(built.assets) || built.assets.length === 0) {
    fail('the built release description has no asset inventory');
  }
  for (const asset of built.assets) {
    if (!asset || typeof asset.name !== 'string' || asset.name === '') {
      fail('the built asset inventory has an entry without a name');
    }
    if (!Number.isFinite(asset.size) || asset.size <= 0) {
      fail('the built asset ' + asset.name + ' has no size');
    }
  }
}

/**
 * Compare an expected asset set with what the remote release actually carries.
 * Every difference is collected (not just the first) so a refusal can name the
 * whole gap. 'hashes' maps an asset name to a sha256 recorded remotely and is
 * used when the API exposes no digest for the upload.
 */
export function verifyRemoteAssets({
  expected,
  remote,
  hashes = {},
  allowedExtras = [],
  requireSha256 = true,
  unhashedAllowed = HASH_UNVERIFIABLE_BY_DESIGN,
} = {}) {
  if (!Array.isArray(expected) || expected.length === 0) fail('no expected asset set supplied');
  if (!Array.isArray(remote)) fail('no remote asset inventory supplied');
  const allowed = new Set(allowedExtras);
  const exempt = new Set(unhashedAllowed);
  const failures = [];
  const notes = [];
  const byName = new Map();
  for (const asset of remote) {
    const name = typeof asset?.name === 'string' ? asset.name.trim() : '';
    if (name === '') {
      failures.push('the remote release carries an asset without a name');
      continue;
    }
    if (byName.has(name)) failures.push('the remote release carries ' + name + ' twice');
    else byName.set(name, asset);
  }

  for (const asset of expected) {
    const name = asset.name;
    const published = byName.get(name);
    if (!published) {
      failures.push('missing remote asset: ' + name);
      continue;
    }
    if (typeof published.state === 'string' && published.state !== 'uploaded') {
      failures.push(
        'remote asset ' + name + ' is not finished uploading (state ' + published.state + ')',
      );
    }
    if (published.size !== asset.size) {
      failures.push(
        'remote asset ' +
          name +
          ' is ' +
          published.size +
          ' bytes, the build produced ' +
          asset.size,
      );
      continue;
    }
    const recorded = digestOf(published.digest) ?? hexOf(hashes?.[name]) ?? null;
    if (recorded === null) {
      if (exempt.has(name)) {
        notes.push('no remote sha256 for ' + name + ': a checksum file cannot checksum itself');
      } else if (requireSha256) {
        failures.push(
          'no sha256 is recorded for remote asset ' + name + ': its identity cannot be proven',
        );
      } else {
        notes.push('no remote sha256 for ' + name + ' (not required at this stage)');
      }
      continue;
    }
    if (asset.sha256 && recorded !== hexOf(asset.sha256)) {
      failures.push(
        'remote asset ' + name + ' sha256 ' + recorded + ' != the built ' + asset.sha256,
      );
    }
  }

  for (const name of byName.keys()) {
    if (expected.some((asset) => asset.name === name)) continue;
    if (allowed.has(name)) notes.push('extra asset carried by the release: ' + name);
    else failures.push('unexpected remote asset: ' + name);
  }

  return { ok: failures.length === 0, failures, notes };
}

/**
 * The release must target TagCommitSHA, and the manifest asset must exist
 * remotely and record the same commit. The authoritative target of a tag-backed
 * release is the remote tag ref; GitHub records target_commitish as the default
 * branch name ("main") for a release created without an explicit target, so a
 * branch name there is a label, while a 40-hex value must match.
 */
export function verifyProvenance({ built, remote } = {}) {
  assertBuiltRelease(built);
  const failures = [];
  const notes = [];
  const tagSHA = shaOf(built.tagCommitSHA);
  const tagRefSHA = shaOf(remote?.tagRefSHA);
  if (!tagRefSHA) {
    failures.push(
      'the remote tag ' + built.tag + ' could not be resolved: the release target cannot be proven',
    );
  } else if (tagRefSHA !== tagSHA) {
    failures.push(
      'the release target (remote tag ' +
        built.tag +
        ') is ' +
        tagRefSHA +
        ' != TagCommitSHA ' +
        tagSHA,
    );
  }

  const release = remote?.release ?? null;
  if (release) {
    const target = String(release.target_commitish ?? '').trim();
    const targetSHA = shaOf(target);
    if (targetSHA && targetSHA !== tagSHA) {
      failures.push('the release targets commit ' + targetSHA + ' != TagCommitSHA ' + tagSHA);
    } else if (!targetSHA && target !== '') {
      notes.push(
        'release target_commitish is the branch label ' +
          JSON.stringify(target) +
          '; the tag ref is authoritative',
      );
    }
  }

  const assets = Array.isArray(remote?.assets) ? remote.assets : [];
  const manifestAsset = assets.find((asset) => asset?.name === MANIFEST_NAME) ?? null;
  if (!manifestAsset) {
    failures.push(
      'the release carries no ' + MANIFEST_NAME + ' asset: its provenance cannot be proven',
    );
  } else if (!(Number.isFinite(manifestAsset.size) && manifestAsset.size > 0)) {
    failures.push('the ' + MANIFEST_NAME + ' asset is empty');
  }

  const remoteManifest = remote?.manifest ?? null;
  if (!remoteManifest) {
    failures.push('the ' + MANIFEST_NAME + ' asset could not be read from the release');
  } else if (shaOf(remoteManifest?.commit?.tagSHA) !== tagSHA) {
    failures.push(
      'the published ' +
        MANIFEST_NAME +
        ' records tag commit ' +
        String(remoteManifest?.commit?.tagSHA ?? '(none)') +
        ' != TagCommitSHA ' +
        tagSHA,
    );
  }
  return { ok: failures.length === 0, failures, notes };
}

/** Asset + identity comparison shared by every decision below. */
export function compareRemoteRelease({ built, remote } = {}) {
  assertBuiltRelease(built);
  const release = remote?.release ?? null;
  const remoteManifest = remote?.manifest ?? null;
  const provenance = verifyProvenance({ built, remote });
  const failures = [...provenance.failures];
  const notes = [...provenance.notes];

  if (remoteManifest) {
    const recorded = {
      tag: String(remoteManifest?.release?.tag ?? ''),
      version: String(remoteManifest?.release?.version ?? ''),
      channel: String(remoteManifest?.release?.channel ?? ''),
      identifier: String(remoteManifest?.app?.identifier ?? ''),
    };
    if (recorded.version !== built.version) {
      failures.push(
        'the existing release records version ' +
          recorded.version +
          ', this build is ' +
          built.version,
      );
    }
    if (recorded.channel !== built.channel) {
      failures.push(
        'the existing release records channel ' +
          recorded.channel +
          ', this build is ' +
          built.channel,
      );
    }
    if (recorded.identifier !== built.identifier) {
      failures.push(
        'the existing release was published under the app identity ' +
          recorded.identifier +
          ', this build is ' +
          built.identifier +
          ': tag ' +
          built.tag +
          ' is immutable, a stable/dev identity conflict cannot be republished',
      );
    }
    if (recorded.tag !== built.tag) {
      failures.push(
        'the existing release manifest records tag ' + recorded.tag + ' != ' + built.tag,
      );
    }
    const recordedAssets = Array.isArray(remoteManifest?.assets) ? remoteManifest.assets : [];
    const table = verifyRemoteAssets({
      expected: built.assets.filter(
        (asset) => asset.name !== MANIFEST_NAME && asset.name !== SUMS_NAME,
      ),
      remote: recordedAssets.map((asset) => ({
        name: asset?.name,
        size: asset?.size,
        digest: asset?.sha256,
        state: 'uploaded',
      })),
      requireSha256: true,
      allowedExtras: [],
    });
    for (const failure of table.failures) {
      failures.push('the existing release manifest disagrees with this build: ' + failure);
    }
  }

  const hashes = {};
  for (const record of remoteManifest?.assets ?? []) {
    const hash = hexOf(record?.sha256);
    if (typeof record?.name === 'string' && hash) hashes[record.name] = hash;
  }
  if (typeof remote?.sumsText === 'string') {
    try {
      for (const [name, hash] of parseSha256Sums(remote.sumsText)) hashes[name] ??= hash;
    } catch (error) {
      failures.push('the published ' + SUMS_NAME + ' is malformed: ' + error.message);
    }
  }
  const assets = verifyRemoteAssets({
    expected: built.assets,
    remote: Array.isArray(remote?.assets) ? remote.assets : [],
    hashes,
    allowedExtras: built.extras,
    requireSha256: true,
  });
  failures.push(...assets.failures);
  notes.push(...assets.notes);

  if (release && release.tag_name && release.tag_name !== built.tag) {
    failures.push(
      'release ' + release.id + ' is attached to tag ' + release.tag_name + ' != ' + built.tag,
    );
  }
  return { ok: failures.length === 0, failures, notes };
}

/**
 * What to do about the tag's existing release.
 *   absent             -> create-draft
 *   draft, identical   -> publish-draft (a retry finishes what it started)
 *   draft, different   -> refuse         (leftover residue: delete it manually)
 *   public, identical  -> noop           (the run repeats a finished build)
 *   public, different  -> refuse         (a tag never carries a second build)
 * An existing release is never returned as create-draft, so no decision can
 * overwrite, delete or rename one.
 */
export function decideExistingRelease({ built, remote } = {}) {
  assertBuiltRelease(built);
  const release = remote?.release ?? null;
  const notes = [];

  if (release === null) {
    const tagRefSHA = shaOf(remote?.tagRefSHA);
    if (!tagRefSHA) {
      return {
        action: DECISION_REFUSE,
        differences: [
          'tag ' +
            built.tag +
            ' does not exist remotely: refusing to create the tag and the release in one write',
        ],
        notes,
        releaseId: null,
      };
    }
    if (tagRefSHA !== shaOf(built.tagCommitSHA)) {
      return {
        action: DECISION_REFUSE,
        differences: [
          'the remote tag ' +
            built.tag +
            ' is ' +
            tagRefSHA +
            ' != TagCommitSHA ' +
            built.tagCommitSHA,
        ],
        notes,
        releaseId: null,
      };
    }
    notes.push('no release exists for tag ' + built.tag + ': publishing it as a draft');
    return { action: DECISION_CREATE_DRAFT, differences: [], notes, releaseId: null };
  }

  const comparison = compareRemoteRelease({ built, remote });
  notes.push(...comparison.notes);
  if (!comparison.ok) {
    return {
      action: DECISION_REFUSE,
      differences: comparison.failures,
      notes,
      releaseId: release.id ?? null,
    };
  }
  if (release.draft === true) {
    notes.push(
      'a draft release for tag ' + built.tag + ' already carries this exact build: publishing it',
    );
    return {
      action: DECISION_PUBLISH_DRAFT,
      differences: [],
      notes,
      releaseId: release.id ?? null,
    };
  }
  notes.push(
    'release ' +
      release.id +
      ' for tag ' +
      built.tag +
      ' already carries this exact build: no write needed',
  );
  return { action: DECISION_NOOP, differences: [], notes, releaseId: release.id ?? null };
}

/**
 * May the verified draft become public? Anything other than a complete,
 * provenance-proven draft leaves the release a draft: an incomplete release
 * must never be publicly visible.
 */
export function decidePublishOutcome({ built, remote } = {}) {
  assertBuiltRelease(built);
  const release = remote?.release ?? null;
  if (release === null) {
    return {
      action: OUTCOME_STAY_DRAFT,
      failures: [
        'the release for tag ' + built.tag + ' disappeared before it could be made public',
      ],
      releaseId: null,
      notes: [],
    };
  }
  const failures = [];
  if (release.draft !== true) {
    failures.push(
      'release ' + release.id + ' is not a draft: refusing to publish it a second time',
    );
  }
  const comparison = compareRemoteRelease({ built, remote });
  failures.push(...comparison.failures);
  if (failures.length > 0) {
    return {
      action: OUTCOME_STAY_DRAFT,
      failures,
      releaseId: release.id ?? null,
      notes: comparison.notes,
    };
  }
  return {
    action: OUTCOME_PUBLISH,
    failures: [],
    releaseId: release.id ?? null,
    notes: comparison.notes,
  };
}

/** The post-publish gate: the release must be public, a pre-release, and proven. */
export function verifyPublishedRelease({ built, remote } = {}) {
  assertBuiltRelease(built);
  const release = remote?.release ?? null;
  if (release === null) {
    return { ok: false, failures: ['no release exists for tag ' + built.tag], notes: [] };
  }
  const failures = [];
  if (release.draft !== false) {
    failures.push(
      'the release for tag ' + built.tag + ' is still a draft: the publish did not complete',
    );
  }
  if (release.prerelease !== true) {
    failures.push('the dev release for tag ' + built.tag + ' must be published as a pre-release');
  }
  const comparison = compareRemoteRelease({ built, remote });
  failures.push(...comparison.failures);
  return { ok: failures.length === 0, failures, notes: comparison.notes };
}

/**
 * A workflow_dispatch can run workflow logic from a commit that is not the
 * release tag commit (github.workflow_sha != TagCommitSHA). That is refused
 * unless the dispatch explicitly acknowledges it, so a dispatch from main can
 * never silently publish with workflow logic from an unrelated commit.
 */
export function guardWorkflowProvenance({
  workflowSha,
  workflowRef = '',
  tagCommitSHA,
  releaseTag = '',
  allowForeignWorkflow = false,
} = {}) {
  const tagSHA = shaOf(tagCommitSHA);
  const workflow = shaOf(workflowSha);
  const raw = String(allowForeignWorkflow ?? '')
    .trim()
    .toLowerCase();
  const acknowledged = allowForeignWorkflow === true || raw === 'true';
  if (!tagSHA) {
    return {
      ok: false,
      failures: ['TagCommitSHA is not a 40-hex commit: the release target is unknown'],
      notes: [],
      acknowledged,
    };
  }
  if (!workflow) {
    return {
      ok: false,
      failures: [
        'the publishing workflow commit (github.workflow_sha) is empty: the workflow logic cannot be proven to belong to tag ' +
          (releaseTag || '(unknown)') +
          ' at ' +
          tagSHA,
      ],
      notes: [],
      acknowledged,
    };
  }
  if (workflow === tagSHA) {
    return {
      ok: true,
      failures: [],
      notes: ['the workflow ran from the release tag commit ' + tagSHA],
      acknowledged,
    };
  }
  const problem =
    'the publishing workflow ran from commit ' +
    workflow +
    (workflowRef ? ' (' + workflowRef + ')' : '') +
    ' but tag ' +
    (releaseTag || '(unknown)') +
    ' is at ' +
    tagSHA +
    ': refusing to publish workflow logic that does not belong to the tag commit';
  if (acknowledged) {
    return {
      ok: true,
      failures: [],
      notes: [problem + ' - acknowledged by allow_foreign_workflow'],
      acknowledged,
    };
  }
  return {
    ok: false,
    failures: [problem + ' (dispatch again with allow_foreign_workflow=true to acknowledge it)'],
    notes: [],
    acknowledged,
  };
}

/* ---------------------------------------------------------------------------
 * CLI: the only place that talks to GitHub, and only through the gh CLI.
 * Every command below is one phase of the transaction, and every phase that
 * writes is preceded by the pure decision that may refuse it.
 * ------------------------------------------------------------------------- */

function requireEnv(name) {
  const value = process.env[name];
  if (typeof value !== 'string' || value.trim() === '') fail(name + ' is not set');
  return value.trim();
}

function repoSlug() {
  const repo = String(process.env.GITHUB_REPOSITORY ?? '').trim();
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) {
    fail('GITHUB_REPOSITORY is not set to owner/repo (found ' + JSON.stringify(repo) + ')');
  }
  return repo;
}

function runGh(args) {
  const result = spawnSync('gh', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  });
  if (result.error) fail('gh ' + args.join(' ') + ' could not run: ' + result.error.message);
  return {
    status: result.status,
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? '').trim(),
  };
}

function bodyOf(stdout) {
  const match = /^HTTP\/[\d.]+\s+\d{3}[^\r\n]*\r?\n(?:[^\r\n]*\r?\n)*\r?\n/.exec(stdout);
  return match ? stdout.slice(match[0].length) : stdout;
}

function httpStatusOf(stdout) {
  const match = /^HTTP\/[\d.]+\s+(\d{3})/m.exec(stdout);
  return match ? Number(match[1]) : null;
}

function looksNotFound(text) {
  return /\b404\b/.test(text) || /not found/i.test(text);
}

/** A JSON read through the gh CLI; null when the resource does not exist. */
function ghApiJson(path, { allowNotFound = false } = {}) {
  const result = runGh(['api', '--include', '--method', 'GET', path]);
  const status = httpStatusOf(result.stdout);
  if (status === 404) {
    if (allowNotFound) return null;
    fail('gh api ' + path + ' returned HTTP 404');
  }
  if (status !== null && (status < 200 || status >= 300)) {
    fail(
      'gh api ' +
        path +
        ' returned HTTP ' +
        status +
        ': ' +
        bodyOf(result.stdout).trim().slice(0, 400),
    );
  }
  if (status === null && result.status !== 0) {
    if (allowNotFound && looksNotFound(result.stdout + '\n' + result.stderr)) return null;
    fail(
      'gh api ' +
        path +
        ' failed (' +
        result.status +
        '): ' +
        (result.stderr || result.stdout.trim()),
    );
  }
  const text = bodyOf(result.stdout).trim();
  if (text === '') return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    fail('gh api ' + path + ' returned unparseable JSON: ' + error.message);
  }
}

/** Raw text of a release asset; null when it is not there. */
function ghApiAssetText(repo, assetId, { allowNotFound = true } = {}) {
  const path = 'repos/' + repo + '/releases/assets/' + String(assetId);
  const result = runGh(['api', '--method', 'GET', '--header', OCTET_STREAM, path]);
  if (result.status !== 0) {
    if (allowNotFound && looksNotFound(result.stderr + '\n' + result.stdout)) return null;
    fail(
      'gh api ' +
        path +
        ' failed (' +
        result.status +
        '): ' +
        (result.stderr || result.stdout.trim()),
    );
  }
  return result.stdout;
}

function resolveRemoteTagCommit(repo, tag) {
  const ref = ghApiJson('repos/' + repo + '/git/ref/tags/' + encodeURIComponent(tag), {
    allowNotFound: true,
  });
  if (!ref) return null;
  const target = ref.object ?? {};
  if (target.type === 'commit') return shaOf(target.sha);
  if (target.type === 'tag') {
    const annotated = ghApiJson('repos/' + repo + '/git/tags/' + String(target.sha ?? ''), {
      allowNotFound: true,
    });
    return annotated ? shaOf(annotated.object?.sha) : null;
  }
  return null;
}

function fetchRelease(repo, tag) {
  return ghApiJson('repos/' + repo + '/releases/tags/' + encodeURIComponent(tag), {
    allowNotFound: true,
  });
}

function fetchReleaseAssets(repo, releaseId) {
  const path =
    'repos/' + repo + '/releases/' + String(releaseId) + '/assets?per_page=' + ASSETS_PER_PAGE;
  const assets = ghApiJson(path, { allowNotFound: true });
  if (!assets) return [];
  if (!Array.isArray(assets)) fail('gh api ' + path + ' did not return a list of assets');
  return assets;
}

function findRemoteAsset(assets, name) {
  return assets.find((asset) => asset?.name === name) ?? null;
}

function readRemoteManifest(repo, assets) {
  const asset = findRemoteAsset(assets, MANIFEST_NAME);
  if (!asset || !asset.id) return null;
  const text = ghApiAssetText(repo, asset.id);
  if (text === null) return null;
  try {
    return { manifest: JSON.parse(text) };
  } catch (error) {
    return { manifest: null, error: error.message };
  }
}

function readRemoteSums(repo, assets) {
  const asset = findRemoteAsset(assets, SUMS_NAME);
  if (!asset || !asset.id) return null;
  return ghApiAssetText(repo, asset.id);
}

/** Everything the pure decisions need, gathered with reads only. */
function fetchReleaseSnapshot({ repo, tag }) {
  const tagRefSHA = resolveRemoteTagCommit(repo, tag);
  const release = fetchRelease(repo, tag);
  if (!release) {
    return { tagRefSHA, release: null, assets: [], manifest: null, sumsText: null };
  }
  const assets = fetchReleaseAssets(repo, release.id);
  const read = readRemoteManifest(repo, assets);
  const sumsText = readRemoteSums(repo, assets);
  return {
    tagRefSHA,
    release,
    assets,
    manifest: read?.manifest ?? null,
    manifestError: read?.error ?? null,
    sumsText,
  };
}

function readBuiltRelease(options) {
  const dir = resolve(REPO_ROOT, options['artifacts-dir'] ?? 'artifacts');
  const manifestPath = join(dir, MANIFEST_NAME);
  if (!existsSync(manifestPath)) {
    fail(
      MANIFEST_NAME +
        ' is missing from ' +
        dir +
        ': the manifest must be written before the decision',
    );
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''));
  return describeBuiltRelease({ manifest, inventory: readArtifactInventory(dir) });
}

function writeGithubOutputs(values) {
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

function reportDecision(decision) {
  for (const note of decision.notes ?? []) console.log('note: ' + note);
  for (const difference of decision.differences ?? []) console.error('::error::' + difference);
  console.log('decision: ' + decision.action);
}

function guardWorkflowCommand() {
  const releaseTag = requireEnv('RELEASE_TAG');
  const verdict = guardWorkflowProvenance({
    workflowSha: process.env.GITHUB_WORKFLOW_SHA ?? '',
    workflowRef: process.env.GITHUB_WORKFLOW_REF ?? '',
    tagCommitSHA: requireEnv('TAG_COMMIT_SHA'),
    releaseTag,
    allowForeignWorkflow: process.env.INPUT_ALLOW_FOREIGN ?? '',
  });
  for (const note of verdict.notes) console.log('note: ' + note);
  if (!verdict.ok) fail(verdict.failures.join('; '));
  console.log('OK workflow provenance: publishing tag ' + releaseTag);
}

function checkExistingCommand(options) {
  const built = readBuiltRelease(options);
  const decision = decideExistingRelease({
    built,
    remote: fetchReleaseSnapshot({ repo: repoSlug(), tag: built.tag }),
  });
  reportDecision(decision);
  writeGithubOutputs({ decision: decision.action });
  if (decision.action === DECISION_REFUSE) {
    if (decision.differences.some((line) => line.startsWith('unexpected remote asset'))) {
      console.log(
        'note: a release that carries assets this build does not produce is repaired by hand, ' +
          'as documented in the workflow header, before the tag is published again',
      );
    }
    fail('refusing to publish tag ' + built.tag + ': ' + decision.differences.join(' | '));
  }
  if (decision.action === DECISION_NOOP) {
    console.log(
      '::notice::tag ' +
        built.tag +
        ' already carries this exact build; this run performs no write',
    );
  }
}

function verifyDraftCommand(options) {
  const built = readBuiltRelease(options);
  const remote = fetchReleaseSnapshot({ repo: repoSlug(), tag: built.tag });
  if (remote.manifestError)
    console.log('note: ' + MANIFEST_NAME + ' is unreadable: ' + remote.manifestError);
  const outcome = decidePublishOutcome({ built, remote });
  for (const note of outcome.notes ?? []) console.log('note: ' + note);
  if (outcome.action !== OUTCOME_PUBLISH) {
    for (const failure of outcome.failures) console.error('::error::' + failure);
    fail('the release for tag ' + built.tag + ' is not publishable and stays a draft');
  }
  console.log(
    'OK the draft release for tag ' + built.tag + ' carries the complete built asset set',
  );
}

function publishDraftCommand(options) {
  const built = readBuiltRelease(options);
  const repo = repoSlug();
  const outcome = decidePublishOutcome({
    built,
    remote: fetchReleaseSnapshot({ repo, tag: built.tag }),
  });
  for (const note of outcome.notes ?? []) console.log('note: ' + note);
  if (outcome.action !== OUTCOME_PUBLISH) {
    for (const failure of outcome.failures) console.error('::error::' + failure);
    fail('the release for tag ' + built.tag + ' is not publishable and stays a draft');
  }
  const path = 'repos/' + repo + '/releases/' + String(outcome.releaseId);
  const result = runGh([
    'api',
    '--method',
    'PATCH',
    '--field',
    'draft=false',
    '--field',
    'prerelease=true',
    path,
  ]);
  if (result.status !== 0) {
    fail(
      'gh api ' +
        path +
        ' failed (' +
        result.status +
        '): ' +
        (result.stderr || result.stdout.trim()),
    );
  }
  console.log(
    'published release ' + outcome.releaseId + ' for tag ' + built.tag + ' as a public pre-release',
  );
}

function verifyPublishedCommand(options) {
  const built = readBuiltRelease(options);
  const verdict = verifyPublishedRelease({
    built,
    remote: fetchReleaseSnapshot({ repo: repoSlug(), tag: built.tag }),
  });
  for (const note of verdict.notes ?? []) console.log('note: ' + note);
  if (!verdict.ok) {
    for (const failure of verdict.failures) console.error('::error::' + failure);
    fail('the published release for tag ' + built.tag + ' does not match the build');
  }
  console.log(
    'OK the published release for tag ' +
      built.tag +
      ' targets ' +
      built.tagCommitSHA +
      ' and carries the built asset set',
  );
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith('--')) continue;
    const body = token.slice(2);
    const equals = body.indexOf('=');
    if (equals === -1) {
      options[body] = rest[index + 1];
      index += 1;
    } else {
      options[body.slice(0, equals)] = body.slice(equals + 1);
    }
  }
  return { command, options };
}

const COMMANDS = {
  'guard-workflow': () => guardWorkflowCommand(),
  'check-existing': (options) => checkExistingCommand(options),
  'verify-draft': (options) => verifyDraftCommand(options),
  'publish-draft': (options) => publishDraftCommand(options),
  'verify-published': (options) => verifyPublishedCommand(options),
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { command, options } = parseArgs(process.argv.slice(2));
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
      handler(options);
    } catch (error) {
      if (error instanceof ReleaseTransactionError) {
        console.error('::error::' + error.message);
        process.exitCode = 1;
      } else {
        throw error;
      }
    }
  }
}

export { REPO_ROOT };
