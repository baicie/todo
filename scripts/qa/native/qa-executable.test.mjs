import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { QaExecutableError, verifyQaExecutable } from './qa-executable.mjs';

const HEAD = 'a'.repeat(40);
const temps = [];

function fixture() {
  const temp = mkdtempSync(join(tmpdir(), 'shishi-qa-exec-'));
  temps.push(temp);
  const root = join(temp, 'run');
  const qaRoot = join(temp, 'qa-install');
  mkdirSync(root, { recursive: true });
  mkdirSync(qaRoot, { recursive: true });
  const exe = join(qaRoot, 'todo-native.exe');
  writeFileSync(exe, 'not a real PE but a regular file');
  const hash = createHash('sha256').update(readFileSync(exe)).digest('hex');
  const manifest = {
    runId: 'run-1',
    gitCommit: HEAD,
    appExe: exe,
    appExeSha256: hash,
  };
  const environment = {
    qaIdentifier: 'app.shishi.todo.qa',
    qaDataRoot: join(temp, 'qa-data'),
    productionDataRoot: join(temp, 'prod-data'),
    productionDataRootPresent: false,
  };
  const provenance = { gitCommit: HEAD };
  writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest));
  writeFileSync(join(root, 'environment.json'), JSON.stringify(environment));
  writeFileSync(join(root, 'provenance.json'), JSON.stringify(provenance));
  return { temp, root, qaRoot, exe, manifest, environment, provenance };
}

function verify(f, overrides = {}) {
  return verifyQaExecutable({
    appExe: f.exe,
    artifactRoot: f.root,
    expectedHead: HEAD,
    allowedRoots: [f.qaRoot],
    productReader: () => 'Shishi QA RC2D',
    ...overrides,
  });
}

afterEach(() => {
  while (temps.length) rmSync(temps.pop(), { recursive: true, force: true });
});

test('accepts a matching QA executable before any spawn', () => {
  const f = fixture();
  const result = verify(f);
  assert.equal(result.realPath.toLowerCase(), f.exe.toLowerCase());
  assert.equal(result.productName, 'Shishi QA RC2D');
});

test('rejects hash mismatch', () => {
  const f = fixture();
  f.manifest.appExeSha256 = 'b'.repeat(64);
  writeFileSync(join(f.root, 'manifest.json'), JSON.stringify(f.manifest));
  assert.throws(() => verify(f), QaExecutableError);
});

test('rejects ProductName mismatch', () => {
  const f = fixture();
  assert.throws(() => verify(f, { productReader: () => 'Shishi' }), /ProductName mismatch/);
});

test('rejects executable outside allowed QA roots', () => {
  const f = fixture();
  const outside = join(f.temp, 'outside.exe');
  writeFileSync(outside, 'outside');
  assert.throws(() => verify(f, { appExe: outside }), /outside allowed QA roots/);
});

test('rejects junction escape from allowed root', (t) => {
  const f = fixture();
  const outside = join(f.temp, 'outside-dir');
  mkdirSync(outside);
  writeFileSync(join(outside, 'todo-native.exe'), 'outside');
  const junction = join(f.qaRoot, 'junction');
  try {
    symlinkSync(outside, junction, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    t.skip(`junction unsupported: ${error.message}`);
    return;
  }
  assert.throws(
    () => verify(f, { appExe: join(junction, 'todo-native.exe') }),
    /outside allowed QA roots/,
  );
});

test('rejects manifest HEAD mismatch', () => {
  const f = fixture();
  assert.throws(() => verify(f, { expectedHead: 'c'.repeat(40) }), /does not match expected/);
});

test('rejects missing or mismatched provenance', () => {
  const f = fixture();
  f.provenance.gitCommit = 'd'.repeat(40);
  writeFileSync(join(f.root, 'provenance.json'), JSON.stringify(f.provenance));
  assert.throws(() => verify(f), /provenance HEAD/);
});

test('rejects launch path differing from manifest appExe', () => {
  const f = fixture();
  const alternate = join(f.qaRoot, 'todo-native.exe');
  f.manifest.appExe = join(f.temp, 'different', 'todo-native.exe');
  writeFileSync(join(f.root, 'manifest.json'), JSON.stringify(f.manifest));
  assert.throws(() => verify(f, { appExe: alternate }), /manifest appExe path/);
});

test('rejects production data root present', () => {
  const f = fixture();
  f.environment.productionDataRootPresent = true;
  writeFileSync(join(f.root, 'environment.json'), JSON.stringify(f.environment));
  assert.throws(() => verify(f), /production data root/);
});

test('rejects QА/production data-root collision', () => {
  const f = fixture();
  f.environment.qaDataRoot = f.environment.productionDataRoot;
  writeFileSync(join(f.root, 'environment.json'), JSON.stringify(f.environment));
  assert.throws(() => verify(f), /not isolated/);
});
