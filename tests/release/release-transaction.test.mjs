/**
 * Transactional publish contract for the dev pre-release (RC2-D.11).
 *
 * Every decision is a pure function of fixture facts, so the whole matrix runs
 * without a network and without touching a real GitHub release: an existing
 * release is compared by identity (tag commit, version, channel, identifier) and
 * by asset (name, size, sha256), and the publish step only flips a draft that
 * has already been proven complete.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEV_IDENTIFIER,
  MANIFEST_NAME,
  SUMS_NAME,
  buildManifest,
  expectedBuildAssets,
} from '../../scripts/release/release-context.mjs';
import {
  DECISION_CREATE_DRAFT,
  DECISION_NOOP,
  DECISION_PUBLISH_DRAFT,
  DECISION_REFUSE,
  EVIDENCE_PHASE_PUBLISH,
  EVIDENCE_PHASE_STAGE,
  ENVIRONMENT_NAME,
  GATE_ENFORCED,
  GATE_NOT_CONFIGURED,
  GATE_UNVERIFIED,
  OUTCOME_PUBLISH,
  OUTCOME_STAY_DRAFT,
  PIPELINE_ALREADY_PUBLISHED,
  PIPELINE_AWAITING_APPROVAL,
  PIPELINE_FAILED,
  PIPELINE_NOT_APPROVED,
  PIPELINE_PUBLISHED,
  RELEASE_READINESS_STATEMENT,
  adoptStagedRelease,
  buildReleaseEvidence,
  decideEnvironmentGate,
  decideExistingRelease,
  decidePublishOutcome,
  describeBuiltRelease,
  describePipelineOutcome,
  guardWorkflowProvenance,
  renderReleaseEvidence,
  verifyPublishedRelease,
  verifyRemoteAssets,
} from '../../scripts/release/release-transaction.mjs';
import {
  ANDROID_COMPILE_SDK,
  ANDROID_COMPILE_SDK_PACKAGE,
  ANDROID_PROVISION_ENTRY,
  ANDROID_PROVISION_GATE_ENTRY,
  ANDROID_SDK_PACKAGES,
  ANDROID_SDK_PACKAGE_LIST,
  decideProvisionGate,
  decideProvisionResult,
  describeProvisionPlan,
  describeProvisioningWiring,
  lintProvisioningWiring,
  readCompileSdk,
} from '../../scripts/release/android-sdk-provision.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RELEASE_DEV = '.github/workflows/release-dev.yml';
const VERSION = '0.0.1-dev.0';
const TAG = VERSION;
const TAG_SHA = '3f4d2c1b0a99887766554433221100ffeeddccbb';
const OTHER_SHA = '00112233445566778899aabbccddeeff00112233';
const STABLE_IDENTIFIER = 'app.shishi.todo';

function hex(name) {
  return createHash('sha256').update(name).digest('hex');
}

function builtManifest({
  version = VERSION,
  identifier = DEV_IDENTIFIER,
  channel = 'dev',
  tagSHA = TAG_SHA,
  tag = version,
} = {}) {
  const assets = expectedBuildAssets(version).map((name, index) => ({
    name,
    size: 1000 + index,
    sha256: hex(name),
  }));
  return {
    schemaVersion: 1,
    generator: {
      workflow: 'release-dev',
      workflowRef: 'owner/repo/.github/workflows/release-dev.yml@refs/tags/' + version,
      workflowSha: tagSHA,
      repository: 'owner/repo',
      runId: '1234',
      runAttempt: '1',
    },
    release: { version, artifactVersion: version, tag, channel },
    commit: { tagSHA, buildSHA: tagSHA },
    app: { appVersion: version, identifier },
    toolVersions: {
      rustc: ['rustc 1.96.0'],
      node: ['v24.16.0'],
      pnpm: ['10.34.3'],
      tauriCli: ['2.12.4'],
    },
    toolchainRecords: [],
    assets,
  };
}

/** The local artifact directory as the publish job sees it: contract + toolchain. */
function inventoryFor(manifest) {
  const files = manifest.assets.map((asset) => ({
    name: asset.name,
    path: asset.name,
    size: asset.size,
    sha256: asset.sha256,
  }));
  for (const name of [MANIFEST_NAME, SUMS_NAME, 'toolchain-web.json']) {
    files.push({ name, path: name, size: name === MANIFEST_NAME ? 4096 : 8192, sha256: hex(name) });
  }
  return files;
}

function builtRelease(overrides = {}) {
  const manifest = builtManifest(overrides);
  const inventory = inventoryFor(manifest);
  return { built: describeBuiltRelease({ manifest, inventory }), manifest, inventory };
}

function sumsTextFor(built) {
  return (
    built.assets
      .filter((asset) => asset.name !== SUMS_NAME)
      .map((asset) => asset.sha256 + '  ./' + asset.name)
      .join('\n') + '\n'
  );
}

/** A remote release fixture that is byte-identical to the given build. */
function remoteFor(
  built,
  { draft = false, digests = true, extras = true, targetCommitish = 'main' } = {},
) {
  const assets = built.assets.map((asset) => ({
    name: asset.name,
    size: asset.size,
    state: 'uploaded',
    ...(digests ? { digest: 'sha256:' + asset.sha256 } : {}),
  }));
  if (extras) {
    for (const name of built.extras) assets.push({ name, size: 8192, state: 'uploaded' });
  }
  return {
    tagRefSHA: TAG_SHA,
    release: {
      id: 4242,
      tag_name: built.tag,
      draft,
      prerelease: true,
      target_commitish: targetCommitish,
    },
    assets,
    manifest: built.manifest,
    sumsText: sumsTextFor(built),
  };
}

function absentRemote(overrides = {}) {
  return {
    tagRefSHA: TAG_SHA,
    release: null,
    assets: [],
    manifest: null,
    sumsText: null,
    ...overrides,
  };
}

function withAsset(remote, name, patch) {
  return {
    ...remote,
    assets: remote.assets.map((asset) => (asset.name === name ? { ...asset, ...patch } : asset)),
  };
}

function withoutAsset(remote, name) {
  return { ...remote, assets: remote.assets.filter((asset) => asset.name !== name) };
}

function assertNeverWritesExisting(decision) {
  assert.notEqual(
    decision.action,
    DECISION_CREATE_DRAFT,
    'an existing release is never re-created',
  );
  assert.ok(
    [DECISION_NOOP, DECISION_PUBLISH_DRAFT, DECISION_REFUSE].includes(decision.action),
    'unexpected action over an existing release: ' + decision.action,
  );
}

test('publish transaction: a new tag with a complete asset set is created as a draft', () => {
  const { built } = builtRelease();
  assert.equal(built.assets.length, expectedBuildAssets(VERSION).length + 2);
  assert.deepEqual(built.extras, ['toolchain-web.json']);
  const decision = decideExistingRelease({ built, remote: absentRemote() });
  assert.equal(decision.action, DECISION_CREATE_DRAFT);
  assert.deepEqual(decision.differences, []);
  assert.equal(decision.releaseId, null);
});

test('publish transaction: a tag that does not exist remotely is refused before any write', () => {
  const { built } = builtRelease();
  const decision = decideExistingRelease({ built, remote: absentRemote({ tagRefSHA: null }) });
  assert.equal(decision.action, DECISION_REFUSE);
  assert.match(decision.differences.join(' '), /does not exist remotely/);
});

test('publish transaction: a tag that moved away from TagCommitSHA is refused', () => {
  const { built } = builtRelease();
  const decision = decideExistingRelease({
    built,
    remote: absentRemote({ tagRefSHA: OTHER_SHA }),
  });
  assert.equal(decision.action, DECISION_REFUSE);
  assert.match(decision.differences.join(' '), /!= TagCommitSHA/);

  const withRelease = decideExistingRelease({
    built,
    remote: { ...remoteFor(built), tagRefSHA: OTHER_SHA },
  });
  assert.equal(withRelease.action, DECISION_REFUSE);
  assert.match(
    withRelease.differences.join(' '),
    /release target \(remote tag 0\.0\.1-dev\.0\) is /,
  );
});

test('publish transaction: a build whose version differs from the published one is refused', () => {
  const { built } = builtRelease();
  const remote = remoteFor(built);
  const decision = decideExistingRelease({
    built,
    remote: {
      ...remote,
      manifest: {
        ...remote.manifest,
        release: { ...remote.manifest.release, version: '0.0.2-dev.0' },
      },
    },
  });
  assert.equal(decision.action, DECISION_REFUSE);
  assert.match(decision.differences.join(' '), /records version 0\.0\.2-dev\.0/);
});

test('publish transaction: a stable/dev identity conflict in an existing release is immutable', () => {
  const { built } = builtRelease();
  const remote = remoteFor(built);
  const decision = decideExistingRelease({
    built,
    remote: {
      ...remote,
      manifest: {
        ...remote.manifest,
        app: { ...remote.manifest.app, identifier: STABLE_IDENTIFIER },
      },
    },
  });
  assert.equal(decision.action, DECISION_REFUSE);
  const report = decision.differences.join(' ');
  assert.match(report, /is immutable/);
  assert.match(report, new RegExp(STABLE_IDENTIFIER.replace(/\./g, '\\.')));
  assert.match(report, new RegExp(DEV_IDENTIFIER.replace(/\./g, '\\.')));
});

test('publish transaction: one missing platform artifact is refused by name', () => {
  const { built } = builtRelease();
  const missing = 'Shishi-' + VERSION + '-macos-arm64.dmg';
  const decision = decideExistingRelease({
    built,
    remote: withoutAsset(remoteFor(built), missing),
  });
  assert.equal(decision.action, DECISION_REFUSE);
  assert.match(
    decision.differences.join(' '),
    new RegExp('missing remote asset: ' + missing.replace(/\./g, '\\.')),
  );
});

test('publish transaction: a sha256 mismatch is refused with both digests', () => {
  const { built } = builtRelease();
  const name = 'Shishi_' + VERSION + '_x64-setup.exe';
  const decision = decideExistingRelease({
    built,
    remote: withAsset(remoteFor(built), name, { digest: 'sha256:' + hex('tampered') }),
  });
  assert.equal(decision.action, DECISION_REFUSE);
  const report = decision.differences.join(' ');
  assert.match(report, /sha256/);
  assert.match(report, new RegExp(hex('tampered')));
});

test('publish transaction: the same version with a different hash is refused, not overwritten', () => {
  const { built } = builtRelease();
  const remote = remoteFor(built);
  const first = remote.manifest.assets[0];
  const tampered = {
    ...remote,
    manifest: {
      ...remote.manifest,
      assets: [{ ...first, sha256: hex('other-build') }, ...remote.manifest.assets.slice(1)],
    },
  };
  const decision = decideExistingRelease({ built, remote: tampered });
  assert.equal(decision.action, DECISION_REFUSE);
  assert.match(decision.differences.join(' '), /manifest disagrees with this build/);
  assertNeverWritesExisting(decision);
});

test('publish transaction: an identical existing release is a no-op without any write', () => {
  const { built } = builtRelease();
  const decision = decideExistingRelease({ built, remote: remoteFor(built) });
  assert.equal(decision.action, DECISION_NOOP);
  assert.deepEqual(decision.differences, []);
  assert.equal(decision.releaseId, 4242);
});

test('publish transaction: hash records are found through the manifest and SHA256SUMS', () => {
  const { built } = builtRelease();
  const decision = decideExistingRelease({ built, remote: remoteFor(built, { digests: false }) });
  assert.equal(decision.action, DECISION_NOOP);
});

test('publish transaction: an upload without a digest and without a manifest record is refused', () => {
  const { built } = builtRelease();
  const name = 'shishi-web-' + VERSION + '.zip';
  const remote = remoteFor(built, { digests: false });
  const stripped = {
    ...remote,
    manifest: {
      ...remote.manifest,
      assets: remote.manifest.assets.map((asset) =>
        asset.name === name ? { name: asset.name, size: asset.size } : asset,
      ),
    },
    sumsText: null,
  };
  const decision = decideExistingRelease({ built, remote: stripped });
  assert.equal(decision.action, DECISION_REFUSE);
  assert.match(decision.differences.join(' '), /no sha256 is recorded for remote asset/);
});

test('publish transaction: two concurrent publishes never overwrite each other', () => {
  const { built } = builtRelease();
  const identical = remoteFor(built);
  const first = decideExistingRelease({ built, remote: identical });
  const second = decideExistingRelease({ built, remote: identical });
  assert.equal(first.action, DECISION_NOOP);
  assert.equal(second.action, DECISION_NOOP);
  assertNeverWritesExisting(second);

  const diverged = withAsset(identical, MANIFEST_NAME, { size: 12 });
  const third = decideExistingRelease({ built, remote: diverged });
  const fourth = decideExistingRelease({ built, remote: diverged });
  assert.equal(third.action, DECISION_REFUSE);
  assert.equal(fourth.action, DECISION_REFUSE);
  assertNeverWritesExisting(fourth);
});

test('publish transaction: a retry finishes a complete draft and refuses an incomplete one', () => {
  const { built } = builtRelease();
  const complete = decideExistingRelease({ built, remote: remoteFor(built, { draft: true }) });
  assert.equal(complete.action, DECISION_PUBLISH_DRAFT);
  assert.equal(complete.releaseId, 4242);

  const partial = decideExistingRelease({
    built,
    remote: withoutAsset(remoteFor(built, { draft: true }), SUMS_NAME),
  });
  assert.equal(partial.action, DECISION_REFUSE);
  assert.match(partial.differences.join(' '), /missing remote asset: SHA256SUMS\.txt/);
});

test('publish transaction: a partial upload keeps the release a draft', () => {
  const { built } = builtRelease();
  const partial = withoutAsset(
    remoteFor(built, { draft: true }),
    'Shishi-' + VERSION + '-android-x86_64-debug.aab',
  );
  const outcome = decidePublishOutcome({ built, remote: partial });
  assert.equal(outcome.action, OUTCOME_STAY_DRAFT);
  assert.match(outcome.failures.join(' '), /missing remote asset/);
  assert.equal(outcome.releaseId, 4242);

  const published = verifyPublishedRelease({ built, remote: partial });
  assert.equal(published.ok, false);
  assert.match(published.failures.join(' '), /still a draft/);

  const complete = decidePublishOutcome({ built, remote: remoteFor(built, { draft: true }) });
  assert.equal(complete.action, OUTCOME_PUBLISH);
  assert.deepEqual(complete.failures, []);
});

test('publish transaction: an already public release is never flipped a second time', () => {
  const { built } = builtRelease();
  const outcome = decidePublishOutcome({ built, remote: remoteFor(built, { draft: false }) });
  assert.equal(outcome.action, OUTCOME_STAY_DRAFT);
  assert.match(outcome.failures.join(' '), /is not a draft/);
});

test('publish transaction: the published release must target TagCommitSHA', () => {
  const { built } = builtRelease();
  const good = verifyPublishedRelease({ built, remote: remoteFor(built) });
  assert.equal(good.ok, true);
  assert.deepEqual(good.failures, []);

  const foreign = verifyPublishedRelease({
    built,
    remote: remoteFor(built, { targetCommitish: OTHER_SHA }),
  });
  assert.equal(foreign.ok, false);
  assert.match(foreign.failures.join(' '), /targets commit/);

  const branchLabel = verifyPublishedRelease({
    built,
    remote: remoteFor(built, { targetCommitish: 'main' }),
  });
  assert.equal(branchLabel.ok, true);

  const movedTag = verifyPublishedRelease({
    built,
    remote: { ...remoteFor(built), tagRefSHA: OTHER_SHA },
  });
  assert.equal(movedTag.ok, false);

  const wrongManifestCommit = verifyPublishedRelease({
    built,
    remote: {
      ...remoteFor(built),
      manifest: { ...built.manifest, commit: { tagSHA: OTHER_SHA, buildSHA: OTHER_SHA } },
    },
  });
  assert.equal(wrongManifestCommit.ok, false);
  assert.match(wrongManifestCommit.failures.join(' '), /records tag commit/);
});

test('publish transaction: a rerun of 0.0.1-dev.0 is refused because it was published as stable', () => {
  const historical = builtManifest({ identifier: STABLE_IDENTIFIER });
  const { built } = builtRelease();
  const remote = {
    tagRefSHA: TAG_SHA,
    release: {
      id: 17,
      tag_name: '0.0.1-dev.0',
      draft: false,
      prerelease: true,
      target_commitish: 'main',
    },
    assets: built.assets.map((asset) => ({
      name: asset.name,
      size: asset.size,
      state: 'uploaded',
    })),
    manifest: historical,
    sumsText: null,
  };
  const decision = decideExistingRelease({ built, remote });
  assert.equal(decision.action, DECISION_REFUSE);
  const report = decision.differences.join(' ');
  assert.match(report, /is immutable/);
  assert.match(report, /stable\/dev identity conflict/);
  assertNeverWritesExisting(decision);
});

test('publish transaction: extra toolchain assets are allowed, unknown assets are not', () => {
  const { built } = builtRelease();
  const asset = {
    name: 'shishi-web-' + VERSION + '.zip',
    size: 1000,
    sha256: hex('shishi-web-' + VERSION + '.zip'),
  };
  const allowed = verifyRemoteAssets({
    expected: [asset],
    remote: [
      { name: asset.name, size: asset.size, digest: 'sha256:' + asset.sha256, state: 'uploaded' },
      { name: 'toolchain-web.json', size: 8192, state: 'uploaded' },
    ],
    allowedExtras: ['toolchain-web.json'],
  });
  assert.equal(allowed.ok, true);
  assert.match(allowed.notes.join(' '), /extra asset carried by the release/);

  const unexpected = verifyRemoteAssets({
    expected: [asset],
    remote: [
      { name: asset.name, size: asset.size, digest: 'sha256:' + asset.sha256, state: 'uploaded' },
      { name: 'latest.json', size: 10, state: 'uploaded' },
    ],
    allowedExtras: ['toolchain-web.json'],
  });
  assert.equal(unexpected.ok, false);
  assert.match(unexpected.failures.join(' '), /unexpected remote asset: latest\.json/);

  const unfinished = verifyRemoteAssets({
    expected: [asset],
    remote: [
      { name: asset.name, size: asset.size, digest: 'sha256:' + asset.sha256, state: 'starter' },
    ],
  });
  assert.equal(unfinished.ok, false);
  assert.match(unfinished.failures.join(' '), /not finished uploading/);

  const sized = verifyRemoteAssets({
    expected: [asset],
    remote: [{ name: asset.name, size: asset.size + 1, digest: 'sha256:' + asset.sha256 }],
  });
  assert.equal(sized.ok, false);
  assert.match(sized.failures.join(' '), /bytes, the build produced/);
});

test('publish transaction: a dispatch from another commit is refused unless acknowledged', () => {
  const foreign = guardWorkflowProvenance({
    workflowSha: OTHER_SHA,
    workflowRef: 'owner/repo/.github/workflows/release-dev.yml@refs/heads/main',
    tagCommitSHA: TAG_SHA,
    releaseTag: TAG,
  });
  assert.equal(foreign.ok, false);
  assert.match(
    foreign.failures.join(' '),
    /refusing to publish workflow logic that does not belong to the tag commit/,
  );
  assert.equal(foreign.acknowledged, false);

  const acknowledged = guardWorkflowProvenance({
    workflowSha: OTHER_SHA,
    tagCommitSHA: TAG_SHA,
    releaseTag: TAG,
    allowForeignWorkflow: 'true',
  });
  assert.equal(acknowledged.ok, true);
  assert.equal(acknowledged.acknowledged, true);
  assert.match(acknowledged.notes.join(' '), /acknowledged by allow_foreign_workflow/);

  const sameCommit = guardWorkflowProvenance({
    workflowSha: TAG_SHA,
    tagCommitSHA: TAG_SHA,
    releaseTag: TAG,
    allowForeignWorkflow: 'false',
  });
  assert.equal(sameCommit.ok, true);
  assert.equal(sameCommit.acknowledged, false);

  const unknown = guardWorkflowProvenance({
    workflowSha: '',
    tagCommitSHA: TAG_SHA,
    releaseTag: TAG,
  });
  assert.equal(unknown.ok, false);
  assert.match(unknown.failures.join(' '), /github\.workflow_sha\) is empty/);
});

/* ---------------------------------------------------------------------------
 * Static assertions over the real workflow: the publish path must stay
 * transactional even when the YAML is edited by hand.
 * ------------------------------------------------------------------------- */

function workflowText(path) {
  // A Windows checkout has CRLF in the working tree; every assertion below is
  // about content, not about the line terminator git happens to check out.
  return readFileSync(join(REPO_ROOT, path), 'utf8').replace(/\r\n/g, '\n');
}

function jobBlock(text, jobId) {
  const lines = text.split(/\r?\n/);
  const start = lines.indexOf('  ' + jobId + ':');
  if (start === -1) return '';
  const block = [lines[start]];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^ {2}[A-Za-z0-9_-]+:\s*$/.test(line)) break;
    if (line !== '' && !/^\s/.test(line)) break;
    block.push(line);
  }
  return block.join('\n');
}

/** Every non-comment, non-empty line of a workflow file. */
function codeLines(text) {
  const lines = [];
  text.split(/\r?\n/).forEach((line, index) => {
    if (/^\s*#/.test(line)) return;
    if (line.trim() === '') return;
    lines.push({ number: index + 1, text: line });
  });
  return lines;
}

const WRITE_COMMAND =
  /(-X|--method)\s+(POST|PATCH|PUT|DELETE)|\bgh\s+release\s+(create|edit|upload|delete)|delete-asset/;

test('workflow transaction: the publish path never deletes or edits a release asset', () => {
  const text = workflowText(RELEASE_DEV);
  const offenders = codeLines(text).filter((entry) => WRITE_COMMAND.test(entry.text));
  assert.deepEqual(
    offenders.map((entry) => entry.number + ': ' + entry.text.trim()),
    [],
    'the publish path must not write to an existing release',
  );
  const documented = text.split(/\r?\n/).filter((line) => line.includes('delete-asset'));
  assert.ok(documented.length >= 1, 'the manual asset-removal procedure must be documented');
  for (const line of documented) {
    assert.match(
      line,
      /^\s*#/,
      'asset deletion may only appear in the manual maintenance comment: ' + line,
    );
  }
  assert.match(text, /^#.*gh release delete\b.*--cleanup-tag=false/m);
});

test('workflow transaction: nothing writes to GitHub before the draft release exists', () => {
  const block = jobBlock(workflowText(RELEASE_DEV), 'stage-release');
  const lines = block.split(/\r?\n/);
  const draftIndex = lines.findIndex((line) => line.includes('softprops/action-gh-release@'));
  assert.ok(draftIndex > 0, 'the publish job must create the release with the pinned action');
  const early = lines
    .slice(0, draftIndex)
    .filter((line) => !/^\s*#/.test(line) && WRITE_COMMAND.test(line));
  assert.deepEqual(early, [], 'no step may write to the release before the draft is created');
  assert.ok(
    lines.slice(0, draftIndex).some((line) => line.includes('check-existing')),
    'the existing release must be inspected before the draft is created',
  );
  const actionIndex = block.indexOf('softprops/action-gh-release@');
  const preGate = block.indexOf('--stage pre');
  const finalGate = block.indexOf('--stage final');
  assert.ok(preGate !== -1 && finalGate !== -1, 'both asset gates must survive');
  assert.ok(
    preGate < actionIndex && finalGate < actionIndex,
    'both gates must run before the write',
  );
  assert.ok(block.includes('assert-checkout'), 'the tag-SHA checkout assertion must survive');
});

test('workflow transaction: the release is a draft until verification flips it public', () => {
  const text = workflowText(RELEASE_DEV);
  const stage = jobBlock(text, 'stage-release');
  const publish = jobBlock(text, 'publish-release');
  assert.ok(stage, 'release-dev.yml must stage the release in its own job');
  assert.ok(publish, 'release-dev.yml must publish from its own job');
  const createIndex = stage.indexOf('softprops/action-gh-release@');
  const verifyDraft = stage.indexOf('verify-draft');
  assert.ok(createIndex !== -1, 'the staging job must create the release');
  assert.ok(stage.includes('draft: true'), 'the release must be created as a draft');
  assert.ok(!/draft:\s*false/.test(stage), 'the workflow must never create a release as public');
  assert.ok(createIndex < verifyDraft, 'the draft must exist before it is verified');
  assert.ok(!stage.includes('publish-draft'), 'staging must never publish the draft');
  const revalidate = publish.indexOf('verify-draft');
  const publishDraft = publish.indexOf('publish-draft');
  const verifyPublished = publish.lastIndexOf('verify-published');
  assert.ok(revalidate !== -1, 'the publish job must revalidate the draft after the approval');
  assert.ok(publishDraft !== -1, 'the publish job must flip the verified draft public');
  assert.ok(revalidate < publishDraft, 'the draft must be verified before it is published');
  assert.ok(
    publishDraft < verifyPublished,
    'the public release must be re-verified after the flip',
  );
  assert.ok(
    !publish.includes('softprops/action-gh-release@'),
    'only the staging job creates the release',
  );
  assert.ok(stage.includes("if: steps.existing.outputs.decision == 'create-draft'"));
  assert.ok(stage.includes("if: steps.existing.outputs.decision != 'noop'"));
  assert.ok(stage.includes('fail_on_unmatched_files: true'));
  assert.ok(stage.includes('prerelease: true'));
  assert.ok(stage.includes(MANIFEST_NAME), 'the manifest must be attached to the release');
});

test('workflow transaction: the publishing module only ever flips a draft public', () => {
  const module = readFileSync(join(REPO_ROOT, 'scripts/release/release-transaction.mjs'), 'utf8');
  assert.match(module, /'--method',\s*'PATCH'/);
  assert.match(module, /'draft=false'/);
  assert.match(module, /'prerelease=true'/);
  assert.ok(!/(-X|--method)'?,\s*'(DELETE|POST|PUT)'/.test(module), 'no other write method');
  const offenders = codeLines(module).filter((entry) =>
    /delete-asset|gh\s+release\s+delete/.test(entry.text),
  );
  assert.deepEqual(
    offenders.map((entry) => entry.number + ': ' + entry.text.trim()),
    [],
  );
});

test('workflow transaction: every action in the release path stays pinned to a 40-hex sha', () => {
  const text = workflowText(RELEASE_DEV);
  const refs = text
    .split(/\r?\n/)
    .map((line) => /^\s*-?\s*uses:\s*(\S+)/.exec(line))
    .filter((match) => match !== null)
    .map((match) => match[1]);
  assert.ok(refs.length >= 10, 'the release path must keep its pinned actions');
  for (const ref of refs) {
    assert.match(ref, /^[^\s@]+@[0-9a-f]{40}$/, 'unpinned action in the release path: ' + ref);
    assert.ok(!/@(v\d|stable|main|master|latest)/.test(ref), 'mutable action ref: ' + ref);
  }
  assert.equal(
    text.split('contents: write').length - 1,
    2,
    'contents: write belongs to the staging and the publishing job',
  );
  assert.ok(jobBlock(text, 'stage-release').includes('contents: write'));
  assert.ok(jobBlock(text, 'publish-release').includes('contents: write'));
  for (const job of ['context', 'web', 'windows', 'macos', 'android']) {
    assert.ok(!jobBlock(text, job).includes('contents: write'), job + ' must stay read-only');
  }
});

test('workflow transaction: publishing is not cancellable and serializes per version', () => {
  const text = workflowText(RELEASE_DEV);
  assert.ok(text.includes('cancel-in-progress: false'));
  assert.ok(
    !/cancel-in-progress:\s*true/.test(text),
    'a cancelled publish can leave a half release',
  );
  assert.ok(
    jobBlock(text, 'stage-release').includes('cancel-in-progress: false'),
    'staging must never be cancelled either',
  );
  const block = jobBlock(text, 'publish-release');
  assert.match(
    block,
    /concurrency:\n\s+group:.*needs\.stage-release\.outputs\.ReleaseVersion.*\n\s+cancel-in-progress: false/,
    'the publish job must serialize on the resolved version and never cancel',
  );
});

test('workflow transaction: a foreign workflow commit needs an explicit acknowledgement', () => {
  const text = workflowText(RELEASE_DEV);
  const stage = jobBlock(text, 'stage-release');
  const publish = jobBlock(text, 'publish-release');
  assert.match(text, /allow_foreign_workflow:\n\s+description:[\s\S]*?default: false/);
  assert.ok(stage.includes('allow_foreign_workflow'), 'the guard input must reach the staging job');
  assert.ok(
    publish.includes('allow_foreign_workflow'),
    'the post-approval guard must receive the same acknowledgement',
  );
  assert.ok(stage.includes('github.workflow_sha'), 'the manifest must record the workflow commit');
  assert.ok(stage.includes('github.workflow_ref'), 'the manifest must record the workflow ref');
  assert.ok(
    publish.includes('github.workflow_sha'),
    'the publish job must re-check the workflow commit',
  );
  const guardIndex = stage.indexOf('guard-workflow');
  const createIndex = stage.indexOf('softprops/action-gh-release@');
  assert.ok(guardIndex !== -1, 'the staging job must guard the workflow provenance');
  assert.ok(guardIndex < createIndex, 'the guard must run before the first write');
  const publishGuard = publish.indexOf('guard-workflow');
  const patchIndex = publish.indexOf('publish-draft');
  assert.ok(publishGuard !== -1, 'the publish job must re-guard the workflow provenance');
  assert.ok(publishGuard < patchIndex, 'the re-guard must run before the single write');
});

test('workflow transaction: the manifest records the workflow commit and ref', () => {
  const manifest = buildManifest({
    releaseVersion: VERSION,
    artifactVersion: VERSION,
    appVersion: VERSION,
    releaseTag: TAG,
    tagCommitSHA: TAG_SHA,
    buildCommitSHA: TAG_SHA,
    releaseChannel: 'dev',
    repository: 'owner/repo',
    workflowRef: 'owner/repo/.github/workflows/release-dev.yml@refs/heads/main',
    workflowSha: OTHER_SHA,
    runId: '1234',
    runAttempt: '2',
    assets: [{ name: 'a.zip', size: 12, sha256: hex('a.zip') }],
    toolchainRecords: [
      {
        platform: 'web',
        rustc: 'rustc 1.96.0',
        node: 'v24.16.0',
        pnpm: '10.34.3',
        tauriCli: '2.12.4',
      },
    ],
  });
  assert.equal(manifest.generator.workflowSha, OTHER_SHA);
  assert.equal(
    manifest.generator.workflowRef,
    'owner/repo/.github/workflows/release-dev.yml@refs/heads/main',
  );
  assert.equal(manifest.commit.tagSHA, TAG_SHA);
});

/* ---------------------------------------------------------------------------
 * RC2-D.15 Phase C: ONE Android SDK provisioning step, shared by the proven
 * smoke path and the release path, so the two workflows cannot drift again.
 * ------------------------------------------------------------------------- */

const ANDROID_SMOKE = '.github/workflows/android-smoke.yml';
const HISTORICAL_ANDROID_PACKAGES = 'platforms;android-35 build-tools;35.0.0 ndk;27.0.12077973';

test('android provisioning: one shared plan owns the package list and the compile SDK', () => {
  const plan = describeProvisionPlan();
  assert.deepEqual(plan.packages, [...ANDROID_SDK_PACKAGES]);
  assert.equal(
    ANDROID_SDK_PACKAGE_LIST,
    HISTORICAL_ANDROID_PACKAGES,
    'the pinned NDK/build-tools/platform list must not drift',
  );
  assert.equal(plan.compileSdk, ANDROID_COMPILE_SDK_PACKAGE);
  assert.equal(ANDROID_COMPILE_SDK, 37, 'tauri CLI 2.12.4 compiles against compileSdk 37');
  assert.deepEqual(
    plan.channels.map((channel) => channel.label),
    ['stable', 'preview'],
  );
  assert.deepEqual(plan.channels[1].args, ['--channel=3']);
  assert.equal(
    plan.checks.find((check) => check.package === 'ndk;27.0.12077973').dir,
    'ndk/27.0.12077973',
  );
});

test('android provisioning: a warning is never reported as a passing build', () => {
  const required = ANDROID_SDK_PACKAGES.map((pkg) => ({ package: pkg, present: true }));
  const ok = decideProvisionResult({ required, compileSdkInstalled: true });
  assert.equal(ok.status, 'ok');
  assert.equal(ok.degraded, false);

  const degraded = decideProvisionResult({
    required,
    compileSdkInstalled: false,
    channelsTried: ['stable', 'preview'],
  });
  assert.equal(degraded.status, 'degraded');
  assert.equal(degraded.degraded, true);
  assert.match(degraded.notes.join(' '), /never a passing build/);

  const failed = decideProvisionResult({
    required: [...required, { package: 'build-tools;99.0.0', present: false }],
    compileSdkInstalled: true,
  });
  assert.equal(failed.status, 'failed');
  assert.deepEqual(failed.missing, ['build-tools;99.0.0']);

  const step = decideProvisionGate({ status: 'ok', compileSdkPresent: true });
  assert.equal(step.ok, true);
  assert.equal(step.provisionedBy, 'shared-step');

  const autoDownloaded = decideProvisionGate({ status: 'degraded', compileSdkPresent: true });
  assert.equal(autoDownloaded.ok, true, 'the gate needs the platform, not a successful install');
  assert.equal(autoDownloaded.provisionedBy, 'agp-auto-download');
  assert.match(autoDownloaded.notes.join(' '), /warning stays recorded/);

  const warningOnly = decideProvisionGate({ status: 'degraded', compileSdkPresent: false });
  assert.equal(warningOnly.ok, false, 'a provisioning warning alone is never a PASS');
  assert.match(warningOnly.failures.join(' '), /never a passing build/);

  const wrongSdk = decideProvisionGate({
    status: 'ok',
    compileSdkPresent: true,
    gradleCompileSdk: 35,
  });
  assert.equal(wrongSdk.ok, false);
  assert.match(wrongSdk.failures.join(' '), /compiles against SDK 35/);
});

test('android provisioning: the generated Gradle compileSdk is read back', () => {
  assert.equal(readCompileSdk('android {\n    compileSdk = 37\n}'), 37);
  assert.equal(readCompileSdk('compileSdkVersion(36)'), 36);
  assert.equal(readCompileSdk('android { }'), null);
});

test('android provisioning: the release path and the smoke path cannot drift apart', () => {
  const workflows = [RELEASE_DEV, ANDROID_SMOKE].map((file) => ({
    path: file,
    text: workflowText(file),
  }));
  assert.deepEqual(
    lintProvisioningWiring(workflows),
    [],
    'both workflows must call the same provisioning entry point with the same package list',
  );
  const release = describeProvisioningWiring(workflows[0].text);
  const smoke = describeProvisioningWiring(workflows[1].text);
  assert.deepEqual(release.entries, [ANDROID_PROVISION_ENTRY]);
  assert.deepEqual(smoke.entries, [ANDROID_PROVISION_ENTRY]);
  assert.deepEqual(release.gates, [ANDROID_PROVISION_GATE_ENTRY]);
  assert.deepEqual(smoke.gates, [ANDROID_PROVISION_GATE_ENTRY]);
  assert.deepEqual(release.packageLists, [ANDROID_SDK_PACKAGE_LIST]);
  assert.deepEqual(smoke.packageLists, [ANDROID_SDK_PACKAGE_LIST]);
  assert.deepEqual(release.inline, [], 'no workflow may provision an SDK package inline');
  assert.deepEqual(smoke.inline, [], 'no workflow may provision an SDK package inline');
  assert.deepEqual(release.hardcoded, [], 'no workflow may hardcode the compile-SDK platform');
  assert.deepEqual(smoke.hardcoded, [], 'no workflow may hardcode the compile-SDK platform');
});

test('android provisioning: a drifted workflow is caught by the regression', () => {
  const drifted = workflowText(RELEASE_DEV)
    .replace(ANDROID_PROVISION_ENTRY, "sdkmanager --install 'platforms;android-37'")
    .replace(/packages: 'platforms;android-35[^']*'/, "packages: 'platforms;android-36'");
  const problems = lintProvisioningWiring([{ path: 'drifted.yml', text: drifted }]);
  assert.ok(problems.some((line) => line.includes('does not call the shared provisioning entry')));
  assert.ok(problems.some((line) => line.includes('provisions the SDK inline')));
  assert.ok(problems.some((line) => line.includes('passes the setup-android package list')));
});

/* ---------------------------------------------------------------------------
 * RC2-D.15 Phase D: the environment approval and the post-approval
 * revalidation. Every case is a fixture; nothing here touches the network.
 * ------------------------------------------------------------------------- */

test('environment gate: an unreadable environment is never release-ready', () => {
  for (const status of [403, 404, null]) {
    const decision = decideEnvironmentGate({
      inspection: { ok: false, status, protectionRules: [] },
    });
    assert.equal(decision.gate, GATE_UNVERIFIED);
    assert.equal(decision.enforced, false);
    assert.equal(decision.releaseReady, false);
    assert.deepEqual(decision.failures, []);
    assert.match(decision.notes.join(' '), /repository setting/);
    assert.match(decision.notes.join(' '), /does not treat the pipeline as release-ready/);
  }
  assert.equal(
    decideEnvironmentGate({}).gate,
    GATE_UNVERIFIED,
    'a missing inspection is unverified, not enforced',
  );
});

test('environment gate: an environment without required reviewers does not gate publishing', () => {
  const noRule = decideEnvironmentGate({
    inspection: { ok: true, status: 200, protectionRules: [{ type: 'wait_timer' }] },
  });
  assert.equal(noRule.gate, GATE_NOT_CONFIGURED);
  assert.equal(noRule.enforced, false);
  assert.equal(noRule.releaseReady, false);
  assert.match(noRule.notes.join(' '), /no required_reviewers rule/);

  const emptyRule = decideEnvironmentGate({
    inspection: {
      ok: true,
      status: 200,
      protectionRules: [{ type: 'required_reviewers', reviewers: [] }],
    },
  });
  assert.equal(emptyRule.gate, GATE_NOT_CONFIGURED);
  assert.equal(emptyRule.enforced, false);

  const noRules = decideEnvironmentGate({ inspection: { ok: true, status: 200 } });
  assert.equal(noRules.gate, GATE_NOT_CONFIGURED);
});

test('environment gate: required reviewers are enforced but still never readiness', () => {
  const decision = decideEnvironmentGate({
    inspection: {
      ok: true,
      status: 200,
      protectionRules: [{ type: 'required_reviewers', reviewers: [{ reviewer: { login: 'a' } }] }],
    },
  });
  assert.equal(decision.gate, GATE_ENFORCED);
  assert.equal(decision.enforced, true);
  assert.equal(decision.releaseReady, false, 'an approval is not a release-readiness claim');
  assert.equal(decision.environmentName, 'dev-pre-release');
  assert.match(decision.notes.join(' '), /blocked this job until one approved it/);
});

test('approval workflow: a pending approval leaves the draft staged', () => {
  const pending = describePipelineOutcome({
    stage: { decision: DECISION_CREATE_DRAFT },
    publish: null,
  });
  assert.equal(pending.action, PIPELINE_AWAITING_APPROVAL);
  assert.equal(pending.draftVisible, true);
  assert.equal(pending.releaseReady, false);
  assert.match(pending.notes.join(' '), /waits for the required reviewers/);
});

test('approval workflow: a rejected approval publishes nothing', () => {
  const rejected = describePipelineOutcome({
    stage: { decision: DECISION_PUBLISH_DRAFT },
    publish: { outcome: 'rejected' },
  });
  assert.equal(rejected.action, PIPELINE_NOT_APPROVED);
  assert.equal(rejected.draftVisible, true);
  assert.equal(rejected.releaseReady, false);
});

test('approval workflow: an interrupted staging leaves a draft that stays a draft', () => {
  const { built } = builtRelease();
  const interrupted = describePipelineOutcome({
    stage: { decision: DECISION_REFUSE, ok: false, failures: ['a partial draft exists'] },
  });
  assert.equal(interrupted.action, PIPELINE_FAILED);
  assert.equal(interrupted.draftVisible, true);
  assert.deepEqual(interrupted.failures, ['a partial draft exists']);
  const partial = withoutAsset(remoteFor(built, { draft: true }), built.assets[0].name);
  assert.equal(decideExistingRelease({ built, remote: partial }).action, DECISION_REFUSE);
});

test('approval workflow: a publish retry finishes a complete draft and refuses a changed one', () => {
  const { built } = builtRelease();
  const retry = decidePublishOutcome({ built, remote: remoteFor(built, { draft: true }) });
  assert.equal(retry.action, OUTCOME_PUBLISH);

  const changed = decidePublishOutcome({
    built,
    remote: withAsset(remoteFor(built, { draft: true }), built.assets[1].name, { size: 999999 }),
  });
  assert.equal(changed.action, OUTCOME_STAY_DRAFT);
  assert.match(changed.failures.join(' '), /is 999999 bytes/);

  const gone = decidePublishOutcome({ built, remote: absentRemote() });
  assert.equal(gone.action, OUTCOME_STAY_DRAFT);
  assert.match(gone.failures.join(' '), /disappeared/);
});

test('approval workflow: a tag that moved after the approval is refused', () => {
  const { built } = builtRelease();
  const moved = decidePublishOutcome({
    built,
    remote: { ...remoteFor(built, { draft: true }), tagRefSHA: OTHER_SHA },
  });
  assert.equal(moved.action, OUTCOME_STAY_DRAFT);
  assert.match(moved.failures.join(' '), /!= TagCommitSHA/);
});

test('approval workflow: the post-approval workflow guard still refuses a foreign commit', () => {
  const verdict = guardWorkflowProvenance({
    workflowSha: OTHER_SHA,
    tagCommitSHA: TAG_SHA,
    releaseTag: TAG,
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.failures.join(' '), /allow_foreign_workflow=true/);
});

test('approval workflow: a duplicate run for a published version writes nothing', () => {
  const { built } = builtRelease();
  const remote = remoteFor(built, { draft: false });
  assert.equal(decideExistingRelease({ built, remote }).action, DECISION_NOOP);
  assert.equal(verifyPublishedRelease({ built, remote }).ok, true);
  const outcome = describePipelineOutcome({
    stage: { decision: DECISION_NOOP },
    publish: { outcome: 'noop' },
  });
  assert.equal(outcome.action, PIPELINE_ALREADY_PUBLISHED);
  assert.equal(outcome.draftVisible, false);
  const second = decidePublishOutcome({ built, remote });
  assert.equal(second.action, OUTCOME_STAY_DRAFT, 'a public release is never flipped again');
  assert.match(second.failures.join(' '), /not a draft/);
});

test('publish revalidation: the staged manifest must describe the re-downloaded artifacts', () => {
  const { built, manifest, inventory } = builtRelease();
  const adopted = adoptStagedRelease({
    stagedManifest: manifest,
    inventory,
    expected: { tag: built.tag, version: built.version, tagCommitSHA: TAG_SHA },
  });
  assert.equal(adopted.ok, true, adopted.failures.join(' | '));

  const tampered = inventory.map((file) =>
    file.name === built.assets[0].name ? { ...file, size: file.size + 1 } : file,
  );
  const changed = adoptStagedRelease({ stagedManifest: manifest, inventory: tampered });
  assert.equal(changed.ok, false);
  assert.match(changed.failures.join(' '), /bytes but the staged manifest records/);

  const missing = adoptStagedRelease({
    stagedManifest: manifest,
    inventory: inventory.filter((file) => file.name !== built.assets[2].name),
  });
  assert.equal(missing.ok, false);
  assert.match(missing.failures.join(' '), /carry no /);
});

test('publish revalidation: a staged identity from another tag is refused', () => {
  const { manifest, inventory } = builtRelease();
  const other = adoptStagedRelease({
    stagedManifest: manifest,
    inventory,
    expected: { tag: '0.0.1-dev.9', tagCommitSHA: OTHER_SHA },
  });
  assert.equal(other.ok, false);
  assert.match(other.failures.join(' '), /records tag/);
  assert.match(other.failures.join(' '), /records tagCommitSHA/);

  const absent = adoptStagedRelease({});
  assert.equal(absent.ok, false);
  assert.match(absent.failures.join(' '), /missing from the staged release evidence/);
});

test('release evidence: a failed run says the draft stays a draft and claims no readiness', () => {
  const evidence = buildReleaseEvidence({
    phase: EVIDENCE_PHASE_PUBLISH,
    context: {
      releaseVersion: VERSION,
      releaseTag: TAG,
      tagCommitSHA: TAG_SHA,
      artifactVersion: VERSION,
    },
    jobStatus: 'failure',
    decision: DECISION_PUBLISH_DRAFT,
    outcome: 'failed',
    environment: { name: ENVIRONMENT_NAME, gate: GATE_ENFORCED, enforced: true },
    manifestSha256: hex('manifest'),
    failures: ['a remote draft asset changed after the approval'],
  });
  assert.equal(evidence.releaseReadiness.claimed, false);
  assert.equal(evidence.releaseReadiness.statement, RELEASE_READINESS_STATEMENT);
  assert.equal(evidence.draftRemainsVisible, true);
  assert.equal(evidence.pipeline.action, PIPELINE_FAILED);
  const markdown = renderReleaseEvidence(evidence).join('\n');
  assert.match(markdown, /leaves the release as a DRAFT/);
  assert.match(markdown, /gate=enforced/);
  assert.match(markdown, /Release readiness: \*\*not claimed\*\*/);
  assert.match(markdown, /a remote draft asset changed after the approval/);
  assert.ok(!/production-ready/i.test(markdown));

  const published = buildReleaseEvidence({
    phase: EVIDENCE_PHASE_PUBLISH,
    decision: DECISION_PUBLISH_DRAFT,
    jobStatus: 'success',
    outcome: 'published',
    environment: { name: ENVIRONMENT_NAME, gate: GATE_ENFORCED, enforced: true },
  });
  assert.equal(published.draftRemainsVisible, false);
  assert.equal(published.pipeline.action, PIPELINE_PUBLISHED);
  assert.doesNotMatch(renderReleaseEvidence(published).join('\n'), /leaves the release as a DRAFT/);
});

test('release evidence: a staged run records the environment as unverified', () => {
  const stage = buildReleaseEvidence({
    phase: EVIDENCE_PHASE_STAGE,
    decision: DECISION_CREATE_DRAFT,
    jobStatus: 'success',
  });
  assert.equal(stage.environment.gate, GATE_UNVERIFIED);
  assert.equal(stage.environment.enforced, false);
  assert.equal(stage.draftRemainsVisible, true);
  assert.equal(stage.pipeline.action, PIPELINE_AWAITING_APPROVAL);
  assert.throws(() => buildReleaseEvidence({ phase: 'nope' }), /evidence phase/);
});

test('workflow transaction: the publish job records the environment gate instead of assuming it', () => {
  const text = workflowText(RELEASE_DEV);
  const stage = jobBlock(text, 'stage-release');
  const publish = jobBlock(text, 'publish-release');
  assert.match(publish, /environment: dev-pre-release/, 'the gate must be declared');
  assert.ok(publish.includes('environment-gate'), 'the publish job must inspect the gate');
  assert.ok(publish.includes('RELEASE_ENVIRONMENT_GATE'), 'the gate result must reach the evidence');
  assert.ok(
    publish.includes('RELEASE_ENVIRONMENT_ENFORCED'),
    'the enforced flag must reach the evidence',
  );
  assert.ok(publish.includes('write-evidence --phase publish'));
  assert.ok(stage.includes('write-evidence --phase stage'));
  assert.ok(stage.includes('name: stage-evidence'), 'staging must upload its evidence');
  assert.ok(publish.includes('name: stage-evidence'), 'publishing must consume the staged evidence');
  assert.ok(publish.includes('--staged-dir staged'));
  assert.ok(publish.includes('--expect-release-id'), 'the write must pin the staged release id');
  assert.match(
    publish,
    /name: Revalidate the draft against the remote release[\s\S]*?publish-draft/,
    'the draft must be revalidated after the approval and before the write',
  );
  assert.ok(
    !/productions?-ready|GOOD TO SHIP|release ready/i.test(stage + publish),
    'no job may claim release readiness',
  );
});
