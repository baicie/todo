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
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MANIFEST_NAME,
  SUMS_NAME,
  expectedBuildAssets,
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

/**
 * The build jobs upload a `toolchain-<platform>.json` next to their artifacts.
 * Those files are carried by the release but are not part of the release
 * contract. The pattern - not a fixed list - is allowed, because the macOS
 * matrix names its records per architecture; anything else unexpected still
 * fails closed.
 */
export const TOOLCHAIN_ASSET_PATTERN = /^toolchain-[A-Za-z0-9._-]+\.json$/;

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
  allowedExtraPattern = null,
  requireSha256 = true,
  unhashedAllowed = HASH_UNVERIFIABLE_BY_DESIGN,
} = {}) {
  if (!Array.isArray(expected) || expected.length === 0) fail('no expected asset set supplied');
  if (!Array.isArray(remote)) fail('no remote asset inventory supplied');
  const allowed = new Set(allowedExtras);
  const exempt = new Set(unhashedAllowed);
  const extraPattern =
    allowedExtraPattern instanceof RegExp && allowedExtraPattern.global === false
      ? allowedExtraPattern
      : null;
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
    if (allowed.has(name) || (extraPattern && extraPattern.test(name))) {
      notes.push('extra asset carried by the release: ' + name);
    } else failures.push('unexpected remote asset: ' + name);
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
    allowedExtras: built.extras ?? [],
    allowedExtraPattern: TOOLCHAIN_ASSET_PATTERN,
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
 * RC2-D.15 Phase D: staging and publishing are two jobs, and the publish job
 * must decide for itself, after the approval, that the world has not moved.
 * ------------------------------------------------------------------------- */

/** The GitHub Environment that gates publishing; a repository setting. */
export const ENVIRONMENT_NAME = 'dev-pre-release';

export const GATE_ENFORCED = 'enforced';
export const GATE_NOT_CONFIGURED = 'not-configured';
export const GATE_UNVERIFIED = 'unverified';
export const GATE_STATES = Object.freeze([GATE_ENFORCED, GATE_NOT_CONFIGURED, GATE_UNVERIFIED]);

/** The protection-rule type GitHub uses for "required reviewers". */
export const REVIEWER_RULE_TYPE = 'required_reviewers';

export const EVIDENCE_PHASE_STAGE = 'stage';
export const EVIDENCE_PHASE_PUBLISH = 'publish';
export const EVIDENCE_PHASES = Object.freeze([EVIDENCE_PHASE_STAGE, EVIDENCE_PHASE_PUBLISH]);

export const PIPELINE_PUBLISHED = 'published';
export const PIPELINE_ALREADY_PUBLISHED = 'already-published';
export const PIPELINE_AWAITING_APPROVAL = 'awaiting-approval';
export const PIPELINE_NOT_APPROVED = 'not-approved';
export const PIPELINE_FAILED = 'failed';

/* ---------------------------------------------------------------------------
 * P0 fail-closed publish authorization.
 *
 * A tag push, or any event this workflow did not ask for explicitly, may only
 * stage a DRAFT. Publishing is a second, deliberate act: a manual dispatch of
 * this workflow with `publish=true`, which still has to pass the environment
 * approval and the explicit acknowledgement below. The decision is a pure
 * function so the whole matrix runs in tests/release/ without a network.
 * ------------------------------------------------------------------------- */

/** The only event that may ever make a release public. */
export const PUBLISH_EVENT = 'workflow_dispatch';

/**
 * The value the maintainer must type into `confirm`, so a mis-click in the
 * dispatch form cannot publish anything.
 */
export function publishConfirmationPhrase(tag) {
  return 'publish ' + String(tag ?? '').trim();
}

/** Authorization facts the caller gathered; none of them imply each other. */
export function decidePublishAuthorization({
  eventName = '',
  publishInput = false,
  confirmInput = '',
  releaseTag = '',
  workflowSha = '',
  tagCommitSHA = '',
  environmentGate = GATE_UNVERIFIED,
} = {}) {
  const failures = [];
  const notes = [];
  const event = String(eventName ?? '').trim();
  const publishRequested = toBoolean(publishInput);
  const tag = String(releaseTag ?? '').trim();
  const expectedPhrase = publishConfirmationPhrase(tag);
  const confirmation = String(confirmInput ?? '').trim();

  if (event !== PUBLISH_EVENT) {
    failures.push(
      'the run was triggered by "' +
        (event || '(unknown)') +
        '": only a manual workflow_dispatch may publish. A tag push stages a draft and stops there',
    );
  }
  if (!publishRequested) {
    failures.push(
      'the publish input is not set: this run may stage a draft, but the Publish job must be ' +
        'dispatched explicitly with publish=true',
    );
  }
  if (expectedPhrase === 'publish' || confirmation !== expectedPhrase) {
    failures.push(
      'the confirmation phrase does not match: dispatch with publish=true and confirm set to "' +
        expectedPhrase +
        '"',
    );
  }
  if (!shaOf(tagCommitSHA)) {
    failures.push('TagCommitSHA is not a 40-hex commit: there is no release target to authorize');
  } else if (!shaOf(workflowSha)) {
    failures.push('the workflow commit is unknown: the publishing logic cannot be tied to the tag');
  }
  // The environment is the second gate. It is the only input this decision takes
  // that a workflow cannot forge: when it is unreadable or not configured, the
  // maintainer's approval provably did not run.
  if (environmentGate !== GATE_ENFORCED) {
    failures.push(
      'the ' +
        ENVIRONMENT_NAME +
        ' environment gate is ' +
        environmentGate +
        ': configure at least one required reviewer, otherwise no human approved this publish',
    );
  }

  if (failures.length === 0) {
    notes.push(
      'publishing was requested explicitly by a manual dispatch and the environment required an ' +
        'approval; the single PATCH below still revalidates every asset first',
    );
  }
  return {
    ok: failures.length === 0,
    failures,
    notes,
    publishRequested,
    environmentGate,
    confirmed: confirmation === expectedPhrase,
  };
}

function toBoolean(value) {
  if (value === true) return true;
  const text = String(value ?? '')
    .trim()
    .toLowerCase();
  return text === 'true' || text === '1' || text === 'yes';
}

/**
 * No run of this workflow ever claims release readiness. The environment gate is
 * a repository setting, the physical-device behaviour is a host fact, and the
 * artifacts are unsigned, so the only honest answer is "not claimed".
 */
export const RELEASE_READINESS_STATEMENT =
  'no production-distribution readiness is claimed: required reviewers on the dev-pre-release ' +
  'environment are a repository setting this workflow cannot verify, the Windows notification ' +
  'banners and clicks and the Android physical-device behaviour are not verified here, and the ' +
  'macOS DMGs are unsigned and not notarised';

/**
 * Whether the GitHub Environment really blocks the publish job.
 *   inspection = { ok, status, protectionRules: [{ type, reviewers }] }
 * GitHub evaluates the approval BEFORE the job starts, so this is evidence only:
 * it is printed, recorded, and never used to claim the pipeline is release-ready.
 */
export function decideEnvironmentGate({
  environmentName = ENVIRONMENT_NAME,
  inspection = null,
} = {}) {
  const name = String(environmentName ?? '').trim() || ENVIRONMENT_NAME;
  const base = { environmentName: name, enforced: false, releaseReady: false, failures: [] };
  if (!inspection || inspection.ok !== true) {
    const status = Number.isFinite(inspection?.status) ? inspection.status : null;
    return {
      ...base,
      gate: GATE_UNVERIFIED,
      notes: [
        'environment ' +
          name +
          ' could not be inspected' +
          (status === null ? '' : ' (HTTP ' + status + ')') +
          ': whether required reviewers block this job is a repository setting only a maintainer ' +
          'can confirm, so this run does not treat the pipeline as release-ready',
      ],
    };
  }
  const rules = Array.isArray(inspection.protectionRules) ? inspection.protectionRules : [];
  const reviewerRule = rules.find((rule) => rule?.type === REVIEWER_RULE_TYPE) ?? null;
  const reviewers = Array.isArray(reviewerRule?.reviewers) ? reviewerRule.reviewers : [];
  if (!reviewerRule || reviewers.length === 0) {
    const seen = rules.map((rule) => String(rule?.type ?? '?')).join(', ') || 'none';
    return {
      ...base,
      gate: GATE_NOT_CONFIGURED,
      notes: [
        'environment ' +
          name +
          ' is not gated: it declares no ' +
          REVIEWER_RULE_TYPE +
          ' rule with at least one reviewer (protection rules seen: ' +
          seen +
          '), so the publish job needs no approval and this run does not treat the pipeline as ' +
          'release-ready',
      ],
    };
  }
  return {
    ...base,
    enforced: true,
    gate: GATE_ENFORCED,
    notes: [
      'environment ' +
        name +
        ' requires ' +
        reviewers.length +
        ' reviewer(s): GitHub blocked this job until one approved it, and the read-only ' +
        'revalidation below still runs after that approval',
    ],
  };
}

function describeReviewerRule(rule) {
  const reviewers = Array.isArray(rule?.reviewers) ? rule.reviewers : [];
  return reviewers
    .map((reviewer) => String(reviewer?.reviewer?.login ?? reviewer?.login ?? '(unknown)'))
    .join(', ');
}

/** The reviewer names, for evidence only. */
export function environmentReviewers(protectionRules = []) {
  const rule = (Array.isArray(protectionRules) ? protectionRules : []).find(
    (entry) => entry?.type === REVIEWER_RULE_TYPE,
  );
  return describeReviewerRule(rule)
    .split(', ')
    .filter((name) => name !== '(unknown)' && name !== '');
}

/**
 * The publish job must publish the exact identity that stage-release created the
 * draft from. The staged manifest IS that identity: it is compared with the
 * artifacts re-downloaded for publishing and with the release context passed
 * through needs.<job>.outputs, so nothing is recomputed differently.
 */
export function adoptStagedRelease({ stagedManifest = null, inventory = [], expected = {} } = {}) {
  if (!stagedManifest || typeof stagedManifest !== 'object') {
    return {
      ok: false,
      failures: [MANIFEST_NAME + ' is missing from the staged release evidence'],
      notes: [],
      assets: [],
    };
  }
  const failures = [];
  const notes = [];

  const staged = Array.isArray(stagedManifest.assets) ? stagedManifest.assets : [];
  if (staged.length === 0) failures.push('the staged ' + MANIFEST_NAME + ' records no assets');
  const onDisk = new Map();
  for (const file of Array.isArray(inventory) ? inventory : []) {
    if (typeof file?.name === 'string' && file.name !== '') onDisk.set(file.name, file);
  }
  const tally = (assets) => assets.map((asset) => asset.name).sort();
  for (const asset of staged) {
    const name = String(asset?.name ?? '');
    const file = onDisk.get(name);
    if (!file) {
      failures.push('the build artifacts re-downloaded for publishing carry no ' + name);
      continue;
    }
    if (file.size !== asset.size) {
      failures.push(
        'the re-downloaded ' +
          name +
          ' is ' +
          file.size +
          ' bytes but the staged manifest records ' +
          asset.size,
      );
      continue;
    }
    if (hexOf(file.sha256) !== hexOf(asset.sha256)) {
      failures.push(
        'the re-downloaded ' +
          name +
          ' has sha256 ' +
          file.sha256 +
          ' but the staged manifest records ' +
          asset.sha256,
      );
    }
  }
  const expectedAssets = expectedBuildAssets(normalizeVersion(stagedManifest.release?.version));
  const stagedNames = tally(staged.map((asset) => ({ name: asset?.name })));
  for (const name of expectedAssets) {
    if (!stagedNames.includes(name)) {
      failures.push('the staged ' + MANIFEST_NAME + ' does not record the contract asset ' + name);
    }
  }
  const recordedSums = onDisk.get(SUMS_NAME);
  if (recordedSums) notes.push(SUMS_NAME + ' is present in the re-downloaded artifact set');

  const identity = {
    tag: String(stagedManifest.release?.tag ?? ''),
    version: normalizeVersion(stagedManifest.release?.version),
    channel: String(stagedManifest.release?.channel ?? ''),
    tagCommitSHA: shaOf(stagedManifest.commit?.tagSHA),
    identifier: String(stagedManifest.app?.identifier ?? ''),
  };
  for (const [key, expectedValue] of Object.entries(expected ?? {})) {
    if (expectedValue === undefined || expectedValue === null || expectedValue === '') continue;
    const actual = key === 'tagCommitSHA' ? identity.tagCommitSHA : identity[key];
    if (actual !== expectedValue) {
      failures.push(
        'the staged ' +
          MANIFEST_NAME +
          ' records ' +
          key +
          ' ' +
          String(actual) +
          ' but stage-release declared ' +
          String(expectedValue),
      );
    }
  }
  return { ok: failures.length === 0, failures, notes, assets: stagedNames, identity };
}

/**
 * The whole pipeline in one decision, so a pending or rejected approval, an
 * interrupted staging and a finished duplicate run all have a name and a
 * statement about what is visible to the public.
 */
export function describePipelineOutcome({ stage = null, publish = null } = {}) {
  const base = { releaseReady: false, failures: [], notes: [] };
  const decision = String(stage?.decision ?? '');
  const stageFailed = !stage || stage.ok === false || decision === DECISION_REFUSE;
  if (stageFailed) {
    return {
      ...base,
      action: PIPELINE_FAILED,
      draftVisible: true,
      notes: [
        'staging did not complete: no release was published and any draft that already exists stays ' +
          'a draft, invisible to the public',
      ],
      failures: [...(stage?.failures ?? [])],
    };
  }
  if (publish === null || publish === undefined || publish.outcome === 'pending') {
    return {
      ...base,
      action: PIPELINE_AWAITING_APPROVAL,
      draftVisible: true,
      notes: [
        'the draft is staged and the publish job has not run: it waits for the required reviewers ' +
          'of the ' +
          ENVIRONMENT_NAME +
          ' environment, and the draft stays a draft until one approves',
      ],
    };
  }
  if (publish.outcome === 'rejected') {
    return {
      ...base,
      action: PIPELINE_NOT_APPROVED,
      draftVisible: true,
      notes: [
        'the publish job was not approved (or the approval was withdrawn): the draft stays a draft ' +
          'and nothing was published',
      ],
    };
  }
  if (publish.outcome === 'failed') {
    return {
      ...base,
      action: PIPELINE_FAILED,
      draftVisible: true,
      notes: [
        'publishing failed after the approval: the release stays a draft and is never publicly ' +
          'visible, delete it by hand before retrying',
      ],
      failures: [...(publish.failures ?? [])],
    };
  }
  if (publish.outcome === 'noop' || decision === DECISION_NOOP) {
    return {
      ...base,
      action: PIPELINE_ALREADY_PUBLISHED,
      draftVisible: false,
      notes: [
        'tag ' +
          String(publish?.tag ?? stage?.tag ?? '(unknown)') +
          ' already carries this exact build: the run is a no-op and the published release is ' +
          'untouched',
      ],
    };
  }
  return {
    ...base,
    action: PIPELINE_PUBLISHED,
    draftVisible: false,
    notes: ['the verified draft was flipped to a public pre-release'],
  };
}

/** The reviewable evidence record a failed or successful run must leave behind. */
export function buildReleaseEvidence({
  phase,
  context = {},
  jobStatus = 'unknown',
  decision = null,
  outcome = null,
  environment = null,
  manifestSha256 = null,
  failures = [],
  notes = [],
  generatedAt = null,
} = {}) {
  if (!EVIDENCE_PHASES.includes(phase)) {
    fail('the evidence phase must be one of ' + EVIDENCE_PHASES.join(', '));
  }
  const pipeline = describePipelineOutcome({
    stage: {
      decision: decision ?? (phase === EVIDENCE_PHASE_STAGE ? null : DECISION_PUBLISH_DRAFT),
    },
    publish: phase === EVIDENCE_PHASE_STAGE ? null : { outcome: outcome ?? 'pending' },
  });
  const gate = environment
    ? {
        name: String(environment.name ?? ENVIRONMENT_NAME),
        gate: GATE_STATES.includes(environment.gate) ? environment.gate : GATE_UNVERIFIED,
        enforced: environment.enforced === true,
      }
    : { name: ENVIRONMENT_NAME, gate: GATE_UNVERIFIED, enforced: false };
  return {
    schemaVersion: 1,
    phase,
    generatedAt,
    jobStatus: String(jobStatus ?? 'unknown'),
    context: {
      releaseVersion: String(context.releaseVersion ?? ''),
      releaseTag: String(context.releaseTag ?? ''),
      tagCommitSHA: String(context.tagCommitSHA ?? ''),
      buildCommitSHA: String(context.buildCommitSHA ?? ''),
      artifactVersion: String(context.artifactVersion ?? ''),
      releaseChannel: String(context.releaseChannel ?? ''),
      workflowSha: String(context.workflowSha ?? ''),
      runId: String(context.runId ?? ''),
    },
    decision: decision ?? null,
    outcome: outcome ?? null,
    manifestSha256: manifestSha256 ?? null,
    environment: gate,
    pipeline: { action: pipeline.action, draftVisible: pipeline.draftVisible },
    releaseReadiness: { claimed: false, statement: RELEASE_READINESS_STATEMENT },
    draftRemainsVisible: pipeline.draftVisible,
    failures: [...failures],
    notes: [...notes, ...pipeline.notes],
  };
}

/** The evidence record as markdown, for the step summary and the artifact. */
export function renderReleaseEvidence(evidence) {
  const record = evidence && typeof evidence === 'object' ? evidence : {};
  const context = record.context ?? {};
  const environment = record.environment ?? {};
  const lines = [
    '## Release evidence: ' + String(record.phase ?? '(unknown)') + ' phase',
    '',
    '| fact | value |',
    '| --- | --- |',
    '| job status | `' + String(record.jobStatus ?? 'unknown') + '` |',
    '| tag | `' + String(context.releaseTag ?? '') + '` |',
    '| TagCommitSHA | `' + String(context.tagCommitSHA ?? '') + '` |',
    '| artifact version | `' + String(context.artifactVersion ?? '') + '` |',
    '| stage decision | `' + String(record.decision ?? '(none)') + '` |',
    '| pipeline | `' + String(record.pipeline?.action ?? '(none)') + '` |',
    '| manifest sha256 | `' + String(record.manifestSha256 ?? '(missing)') + '` |',
    '| environment | `' +
      String(environment.name ?? ENVIRONMENT_NAME) +
      '` gate=' +
      String(environment.gate ?? GATE_UNVERIFIED) +
      ' enforced=' +
      String(environment.enforced === true) +
      ' |',
    '',
    record.draftRemainsVisible === false
      ? 'The release is public; it is never overwritten or re-uploaded by a later run.'
      : 'A failed, cancelled or unapproved run leaves the release as a DRAFT: it is never publicly ' +
        'visible. Remove a partial draft by hand before retrying.',
    '',
    'Release readiness: **not claimed**. ' + String(record.releaseReadiness?.statement ?? ''),
  ];
  if (Array.isArray(record.failures) && record.failures.length > 0) {
    lines.push('', '### Failures', '');
    for (const failure of record.failures) lines.push('- ' + String(failure));
  }
  if (Array.isArray(record.notes) && record.notes.length > 0) {
    lines.push('', '### Notes', '');
    for (const note of record.notes) lines.push('- ' + String(note));
  }
  return lines;
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
    return { manifest: JSON.parse(text), manifestText: text };
  } catch (error) {
    return { manifest: null, manifestText: null, error: error.message };
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
    manifestText: read?.manifestText ?? null,
    manifestError: read?.error ?? null,
    sumsText,
  };
}

/**
 * The built side of a publish run. The publish job has NO build artifacts on
 * disk: it downloaded the draft's manifest and SHA256SUMS and nothing else, so
 * describing the build from a local inventory can never succeed there. The
 * staged manifest is the build record, and its own sha256 was pinned by the
 * staging run (a different workflow run) before this one started - that pin is
 * what keeps the comparison below from being circular.
 *
 * The manifest records the BUILD assets only: it is written before itself and
 * SHA256SUMS exist, so it cannot list either. The release contract adds those
 * two, and they are what `extras` carries here.
 *
 * A manifest without a recorded asset table is refused: there would be nothing
 * left to compare the remote draft against.
 */
export function describeDraftRelease({ manifest } = {}) {
  if (!manifest || typeof manifest !== 'object') fail('the staged release manifest is missing');
  const version = normalizeVersion(manifest.release?.version);
  const recorded = Array.isArray(manifest.assets) ? manifest.assets : [];
  if (recorded.length === 0) {
    fail(
      'the staged ' +
        MANIFEST_NAME +
        ' records no asset inventory: the remote draft cannot be compared against it',
    );
  }
  const assets = recorded.map((asset) => {
    const name = typeof asset?.name === 'string' ? asset.name.trim() : '';
    if (name === '') fail('the staged manifest carries an asset without a name');
    const sha256 = hexOf(asset.sha256);
    if (!sha256) fail('the staged manifest records no sha256 for ' + name);
    if (!Number.isFinite(asset.size) || asset.size <= 0) {
      fail('the staged manifest records no size for ' + name);
    }
    return { name, size: asset.size, sha256 };
  });
  const expected = expectedBuildAssets(version);
  const missing = expected.filter((name) => !assets.some((asset) => asset.name === name));
  if (missing.length > 0) {
    fail(
      'the staged manifest does not describe the release contract: missing ' + missing.join(', '),
    );
  }
  const extra = [...assets.map((asset) => asset.name), MANIFEST_NAME, SUMS_NAME].filter(
    (name) => !expected.includes(name),
  );
  return {
    tag: String(manifest.release?.tag ?? version),
    version,
    channel: String(manifest.release?.channel ?? ''),
    identifier: String(manifest.app?.identifier ?? ''),
    tagCommitSHA: shaOf(manifest.commit?.tagSHA),
    manifest,
    assets,
    extras: [...new Set(extra)].sort(),
    source: 'draft-manifest',
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
  const bytes = readFileSync(manifestPath);
  const declared = options['expect-draft-sha'] ? hexOf(options['expect-draft-sha']) : null;
  if (options['expect-draft-sha'] && !declared) {
    fail('--expect-draft-sha must be a 64-hex sha256');
  }
  if (declared) {
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== declared) {
      fail(
        'the staged ' +
          MANIFEST_NAME +
          ' sha256 ' +
          actual +
          ' is not the one staging recorded (' +
          declared +
          ')',
      );
    }
  }
  const manifest = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
  if (options['from-manifest']) return describeDraftRelease({ manifest });
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
  writeGithubOutputs({ decision: decision.action, releaseId: decision.releaseId ?? '' });
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

/**
 * The publish job must not touch a release that is not the one stage-release
 * verified, so both the read-only revalidation and the single write pin the id.
 */
function assertExpectedReleaseId(outcome, expectedId) {
  const declared = String(expectedId ?? '').trim();
  if (declared === '') return;
  if (String(outcome.releaseId ?? '') !== declared) {
    fail(
      'release ' +
        String(outcome.releaseId ?? '(none)') +
        ' for this tag is not the draft stage-release verified (' +
        declared +
        ')',
    );
  }
}

function verifyDraftCommand(options) {
  const built = readBuiltRelease(options);
  const remote = fetchReleaseSnapshot({ repo: repoSlug(), tag: built.tag });
  if (remote.manifestError)
    console.log('note: ' + MANIFEST_NAME + ' is unreadable: ' + remote.manifestError);
  // A publish run re-downloaded the draft's manifest; it must be byte-identical
  // to the one the staging run recorded, or this is a different draft.
  const expectDraftSha = options['expect-draft-sha'] ? hexOf(options['expect-draft-sha']) : null;
  if (options['expect-draft-sha'] && !expectDraftSha) {
    fail('--expect-draft-sha must be a 64-hex sha256');
  }
  if (expectDraftSha) {
    const exact = remote.manifestText
      ? shaOf256(remote.manifestText)
      : shaOf256(JSON.stringify(remote.manifest, null, 2) + '\n');
    if (exact !== expectDraftSha) {
      for (const failure of [
        'the remote draft ' +
          MANIFEST_NAME +
          ' sha256 ' +
          exact +
          ' is not the staged one (' +
          expectDraftSha +
          '): the draft changed after staging',
      ])
        console.error('::error::' + failure);
      fail('the remote draft is not the build that was staged; it stays a draft');
    }
    console.log('note: the remote draft manifest matches the staged sha256 ' + exact);
  }
  const outcome = decidePublishOutcome({ built, remote });
  assertExpectedReleaseId(outcome, options['expect-release-id']);
  for (const note of outcome.notes ?? []) console.log('note: ' + note);
  if (outcome.action !== OUTCOME_PUBLISH) {
    for (const failure of outcome.failures) console.error('::error::' + failure);
    fail('the release for tag ' + built.tag + ' is not publishable and stays a draft');
  }
  writeGithubOutputs({ releaseId: String(outcome.releaseId ?? ''), decision: outcome.action });
  console.log(
    'OK the draft release for tag ' +
      built.tag +
      ' (' +
      outcome.releaseId +
      ') carries the complete built asset set',
  );
}

/** Read the authorization facts from the workflow environment. */
function readPublishAuthorization() {
  return decidePublishAuthorization({
    eventName: process.env.GITHUB_EVENT_NAME ?? '',
    publishInput: process.env.INPUT_PUBLISH ?? false,
    confirmInput: process.env.INPUT_CONFIRM ?? '',
    releaseTag: process.env.RELEASE_TAG ?? '',
    workflowSha: process.env.GITHUB_WORKFLOW_SHA ?? '',
    tagCommitSHA: process.env.TAG_COMMIT_SHA ?? '',
    environmentGate: process.env.RELEASE_ENVIRONMENT_GATE ?? GATE_UNVERIFIED,
  });
}

/**
 * The fail-closed authorization gate. It runs BEFORE the publish job is allowed
 * to do anything else, so a tag push, a missing confirmation or an unconfigured
 * environment stops the job before it downloads, revalidates or writes.
 */
function authorizePublishCommand(options) {
  const authorization = readPublishAuthorization();
  for (const note of authorization.notes) console.log('note: ' + note);
  appendStepSummary([
    '## Publish authorization',
    '',
    '| fact | value |',
    '| --- | --- |',
    '| trigger | ' + (process.env.GITHUB_EVENT_NAME ?? '(unknown)') + ' |',
    '| publish requested | ' + String(authorization.publishRequested) + ' |',
    '| confirmation phrase matched | ' + String(authorization.confirmed) + ' |',
    '| environment gate | ' + authorization.environmentGate + ' |',
    '| authorized | ' + String(authorization.ok) + ' |',
    '',
    authorization.ok
      ? 'Publishing is authorized: the dispatch was manual, the confirmation phrase matched and ' +
        'the environment required an approval.'
      : 'Publishing is NOT authorized. The draft stays a draft.',
  ]);
  for (const failure of authorization.failures) console.error('::error::' + failure);
  if (!authorization.ok) {
    fail(
      'refusing to publish: the run is not an authorized publish (' +
        authorization.failures.join(' | ') +
        '); nothing was written',
    );
  }
  writeGithubOutputs({ authorized: 'true' });
  console.log(
    'OK publishing is authorized: manual dispatch, confirmation phrase matched, environment gate ' +
      authorization.environmentGate,
  );
}

function publishDraftCommand(options) {
  // Defence in depth: the workflow already ran authorize-publish, but the write
  // command refuses on its own if that proof is missing.
  const authorization = readPublishAuthorization();
  if (!authorization.ok) {
    for (const failure of authorization.failures) console.error('::error::' + failure);
    fail(
      'refusing to publish: the run is not an authorized publish (' +
        authorization.failures.join(' | ') +
        '); nothing was written',
    );
  }
  const built = readBuiltRelease(options);
  const repo = repoSlug();
  const outcome = decidePublishOutcome({
    built,
    remote: fetchReleaseSnapshot({ repo, tag: built.tag }),
  });
  assertExpectedReleaseId(outcome, options['expect-release-id']);
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

/**
 * Download the draft's own manifest and SHA256SUMS from the remote release, so a
 * later publish run can prove the remote build without the staging run's
 * artifacts still existing. Every downloaded byte is checksummed.
 *
 * `expectDraftSha256` is the manifest sha256 the staging run recorded; when it is
 * given, the adopted manifest must hash exactly to it.
 */
function adoptDraftCommand(options) {
  const repo = repoSlug();
  const tag = requireString(options.tag, 'tag');
  const outDir = resolve(REPO_ROOT, options['out-dir'] ?? 'staged');
  const expectedSHA = options['expect-draft-sha'] ? hexOf(options['expect-draft-sha']) : null;
  if (options['expect-draft-sha'] && !expectedSHA) {
    fail('--expect-draft-sha must be a 64-hex sha256');
  }
  const snapshot = fetchReleaseSnapshot({ repo, tag });
  const release = snapshot.release;
  if (!release) fail('there is no release for tag ' + tag + ' to adopt');
  if (release.draft !== true) {
    fail(
      'release ' +
        release.id +
        ' for tag ' +
        tag +
        ' is already public: a publish run cannot adopt it and will verify it instead',
    );
  }
  mkdirSync(outDir, { recursive: true });
  const wanted = [MANIFEST_NAME, SUMS_NAME];
  const written = [];
  for (const name of wanted) {
    const asset = (snapshot.assets ?? []).find((entry) => entry?.name === name);
    if (!asset) {
      fail('the draft release ' + release.id + ' does not carry ' + name + ': nothing to adopt');
    }
    const text = ghApiAssetText(repo, asset.id);
    if (text === null) fail('could not download ' + name + ' from draft release ' + release.id);
    const actual = shaOf256(text);
    const remoteDigest = digestOf(asset.digest);
    if (remoteDigest && remoteDigest !== actual) {
      fail(
        'the downloaded ' +
          name +
          ' sha256 ' +
          actual +
          ' != the digest GitHub reports for it (' +
          remoteDigest +
          ')',
      );
    }
    if (name === MANIFEST_NAME && expectedSHA && expectedSHA !== actual) {
      fail(
        'the draft ' +
          MANIFEST_NAME +
          ' sha256 ' +
          actual +
          ' is not the staged one (' +
          expectedSHA +
          '): the remote draft is not the build this publish was approved for',
      );
    }
    writeFileSync(join(outDir, name), text);
    written.push({ name, sha256: actual });
  }
  writeGithubOutputs({
    releaseId: String(release.id),
    draftManifestSha256: written.find((entry) => entry.name === MANIFEST_NAME).sha256,
  });
  console.log(
    'OK adopted draft release ' +
      release.id +
      ' for tag ' +
      tag +
      ': ' +
      written.map((entry) => entry.name + '=' + entry.sha256).join(' '),
  );
}

function requireString(value, label) {
  const text = String(value ?? '').trim();
  if (text === '') fail('--' + label + ' is required');
  return text;
}

function shaOf256(value) {
  return createHash('sha256').update(value).digest('hex');
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

function appendStepSummary(lines) {
  const path = process.env.GITHUB_STEP_SUMMARY;
  const text = lines.join('\n') + '\n';
  if (typeof path !== 'string' || path === '') {
    console.log(text);
    return;
  }
  appendFileSync(path, text);
}

/** A JSON read that never throws: the environment API is usually not readable. */
function ghApiJsonTolerant(path) {
  const result = runGh(['api', '--include', '--method', 'GET', path]);
  const status = httpStatusOf(result.stdout);
  if (status === null) {
    return {
      ok: false,
      status: null,
      body: null,
      error: (result.stderr || result.stdout).trim().slice(0, 300),
    };
  }
  if (status < 200 || status >= 300) return { ok: false, status, body: null, error: '' };
  const text = bodyOf(result.stdout).trim();
  if (text === '') return { ok: true, status, body: null, error: '' };
  try {
    return { ok: true, status, body: JSON.parse(text), error: '' };
  } catch {
    return { ok: false, status, body: null, error: 'unparseable JSON' };
  }
}

function artifactsDirOf(options) {
  const dir = resolve(REPO_ROOT, options['artifacts-dir'] ?? 'artifacts');
  if (!existsSync(dir)) fail('the artifact directory ' + dir + ' does not exist');
  return dir;
}

/**
 * Install the identity stage-release staged into the artifacts directory, after
 * proving it still describes the artifacts this job downloaded.
 */
function adoptStagedCommand(options) {
  const artifacts = artifactsDirOf(options);
  const stagedDir = resolve(REPO_ROOT, options['staged-dir'] ?? 'staged');
  const stagedManifestPath = join(stagedDir, MANIFEST_NAME);
  if (!existsSync(stagedManifestPath)) {
    fail(
      MANIFEST_NAME +
        ' is missing from ' +
        stagedDir +
        ': the publish job cannot prove which build it is publishing',
    );
  }
  const stagedText = readFileSync(stagedManifestPath, 'utf8').replace(/^\uFEFF/, '');
  const manifestSha256 = createHash('sha256').update(stagedText).digest('hex');
  const declared = String(process.env.STAGED_MANIFEST_SHA256 ?? '').trim();
  const failures = [];
  if (declared !== '' && declared !== manifestSha256) {
    failures.push(
      'the staged ' +
        MANIFEST_NAME +
        ' is not the one stage-release recorded (sha256 ' +
        manifestSha256 +
        ' != ' +
        declared +
        ')',
    );
  }
  let stagedManifest = null;
  try {
    stagedManifest = JSON.parse(stagedText);
  } catch (error) {
    failures.push('the staged ' + MANIFEST_NAME + ' is unparseable: ' + error.message);
  }
  const adopted =
    failures.length > 0
      ? { ok: false, failures, notes: [], assets: [] }
      : adoptStagedRelease({
          stagedManifest,
          inventory: readArtifactInventory(artifacts),
          expected: {
            tag: String(process.env.RELEASE_TAG ?? '').trim(),
            version: normalizeVersion(String(process.env.ARTIFACT_VERSION ?? '').trim()),
            tagCommitSHA: String(process.env.TAG_COMMIT_SHA ?? '').trim(),
          },
        });
  for (const note of adopted.notes) console.log('note: ' + note);
  if (!adopted.ok) {
    for (const failure of adopted.failures) console.error('::error::' + failure);
    fail(
      'refusing to publish: the staged release identity does not describe this build (' +
        adopted.failures.join(' | ') +
        '); nothing was written',
    );
  }
  const sumsSource = join(stagedDir, SUMS_NAME);
  if (existsSync(sumsSource)) copyFileSync(sumsSource, join(artifacts, SUMS_NAME));
  copyFileSync(stagedManifestPath, join(artifacts, MANIFEST_NAME));
  console.log(
    'OK adopted the staged release identity: ' +
      MANIFEST_NAME +
      ' sha256 ' +
      manifestSha256 +
      ', ' +
      adopted.assets.length +
      ' assets proven against the re-downloaded build outputs',
  );
  writeGithubOutputs({ manifestSha256 });
}

/**
 * Evidence only: GitHub evaluates an environment approval before the job starts,
 * so this command can report whether the gate is enforced but never proves it.
 */
function environmentGateCommand(options) {
  const name = String(options.environment ?? ENVIRONMENT_NAME).trim() || ENVIRONMENT_NAME;
  let inspection = null;
  try {
    const probe = ghApiJsonTolerant(
      'repos/' + repoSlug() + '/environments/' + encodeURIComponent(name),
    );
    inspection = {
      ok: probe.ok && probe.body !== null,
      status: probe.status,
      protectionRules: Array.isArray(probe.body?.protection_rules)
        ? probe.body.protection_rules
        : [],
    };
    if (probe.error) console.log('note: the environment read reported: ' + probe.error);
  } catch (error) {
    console.log('note: the environment could not be read: ' + error.message);
    inspection = { ok: false, status: null, protectionRules: [] };
  }
  const decision = decideEnvironmentGate({ environmentName: name, inspection });
  for (const note of decision.notes) console.log('note: ' + note);
  const reviewers = environmentReviewers(inspection?.protectionRules ?? []);
  console.log(
    'environment ' +
      name +
      ': gate=' +
      decision.gate +
      ' enforced=' +
      String(decision.enforced) +
      ' reviewers=' +
      (reviewers.join(', ') || '(none recorded)'),
  );
  console.log(
    '::notice::the environment gate is a repository setting (Settings -> Environments -> ' +
      name +
      ' -> Required reviewers); this run does not treat the pipeline as release-ready',
  );
  appendStepSummary([
    '## Environment gate: ' + name,
    '',
    '| fact | value |',
    '| --- | --- |',
    '| gate | ' + decision.gate + ' |',
    '| enforced by GitHub | ' + String(decision.enforced) + ' |',
    '| required reviewers | ' + (reviewers.join(', ') || '(none recorded)') + ' |',
    '',
    'Maintainer action: configure the ' +
      name +
      ' environment in the repository settings and add at least one required reviewer; without ' +
      'it the publish job is not gated by an approval.',
  ]);
  writeGithubOutputs({
    gate: decision.gate,
    enforced: String(decision.enforced),
    reviewers: reviewers.join(','),
  });
}

/** Write the reviewable evidence record of this job, success or failure. */
function writeEvidenceCommand(options) {
  const phase = String(options.phase ?? '').trim();
  if (!EVIDENCE_PHASES.includes(phase)) {
    fail('--phase must be one of ' + EVIDENCE_PHASES.join(', '));
  }
  const artifacts = resolve(REPO_ROOT, options['artifacts-dir'] ?? 'artifacts');
  const outDir = resolve(REPO_ROOT, options['out-dir'] ?? 'evidence-' + phase);
  mkdirSync(outDir, { recursive: true });
  const failures = [];
  const notes = [];
  let manifestSha256 = null;
  const manifestPath = join(artifacts, MANIFEST_NAME);
  if (existsSync(manifestPath)) {
    manifestSha256 = createHash('sha256').update(readFileSync(manifestPath)).digest('hex');
    copyFileSync(manifestPath, join(outDir, MANIFEST_NAME));
    const sumsPath = join(artifacts, SUMS_NAME);
    if (existsSync(sumsPath)) copyFileSync(sumsPath, join(outDir, SUMS_NAME));
    else failures.push(SUMS_NAME + ' is missing from ' + artifacts);
  } else {
    failures.push(
      MANIFEST_NAME +
        ' is missing from ' +
        artifacts +
        ': this run has no release identity to show',
    );
  }
  const declared = String(options['manifest-sha256'] ?? '').trim();
  if (declared !== '' && manifestSha256 !== null && declared !== manifestSha256) {
    failures.push(
      'the local ' +
        MANIFEST_NAME +
        ' (sha256 ' +
        manifestSha256 +
        ') is not the staged one (' +
        declared +
        ')',
    );
  }
  const jobStatus = String(options['job-status'] ?? process.env.RELEASE_JOB_STATUS ?? 'unknown');
  const stageDecision = options.decision ?? process.env.STAGE_DECISION ?? null;
  let outcome = options.outcome ?? process.env.PUBLISH_OUTCOME ?? null;
  if (phase === EVIDENCE_PHASE_PUBLISH && (outcome === null || outcome === '')) {
    if (jobStatus === 'success') outcome = stageDecision === DECISION_NOOP ? 'noop' : 'published';
    else outcome = 'failed';
  }
  if (phase === EVIDENCE_PHASE_STAGE && (outcome === null || outcome === '')) outcome = null;
  const evidence = buildReleaseEvidence({
    phase,
    context: {
      releaseVersion: process.env.RELEASE_VERSION ?? '',
      releaseTag: process.env.RELEASE_TAG ?? '',
      tagCommitSHA: process.env.TAG_COMMIT_SHA ?? '',
      buildCommitSHA: process.env.BUILD_COMMIT_SHA ?? '',
      artifactVersion: process.env.ARTIFACT_VERSION ?? '',
      releaseChannel: process.env.RELEASE_CHANNEL ?? '',
      workflowSha: process.env.GITHUB_WORKFLOW_SHA ?? '',
      runId: process.env.GITHUB_RUN_ID ?? '',
    },
    jobStatus,
    decision: stageDecision,
    outcome,
    environment: {
      name: process.env.RELEASE_ENVIRONMENT_NAME ?? ENVIRONMENT_NAME,
      gate: process.env.RELEASE_ENVIRONMENT_GATE ?? GATE_UNVERIFIED,
      enforced: String(process.env.RELEASE_ENVIRONMENT_ENFORCED ?? '') === 'true',
    },
    manifestSha256,
    failures,
    notes,
    generatedAt: new Date().toISOString(),
  });
  writeFileSync(join(outDir, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
  const lines = renderReleaseEvidence(evidence);
  writeFileSync(join(outDir, 'evidence.md'), lines.join('\n') + '\n');
  appendStepSummary(lines);
  writeGithubOutputs({
    manifestSha256: manifestSha256 ?? '',
    evidenceDir: outDir,
    evidencePhase: phase,
  });
  console.log('evidence written to ' + outDir + ' (phase ' + phase + ')');
  for (const failure of failures) console.log('::warning::' + failure);
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
  'adopt-staged': (options) => adoptStagedCommand(options),
  'environment-gate': (options) => environmentGateCommand(options),
  'authorize-publish': (options) => authorizePublishCommand(options),
  'adopt-draft': (options) => adoptDraftCommand(options),
  'write-evidence': (options) => writeEvidenceCommand(options),
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
