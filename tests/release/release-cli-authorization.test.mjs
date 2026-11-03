/**
 * Command-line authorization contract for `publish-dev.yml`.
 *
 * The pure decision tests prove the rules; these run the actual command in a
 * child process with a real environment, so they also prove the argv/env
 * plumbing: a variable the workflow forgets to pass is missing here too.
 *
 * Nothing here writes to GitHub. `authorize-publish` only reads its environment
 * and prints a summary, and every case below stops before any network call.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'release', 'release-transaction.mjs');

const TAG = '0.0.1-dev.1';
const SHA = '3f4d2c1b0a99887766554433221100ffeeddccbb';
const OTHER_SHA = '00112233445566778899aabbccddeeff00112233';

/** The environment the publish job would pass after a real approval. */
function authorizedEnv(overrides = {}) {
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_WORKFLOW_SHA: SHA,
    RELEASE_TAG: TAG,
    TAG_COMMIT_SHA: SHA,
    RELEASE_ENVIRONMENT_GATE: 'enforced',
    INPUT_PUBLISH: 'true',
    INPUT_CONFIRM: 'publish ' + TAG,
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

function run(command, env) {
  const result = spawnSync(process.execPath, [SCRIPT, command], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env,
  });
  assert.equal(result.error, undefined, 'the command could not start: ' + result.error?.message);
  return {
    status: result.status,
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
    output: String(result.stdout ?? '') + String(result.stderr ?? ''),
  };
}

test('release CLI: a complete authorization context exits 0', () => {
  const reply = run('authorize-publish', authorizedEnv());
  assert.equal(reply.status, 0, reply.output);
  assert.match(reply.output, /OK publishing is authorized/);
  assert.match(reply.output, /environment gate enforced/);
});

test('release CLI: a missing GITHUB_WORKFLOW_SHA exits non-zero and writes nothing', () => {
  const reply = run('authorize-publish', authorizedEnv({ GITHUB_WORKFLOW_SHA: undefined }));
  assert.notEqual(reply.status, 0, 'authorization must fail without the workflow commit');
  assert.match(reply.output, /the workflow commit is unknown/);
  assert.match(reply.output, /refusing to publish/);
  assert.match(reply.output, /nothing was written/);
});

test('release CLI: a malformed GITHUB_WORKFLOW_SHA is rejected, not trimmed into a value', () => {
  for (const value of ['', '   ', 'main', 'abc123', SHA.slice(0, 39), SHA + 'A']) {
    const reply = run('authorize-publish', authorizedEnv({ GITHUB_WORKFLOW_SHA: value }));
    assert.notEqual(reply.status, 0, JSON.stringify(value) + ' must not authorize');
    assert.match(reply.output, /the workflow commit is unknown/);
  }
});

test('release CLI: an unproven environment gate exits non-zero', () => {
  for (const gate of ['unverified', 'not-configured', '', 'enforced ']) {
    const reply = run('authorize-publish', authorizedEnv({ RELEASE_ENVIRONMENT_GATE: gate }));
    assert.notEqual(reply.status, 0, JSON.stringify(gate) + ' must not authorize');
    assert.match(reply.output, /environment gate is/);
  }
});

test('release CLI: a wrong tag commit or unmatched phrase exits non-zero', () => {
  const wrongTag = run('authorize-publish', authorizedEnv({ TAG_COMMIT_SHA: 'main' }));
  assert.notEqual(wrongTag.status, 0);
  assert.match(wrongTag.output, /TagCommitSHA is not a 40-hex commit/);

  const wrongPhrase = run(
    'authorize-publish',
    authorizedEnv({ INPUT_CONFIRM: 'publish 0.0.1-dev.2' }),
  );
  assert.notEqual(wrongPhrase.status, 0);
  assert.match(wrongPhrase.output, /confirmation phrase does not match/);

  // A different valid commit is still a mismatch: the phrase names the tag, and
  // the tag must be the one whose commit the run was resolved from.
  const otherCommit = run('authorize-publish', authorizedEnv({ TAG_COMMIT_SHA: OTHER_SHA }));
  assert.equal(
    otherCommit.status,
    0,
    'a well-formed commit is authorized; the tag check lives in guard-workflow',
  );
});

test('release CLI: a non-dispatch event exits non-zero even with every other fact', () => {
  for (const event of ['push', 'schedule', '']) {
    const reply = run('authorize-publish', authorizedEnv({ GITHUB_EVENT_NAME: event }));
    assert.notEqual(reply.status, 0, JSON.stringify(event) + ' must not authorize');
    assert.match(reply.output, /only a manual workflow_dispatch may publish/);
  }
});

test('release CLI: publish must be requested explicitly', () => {
  for (const value of [undefined, '', 'false', '0', 'no']) {
    const reply = run('authorize-publish', authorizedEnv({ INPUT_PUBLISH: value }));
    assert.notEqual(reply.status, 0, JSON.stringify(value) + ' must not authorize');
    assert.match(reply.output, /publish input is not set/);
  }
});

test('release CLI: publish-draft refuses an unauthorized run before touching the network', () => {
  // No artifact directory is supplied on purpose: the authorization check runs
  // first, so the refusal proves nothing reached GitHub. Every one of these is a
  // distinct way the publish job could lose its authorization context, and each
  // must stop the write itself - not only the read-only authorize step.
  const cases = {
    'missing workflow SHA': { GITHUB_WORKFLOW_SHA: undefined },
    'malformed workflow SHA': { GITHUB_WORKFLOW_SHA: 'main' },
    'empty workflow SHA': { GITHUB_WORKFLOW_SHA: '   ' },
    'unproven environment': { RELEASE_ENVIRONMENT_GATE: 'unverified' },
    'environment 403-style state': { RELEASE_ENVIRONMENT_GATE: 'not-configured' },
    'wrong tag commit': { TAG_COMMIT_SHA: 'not-a-commit' },
    'unmatched phrase': { INPUT_CONFIRM: 'publish 0.0.1-dev.2' },
    'non-dispatch event': { GITHUB_EVENT_NAME: 'push' },
    'publish not requested': { INPUT_PUBLISH: 'false' },
  };
  for (const [name, overrides] of Object.entries(cases)) {
    const reply = run('publish-draft', authorizedEnv(overrides));
    assert.notEqual(reply.status, 0, name + ' must not reach the write');
    assert.match(reply.output, /refusing to publish/, name + ': ' + reply.output);
    assert.match(reply.output, /nothing was written/, name + ': ' + reply.output);
    assert.ok(
      !/gh api|HTTP \d{3}/.test(reply.output),
      name + ' must fail before any GitHub call: ' + reply.output,
    );
  }
});

test('release CLI: guard-workflow refuses a missing or foreign workflow commit', () => {
  // The post-approval guard reads the same GITHUB_WORKFLOW_SHA the authorization
  // steps do. Losing it there is equally fatal: an unprovable provenance must
  // stop the run, not silently pass.
  const guardEnv = (overrides = {}) =>
    authorizedEnv({
      INPUT_ALLOW_FOREIGN: 'false',
      GITHUB_WORKFLOW_REF: 'baicie/todo/.github/workflows/publish-dev.yml@refs/heads/main',
      ...overrides,
    });

  const ok = run('guard-workflow', guardEnv());
  assert.equal(ok.status, 0, ok.output);

  for (const value of [undefined, '', 'main', SHA.slice(0, 39)]) {
    const reply = run('guard-workflow', guardEnv({ GITHUB_WORKFLOW_SHA: value }));
    assert.notEqual(reply.status, 0, JSON.stringify(value) + ' must not satisfy the guard');
    assert.match(reply.output, /workflow commit|empty/i);
  }

  // A different, well-formed commit is refused unless it was acknowledged.
  const foreign = run('guard-workflow', guardEnv({ GITHUB_WORKFLOW_SHA: OTHER_SHA }));
  assert.notEqual(foreign.status, 0);
  assert.match(foreign.output, /does not belong to the tag commit/);
  const acknowledged = run(
    'guard-workflow',
    guardEnv({ GITHUB_WORKFLOW_SHA: OTHER_SHA, INPUT_ALLOW_FOREIGN: 'true' }),
  );
  assert.equal(acknowledged.status, 0, acknowledged.output);
});
