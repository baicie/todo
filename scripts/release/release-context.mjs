/**
 * RC2-D.11 Phase E — the single source of truth for the dev pre-release.
 *
 * Every release fact (version, tag, commit, channel, app version, artifact
 * version) is resolved and validated ONCE by the "context" workflow job through
 * this module, then handed to every build job. No workflow step derives an
 * artifact name from github.ref_name or github.event.inputs anymore.
 *
 * Semantic version normalization (the only rules, applied by normalizeVersion):
 *   1. surrounding whitespace is trimmed;
 *   2. exactly one leading "v"/"V" is stripped (so tag v0.0.2-dev.1 releases
 *      version 0.0.2-dev.1);
 *   3. the pre-release / build-metadata suffix is preserved byte for byte —
 *      "-dev.0" is never rewritten to ".0" or "-dev0";
 *   4. the remainder must be <major>.<minor>.<patch> plus an optional
 *      [-pre-release] and [+build] suffix, so a branch name, a range, or a path
 *      can never be mistaken for a version;
 *   5. normalization is idempotent: normalize(normalize(v)) === normalize(v).
 *
 * Channel rule: a release is "dev" if and only if the normalized version carries
 * a "-dev." pre-release segment (the *-dev.* tag pattern of release-dev.yml).
 *
 * Artifact naming (formatArtifactName is the ONLY place these names are built):
 *
 *   | kind          | options | name                                        |
 *   |---------------|---------|---------------------------------------------|
 *   | web-zip       |         | shishi-web-<v>.zip                          |
 *   | web-sha256    |         | shishi-web-sha256.txt                       |
 *   | windows-nsis  |         | Shishi_<v>_x64-setup.exe                    |
 *   | macos-dmg     | arch    | Shishi-<v>-macos-<arm64|x64>.dmg            |
 *   | macos-sha256  | arch    | Shishi-<v>-macos-<arm64|x64>.sha256          |
 *   | android-apk   | abi     | Shishi-<v>-android-<abi>-debug.apk          |
 *   | android-aab   | abi     | Shishi-<v>-android-<abi>-debug.aab          |
 *   | sha256sums    |         | SHA256SUMS.txt                              |
 *   | manifest      |         | release-manifest.json                       |
 *
 *   <v> is always ArtifactVersion, which the context job proves equal to
 *   ReleaseVersion. <abi> is one of arm, arm64, x86, x86_64.
 */

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const DEV_CHANNEL = 'dev';
export const RELEASE_CHANNEL = 'release';
export const DEV_IDENTIFIER = 'app.shishi.todo.dev';
export const BASE_CONFIG_PATH = 'apps/native/src-tauri/tauri.conf.json';
export const DEV_CONFIG_PATH = 'apps/native/src-tauri/tauri.dev.conf.json';
export const SUMS_NAME = 'SHA256SUMS.txt';
export const MANIFEST_NAME = 'release-manifest.json';
export const MACOS_ARCHES = Object.freeze(['arm64', 'x64']);
export const ANDROID_TARGETS = Object.freeze([
  Object.freeze({ token: 'arm', zipAbi: 'armeabi-v7a' }),
  Object.freeze({ token: 'arm64', zipAbi: 'arm64-v8a' }),
  Object.freeze({ token: 'x86', zipAbi: 'x86' }),
  Object.freeze({ token: 'x86_64', zipAbi: 'x86_64' }),
]);

const VERSION_PATTERN =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?(?:\+[0-9A-Za-z][0-9A-Za-z.-]*)?$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const SAFE_REF_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+_-]*$/;
const CHECKSUM_PATTERN = /^([0-9a-f]{64})\s+\*?(.+)$/i;

export class ReleaseContextError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ReleaseContextError';
  }
}

function fail(message) {
  throw new ReleaseContextError(message);
}

/** Rules 1-5 of the normalization contract above. Throws on anything else. */
export function normalizeVersion(input) {
  if (typeof input !== 'string') fail('version must be a string');
  const trimmed = input.trim();
  if (trimmed === '') fail('version is empty');
  const withoutPrefix =
    trimmed.startsWith('v') || trimmed.startsWith('V') ? trimmed.slice(1) : trimmed;
  if (!VERSION_PATTERN.test(withoutPrefix)) {
    fail('not a semver version: ' + JSON.stringify(input));
  }
  return withoutPrefix;
}

/** "dev" for a *-dev.* pre-release, "release" for anything else. */
export function detectChannel(tagOrVersion) {
  const version = normalizeVersion(tagOrVersion);
  return version.includes('-dev.') ? DEV_CHANNEL : RELEASE_CHANNEL;
}

/** Split a tag into its normalized version and its channel. */
export function describeTag(tag) {
  if (typeof tag !== 'string' || tag.trim() === '') fail('release tag is empty');
  const version = normalizeVersion(tag);
  return { tag: tag.trim(), version, channel: detectChannel(version) };
}

/**
 * Resolve a config "version" value, following Tauri's package.json form
 * ("version": "../package.json") when one is used.
 */
export function resolveVersionValue(raw, readVersionFile = null) {
  if (typeof raw !== 'string' || raw.trim() === '') fail('tauri config has no version');
  const value = raw.trim();
  if (!value.endsWith('.json')) return normalizeVersion(value);
  if (typeof readVersionFile !== 'function') {
    fail('config version delegates to ' + value + '; a file reader is required');
  }
  return resolveVersionValue(readVersionFile(value)?.version, readVersionFile);
}

function isConfigObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * RFC 7386 JSON Merge Patch, one layer: objects merge recursively, a `null` in
 * the patch deletes the key, arrays and scalars replace wholesale. This is the
 * merge Tauri performs when several config files are combined, so it — not a
 * top-level spread — is the model of the effective config.
 */
export function applyMergePatch(target, patch) {
  if (!isConfigObject(patch)) return patch;
  const merged = isConfigObject(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete merged[key];
    else merged[key] = applyMergePatch(merged[key], value);
  }
  return merged;
}

/** Fold tauri configs left to right, base first: the merge `tauri build --config` performs. */
export function mergeTauriConfig(...configs) {
  let merged = {};
  for (const config of configs) {
    if (config === null || config === undefined) continue;
    merged = applyMergePatch(merged, config);
  }
  return merged;
}

/**
 * Effective app config: the base config folded with the dev override and any
 * further configs in order, using the RFC 7386 merge `tauri build` performs — so
 * a nested object the overrides do not mention (bundle.targets, bundle.macOS,
 * app.security, ...) survives instead of being replaced by the last config.
 */
export function resolveAppConfig({
  baseConfig,
  devConfig = null,
  extraConfigs = [],
  readVersionFile = null,
} = {}) {
  if (!baseConfig || typeof baseConfig !== 'object') fail('base tauri config is unreadable');
  const overrides = [devConfig, ...(extraConfigs ?? [])].filter(
    (config) => config !== null && config !== undefined,
  );
  const merged = mergeTauriConfig(baseConfig, ...overrides);
  return {
    version: resolveVersionValue(merged.version, readVersionFile),
    productName: typeof merged.productName === 'string' ? merged.productName.trim() : '',
    identifier: typeof merged.identifier === 'string' ? merged.identifier.trim() : '',
    publisher: typeof merged.bundle?.publisher === 'string' ? merged.bundle.publisher.trim() : '',
    nsisInstallMode:
      typeof merged.bundle?.windows?.nsis?.installMode === 'string'
        ? merged.bundle.windows.nsis.installMode
        : null,
    overriddenKeys: [...new Set(overrides.flatMap((config) => Object.keys(config)))].sort(),
    /** The effective config model the fields above were derived from. */
    config: merged,
  };
}

/** The dev channel must be built from a config that carries the dev identity. */
export function assertDevConfig(config) {
  if (!config || typeof config !== 'object') fail('dev app config is unreadable');
  if (config.identifier !== DEV_IDENTIFIER) {
    fail(
      'dev config identifier ' + JSON.stringify(config.identifier || '') + ' != ' + DEV_IDENTIFIER,
    );
  }
  if (!config.productName) fail('dev config productName is missing');
  return config;
}

/**
 * The pure heart of the context job. Takes already-verified facts (the tag
 * commit resolved by git, the app version resolved from the config) and either
 * returns the seven release-context outputs or throws. The validation order is
 * deliberate: channel, then tag existence, then version agreement, so a missing
 * tag is reported as a missing tag.
 */
export function resolveReleaseContext({
  eventName,
  refType = '',
  refName = '',
  inputVersion = '',
  tagCommitSHA = null,
  appVersion = undefined,
  artifactVersion = undefined,
  buildCommitSHA = undefined,
} = {}) {
  let requestedTag;
  if (eventName === 'push') {
    if (refType !== 'tag') {
      fail('release-dev runs on tag pushes only; ' + (refType || 'unknown') + ' refs are refused');
    }
    requestedTag = refName;
  } else if (eventName === 'workflow_dispatch') {
    requestedTag = typeof inputVersion === 'string' ? inputVersion.trim() : '';
    if (requestedTag === '') {
      fail('workflow_dispatch requires the "version" input: the existing dev tag to publish');
    }
  } else {
    fail('unsupported trigger: ' + JSON.stringify(eventName ?? ''));
  }

  const { tag, version, channel } = describeTag(requestedTag);
  if (channel !== DEV_CHANNEL) {
    fail(
      'release channel ' +
        channel +
        ' refused: release-dev publishes *-dev.* tags only (tag ' +
        tag +
        ')',
    );
  }

  if (typeof tagCommitSHA !== 'string' || !SHA_PATTERN.test(tagCommitSHA)) {
    fail('tag ' + tag + ' does not exist (no commit SHA resolved), refusing to build');
  }

  if (typeof appVersion !== 'string' || appVersion.trim() === '') {
    fail('app version was not resolved from the tauri config; cannot prove the build identity');
  }
  const resolvedAppVersion = normalizeVersion(appVersion);
  if (resolvedAppVersion !== version) {
    fail('app version ' + resolvedAppVersion + ' != release version ' + version);
  }

  const resolvedArtifactVersion = normalizeVersion(
    artifactVersion === undefined ? version : artifactVersion,
  );
  if (resolvedArtifactVersion !== version) {
    fail('artifact version ' + resolvedArtifactVersion + ' != release version ' + version);
  }

  const resolvedBuildCommit = buildCommitSHA === undefined ? tagCommitSHA : buildCommitSHA;
  if (resolvedBuildCommit !== tagCommitSHA) {
    fail(
      'build commit ' +
        resolvedBuildCommit +
        ' != tag commit ' +
        tagCommitSHA +
        ': artifacts must be built from the tag commit',
    );
  }

  return {
    ReleaseVersion: version,
    ReleaseTag: tag,
    TagCommitSHA: tagCommitSHA,
    BuildCommitSHA: resolvedBuildCommit,
    AppVersion: resolvedAppVersion,
    ArtifactVersion: resolvedArtifactVersion,
    ReleaseChannel: channel,
  };
}

function assertArch(arch) {
  if (!MACOS_ARCHES.includes(arch)) {
    fail('unknown macOS arch ' + JSON.stringify(arch ?? '') + ' (expected arm64 or x64)');
  }
  return arch;
}

function assertAbi(abi) {
  if (!ANDROID_TARGETS.some((target) => target.token === abi)) {
    fail(
      'unknown Android abi ' +
        JSON.stringify(abi ?? '') +
        ' (expected one of ' +
        ANDROID_TARGETS.map((target) => target.token).join(', ') +
        ')',
    );
  }
  return abi;
}

const ARTIFACT_FORMATTERS = {
  'web-zip': (version) => 'shishi-web-' + version + '.zip',
  'web-sha256': () => 'shishi-web-sha256.txt',
  'windows-nsis': (version) => 'Shishi_' + version + '_x64-setup.exe',
  'macos-dmg': (version, { arch }) => 'Shishi-' + version + '-macos-' + assertArch(arch) + '.dmg',
  'macos-sha256': (version, { arch }) =>
    'Shishi-' + version + '-macos-' + assertArch(arch) + '.sha256',
  'android-apk': (version, { abi }) =>
    'Shishi-' + version + '-android-' + assertAbi(abi) + '-debug.apk',
  'android-aab': (version, { abi }) =>
    'Shishi-' + version + '-android-' + assertAbi(abi) + '-debug.aab',
  sha256sums: () => SUMS_NAME,
  manifest: () => MANIFEST_NAME,
};

export const ARTIFACT_KINDS = Object.freeze(Object.keys(ARTIFACT_FORMATTERS));

/** The only place an artifact file name is formatted. */
export function formatArtifactName(kind, version, options = {}) {
  const formatter = ARTIFACT_FORMATTERS[kind];
  if (!formatter) {
    fail(
      'unknown artifact kind ' +
        JSON.stringify(kind ?? '') +
        ' (expected one of ' +
        ARTIFACT_KINDS.join(', ') +
        ')',
    );
  }
  return formatter(normalizeVersion(version), options);
}

/** Everything the build jobs must upload before the publish gate opens. */
export function expectedBuildAssets(version) {
  return [
    formatArtifactName('web-zip', version),
    formatArtifactName('web-sha256', version),
    formatArtifactName('windows-nsis', version),
    ...MACOS_ARCHES.flatMap((arch) => [
      formatArtifactName('macos-dmg', version, { arch }),
      formatArtifactName('macos-sha256', version, { arch }),
    ]),
    ...ANDROID_TARGETS.flatMap(({ token }) => [
      formatArtifactName('android-apk', version, { abi: token }),
      formatArtifactName('android-aab', version, { abi: token }),
    ]),
  ];
}

/** Every file the GitHub release must carry, checksums and manifest included. */
export function expectedReleaseAssets(version) {
  return [
    ...expectedBuildAssets(version),
    formatArtifactName('manifest', version),
    formatArtifactName('sha256sums', version),
  ];
}

/** Parse sha256sum(1) output into a basename -> hex digest map. */
export function parseSha256Sums(text) {
  const sums = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const match = CHECKSUM_PATTERN.exec(trimmed);
    if (!match) fail('malformed ' + SUMS_NAME + ' line: ' + JSON.stringify(line));
    sums.set(basename(match[2].trim()), match[1].toLowerCase());
  }
  return sums;
}

/**
 * The publish gate. Compares what is on disk with what the release contract
 * requires and returns every failure instead of the first one, so a broken
 * release reports its whole gap. A checksum file cannot checksum itself, so
 * SUMS_NAME must exist but is not expected to cover itself.
 */
export function verifyReleaseAssets({ expected, files, sumsText = null } = {}) {
  if (!Array.isArray(expected) || expected.length === 0) fail('no expected assets supplied');
  if (!Array.isArray(files)) fail('no asset inventory supplied');
  const failures = [];
  const byName = new Map();
  for (const file of files) {
    const name = file.name ?? basename(String(file.path ?? ''));
    if (byName.has(name)) failures.push('duplicate asset name: ' + name);
    else byName.set(name, file);
  }

  for (const name of expected) {
    const file = byName.get(name);
    if (!file) {
      failures.push('missing expected asset: ' + name);
      continue;
    }
    if (!Number.isFinite(file.size) || file.size <= 0) failures.push('empty asset: ' + name);
  }

  if (sumsText !== null && sumsText !== undefined) {
    const sums = parseSha256Sums(sumsText);
    for (const name of expected) {
      if (name === SUMS_NAME) continue;
      const file = byName.get(name);
      if (!file) continue;
      const recorded = sums.get(name);
      if (!recorded) {
        failures.push(SUMS_NAME + ' has no entry for ' + name);
      } else if (file.sha256 && recorded !== String(file.sha256).toLowerCase()) {
        failures.push(SUMS_NAME + ' hash mismatch for ' + name);
      }
    }
    for (const name of sums.keys()) {
      if (name !== SUMS_NAME && !byName.has(name)) {
        failures.push(SUMS_NAME + ' references a file that is not in the release: ' + name);
      }
    }
  }

  return { ok: failures.length === 0, failures };
}

/**
 * Assemble the release manifest. Fails closed when a tool version is missing:
 * an unrecorded toolchain is an unreproducible release.
 */
export function buildManifest({
  releaseVersion,
  artifactVersion,
  appVersion,
  releaseTag,
  tagCommitSHA,
  buildCommitSHA,
  releaseChannel,
  repository = '',
  workflowRef = '',
  workflowSha = '',
  runId = '',
  runAttempt = '',
  assets = [],
  toolchainRecords = [],
} = {}) {
  if (releaseChannel !== DEV_CHANNEL) {
    fail('manifest refuses channel ' + JSON.stringify(releaseChannel ?? ''));
  }
  if (!SHA_PATTERN.test(String(tagCommitSHA ?? ''))) fail('manifest has no tag commit SHA');
  if (!SHA_PATTERN.test(String(buildCommitSHA ?? ''))) fail('manifest has no build commit SHA');
  if (tagCommitSHA !== buildCommitSHA) {
    fail('manifest build commit ' + buildCommitSHA + ' != tag commit ' + tagCommitSHA);
  }
  if (normalizeVersion(artifactVersion) !== normalizeVersion(releaseVersion)) {
    fail('manifest artifact version != release version');
  }
  if (normalizeVersion(appVersion) !== normalizeVersion(releaseVersion)) {
    fail('manifest app version != release version');
  }

  const distinct = (key) => {
    const values = toolchainRecords
      .map((record) => (typeof record?.[key] === 'string' ? record[key].trim() : ''))
      .filter((value) => value !== '');
    return [...new Set(values)].sort();
  };
  const toolVersions = {
    rustc: distinct('rustc'),
    node: distinct('node'),
    pnpm: distinct('pnpm'),
    tauriCli: distinct('tauriCli'),
  };
  for (const [tool, values] of Object.entries(toolVersions)) {
    if (values.length === 0) {
      fail('manifest is missing the recorded ' + tool + ' version (no toolchain record supplied)');
    }
  }
  if (!Array.isArray(assets) || assets.length === 0) fail('manifest has no asset inventory');

  return {
    schemaVersion: 1,
    generator: {
      workflow: 'release-dev',
      workflowRef,
      workflowSha,
      repository,
      runId,
      runAttempt,
    },
    release: {
      version: normalizeVersion(releaseVersion),
      artifactVersion: normalizeVersion(artifactVersion),
      tag: releaseTag,
      channel: releaseChannel,
    },
    commit: {
      tagSHA: tagCommitSHA,
      buildSHA: buildCommitSHA,
    },
    app: {
      appVersion: normalizeVersion(appVersion),
      identifier: DEV_IDENTIFIER,
    },
    toolVersions,
    toolchainRecords,
    assets: assets.map((asset) => ({
      name: asset.name,
      size: asset.size,
      sha256: asset.sha256,
    })),
  };
}

function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    fail('cannot read JSON ' + path + ': ' + error.message);
  }
}

function readEffectiveConfig() {
  const devPath = join(REPO_ROOT, DEV_CONFIG_PATH);
  if (!existsSync(devPath)) {
    fail(DEV_CONFIG_PATH + ' is missing: dev artifacts must be built from the dev identity config');
  }
  return assertDevConfig(
    resolveAppConfig({
      baseConfig: readJsonFile(join(REPO_ROOT, BASE_CONFIG_PATH)),
      devConfig: readJsonFile(devPath),
      readVersionFile: (reference) => readJsonFile(resolve(devPath, '..', reference)),
    }),
  );
}

function git(args, { allowFailure = false } = {}) {
  const result = spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' });
  if (result.error) fail('git ' + args.join(' ') + ' failed: ' + result.error.message);
  if (result.status !== 0) {
    if (allowFailure) return null;
    fail(
      'git ' +
        args.join(' ') +
        ' failed (' +
        result.status +
        '): ' +
        String(result.stderr ?? '').trim(),
    );
  }
  return String(result.stdout ?? '').trim();
}

function resolveTagCommit(tag) {
  if (!SAFE_REF_PATTERN.test(tag)) return null;
  const ref = 'refs/tags/' + tag;
  const revParse = ['rev-parse', '--verify', '--quiet', ref + '^{commit}'];
  const local = git(revParse, { allowFailure: true });
  if (local) return local;
  git(['fetch', '--quiet', '--no-tags', '--force', 'origin', '+' + ref + ':' + ref], {
    allowFailure: true,
  });
  return git(revParse, { allowFailure: true });
}

function commandVersion(command, args) {
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  if (result.error || result.status !== 0) return null;
  return String(result.stdout ?? '').trim() || null;
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** Recursive name/size/sha256 inventory of a directory; shared by the publish gate. */
export function readArtifactInventory(dir) {
  const files = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      files.push({
        name: entry.name,
        path: relative(dir, full).split('\\').join('/'),
        size: statSync(full).size,
        sha256: sha256File(full),
      });
    }
  };
  walk(dir);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function requireEnv(name) {
  const value = process.env[name];
  if (typeof value !== 'string' || value.trim() === '') fail(name + ' is not set');
  return value.trim();
}

function requireOption(value, label) {
  if (typeof value !== 'string' || value.trim() === '') fail('--' + label + ' is required');
  return value.trim();
}

function reportContext(context) {
  for (const [key, value] of Object.entries(context)) {
    console.log(key + '=' + value);
  }
}

function writeGithubOutputs(context) {
  const path = process.env.GITHUB_OUTPUT;
  if (typeof path !== 'string' || path === '') fail('GITHUB_OUTPUT is not set');
  const lines = Object.entries(context).map(([key, value]) => key + '=' + value);
  appendFileSync(path, lines.join('\n') + '\n');
}

function resolveCommand() {
  const eventName = requireEnv('EVENT_NAME');
  const refType = process.env.REF_TYPE ?? '';
  const refName = process.env.REF_NAME ?? '';
  const inputVersion = process.env.INPUT_VERSION ?? '';
  const requestedTag = (eventName === 'push' ? refName : inputVersion).trim();

  const tagCommitSHA = requestedTag === '' ? null : resolveTagCommit(requestedTag);
  const appVersion = tagCommitSHA ? readEffectiveConfig().version : undefined;

  const context = resolveReleaseContext({
    eventName,
    refType,
    refName,
    inputVersion,
    tagCommitSHA,
    appVersion,
  });

  if (eventName === 'workflow_dispatch' && refType !== 'tag') {
    console.log(
      'dispatch ref ' +
        (refName || '(unknown)') +
        ' is not a tag; artifacts come from tag ' +
        context.ReleaseTag +
        ' at ' +
        context.TagCommitSHA,
    );
  }
  reportContext(context);
  writeGithubOutputs(context);
}

function assertCheckoutCommand() {
  const buildCommitSHA = requireEnv('BUILD_COMMIT_SHA');
  const tagCommitSHA = requireEnv('TAG_COMMIT_SHA');
  const releaseTag = requireEnv('RELEASE_TAG');
  const head = git(['rev-parse', 'HEAD']);
  if (head !== buildCommitSHA) {
    fail('checkout HEAD ' + head + ' != BuildCommitSHA ' + buildCommitSHA);
  }
  const ref = 'refs/tags/' + releaseTag;
  git(['fetch', '--quiet', '--force', '--no-tags', 'origin', '+' + ref + ':' + ref], {
    allowFailure: true,
  });
  const tagSHA = git(['rev-parse', '--verify', '--quiet', ref + '^{commit}'], {
    allowFailure: true,
  });
  if (!tagSHA) fail('tag ' + releaseTag + ' is not resolvable after refresh');
  if (tagSHA !== tagCommitSHA) {
    fail('tag ' + releaseTag + ' now points at ' + tagSHA + ' != ' + tagCommitSHA);
  }
  if (head !== tagSHA) fail('BuildCommitSHA ' + head + ' != TagCommitSHA ' + tagSHA);
  console.log('OK build commit == tag commit ' + tagSHA + ' (tag ' + releaseTag + ')');
}

function configCommand(options) {
  const config = readEffectiveConfig();
  if (options.field === undefined) {
    console.log(JSON.stringify(config, null, 2));
    return;
  }
  if (!(options.field in config)) fail('config has no field ' + JSON.stringify(options.field));
  console.log(String(config[options.field] ?? ''));
}

function artifactNameCommand(positional, options) {
  const kind = positional[0];
  if (!kind) fail('artifact-name needs an artifact kind');
  const version = requireOption(options.version, 'version');
  console.log(formatArtifactName(kind, version, { arch: options.arch, abi: options.abi }));
}

function toolchainCommand(options) {
  const out = requireOption(options.out, 'out');
  const record = {
    platform: requireOption(options.platform, 'platform'),
    rustc: commandVersion('rustc', ['--version']),
    node: process.version,
    pnpm: commandVersion('pnpm', ['--version']),
    tauriCli: options['tauri-cli'] ?? process.env.TAURI_CLI_VERSION ?? null,
  };
  writeFileSync(resolve(REPO_ROOT, out), JSON.stringify(record, null, 2) + '\n');
  console.log(JSON.stringify(record));
}

function artifactsDir(options) {
  const dir = resolve(REPO_ROOT, options['artifacts-dir'] ?? 'artifacts');
  if (!existsSync(dir)) fail('artifact directory ' + dir + ' does not exist');
  return dir;
}

function manifestCommand(options) {
  const dir = artifactsDir(options);
  const artifactVersion = requireEnv('ARTIFACT_VERSION');
  const expected = expectedBuildAssets(artifactVersion);
  const files = readArtifactInventory(dir);
  const gate = verifyReleaseAssets({ expected, files });
  if (!gate.ok) {
    fail('manifest refused, the release is incomplete: ' + gate.failures.join('; '));
  }
  const toolchainRecords = files
    .filter((file) => /^toolchain-.+\.json$/.test(file.name))
    .map((file) => readJsonFile(join(dir, file.path)));
  const manifest = buildManifest({
    releaseVersion: requireEnv('RELEASE_VERSION'),
    artifactVersion,
    appVersion: requireEnv('APP_VERSION'),
    releaseTag: requireEnv('RELEASE_TAG'),
    tagCommitSHA: requireEnv('TAG_COMMIT_SHA'),
    buildCommitSHA: requireEnv('BUILD_COMMIT_SHA'),
    releaseChannel: requireEnv('RELEASE_CHANNEL'),
    repository: process.env.GITHUB_REPOSITORY ?? '',
    workflowRef: process.env.GITHUB_WORKFLOW_REF ?? '',
    workflowSha: process.env.GITHUB_WORKFLOW_SHA ?? '',
    runId: process.env.GITHUB_RUN_ID ?? '',
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? '',
    assets: files.filter((file) => expected.includes(file.name)),
    toolchainRecords,
  });
  const out = join(dir, MANIFEST_NAME);
  writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n');
  console.log(out);
}

function verifyAssetsCommand(options) {
  const dir = artifactsDir(options);
  const artifactVersion = requireEnv('ARTIFACT_VERSION');
  const stage = options.stage ?? 'final';
  if (stage !== 'pre' && stage !== 'final') fail('--stage must be pre or final');
  const requireSums = stage === 'final';
  const expected =
    stage === 'final'
      ? expectedReleaseAssets(artifactVersion)
      : expectedBuildAssets(artifactVersion);
  const sumsPath = join(dir, SUMS_NAME);
  if (requireSums && !existsSync(sumsPath)) {
    fail(stage + ' gate: ' + SUMS_NAME + ' is missing from ' + dir);
  }
  const files = readArtifactInventory(dir);
  const sumsText = existsSync(sumsPath) ? readFileSync(sumsPath, 'utf8') : null;
  const gate = verifyReleaseAssets({ expected, files, sumsText: requireSums ? sumsText : null });
  if (!gate.ok) {
    for (const failure of gate.failures) console.error('FAIL ' + failure);
    fail(stage + ' gate failed with ' + gate.failures.length + ' problem(s)');
  }
  console.log(
    'OK ' + stage + ' gate: ' + expected.length + ' expected assets present and checksummed',
  );
}

/* ---------------------------------------------------------------------------
 * GitHub expression lint
 *
 * GitHub evaluates its double-brace expressions before a job starts and refuses
 * the whole workflow file (0 jobs, "Invalid workflow file") when one of them is
 * malformed. A shell parameter expansion typed with a doubled brace looks like
 * an expression to GitHub and like valid YAML to a YAML parser, so workflow
 * files must be linted for expression grammar, not only for YAML syntax.
 * ------------------------------------------------------------------------- */

export const EXPRESSION_OPEN = '$' + '{{';
export const EXPRESSION_CLOSE = '}}';
export const EXPRESSION_CONTEXTS = Object.freeze([
  'github',
  'needs',
  'env',
  'steps',
  'matrix',
  'secrets',
  'inputs',
  'runner',
  'job',
  'strategy',
  'vars',
]);
export const EXPRESSION_FUNCTIONS = Object.freeze([
  'contains',
  'startsWith',
  'endsWith',
  'format',
  'join',
  'toJSON',
  'fromJSON',
  'hashFiles',
  'success',
  'always',
  'cancelled',
  'failure',
]);
export const EXPRESSION_LITERALS = Object.freeze(['true', 'false', 'null']);
export const RELEASE_WORKFLOW_PATHS = Object.freeze([
  '.github/workflows/release-dev.yml',
  '.github/workflows/release-acceptance.yml',
  '.github/workflows/release-desktop.yml',
  '.github/workflows/release-web.yml',
]);

const EXPRESSION_TOKEN =
  /'(?:[^']*)'|[A-Za-z_][A-Za-z0-9_]*|\d+(?:\.\d+)?|===|!==|==|!=|<=|>=|&&|\|\||[.[\]()!,<>+\-*/]/g;
const EXPRESSION_OPERATORS = new Set([
  '(',
  '!',
  '&&',
  '||',
  ',',
  '==',
  '!=',
  '<',
  '<=',
  '>',
  '>=',
  '+',
  '-',
  '*',
  '/',
]);
const KNOWN_EXPRESSION_ROOTS = new Set([
  ...EXPRESSION_CONTEXTS,
  ...EXPRESSION_FUNCTIONS,
  ...EXPRESSION_LITERALS,
]);

function tokenizeExpression(body) {
  const tokens = [];
  let cursor = 0;
  for (const match of body.matchAll(EXPRESSION_TOKEN)) {
    const gap = body.slice(cursor, match.index);
    if (gap.trim() !== '') return { error: 'unexpected text ' + JSON.stringify(gap.trim()) };
    const value = match[0];
    const kind = value.startsWith("'")
      ? 'string'
      : /^[A-Za-z_]/.test(value)
        ? 'ident'
        : /^\d/.test(value)
          ? 'number'
          : 'punct';
    tokens.push({ kind, value });
    cursor = match.index + value.length;
  }
  const tail = body.slice(cursor);
  if (tail.trim() !== '') return { error: 'unexpected text ' + JSON.stringify(tail.trim()) };
  return { tokens };
}

/** Problems in one expression body; an empty array means it is well formed. */
export function lintExpressionBody(body) {
  const { tokens, error } = tokenizeExpression(String(body));
  if (error) return [error];
  if (tokens.length === 0) return ['empty expression body'];
  const problems = [];
  let previous = null;
  for (const token of tokens) {
    const isRoot =
      previous === null || (previous.kind === 'punct' && EXPRESSION_OPERATORS.has(previous.value));
    if (token.kind === 'ident' && isRoot && !KNOWN_EXPRESSION_ROOTS.has(token.value)) {
      problems.push('unknown expression root ' + JSON.stringify(token.value));
    }
    previous = token;
  }
  return problems;
}

/** Every double-brace expression of a workflow text, checked line by line. */
export function lintWorkflowExpressions(text, filePath = '(workflow)') {
  const problems = [];
  const lines = String(text).split(/\r?\n/);
  lines.forEach((line, index) => {
    let searchFrom = 0;
    for (;;) {
      const open = line.indexOf(EXPRESSION_OPEN, searchFrom);
      if (open === -1) return;
      const location = { file: filePath, line: index + 1, column: open + 1 };
      const close = line.indexOf(EXPRESSION_CLOSE, open + EXPRESSION_OPEN.length);
      if (close === -1) {
        problems.push({
          ...location,
          message: 'expression is not closed by a double brace on the same line',
        });
        return;
      }
      const body = line.slice(open + EXPRESSION_OPEN.length, close);
      for (const message of lintExpressionBody(body)) problems.push({ ...location, message });
      searchFrom = close + EXPRESSION_CLOSE.length;
    }
  });
  return problems;
}

/** Lint the real workflow files on disk; one entry per problem found. */
export function lintReleaseWorkflows(paths = RELEASE_WORKFLOW_PATHS) {
  const problems = [];
  for (const path of paths) {
    problems.push(...lintWorkflowExpressions(readFileSync(resolve(REPO_ROOT, path), 'utf8'), path));
  }
  return problems;
}

function lintWorkflowsCommand(positional) {
  const paths = positional.length > 0 ? positional : RELEASE_WORKFLOW_PATHS;
  const problems = lintReleaseWorkflows(paths);
  if (problems.length > 0) {
    for (const problem of problems) {
      console.error(
        problem.file + ':' + problem.line + ':' + problem.column + ' ' + problem.message,
      );
    }
    fail(
      problems.length + ' GitHub expression problem(s) in ' + paths.length + ' workflow file(s)',
    );
  }
  console.log('OK GitHub expressions: ' + paths.length + ' workflow file(s) clean');
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  const positional = [];
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const body = token.slice(2);
    const equals = body.indexOf('=');
    if (equals === -1) {
      options[body] = rest[index + 1];
      index += 1;
    } else {
      options[body.slice(0, equals)] = body.slice(equals + 1);
    }
  }
  return { command, options, positional };
}

const COMMANDS = {
  resolve: () => resolveCommand(),
  'assert-checkout': () => assertCheckoutCommand(),
  config: (_positional, options) => configCommand(options),
  'artifact-name': (positional, options) => artifactNameCommand(positional, options),
  toolchain: (_positional, options) => toolchainCommand(options),
  manifest: (_positional, options) => manifestCommand(options),
  'verify-assets': (_positional, options) => verifyAssetsCommand(options),
  'lint-workflows': (positional) => lintWorkflowsCommand(positional),
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { command, options, positional } = parseArgs(process.argv.slice(2));
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
      handler(positional, options);
    } catch (error) {
      if (error instanceof ReleaseContextError) {
        console.error('::error::' + error.message);
        process.exitCode = 1;
      } else {
        throw error;
      }
    }
  }
}

export { REPO_ROOT };
