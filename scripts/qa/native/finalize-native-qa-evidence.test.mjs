import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { finalizeEvidence } from './finalize-native-qa-evidence.mjs';

const temps = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'shishi-finalize-'));
  temps.push(root);
  const manifest = {
    runId: 'run-1',
    gitCommit: 'a'.repeat(40),
    appExeSha256: 'b'.repeat(64),
    installerSha256: 'c'.repeat(64),
    finishedAt: '2026-10-26T00:00:00Z',
    files: [],
  };
  writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest));
  writeFileSync(
    join(root, 'manual-platform.json'),
    JSON.stringify({ schemaVersion: 2, runId: 'run-1', scenarios: [], evidence: [] }),
  );
  writeFileSync(
    join(root, 'platform-results.json'),
    JSON.stringify({ schemaVersion: 1, runId: 'run-1', windowsPlatformReady: false }),
  );
  writeFileSync(join(root, 'business.txt'), 'business result');
  return root;
}

afterEach(() => {
  while (temps.length) rmSync(temps.pop(), { recursive: true, force: true });
});

test('first finalize includes evidence-index and checksums it', () => {
  const root = fixture();
  finalizeEvidence(root);
  const sums = readFileSync(join(root, 'sha256sums.txt'), 'utf8');
  assert.match(sums, /  evidence-index\.json$/m);
  assert.match(sums, /  platform-results\.json$/m);
  assert.doesNotMatch(sums, /  manifest\.json$/m);
  assert.doesNotMatch(sums, /  sha256sums\.txt$/m);
  const index = JSON.parse(readFileSync(join(root, 'evidence-index.json'), 'utf8'));
  assert.ok(index.files.includes('evidence-index.json'));
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
  assert.ok(manifest.files.includes('evidence-index.json'));
  assert.ok(manifest.files.includes('sha256sums.txt'));
});

test('second finalize is deterministic and includes the existing index', () => {
  const root = fixture();
  finalizeEvidence(root);
  const first = readFileSync(join(root, 'sha256sums.txt'), 'utf8');
  const firstManifest = readFileSync(join(root, 'manifest.json'), 'utf8');
  finalizeEvidence(root);
  assert.equal(readFileSync(join(root, 'sha256sums.txt'), 'utf8'), first);
  assert.deepEqual(
    JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')).files,
    JSON.parse(firstManifest).files,
  );
});

test('new result file is added on the next finalize', () => {
  const root = fixture();
  finalizeEvidence(root);
  writeFileSync(join(root, 'video.mp4'), 'new evidence');
  finalizeEvidence(root);
  const sums = readFileSync(join(root, 'sha256sums.txt'), 'utf8');
  assert.match(sums, /  video\.mp4$/m);
  const index = JSON.parse(readFileSync(join(root, 'evidence-index.json'), 'utf8'));
  assert.ok(index.files.includes('video.mp4'));
});

test('missing mandatory business input fails', () => {
  const root = fixture();
  rmSync(join(root, 'manual-platform.json'));
  assert.throws(() => finalizeEvidence(root));
});
