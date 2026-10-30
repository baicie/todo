import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { validateManualEvidence } from './manual-evidence.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const inventory = JSON.parse(readFileSync(join(here, 'manual-scenarios.json'), 'utf8'));
const HEAD = 'a'.repeat(40);
const APP = 'b'.repeat(64);
const INSTALLER = 'c'.repeat(64);
const temps = [];

function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), 'shishi-manual-evidence-'));
  temps.push(root);
  mkdirSync(join(root, 'evidence'), { recursive: true });
  const evidencePath = join(root, 'evidence', 'toast.txt');
  writeFileSync(evidencePath, 'real observed toast screenshot bytes');
  const evidenceSha = createHash('sha256').update(readFileSync(evidencePath)).digest('hex');
  const now = new Date();
  const startedAt = new Date(now.getTime() - 1000).toISOString();
  const finishedAt = now.toISOString();
  const manifest = {
    runId: 'run-1',
    gitCommit: HEAD,
    appExeSha256: APP,
    installerSha256: INSTALLER,
  };
  const scenarios = inventory.map((scenario) => ({
    id: scenario.id,
    status: 'NOT_RUN',
    expected: scenario.expected,
    observed: null,
    evidence: [],
    reason: null,
    runId: manifest.runId,
    headSha: HEAD,
    appExeSha256: APP,
    installerSha256: INSTALLER,
    startedAt,
    finishedAt,
  }));
  return { root, manifest, scenarios, evidenceSha, startedAt, finishedAt };
}

function writeFixture(fixture, mutate) {
  const manual = {
    schemaVersion: 2,
    runId: fixture.manifest.runId,
    gitCommit: fixture.manifest.gitCommit,
    appExeSha256: fixture.manifest.appExeSha256,
    installerSha256: fixture.manifest.installerSha256,
    scenarios: structuredClone(fixture.scenarios),
  };
  mutate?.(manual);
  writeFileSync(join(fixture.root, 'manifest.json'), JSON.stringify(fixture.manifest));
  writeFileSync(join(fixture.root, 'manual-platform.json'), JSON.stringify(manual));
  return validateManualEvidence(fixture.root, HEAD);
}

function passScenario(fixture, targetId = 'running-app-activation') {
  return fixture.scenarios.map((scenario) =>
    scenario.id === targetId
      ? {
          ...scenario,
          status: 'PASS',
          observed: 'Real Toast button 打开任务 clicked; task opened.',
          evidence: [
            { path: 'evidence/toast.txt', sha256: fixture.evidenceSha, kind: 'screenshot' },
          ],
        }
      : scenario,
  );
}

afterEach(() => {
  while (temps.length) rmSync(temps.pop(), { recursive: true, force: true });
});

test('accepts a valid PASS with real evidence', () => {
  const fixture = fixtureRoot();
  fixture.scenarios = passScenario(fixture);
  const result = writeFixture(fixture);
  assert.equal(result.ok, true, result.errors.join('\n'));
});

test('rejects PASS without evidence', () => {
  const fixture = fixtureRoot();
  fixture.scenarios = passScenario(fixture).map((scenario) =>
    scenario.status === 'PASS' ? { ...scenario, evidence: [] } : scenario,
  );
  const result = writeFixture(fixture);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('requires at least one evidence')));
});

test('rejects PASS with empty observed', () => {
  const fixture = fixtureRoot();
  fixture.scenarios = passScenario(fixture).map((scenario) =>
    scenario.status === 'PASS' ? { ...scenario, observed: '   ' } : scenario,
  );
  const result = writeFixture(fixture);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('PASS observed')));
});

test('rejects missing evidence file', () => {
  const fixture = fixtureRoot();
  fixture.scenarios = passScenario(fixture).map((scenario) =>
    scenario.status === 'PASS'
      ? { ...scenario, evidence: [{ path: 'evidence/missing.txt', sha256: fixture.evidenceSha }] }
      : scenario,
  );
  const result = writeFixture(fixture);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('missing or unreadable')));
});

test('rejects wrong evidence hash', () => {
  const fixture = fixtureRoot();
  fixture.scenarios = passScenario(fixture).map((scenario) =>
    scenario.status === 'PASS'
      ? { ...scenario, evidence: [{ path: 'evidence/toast.txt', sha256: 'd'.repeat(64) }] }
      : scenario,
  );
  const result = writeFixture(fixture);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('evidence hash')));
});

test('rejects wrong run id', () => {
  const fixture = fixtureRoot();
  fixture.scenarios = passScenario(fixture).map((scenario) => ({
    ...scenario,
    runId: 'other-run',
  }));
  const result = writeFixture(fixture);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('runId mismatch')));
});

test('rejects wrong head SHA', () => {
  const fixture = fixtureRoot();
  fixture.scenarios = passScenario(fixture).map((scenario) => ({
    ...scenario,
    headSha: 'e'.repeat(40),
  }));
  const result = writeFixture(fixture);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('HEAD mismatch')));
});

test('rejects path traversal', () => {
  const fixture = fixtureRoot();
  fixture.scenarios = passScenario(fixture).map((scenario) =>
    scenario.status === 'PASS'
      ? { ...scenario, evidence: [{ path: '../outside.txt', sha256: fixture.evidenceSha }] }
      : scenario,
  );
  const result = writeFixture(fixture);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('traversal')));
});

test('allows NOT_RUN with null observed/evidence and rejects invalid status', () => {
  const fixture = fixtureRoot();
  const ok = writeFixture(fixture);
  assert.equal(ok.ok, true, ok.errors.join('\n'));

  const bad = writeFixture(fixture, (manual) => {
    manual.scenarios[0].status = 'MAYBE';
  });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((error) => error.includes('invalid status')));
});

test('rejects duplicate and missing canonical IDs', () => {
  const fixture = fixtureRoot();
  const duplicate = writeFixture(fixture, (manual) => {
    manual.scenarios[1].id = manual.scenarios[0].id;
  });
  assert.equal(duplicate.ok, false);
  assert.ok(duplicate.errors.some((error) => error.includes('duplicate scenario id')));

  const missing = writeFixture(fixture, (manual) => {
    manual.scenarios.pop();
  });
  assert.equal(missing.ok, false);
  assert.ok(missing.errors.some((error) => error.includes('scenario count')));
});

test('rejects wrong app or installer binary hash', () => {
  const fixture = fixtureRoot();
  const wrongApp = writeFixture(fixture, (manual) => {
    manual.scenarios[0].appExeSha256 = 'f'.repeat(64);
  });
  assert.equal(wrongApp.ok, false);
  assert.ok(wrongApp.errors.some((error) => error.includes('app binary hash')));

  const wrongInstaller = writeFixture(fixture, (manual) => {
    manual.scenarios[0].installerSha256 = null;
  });
  assert.equal(wrongInstaller.ok, false);
  assert.ok(wrongInstaller.errors.some((error) => error.includes('installer hash')));
});

test('rejects evidence symlink', (t) => {
  const fixture = fixtureRoot();
  const linkPath = join(fixture.root, 'evidence', 'link.txt');
  try {
    symlinkSync(join(fixture.root, 'evidence', 'toast.txt'), linkPath);
  } catch (error) {
    t.skip(`symlink unavailable: ${error.message}`);
    return;
  }
  fixture.scenarios = passScenario(fixture).map((scenario) =>
    scenario.status === 'PASS'
      ? { ...scenario, evidence: [{ path: 'evidence/link.txt', sha256: fixture.evidenceSha }] }
      : scenario,
  );
  const result = writeFixture(fixture);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('symlink')));
});

test('rejects evidence reached through a directory junction/symlink', (t) => {
  const fixture = fixtureRoot();
  const outside = mkdtempSync(join(tmpdir(), 'shishi-evidence-outside-'));
  temps.push(outside);
  writeFileSync(
    join(outside, 'toast.txt'),
    readFileSync(join(fixture.root, 'evidence', 'toast.txt')),
  );
  const junction = join(fixture.root, 'junction');
  try {
    symlinkSync(outside, junction, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    t.skip(`directory symlink unavailable: ${error.message}`);
    return;
  }
  fixture.scenarios = passScenario(fixture).map((scenario) =>
    scenario.status === 'PASS'
      ? { ...scenario, evidence: [{ path: 'junction/toast.txt', sha256: fixture.evidenceSha }] }
      : scenario,
  );
  const result = writeFixture(fixture);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('escapes')));
});

test('requires reason for FAIL and PARTIAL', () => {
  const fixture = fixtureRoot();
  const result = writeFixture(fixture, (manual) => {
    manual.scenarios[0].status = 'PARTIAL';
    manual.scenarios[0].observed = 'clicked but app did not open';
    manual.scenarios[0].reason = '';
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('reason')));
});

test('rejects unknown scenario ID', () => {
  const fixture = fixtureRoot();
  const result = writeFixture(fixture, (manual) => {
    manual.scenarios[0].id = 'unknown-scenario';
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('unknown scenario id')));
});
