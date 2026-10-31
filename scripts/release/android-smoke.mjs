/**
 * RC2-D.14 Phase D — assertions for .github/workflows/android-smoke.yml.
 *
 * The Android smoke workflow must prove that the DEV identity really reaches a
 * built Android artifact, so every claim is checked against a file the build
 * just produced, never against the config it was built from:
 *
 *   check-gradle  the Gradle project the CLI generated carries the resolved
 *                 identifier as namespace AND applicationId (an applicationId
 *                 suffix would silently rename the package, so its presence is a
 *                 failure), the versionName it applies comes from
 *                 app/tauri.properties, and — once `android build` has written
 *                 that file — its value is the resolved version.
 *   verify-apk    the `aapt2 dump badging` output: package name, versionName and
 *                 the native-code ABI of the APK.
 *   verify-aab    the protobuf AndroidManifest inside the AAB: the identifier and
 *                 the version appear in its string pool as complete strings, and
 *                 the bundle carries base/lib/<abi>/ for the requested ABI.
 *
 * Every command reports ALL the problems it found instead of the first one, so a
 * red smoke run names the whole gap. Nothing here publishes, signs, uploads or
 * writes to the repository: these commands only read files.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ANDROID_TARGETS, REPO_ROOT } from './release-context.mjs';

export const DEFAULT_PROJECT_DIR = 'apps/native/src-tauri/gen/android';
export const MIN_POOL_STRING = 4;

/** Characters that make a string part of a longer identifier, not a boundary. */
const IDENTIFIER_CHARS = /[A-Za-z0-9._-]/;

export class AndroidSmokeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AndroidSmokeError';
  }
}

function fail(message) {
  throw new AndroidSmokeError(message);
}

function requireText(path, label) {
  const full = resolve(REPO_ROOT, path);
  if (!existsSync(full)) fail(label + ' does not exist: ' + full);
  const text = readFileSync(full, 'utf8');
  if (text.trim() === '') fail(label + ' is empty: ' + full);
  return text;
}

/** The zip ABI (`arm64-v8a`) of a release-contract ABI token (`arm64`). */
export function expectedZipAbi(token) {
  const target = ANDROID_TARGETS.find((entry) => entry.token === token);
  if (!target) {
    fail(
      'unknown Android abi token ' +
        JSON.stringify(token ?? '') +
        ' (expected one of ' +
        ANDROID_TARGETS.map((entry) => entry.token).join(', ') +
        ')',
    );
  }
  return target.zipAbi;
}

/* ---------------------------------------------------------------------------
 * The generated Gradle project
 * ------------------------------------------------------------------------- */

/** The identity facts of a generated app/build.gradle.kts. */
export function readGradleIdentity(text) {
  const value = (pattern) => {
    const match = pattern.exec(text);
    return match ? match[1] : null;
  };
  return {
    applicationId: value(/\bapplicationId\b[^\S\r\n]*=[^\S\r\n]*"([^"]*)"/),
    namespace: value(/\bnamespace\b[^\S\r\n]*=[^\S\r\n]*"([^"]*)"/),
    hasApplicationIdSuffix: /\bapplicationIdSuffix\b/.test(text),
    readsVersionNameFromProperties:
      /\bversionName\b[^\S\r\n]*=[^\S\r\n]*tauriProperties\.getProperty\(\s*"tauri\.android\.versionName"/.test(
        text,
      ),
  };
}

/** The tauri.android.* entries `android build` writes into app/tauri.properties. */
export function readTauriProperties(text) {
  const value = (key) => {
    const match = new RegExp('^' + key.replace(/\./g, '\\.') + '=(.*)$', 'm').exec(text);
    return match ? match[1].trim() : null;
  };
  const versionCode = value('tauri.android.versionCode');
  return {
    versionName: value('tauri.android.versionName'),
    versionCode: versionCode === null ? null : Number.parseInt(versionCode, 10),
  };
}

/**
 * Phase "init": proves the project `android init` just generated is the dev one.
 * Phase "build": also proves `android build` wrote the resolved version into it.
 */
export function checkGradleProject({ identifier, version, phase = 'init', projectDir } = {}) {
  if (phase !== 'init' && phase !== 'build') fail('--phase must be "init" or "build"');
  const dir = projectDir ?? DEFAULT_PROJECT_DIR;
  const appDir = join(dir, 'app');
  const buildGradlePath = join(appDir, 'build.gradle.kts');
  const identity = readGradleIdentity(requireText(buildGradlePath, 'generated ' + buildGradlePath));
  const problems = [];

  if (identity.applicationId === null) {
    problems.push(buildGradlePath + ' declares no applicationId');
  } else if (identity.applicationId !== identifier) {
    problems.push(
      'generated applicationId ' +
        JSON.stringify(identity.applicationId) +
        ' != resolved identifier ' +
        JSON.stringify(identifier),
    );
  }
  if (identity.namespace === null) {
    problems.push(buildGradlePath + ' declares no namespace');
  } else if (identity.namespace !== identifier) {
    problems.push(
      'generated namespace ' +
        JSON.stringify(identity.namespace) +
        ' != resolved identifier ' +
        JSON.stringify(identifier),
    );
  }
  if (identity.hasApplicationIdSuffix) {
    problems.push(
      'the generated project declares an applicationId suffix, so the debug APK package name would no longer be the dev identifier',
    );
  }
  if (!identity.readsVersionNameFromProperties) {
    problems.push(
      'the generated project does not read versionName from tauri.android.versionName, so the APK versionName would not be the resolved version',
    );
  }

  let properties = null;
  if (phase === 'build') {
    const propertiesPath = join(appDir, 'tauri.properties');
    properties = readTauriProperties(requireText(propertiesPath, 'generated ' + propertiesPath));
    if (properties.versionName === null) {
      problems.push(propertiesPath + ' carries no tauri.android.versionName');
    } else if (properties.versionName !== version) {
      problems.push(
        'tauri.android.versionName ' +
          JSON.stringify(properties.versionName) +
          ' != resolved version ' +
          JSON.stringify(version),
      );
    }
    if (!Number.isInteger(properties.versionCode) || properties.versionCode < 1) {
      problems.push(
        'tauri.android.versionCode ' +
          JSON.stringify(properties.versionCode) +
          ' is not a positive integer',
      );
    }
  }

  if (problems.length > 0) {
    fail('the generated Gradle project does not carry the dev identity: ' + problems.join('; '));
  }
  return {
    applicationId: identity.applicationId,
    namespace: identity.namespace,
    versionName: properties?.versionName ?? null,
    versionCode: properties?.versionCode ?? null,
  };
}

/* ---------------------------------------------------------------------------
 * APK — `aapt2 dump badging`
 * ------------------------------------------------------------------------- */

export function parseBadging(text) {
  const packageLine = /^package: (.+)$/m.exec(text);
  if (!packageLine) {
    fail(
      'aapt2 dump badging printed no "package:" line: ' +
        JSON.stringify(String(text).slice(0, 200)),
    );
  }
  const attribute = (name) => {
    const match = new RegExp('\\b' + name + "='([^']*)'").exec(packageLine[1]);
    return match ? match[1] : null;
  };
  const nativeCodeLine = /^native-code: (.+)$/m.exec(text);
  return {
    packageName: attribute('name'),
    versionCode: attribute('versionCode'),
    versionName: attribute('versionName'),
    abis: nativeCodeLine
      ? [...nativeCodeLine[1].matchAll(/'([^']+)'/g)].map((match) => match[1])
      : [],
  };
}

export function assertApkIdentity({ badging, identifier, version, token }) {
  const parsed = parseBadging(badging);
  const zipAbi = expectedZipAbi(token);
  const problems = [];
  if (parsed.packageName !== identifier) {
    problems.push(
      'package name ' +
        JSON.stringify(parsed.packageName) +
        ' != resolved identifier ' +
        JSON.stringify(identifier),
    );
  }
  if (parsed.versionName !== version) {
    problems.push(
      'versionName ' +
        JSON.stringify(parsed.versionName) +
        ' != resolved version ' +
        JSON.stringify(version),
    );
  }
  if (parsed.abis.length === 0) {
    problems.push('the APK carries no native-code ABI, so no Rust library was packaged');
  } else if (!parsed.abis.includes(zipAbi)) {
    problems.push(
      'native-code ' +
        JSON.stringify(parsed.abis) +
        ' lacks ' +
        zipAbi +
        ' (abi token ' +
        token +
        ')',
    );
  }
  if (problems.length > 0) fail('the APK is not the dev artifact: ' + problems.join('; '));
  return { ...parsed, expectedAbi: zipAbi };
}

/* ---------------------------------------------------------------------------
 * AAB — the protobuf AndroidManifest string pool
 * ------------------------------------------------------------------------- */

/**
 * Every printable string of a binary blob, read as flat bytes and as UTF-16LE at
 * both alignments, because the bundle manifest stores its string pool in either
 * encoding and the pool entries are length-prefixed rather than separated.
 */
export function collectStrings(buffer, minLength = MIN_POOL_STRING) {
  const strings = new Set();
  const harvest = (text) => {
    let run = '';
    for (const char of text) {
      const code = char.codePointAt(0);
      if (code >= 0x20 && code <= 0x7e) {
        run += char;
        continue;
      }
      if (run.length >= minLength) strings.add(run);
      run = '';
    }
    if (run.length >= minLength) strings.add(run);
  };
  harvest(buffer.toString('utf8'));
  harvest(buffer.toString('utf16le', 0));
  harvest(buffer.toString('utf16le', 1));
  return strings;
}

/** True when `value` is a whole string of the pool, ignoring pool artefacts. */
export function poolHasString(strings, value) {
  if (typeof value !== 'string' || value === '') return false;
  for (const candidate of strings) {
    if (candidate === value) return true;
    let from = candidate.indexOf(value);
    while (from !== -1) {
      const before = from === 0 ? '' : candidate[from - 1];
      const afterIndex = from + value.length;
      const after = afterIndex >= candidate.length ? '' : candidate[afterIndex];
      if (!IDENTIFIER_CHARS.test(before) && !IDENTIFIER_CHARS.test(after)) return true;
      from = candidate.indexOf(value, from + 1);
    }
  }
  return false;
}

function nearMiss(strings, value) {
  const needle = value.slice(0, Math.min(8, value.length));
  const candidates = [...strings].filter((entry) => entry.includes(needle)).slice(0, 3);
  return candidates.length === 0
    ? ''
    : ' (closest pool strings: ' + JSON.stringify(candidates) + ')';
}

export function assertAabIdentity({ manifest, entries = null, identifier, version, token }) {
  const zipAbi = expectedZipAbi(token);
  const strings = collectStrings(manifest);
  const problems = [];
  if (strings.size === 0) {
    problems.push('the bundle manifest carries no readable string pool');
  } else {
    if (!poolHasString(strings, identifier)) {
      problems.push(
        'the string pool does not carry the identifier ' +
          JSON.stringify(identifier) +
          nearMiss(strings, identifier),
      );
    }
    if (!poolHasString(strings, version)) {
      problems.push(
        'the string pool does not carry the version ' +
          JSON.stringify(version) +
          nearMiss(strings, version),
      );
    }
  }
  if (entries !== null && !entries.includes('base/lib/' + zipAbi + '/')) {
    problems.push('the bundle carries no base/lib/' + zipAbi + '/ entry (abi token ' + token + ')');
  }
  if (problems.length > 0) fail('the AAB is not the dev artifact: ' + problems.join('; '));
  return { strings: strings.size, expectedAbi: zipAbi };
}

/* ---------------------------------------------------------------------------
 * CLI
 * ------------------------------------------------------------------------- */

function requireOption(value, label) {
  if (typeof value !== 'string' || value.trim() === '') fail('--' + label + ' is required');
  return value.trim();
}

function resolvePathOption(value, label) {
  const path = requireOption(value, label);
  const full = resolve(REPO_ROOT, path);
  if (!existsSync(full)) fail('--' + label + ' does not exist: ' + full);
  return full;
}

function checkGradleCommand(options) {
  const summary = checkGradleProject({
    identifier: requireOption(options.identifier, 'identifier'),
    version: requireOption(options.version, 'version'),
    phase: options.phase ?? 'init',
    projectDir: options['project-dir'],
  });
  console.log(
    'OK gradle project: applicationId=' +
      summary.applicationId +
      ' namespace=' +
      summary.namespace +
      (summary.versionName === null
        ? ' versionName=(written by android build)'
        : ' versionName=' + summary.versionName + ' versionCode=' + String(summary.versionCode)),
  );
}

function verifyApkCommand(options) {
  const badging = readFileSync(resolvePathOption(options.badging, 'badging'), 'utf8');
  const summary = assertApkIdentity({
    badging,
    identifier: requireOption(options.identifier, 'identifier'),
    version: requireOption(options.version, 'version'),
    token: requireOption(options['abi-token'], 'abi-token'),
  });
  console.log(
    'OK apk: package=' +
      summary.packageName +
      ' versionName=' +
      summary.versionName +
      ' versionCode=' +
      String(summary.versionCode) +
      ' abi=' +
      summary.expectedAbi +
      ' native-code=' +
      JSON.stringify(summary.abis),
  );
}

function verifyAabCommand(options) {
  const manifest = readFileSync(resolvePathOption(options.manifest, 'manifest'));
  const summary = assertAabIdentity({
    manifest,
    entries:
      options.entries === undefined
        ? null
        : readFileSync(resolvePathOption(options.entries, 'entries'), 'utf8'),
    identifier: requireOption(options.identifier, 'identifier'),
    version: requireOption(options.version, 'version'),
    token: requireOption(options['abi-token'], 'abi-token'),
  });
  console.log(
    'OK aab: abi=' + summary.expectedAbi + ' manifest-strings=' + String(summary.strings),
  );
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
  'check-gradle': (_positional, options) => checkGradleCommand(options),
  'verify-apk': (_positional, options) => verifyApkCommand(options),
  'verify-aab': (_positional, options) => verifyAabCommand(options),
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
      if (error instanceof AndroidSmokeError) {
        console.error('::error::' + error.message);
        process.exitCode = 1;
      } else {
        throw error;
      }
    }
  }
}

export { REPO_ROOT };
