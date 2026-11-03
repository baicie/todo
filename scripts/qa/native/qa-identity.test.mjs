/**
 * QA identity consistency contract.
 *
 * Why this file exists: the QA product name and version used to be copy-pasted
 * into the harness policy, the executable verifier, two PowerShell diagnostics
 * and the CI artifact name. Bumping the QA build for a new release candidate
 * left those copies behind, and a stale copy is a silent failure - the harness
 * either rejects the package it was asked to validate ("ProductName mismatch")
 * or keeps pointing at the previous build's install directory. This suite fails
 * the moment the config, the derived constants, a consumer literal or the
 * isolation boundary drift apart.
 *
 * Nothing here installs, spawns or networks.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  DEV_IDENTIFIER,
  PRODUCTION_DATA_ROOT_DIRNAME,
  QA_CONFIG_IDENTIFIER,
  QA_CREDENTIAL_SERVICE,
  QA_DATA_ROOT_DIRNAME,
  QA_IDENTIFIER,
  QA_PRODUCT_NAME,
  QA_PRODUCT_VERSION,
  QA_RELEASE_CANDIDATE,
  STABLE_IDENTIFIER,
  qaInstallRoots,
  qaStartMenuShortcut,
} from './qa-identity.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const read = (...parts) => readFileSync(join(repoRoot, ...parts), 'utf8');
const config = JSON.parse(read('apps', 'native', 'src-tauri', 'tauri.qa.conf.json'));

test('the QA config agrees with the derived identity', () => {
  assert.equal(config.identifier, QA_IDENTIFIER);
  assert.equal(QA_CONFIG_IDENTIFIER, QA_IDENTIFIER);
  assert.equal(config.productName, QA_PRODUCT_NAME);
  assert.equal(config.version, QA_PRODUCT_VERSION);
  // The window title is what a tester sees; it must name the same build.
  assert.equal(config.app.windows[0].title, QA_PRODUCT_NAME);
});

test('the QA build names its release candidate', () => {
  assert.match(QA_PRODUCT_NAME, /^Shishi QA V\d+\.\d+-RC\d+$/);
  assert.ok(
    QA_PRODUCT_NAME.endsWith(QA_RELEASE_CANDIDATE),
    `product name ${QA_PRODUCT_NAME} must end with ${QA_RELEASE_CANDIDATE}`,
  );
  // A version that does not move with the candidate is how the stale QA
  // identity happened the first time. `V1.1-RC1` must yield a `1.1.x-rcN`
  // version, so the two can never describe different candidates.
  const match = QA_RELEASE_CANDIDATE.match(/^V(\d+)\.(\d+)-RC(\d+)$/);
  assert.ok(match, `unexpected candidate format: ${QA_RELEASE_CANDIDATE}`);
  const [, major, minor, candidate] = match;
  assert.equal(
    QA_PRODUCT_VERSION,
    `${major}.${minor}.0-rc${candidate}`,
    `version ${QA_PRODUCT_VERSION} must encode the candidate ${QA_RELEASE_CANDIDATE}`,
  );
});

test('the three channels keep distinct install, data and credential namespaces', () => {
  // The identifier is the install, data-root, credential and AUMID namespace.
  // Only the product name may differ per release candidate.
  assert.notEqual(QA_IDENTIFIER, STABLE_IDENTIFIER);
  assert.notEqual(QA_IDENTIFIER, DEV_IDENTIFIER);
  assert.notEqual(STABLE_IDENTIFIER, DEV_IDENTIFIER);
  assert.equal(QA_DATA_ROOT_DIRNAME, QA_IDENTIFIER);
  assert.equal(PRODUCTION_DATA_ROOT_DIRNAME, STABLE_IDENTIFIER);

  // The credential namespace is NOT derived from the identifier: it predates
  // channel isolation and existing QA tokens live under it. Pinned against the
  // Rust source of truth so a rename in one place cannot silently orphan them.
  assert.equal(QA_CREDENTIAL_SERVICE, 'app.shishi.todo.rc2d-qa.secure-token');
  const rust = read('apps', 'native', 'src-tauri', 'src', 'build_identity.rs');
  assert.ok(
    rust.includes(`"${QA_CREDENTIAL_SERVICE}"`),
    'build_identity.rs no longer maps QA to the pinned credential service',
  );
  assert.ok(
    rust.includes(`Self::Qa => "${QA_IDENTIFIER}"`),
    'build_identity.rs no longer maps QA to the pinned identifier',
  );
});

test('install roots and the shortcut follow the product name, not the identifier', () => {
  const local = 'C:\\Users\\qa\\AppData\\Local';
  const roots = qaInstallRoots(local);
  assert.equal(roots.length, 2);
  assert.equal(roots[0], join(local, QA_PRODUCT_NAME));
  assert.equal(roots[1], join(local, 'Programs', QA_PRODUCT_NAME));
  for (const root of roots) {
    assert.ok(!root.includes('Shishi Dev'), 'a QA root must never resolve into the Dev install');
    assert.ok(!root.endsWith('Shishi'), 'a QA root must never resolve into the Stable install');
  }
  assert.equal(
    qaStartMenuShortcut('C:\\Users\\qa\\AppData\\Roaming'),
    join(
      'C:\\Users\\qa\\AppData\\Roaming',
      'Microsoft',
      'Windows',
      'Start Menu',
      'Programs',
      `${QA_PRODUCT_NAME}.lnk`,
    ),
  );
  assert.equal(qaInstallRoots(undefined).length, 0);
  assert.equal(qaStartMenuShortcut(undefined), null);
});

test('every isolation dimension names QA, Dev and Stable differently', () => {
  // The install-time isolation claim rests on these being pairwise distinct.
  // If any two channels ever collide, a QA install can overwrite or read
  // another channel's directory, data root, credentials or notification
  // registration. Derived from the configs, never retyped.
  const appData = 'C:\\Users\\qa\\AppData\\Roaming';
  const local = 'C:\\Users\\qa\\AppData\\Local';
  const dimensions = {
    identifier: [QA_IDENTIFIER, DEV_IDENTIFIER, STABLE_IDENTIFIER],
    dataRoot: [
      join(appData, QA_DATA_ROOT_DIRNAME),
      join(appData, DEV_IDENTIFIER),
      join(appData, PRODUCTION_DATA_ROOT_DIRNAME),
    ],
    credentialService: [
      QA_CREDENTIAL_SERVICE,
      'app.shishi.todo.dev.secure-token',
      'app.shishi.todo.secure-token',
    ],
    // The AUMID is the identifier on Windows, so notification registration is
    // isolated exactly when the identifiers are.
    aumid: [QA_IDENTIFIER, DEV_IDENTIFIER, STABLE_IDENTIFIER],
    installRoot: [
      ...qaInstallRoots(local).slice(0, 1),
      join(local, 'Shishi Dev'),
      join(local, 'Shishi'),
    ],
    startMenuShortcut: [
      qaStartMenuShortcut(appData),
      join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Shishi Dev.lnk'),
      join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Shishi.lnk'),
    ],
  };
  for (const [dimension, values] of Object.entries(dimensions)) {
    assert.equal(
      new Set(values.map((value) => String(value).toLowerCase())).size,
      values.length,
      `${dimension} collides across channels: ${values.join(' / ')}`,
    );
  }
  // The QA install directory must specifically not be a prefix path of, or
  // equal to, the Dev/Stable one - NSIS removes its own install directory on
  // uninstall.
  const [qaRoot] = qaInstallRoots(local);
  assert.ok(!qaRoot.toLowerCase().startsWith(join(local, 'Shishi Dev').toLowerCase() + '\\'));
  assert.ok(!qaRoot.toLowerCase().startsWith(join(local, 'Shishi').toLowerCase() + '\\'));
  assert.notEqual(qaRoot.toLowerCase(), join(local, 'Shishi').toLowerCase());
  assert.notEqual(qaRoot.toLowerCase(), join(local, 'Shishi Dev').toLowerCase());
});

test('no consumer still hardcodes a previous QA identity', () => {
  // Every file that used to carry a copy of the QA name or version. A literal
  // here means someone reintroduced the drift this suite exists to prevent.
  const consumers = [
    ['scripts', 'qa', 'native', 'harness-target.mjs'],
    ['scripts', 'qa', 'native', 'qa-executable.mjs'],
    ['scripts', 'qa', 'native', 'bench.mjs'],
    ['scripts', 'qa', 'native', 'check-windows-activation-prerequisites.ps1'],
    ['scripts', 'qa', 'native', 'windows-notification-diagnostic.ps1'],
    ['.github', 'workflows', 'native-qa.yml'],
  ];
  for (const parts of consumers) {
    const source = read(...parts);
    const name = parts.join('/');
    assert.ok(
      !source.includes('Shishi QA RC2D'),
      `${name} still hardcodes the previous QA product name`,
    );
    assert.ok(
      !source.includes("'1.0.0-rc2d'") && !source.includes('"1.0.0-rc2d"'),
      `${name} still hardcodes the previous QA version`,
    );
  }
});

test('run-windows.ps1 resolves the QA name instead of embedding it', () => {
  const script = read('scripts', 'qa', 'native', 'run-windows.ps1');
  assert.ok(
    script.includes('qa-identity.mjs') && script.includes('--field productName'),
    'run-windows.ps1 must resolve the QA product name from qa-identity.mjs',
  );
  // The installed-exe probe and the ProductName gate must both use the resolved
  // value; an inline copy in either place is how a rename broke the harness.
  assert.match(script, /\$appProduct -ne \$qaProductName/);
  assert.match(script, /LOCALAPPDATA "\$qaProductName\\todo-native\.exe"/);
});

test('the Rust packaging contract pins the same identity', () => {
  const rust = read('apps', 'native', 'src-tauri', 'src', 'build_identity.rs');
  // The config is compiled in, so a mismatch would be a build-time surprise
  // rather than a silent runtime one. These assertions mirror
  // packaging_contract_keeps_three_build_identities_apart.
  assert.ok(rust.includes('tauri.qa.conf.json'), 'the QA config must be part of the Rust contract');
  assert.ok(
    rust.includes('qa_identity_survives_a_release_candidate_bump'),
    'the release-candidate contract test must stay in build_identity.rs',
  );
});

test('the QA workflow uploads a candidate-named artifact', () => {
  const workflow = read('.github', 'workflows', 'native-qa.yml');
  assert.ok(
    workflow.includes('shishi-qa-v1.1-rc1-windows'),
    'the QA artifact name must name the release candidate it belongs to',
  );
});

test('the QA scripts directory has no other product-name literal', () => {
  // A directory-wide sweep catches a new consumer being added without going
  // through qa-identity.mjs, which a fixed list above would miss.
  const dir = join(repoRoot, 'scripts', 'qa', 'native');
  // The identity module names the old build in its rationale comment, and this
  // suite names it as the string it forbids. Every other QA script must not.
  const allowed = new Set(['qa-identity.mjs', 'qa-identity.test.mjs']);
  const offenders = readdirSync(dir)
    .filter((file) => /\.(mjs|ps1)$/.test(file) && !allowed.has(file))
    .filter((file) => readFileSync(join(dir, file), 'utf8').includes('Shishi QA RC2D'));
  assert.deepEqual(offenders, [], `these QA scripts still hardcode the old name: ${offenders}`);
});
