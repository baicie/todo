/**
 * Machine-checkable contract tests for the dev pre-release pipeline
 * (RC2-D.11 Phase E). Run with: node --test tests/release/
 *
 * Three layers:
 *   1. pure resolution/validation/naming units of scripts/release/release-context.mjs;
 *   2. a build contract over the three real tauri config files, so the script's
 *      config model cannot drift away from tauri's own RFC 7396 merge again;
 *   3. static assertions over the release workflow text, so a mutable action ref
 *      or a second, independent version source cannot sneak back in unnoticed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ANDROID_TARGETS,
  DEV_IDENTIFIER,
  EXPRESSION_OPEN,
  MACOS_ARCHES,
  RELEASE_WORKFLOW_PATHS,
  ReleaseContextError,
  SUMS_NAME,
  MANIFEST_NAME,
  applyMergePatch,
  assertDevConfig,
  buildManifest,
  describeTag,
  detectChannel,
  expectedBuildAssets,
  expectedReleaseAssets,
  formatArtifactName,
  lintReleaseWorkflows,
  lintWorkflowExpressions,
  mergeTauriConfig,
  normalizeVersion,
  parseSha256Sums,
  resolveAppConfig,
  resolveReleaseContext,
  resolveVersionValue,
  verifyReleaseAssets,
} from '../../scripts/release/release-context.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RELEASE_WORKFLOWS = [
  '.github/workflows/release-dev.yml',
  '.github/workflows/release-acceptance.yml',
  '.github/workflows/release-desktop.yml',
  '.github/workflows/release-web.yml',
];
const VERSION = '0.0.1-dev.0';
const TAG_SHA = '3f4d2c1b0a99887766554433221100ffeeddccbb';
const OTHER_SHA = '00112233445566778899aabbccddeeff00112233';

function workflowText(path) {
  return readFileSync(join(REPO_ROOT, path), 'utf8');
}

function jobBlock(text, jobId) {
  const lines = text.split(/\r?\n/);
  const start = lines.indexOf('  ' + jobId + ':');
  if (start === -1) return null;
  const block = [lines[start]];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^ {2}[A-Za-z0-9_-]+:\s*$/.test(line)) break;
    if (line !== '' && !/^\s/.test(line)) break;
    block.push(line);
  }
  return block.join('\n');
}

function actionRefs(text) {
  const refs = [];
  text.split(/\r?\n/).forEach((line, index) => {
    const match = /^\s*-?\s*uses:\s*(\S+)/.exec(line);
    if (match) refs.push({ ref: match[1], line: index + 1 });
  });
  return refs;
}

function isPinnedRef(ref) {
  return /^[^\s@]+@[0-9a-f]{40}$/.test(ref);
}

function baseContext(overrides = {}) {
  return {
    eventName: 'push',
    refType: 'tag',
    refName: VERSION,
    inputVersion: '',
    tagCommitSHA: TAG_SHA,
    appVersion: VERSION,
    ...overrides,
  };
}

test('release context: a valid dev tag is accepted and exposes the seven outputs', () => {
  const context = resolveReleaseContext(baseContext());
  assert.deepEqual(context, {
    ReleaseVersion: VERSION,
    ReleaseTag: VERSION,
    TagCommitSHA: TAG_SHA,
    BuildCommitSHA: TAG_SHA,
    AppVersion: VERSION,
    ArtifactVersion: VERSION,
    ReleaseChannel: 'dev',
  });
});

test('release context: a tag with a leading v keeps the tag and normalizes the version', () => {
  const context = resolveReleaseContext(
    baseContext({ refName: 'v0.0.2-dev.1', appVersion: '0.0.2-dev.1' }),
  );
  assert.equal(context.ReleaseTag, 'v0.0.2-dev.1');
  assert.equal(context.ReleaseVersion, '0.0.2-dev.1');
});

test('release context: a non-dev tag is rejected', () => {
  assert.throws(
    () => resolveReleaseContext(baseContext({ refName: 'v1.2.3', appVersion: '1.2.3' })),
    /release channel release refused/,
  );
  assert.throws(
    () => resolveReleaseContext(baseContext({ refName: '1.2.3-rc.1', appVersion: '1.2.3-rc.1' })),
    /release channel release refused/,
  );
});

test('release context: a missing tag is rejected before anything is built', () => {
  assert.throws(
    () => resolveReleaseContext(baseContext({ tagCommitSHA: null })),
    /does not exist \(no commit SHA resolved\)/,
  );
  assert.throws(
    () => resolveReleaseContext(baseContext({ tagCommitSHA: '0.0.1-dev.0' })),
    /does not exist \(no commit SHA resolved\)/,
  );
});

test('release context: a non-tag push ref is rejected', () => {
  assert.throws(
    () => resolveReleaseContext(baseContext({ refType: 'branch', refName: 'main' })),
    /tag pushes only/,
  );
});

test('release context: an app version mismatch is rejected', () => {
  assert.throws(
    () => resolveReleaseContext(baseContext({ appVersion: '0.0.2-dev.0' })),
    /app version 0\.0\.2-dev\.0 != release version 0\.0\.1-dev\.0/,
  );
  assert.throws(() => resolveReleaseContext(baseContext({ appVersion: '' })), /app version/);
});

test('release context: an artifact version mismatch is rejected', () => {
  assert.throws(
    () => resolveReleaseContext(baseContext({ artifactVersion: '0.0.1-dev.1' })),
    /artifact version 0\.0\.1-dev\.1 != release version 0\.0\.1-dev\.0/,
  );
});

test('release context: a build commit that is not the tag commit is rejected', () => {
  assert.throws(
    () => resolveReleaseContext(baseContext({ buildCommitSHA: OTHER_SHA })),
    /build commit .* != tag commit .*: artifacts must be built from the tag commit/,
  );
});

test('release context: a manual dispatch needs the version input', () => {
  assert.throws(
    () =>
      resolveReleaseContext(
        baseContext({ eventName: 'workflow_dispatch', refType: 'branch', refName: 'main' }),
      ),
    /requires the "version" input/,
  );
});

test('release context: a manual dispatch from a floating branch builds the tag commit', () => {
  const context = resolveReleaseContext(
    baseContext({
      eventName: 'workflow_dispatch',
      refType: 'branch',
      refName: 'main',
      inputVersion: VERSION,
    }),
  );
  assert.equal(context.BuildCommitSHA, TAG_SHA);
  assert.equal(context.TagCommitSHA, TAG_SHA);
  assert.equal(context.ReleaseVersion, VERSION);
});

test('release context: an unsupported trigger is rejected', () => {
  assert.throws(
    () => resolveReleaseContext(baseContext({ eventName: 'pull_request' })),
    /unsupported trigger/,
  );
});

test('version normalization: strips one leading v, preserves the suffix, is idempotent', () => {
  const samples = [
    '0.0.1-dev.0',
    'v0.0.1-dev.0',
    'V0.0.1-dev.0',
    '1.0.0-dev.12',
    ' 2.3.4 ',
    '1.0.0-dev.3+build.7',
  ];
  for (const sample of samples) {
    const once = normalizeVersion(sample);
    assert.equal(normalizeVersion(once), once, 'normalization must be idempotent for ' + sample);
    assert.equal(normalizeVersion(sample), once, 'normalization must be deterministic');
    assert.ok(!once.startsWith('v') && !once.startsWith('V'), 'leading v must be stripped');
  }
  assert.equal(normalizeVersion('V0.0.1-dev.0'), '0.0.1-dev.0');
  assert.equal(normalizeVersion('1.0.0-dev.3+build.7'), '1.0.0-dev.3+build.7');
});

test('version normalization: rejects branch names, ranges and paths', () => {
  const bad = [
    '',
    '  ',
    'main',
    'v',
    'V',
    '1.0',
    '1',
    'latest',
    '1.0.0-dev.0/../x',
    'vv1.0.0',
    '1.0.0-',
    'refs/tags/1.0.0',
  ];
  for (const sample of bad) {
    assert.throws(() => normalizeVersion(sample), ReleaseContextError, 'must reject ' + sample);
  }
  assert.throws(() => normalizeVersion(undefined), ReleaseContextError);
});

test('version normalization: channel detection follows the -dev. rule', () => {
  assert.equal(detectChannel('0.0.1-dev.0'), 'dev');
  assert.equal(detectChannel('v0.0.1-dev.0'), 'dev');
  assert.equal(detectChannel('1.0.0'), 'release');
  assert.equal(detectChannel('1.0.0-rc.1'), 'release');
  assert.deepEqual(describeTag('v1.2.3-dev.4'), {
    tag: 'v1.2.3-dev.4',
    version: '1.2.3-dev.4',
    channel: 'dev',
  });
});

test('artifact names: match the published 0.0.1-dev.0 scheme', () => {
  assert.equal(formatArtifactName('web-zip', VERSION), 'shishi-web-0.0.1-dev.0.zip');
  assert.equal(formatArtifactName('web-sha256', VERSION), 'shishi-web-sha256.txt');
  assert.equal(formatArtifactName('windows-nsis', VERSION), 'Shishi_0.0.1-dev.0_x64-setup.exe');
  assert.equal(
    formatArtifactName('macos-dmg', VERSION, { arch: 'arm64' }),
    'Shishi-0.0.1-dev.0-macos-arm64.dmg',
  );
  assert.equal(
    formatArtifactName('macos-dmg', VERSION, { arch: 'x64' }),
    'Shishi-0.0.1-dev.0-macos-x64.dmg',
  );
  assert.equal(
    formatArtifactName('android-apk', VERSION, { abi: 'arm' }),
    'Shishi-0.0.1-dev.0-android-arm-debug.apk',
  );
  assert.equal(
    formatArtifactName('android-aab', VERSION, { abi: 'x86_64' }),
    'Shishi-0.0.1-dev.0-android-x86_64-debug.aab',
  );
  assert.equal(formatArtifactName('sha256sums', VERSION), SUMS_NAME);
  assert.equal(formatArtifactName('manifest', VERSION), MANIFEST_NAME);
});

test('artifact names: every name derives from the artifact version alone', () => {
  const version = '9.9.9-dev.42';
  const unversioned = ['shishi-web-sha256.txt'];
  const versioned = expectedBuildAssets(version).filter((name) => !unversioned.includes(name));
  assert.equal(versioned.length, 14);
  for (const name of versioned) {
    assert.ok(name.includes(version), name + ' must carry the artifact version');
  }
  assert.deepEqual(expectedBuildAssets(VERSION).slice(0, 3), [
    'shishi-web-0.0.1-dev.0.zip',
    'shishi-web-sha256.txt',
    'Shishi_0.0.1-dev.0_x64-setup.exe',
  ]);
  assert.equal(
    expectedBuildAssets(VERSION).length,
    3 + MACOS_ARCHES.length * 2 + ANDROID_TARGETS.length * 2,
  );
  assert.equal(expectedReleaseAssets(VERSION).length, expectedBuildAssets(VERSION).length + 2);
});

test('artifact names: unknown kinds, arches and abis are rejected', () => {
  assert.throws(() => formatArtifactName('nope', VERSION), /unknown artifact kind/);
  assert.throws(
    () => formatArtifactName('macos-dmg', VERSION, { arch: 'x86' }),
    /unknown macOS arch/,
  );
  assert.throws(
    () => formatArtifactName('android-apk', VERSION, { abi: 'mips' }),
    /unknown Android abi/,
  );
});

test('app config: the dev config overrides version, productName and identifier', () => {
  const config = resolveAppConfig({
    baseConfig: {
      productName: 'Shishi',
      version: '0.0.1-dev.0',
      identifier: 'app.shishi.todo',
      bundle: { publisher: 'Shishi' },
    },
    devConfig: { productName: 'Shishi Dev', version: '0.0.1-dev.0', identifier: DEV_IDENTIFIER },
  });
  assert.equal(config.version, '0.0.1-dev.0');
  assert.equal(config.productName, 'Shishi Dev');
  assert.equal(config.identifier, DEV_IDENTIFIER);
  assert.equal(config.publisher, 'Shishi');
  assert.deepEqual(config.overriddenKeys, ['identifier', 'productName', 'version']);
  assert.throws(() => assertDevConfig({ ...config, identifier: 'app.shishi.todo' }), /identifier/);
  assert.throws(() => assertDevConfig({ ...config, productName: '' }), /productName/);
  assert.equal(
    resolveVersionValue('../package.json', () => ({ version: '1.2.3-dev.4' })),
    '1.2.3-dev.4',
  );
  assert.throws(() => resolveVersionValue('../package.json'), /file reader/);
});

test('merge patch: objects merge recursively, null deletes, arrays and scalars replace', () => {
  assert.deepEqual(
    applyMergePatch(
      { a: 1, b: { c: 2, d: [1, 2] }, e: 'keep' },
      { b: { c: 3, d: [9] }, e: null, f: [1] },
    ),
    {
      a: 1,
      b: { c: 3, d: [9] },
      f: [1],
    },
  );
  // an empty patch object changes nothing, a scalar under an object becomes an object
  assert.deepEqual(applyMergePatch({ a: { b: 1 } }, { a: {} }), { a: { b: 1 } });
  assert.deepEqual(applyMergePatch({ a: 1 }, { a: { b: 2 } }), { a: { b: 2 } });
  assert.deepEqual(applyMergePatch({ a: { b: 1, c: 2 } }, { a: { b: null } }), { a: { c: 2 } });
  assert.deepEqual(applyMergePatch({ a: 1 }, 'scalar'), 'scalar');
  assert.deepEqual(mergeTauriConfig({ a: 1 }, null, { b: 2 }, { a: 3 }), { a: 3, b: 2 });
  assert.deepEqual(mergeTauriConfig(), {});
});

test('app config: a base config with no override resolves its own identity', () => {
  const baseConfig = {
    productName: 'Shishi',
    version: '1.0.0',
    identifier: 'app.shishi.todo',
    bundle: { publisher: 'Shishi', targets: 'all', macOS: { minimumSystemVersion: '10.15' } },
  };
  const config = resolveAppConfig({ baseConfig });
  assert.equal(config.version, '1.0.0');
  assert.equal(config.productName, 'Shishi');
  assert.equal(config.identifier, 'app.shishi.todo');
  assert.equal(config.publisher, 'Shishi');
  assert.equal(config.nsisInstallMode, null);
  assert.deepEqual(config.overriddenKeys, []);
  assert.deepEqual(config.config, baseConfig);
});

test('app config: an override replaces productName', () => {
  const config = resolveAppConfig({
    baseConfig: { productName: 'Shishi', version: '1.0.0', identifier: 'app.shishi.todo' },
    devConfig: { productName: 'Shishi Dev' },
  });
  assert.equal(config.productName, 'Shishi Dev');
  assert.equal(config.identifier, 'app.shishi.todo');
  assert.equal(config.version, '1.0.0');
  assert.deepEqual(config.overriddenKeys, ['productName']);
});

test('app config: an override replaces identifier', () => {
  const config = resolveAppConfig({
    baseConfig: { productName: 'Shishi', version: '0.0.1-dev.1', identifier: 'app.shishi.todo' },
    devConfig: { identifier: DEV_IDENTIFIER },
  });
  assert.equal(config.identifier, DEV_IDENTIFIER);
  assert.equal(config.productName, 'Shishi');
  assert.equal(assertDevConfig(config).identifier, DEV_IDENTIFIER);
});

test('app config: an override replaces version', () => {
  const config = resolveAppConfig({
    baseConfig: { productName: 'Shishi', version: '0.0.1-dev.1', identifier: 'app.shishi.todo' },
    devConfig: { version: 'v0.0.2-dev.3' },
  });
  assert.equal(config.version, '0.0.2-dev.3');
  assert.equal(config.productName, 'Shishi');
});

test('app config: an override sets bundle.windows.nsis.installMode', () => {
  const config = resolveAppConfig({
    baseConfig: {
      productName: 'Shishi',
      version: '0.0.1-dev.1',
      identifier: 'app.shishi.todo',
      bundle: { active: true, windows: { nsis: { installMode: 'currentUser' } } },
    },
    devConfig: { bundle: { windows: { nsis: { installMode: 'perMachine' } } } },
  });
  assert.equal(config.nsisInstallMode, 'perMachine');
  assert.equal(config.config.bundle.active, true);
});

test('app config: bundle.publisher survives an override that does not mention it', () => {
  const config = resolveAppConfig({
    baseConfig: {
      productName: 'Shishi',
      version: '0.0.1-dev.1',
      identifier: 'app.shishi.todo',
      bundle: { publisher: 'Shishi', targets: 'all' },
    },
    devConfig: { bundle: { windows: { nsis: { installMode: 'currentUser' } } } },
  });
  assert.equal(config.publisher, 'Shishi');
  assert.equal(config.config.bundle.targets, 'all');
  assert.equal(config.nsisInstallMode, 'currentUser');
});

test('app config: bundle.macOS survives an override that does not mention it', () => {
  const config = resolveAppConfig({
    baseConfig: {
      productName: 'Shishi',
      version: '0.0.1-dev.1',
      identifier: 'app.shishi.todo',
      bundle: { macOS: { minimumSystemVersion: '10.15' }, icon: ['icons/base.png'] },
    },
    devConfig: { bundle: { icon: ['icons/dev.png'] } },
  });
  assert.equal(config.config.bundle.macOS.minimumSystemVersion, '10.15');
  assert.deepEqual(config.config.bundle.icon, ['icons/dev.png']);
});

test('app config: nested objects merge deeply instead of replacing', () => {
  const config = resolveAppConfig({
    baseConfig: {
      productName: 'Shishi',
      version: '0.0.1-dev.1',
      identifier: 'app.shishi.todo',
      app: {
        windows: [{ label: 'main', title: 'Shishi' }],
        security: { csp: "default-src 'self'" },
      },
      bundle: {
        windows: {
          nsis: { installMode: 'currentUser' },
          webviewInstallMode: { type: 'downloadBootstrapper' },
        },
      },
    },
    devConfig: {
      app: { windows: [{ label: 'main', title: 'Shishi Dev' }] },
      bundle: { windows: { nsis: { languages: ['SimpChinese'] } } },
    },
  });
  // an array is a value, not an object: the dev array replaces the base array
  assert.deepEqual(config.config.app.windows, [{ label: 'main', title: 'Shishi Dev' }]);
  // the sibling object the dev config never mentions survives the merge
  assert.deepEqual(config.config.app.security, { csp: "default-src 'self'" });
  assert.deepEqual(config.config.bundle.windows.nsis, {
    installMode: 'currentUser',
    languages: ['SimpChinese'],
  });
  assert.deepEqual(config.config.bundle.windows.webviewInstallMode, {
    type: 'downloadBootstrapper',
  });
});

test('app config: a JSON null in the override deletes the key', () => {
  const config = resolveAppConfig({
    baseConfig: {
      productName: 'Shishi',
      version: '0.0.1-dev.1',
      identifier: 'app.shishi.todo',
      bundle: {
        targets: 'all',
        category: 'Productivity',
        windows: { nsis: { installMode: 'currentUser' } },
      },
    },
    devConfig: { bundle: { targets: null, windows: { nsis: null } } },
  });
  assert.equal('targets' in config.config.bundle, false);
  assert.equal('nsis' in config.config.bundle.windows, false);
  assert.equal(config.config.bundle.category, 'Productivity');
  assert.equal(config.nsisInstallMode, null);
});

test('app config: multiple ordered configs merge left to right', () => {
  const config = resolveAppConfig({
    baseConfig: {
      productName: 'Shishi',
      version: '1.0.0',
      identifier: 'app.shishi.todo',
      bundle: { publisher: 'Shishi', category: 'Productivity', targets: 'all' },
    },
    devConfig: {
      productName: 'Shishi Dev',
      identifier: DEV_IDENTIFIER,
      bundle: { windows: { nsis: { installMode: 'currentUser' } } },
    },
    extraConfigs: [
      {
        productName: 'Shishi QA',
        identifier: 'app.shishi.todo.qa',
        bundle: { category: 'Utilities', targets: null },
      },
    ],
  });
  assert.equal(config.productName, 'Shishi QA');
  assert.equal(config.identifier, 'app.shishi.todo.qa');
  assert.equal(config.publisher, 'Shishi');
  assert.equal(config.config.bundle.category, 'Utilities');
  assert.equal('targets' in config.config.bundle, false);
  assert.equal(config.nsisInstallMode, 'currentUser');
  assert.deepEqual(config.overriddenKeys, ['bundle', 'identifier', 'productName']);

  // the order is the contract: the last config wins
  const reversed = resolveAppConfig({
    baseConfig: { version: '1.0.0', productName: 'Shishi' },
    devConfig: { productName: 'First' },
    extraConfigs: [{ productName: 'Second' }],
  });
  assert.equal(reversed.productName, 'Second');
});

test('app config: a wrong version is rejected', () => {
  const baseConfig = {
    productName: 'Shishi',
    version: '0.0.1-dev.1',
    identifier: 'app.shishi.todo',
  };
  assert.throws(
    () => resolveAppConfig({ baseConfig, devConfig: { version: 'not-a-version' } }),
    /not a semver version/,
  );
  assert.throws(
    () => resolveAppConfig({ baseConfig: { ...baseConfig, version: '1.0' } }),
    /not a semver version/,
  );
  assert.throws(
    () => resolveAppConfig({ baseConfig: { ...baseConfig, version: undefined } }),
    /no version/,
  );
  assert.throws(() => resolveAppConfig({}), /base tauri config is unreadable/);

  // an override version that resolves is still bound to the release tag
  const config = resolveAppConfig({ baseConfig, devConfig: { version: '0.0.2-dev.3' } });
  assert.equal(config.version, '0.0.2-dev.3');
  assert.throws(
    () =>
      resolveReleaseContext({
        eventName: 'push',
        refType: 'tag',
        refName: 'v0.0.1-dev.1',
        tagCommitSHA: TAG_SHA,
        appVersion: config.version,
      }),
    /app version 0\.0\.2-dev\.3 != release version 0\.0\.1-dev\.1/,
  );
});

test('app config: a Stable/Dev/QA identity conflict is rejected', () => {
  const baseConfig = {
    productName: 'Shishi',
    version: '0.0.1-dev.1',
    identifier: 'app.shishi.todo',
  };
  const devConfig = { productName: 'Shishi Dev', identifier: DEV_IDENTIFIER };
  const qaConfig = { productName: 'Shishi QA', identifier: 'app.shishi.todo.qa' };

  assert.equal(
    assertDevConfig(resolveAppConfig({ baseConfig, devConfig })).identifier,
    DEV_IDENTIFIER,
  );
  // the stable base identity alone is never publishable as dev
  assert.throws(() => assertDevConfig(resolveAppConfig({ baseConfig })), /identifier/);
  // a QA override that wins the identity is refused
  assert.throws(
    () => assertDevConfig(resolveAppConfig({ baseConfig, devConfig: qaConfig })),
    /identifier/,
  );
  assert.throws(
    () => assertDevConfig(resolveAppConfig({ baseConfig, devConfig, extraConfigs: [qaConfig] })),
    /identifier/,
  );
  assert.throws(
    () => assertDevConfig({ ...resolveAppConfig({ baseConfig, devConfig }), productName: '' }),
    /productName/,
  );
});

const TAURI_CONFIGS = Object.freeze({
  base: 'apps/native/src-tauri/tauri.conf.json',
  dev: 'apps/native/src-tauri/tauri.dev.conf.json',
  qa: 'apps/native/src-tauri/tauri.qa.conf.json',
});

function tauriConfig(path) {
  return JSON.parse(readFileSync(join(REPO_ROOT, path), 'utf8').replace(/^\uFEFF/, ''));
}

/**
 * Independent RFC 7396 merge patch, written from the specification instead of
 * from scripts/release/release-context.mjs, so the two interpreters cannot drift
 * together unnoticed.
 */
function referenceMergePatch(target, patch) {
  const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!isObject(patch)) return patch;
  const merged = isObject(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete merged[key];
    else merged[key] = referenceMergePatch(merged[key], value);
  }
  return merged;
}

test('build contract: the merged model equals an independent merge of the real configs', () => {
  const base = tauriConfig(TAURI_CONFIGS.base);
  const dev = tauriConfig(TAURI_CONFIGS.dev);
  const qa = tauriConfig(TAURI_CONFIGS.qa);

  assert.deepEqual(
    resolveAppConfig({ baseConfig: base, devConfig: dev }).config,
    referenceMergePatch(base, dev),
  );
  assert.deepEqual(
    resolveAppConfig({ baseConfig: base, devConfig: dev, extraConfigs: [qa] }).config,
    referenceMergePatch(referenceMergePatch(base, dev), qa),
  );
  assert.equal(
    resolveAppConfig({ baseConfig: base, devConfig: qa }).identifier,
    tauriConfig(TAURI_CONFIGS.qa).identifier,
  );

  // the top-level spread this model replaced must stay detectably wrong here,
  // otherwise the assertions above would stop guarding anything
  const naiveSpread = { ...base, ...dev };
  assert.equal(naiveSpread.bundle.targets, undefined);
  assert.equal(naiveSpread.app.security, undefined);
  assert.notDeepEqual(resolveAppConfig({ baseConfig: base, devConfig: dev }).config, naiveSpread);
});

test('build contract: the dev merge keeps the base bundle and app facts tauri needs', () => {
  const base = tauriConfig(TAURI_CONFIGS.base);
  const dev = tauriConfig(TAURI_CONFIGS.dev);
  const config = resolveAppConfig({ baseConfig: base, devConfig: dev });

  assert.equal(config.identifier, DEV_IDENTIFIER);
  assert.equal(config.productName, dev.productName);
  assert.equal(config.version, base.version);
  assert.deepEqual(config.overriddenKeys, Object.keys(dev).sort());

  for (const key of ['active', 'targets', 'category', 'shortDescription', 'longDescription']) {
    assert.deepEqual(
      config.config.bundle[key],
      base.bundle[key],
      'bundle.' + key + ' must survive',
    );
  }
  assert.equal(
    config.config.bundle.macOS.minimumSystemVersion,
    base.bundle.macOS.minimumSystemVersion,
  );
  // the dev config overrides the icon array wholesale; it must be the dev array
  assert.deepEqual(config.config.bundle.icon, dev.bundle.icon);
  assert.equal(config.config.bundle.icon.length, 6);
  assert.equal(config.config.bundle.windows.nsis.installMode, dev.bundle.windows.nsis.installMode);
  assert.equal(config.nsisInstallMode, 'currentUser');
  // dev declares app.windows, so the whole app object used to be replaced
  assert.deepEqual(config.config.app.security, base.app.security);
  assert.equal(config.config.app.windows[0].title, dev.app.windows[0].title);
  assert.equal(config.config.build.beforeBuildCommand, base.build.beforeBuildCommand);
});

test('publish gate: missing and empty assets fail before the release is created', () => {
  const expected = ['a.zip', 'b.exe'];
  assert.deepEqual(verifyReleaseAssets({ expected, files: [] }).failures, [
    'missing expected asset: a.zip',
    'missing expected asset: b.exe',
  ]);
  const empty = verifyReleaseAssets({
    expected,
    files: [
      { name: 'a.zip', size: 10, sha256: 'aa' },
      { name: 'b.exe', size: 0, sha256: 'bb' },
    ],
  });
  assert.equal(empty.ok, false);
  assert.deepEqual(empty.failures, ['empty asset: b.exe']);
  const duplicate = verifyReleaseAssets({
    expected,
    files: [
      { name: 'a.zip', size: 10, sha256: 'aa' },
      { name: 'a.zip', size: 10, sha256: 'aa' },
      { name: 'b.exe', size: 10, sha256: 'bb' },
    ],
  });
  assert.deepEqual(duplicate.failures, ['duplicate asset name: a.zip']);
});

test('publish gate: SHA256SUMS must cover every expected asset', () => {
  const sha = 'a'.repeat(64);
  const other = 'b'.repeat(64);
  const files = [{ name: 'a.zip', size: 10, sha256: sha }];
  const complete = verifyReleaseAssets({
    expected: ['a.zip'],
    files,
    sumsText: sha + '  ./web/a.zip\n',
  });
  assert.deepEqual(complete, { ok: true, failures: [] });
  const uncovered = verifyReleaseAssets({ expected: ['a.zip'], files, sumsText: '' });
  assert.deepEqual(uncovered.failures, [SUMS_NAME + ' has no entry for a.zip']);
  const mismatched = verifyReleaseAssets({
    expected: ['a.zip'],
    files,
    sumsText: other + '  a.zip',
  });
  assert.deepEqual(mismatched.failures, [SUMS_NAME + ' hash mismatch for a.zip']);
  const dangling = verifyReleaseAssets({
    expected: ['a.zip'],
    files,
    sumsText: sha + '  a.zip\n' + sha + '  ghost.dmg\n',
  });
  assert.deepEqual(dangling.failures, [
    SUMS_NAME + ' references a file that is not in the release: ghost.dmg',
  ]);
  const selfOnly = verifyReleaseAssets({
    expected: [SUMS_NAME, 'a.zip'],
    files: [...files, { name: SUMS_NAME, size: 4, sha256: other }],
    sumsText: sha + '  a.zip\n',
  });
  assert.equal(selfOnly.ok, true, 'a checksum file is not expected to checksum itself');
});

test('publish gate: sha256sum output is parsed with ./ prefixes and binary markers', () => {
  const sums = parseSha256Sums(
    'cd'.repeat(32) +
      '  ./windows/Shishi_0.0.1-dev.0_x64-setup.exe\n' +
      'ef'.repeat(32) +
      ' *Shishi-0.0.1-dev.0-macos-arm64.dmg\n\n',
  );
  assert.equal(sums.get('Shishi_0.0.1-dev.0_x64-setup.exe'), 'cd'.repeat(32));
  assert.equal(sums.get('Shishi-0.0.1-dev.0-macos-arm64.dmg'), 'ef'.repeat(32));
  assert.throws(() => parseSha256Sums('not a checksum line'), /malformed/);
});

test('release manifest: records commits, versions, tools and every asset', () => {
  const assets = [{ name: 'a.zip', size: 12, sha256: 'aa'.repeat(32) }];
  const toolchainRecords = [
    {
      platform: 'windows',
      rustc: 'rustc 1.96.0',
      node: 'v24.16.0',
      pnpm: '10.34.3',
      tauriCli: '2.12.4',
    },
    { platform: 'web', rustc: null, node: 'v24.16.0', pnpm: '10.34.3', tauriCli: null },
  ];
  const common = {
    releaseVersion: VERSION,
    artifactVersion: VERSION,
    appVersion: VERSION,
    releaseTag: VERSION,
    tagCommitSHA: TAG_SHA,
    buildCommitSHA: TAG_SHA,
    releaseChannel: 'dev',
    repository: 'owner/repo',
    workflowRef: 'owner/repo/.github/workflows/release-dev.yml@refs/tags/0.0.1-dev.0',
    runId: '123',
    runAttempt: '1',
    assets,
    toolchainRecords,
  };
  const manifest = buildManifest(common);
  assert.equal(manifest.commit.tagSHA, TAG_SHA);
  assert.equal(manifest.commit.buildSHA, TAG_SHA);
  assert.equal(manifest.release.version, VERSION);
  assert.equal(manifest.release.tag, VERSION);
  assert.equal(manifest.release.channel, 'dev');
  assert.equal(manifest.app.appVersion, VERSION);
  assert.equal(manifest.app.identifier, DEV_IDENTIFIER);
  assert.deepEqual(manifest.toolVersions, {
    rustc: ['rustc 1.96.0'],
    node: ['v24.16.0'],
    pnpm: ['10.34.3'],
    tauriCli: ['2.12.4'],
  });
  assert.deepEqual(manifest.assets, assets);
  assert.equal(manifest.generator.runId, '123');
  assert.throws(
    () =>
      buildManifest({
        ...common,
        toolchainRecords: toolchainRecords.map((record) => ({ ...record, rustc: null })),
      }),
    /missing the recorded rustc version/,
  );
  assert.throws(
    () => buildManifest({ ...common, buildCommitSHA: OTHER_SHA }),
    /manifest build commit/,
  );
});

test('workflow pins: every third-party action in the release path uses a 40-hex SHA', () => {
  const offenders = [];
  for (const path of RELEASE_WORKFLOWS) {
    for (const entry of actionRefs(workflowText(path))) {
      if (entry.ref.startsWith('./')) continue;
      if (!isPinnedRef(entry.ref)) offenders.push(path + ':' + entry.line + ' ' + entry.ref);
    }
  }
  assert.deepEqual(offenders, [], 'unpinned actions: ' + offenders.join(', '));
});

test('workflow pins: no mutable action refs remain in the release path', () => {
  const mutable = /@(v\d+(\.\d+)*|stable|beta|nightly|main|master|latest|HEAD)$/;
  const offenders = [];
  for (const path of RELEASE_WORKFLOWS) {
    for (const entry of actionRefs(workflowText(path))) {
      if (mutable.test(entry.ref)) offenders.push(path + ':' + entry.line + ' ' + entry.ref);
    }
  }
  assert.deepEqual(offenders, [], 'mutable refs: ' + offenders.join(', '));
});

test('workflow pins: the publishing job only runs pinned actions', () => {
  const text = workflowText('.github/workflows/release-dev.yml');
  const block = jobBlock(text, 'release');
  assert.ok(block, 'release-dev.yml must keep a release job');
  const refs = actionRefs(block);
  assert.ok(refs.length >= 3, 'the publish job must checkout, download artifacts and publish');
  for (const entry of refs) {
    assert.ok(isPinnedRef(entry.ref), 'publish job uses an unpinned action: ' + entry.ref);
  }
  assert.ok(
    refs.some((entry) => entry.ref.startsWith('softprops/action-gh-release@')),
    'the publish job must create the release with a pinned gh-release action',
  );
});

test('workflow wiring: every build job consumes the single release context', () => {
  const text = workflowText('.github/workflows/release-dev.yml');
  const contextBlock = jobBlock(text, 'context');
  assert.ok(contextBlock, 'release-dev.yml must start from a context job');
  const outputs = [
    'ReleaseVersion',
    'ReleaseTag',
    'TagCommitSHA',
    'BuildCommitSHA',
    'AppVersion',
    'ArtifactVersion',
    'ReleaseChannel',
  ];
  for (const output of outputs) {
    assert.ok(contextBlock.includes(output + ':'), 'context job must expose ' + output);
  }
  for (const job of ['web', 'windows', 'macos', 'android', 'release']) {
    const block = jobBlock(text, job);
    assert.ok(block, 'release-dev.yml must keep the ' + job + ' job');
    assert.ok(/needs:.*\bcontext\b/.test(block), job + ' must depend on context');
    assert.ok(block.includes('needs.context.outputs.'), job + ' must read the context outputs');
    assert.ok(
      block.includes('assert-checkout'),
      job + ' must assert its checkout is the tag commit',
    );
  }
  for (const job of ['web', 'windows', 'macos', 'android']) {
    const block = jobBlock(text, job);
    assert.ok(
      block.includes('${{ needs.context.outputs.TagCommitSHA }}'),
      job + ' must check out the tag commit',
    );
  }
});

test('workflow wiring: release-dev.yml has exactly one source of truth for the version', () => {
  const text = workflowText('.github/workflows/release-dev.yml');
  const contextBlock = jobBlock(text, 'context');
  const others = Object.fromEntries(
    ['web', 'windows', 'macos', 'android', 'release'].map((job) => [job, jobBlock(text, job)]),
  );
  assert.equal(
    text.split('github.event.inputs.version').length - 1,
    1,
    'only the context job may read the version input',
  );
  assert.equal(
    text.split('github.ref_name').length - 1,
    1,
    'only the context job may read github.ref_name',
  );
  assert.equal(
    text.split('GITHUB_REF_NAME').length - 1,
    0,
    'no shell step may use GITHUB_REF_NAME',
  );
  assert.ok(contextBlock.includes('github.ref_name'));
  assert.ok(contextBlock.includes('github.event.inputs.version'));
  for (const [job, block] of Object.entries(others)) {
    assert.ok(!block.includes('github.ref_name'), job + ' must not read github.ref_name');
    assert.ok(
      !block.includes('github.event.inputs.version'),
      job + ' must not read the version input',
    );
    assert.ok(!block.includes('GITHUB_REF_NAME'), job + ' must not use GITHUB_REF_NAME');
  }
  assert.ok(
    text.includes('node scripts/release/release-context.mjs artifact-name'),
    'artifact names must come from the single formatter',
  );
});

test('workflow permissions: write access is limited to the publishing job', () => {
  const text = workflowText('.github/workflows/release-dev.yml');
  assert.match(
    text,
    /^permissions:\n  contents: read$/m,
    'top-level permissions must be contents: read',
  );
  assert.equal(text.split('contents: write').length - 1, 1, 'contents: write belongs to one job');
  assert.ok(jobBlock(text, 'release').includes('contents: write'));
  for (const job of ['context', 'web', 'windows', 'macos', 'android']) {
    assert.ok(
      !jobBlock(text, job).includes('contents: write'),
      job + ' must not hold write access',
    );
  }
});

test('workflow gates: the publish job verifies assets and identity before publishing', () => {
  const block = jobBlock(workflowText('.github/workflows/release-dev.yml'), 'release');
  const verifyIndex = block.indexOf('verify-assets');
  const manifestIndex = block.indexOf('manifest --artifacts-dir');
  const publishIndex = block.indexOf('softprops/action-gh-release@');
  assert.ok(verifyIndex !== -1, 'the publish job must run the asset gate');
  assert.ok(manifestIndex !== -1, 'the publish job must write the release manifest');
  assert.ok(publishIndex !== -1, 'the publish job must publish');
  assert.ok(verifyIndex < publishIndex, 'the asset gate must run before publishing');
  assert.ok(manifestIndex < publishIndex, 'the manifest must be written before publishing');
  assert.ok(block.includes('fail_on_unmatched_files: true'));
  assert.ok(block.includes('prerelease: true'));
  assert.ok(block.includes(MANIFEST_NAME), 'the manifest must be attached to the release');
});

test('workflow expressions: all four release workflows pass the expression lint today', () => {
  assert.equal(RELEASE_WORKFLOW_PATHS.length, 4);
  for (const path of RELEASE_WORKFLOW_PATHS) {
    const problems = lintWorkflowExpressions(workflowText(path), path);
    const report = problems.map(
      (problem) => problem.file + ':' + problem.line + ':' + problem.column + ' ' + problem.message,
    );
    assert.deepEqual(report, [], path + ' has malformed GitHub expressions: ' + report.join(' | '));
  }
});

test('workflow expressions: the real-file lint entry point reports nothing', () => {
  const offenders = lintReleaseWorkflows().map(
    (problem) => problem.file + ':' + problem.line + ':' + problem.column + ' ' + problem.message,
  );
  assert.deepEqual(offenders, [], 'malformed GitHub expressions: ' + offenders.join(' | '));
});

test('workflow expressions: a shell expansion typed with doubled braces is rejected', () => {
  const open = EXPRESSION_OPEN;
  const damaged = [
    'SDK_DIR="' + open + 'ANDROID_HOME:-' + open + 'ANDROID_SDK_ROOT}}"',
    'abi="' + open + 'abi_of[$name]:-}"',
    'base="' + open + 'name%.aab}.apk"',
    '--abi "' + open + 'token_of[$abi]}"',
  ].join('\n');
  const problems = lintWorkflowExpressions(damaged, 'damaged.yml');
  assert.equal(problems.length, 4, 'each damaged line must be reported once');
  assert.deepEqual([...new Set(problems.map((problem) => problem.line))], [1, 2, 3, 4]);
  for (const problem of problems) {
    assert.equal(problem.file, 'damaged.yml');
    assert.ok(problem.column > 0);
  }

  const clean = [
    'ref: ' + open + ' needs.context.outputs.TagCommitSHA }}',
    'runs-on: ' + open + ' matrix.os }}',
    'run: echo "${ANDROID_HOME:-$ANDROID_SDK_ROOT}"',
    'run: node x --version "$ARTIFACT_VERSION" --abi "${token_of[$abi]}"',
  ].join('\n');
  assert.deepEqual(lintWorkflowExpressions(clean, 'clean.yml'), []);
});

test('workflow expressions: unknown roots and unterminated expressions are rejected', () => {
  const open = EXPRESSION_OPEN;
  assert.deepEqual(lintWorkflowExpressions('a: ' + open + ' bogus.context }}'), [
    { file: '(workflow)', line: 1, column: 4, message: 'unknown expression root "bogus"' },
  ]);
  assert.deepEqual(lintWorkflowExpressions('a: ' + open + ' github.ref'), [
    {
      file: '(workflow)',
      line: 1,
      column: 4,
      message: 'expression is not closed by a double brace on the same line',
    },
  ]);
});
