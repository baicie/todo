#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const inventoryPath = join(here, 'manual-scenarios.json');
const checklistPath = join(here, 'manual-platform-acceptance.md');
const harnessPath = join(here, 'run-windows.ps1');

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));

const inventory = readJson(inventoryPath);
const checklist = readFileSync(checklistPath, 'utf8');
const harness = readFileSync(harnessPath, 'utf8');

assert.ok(Array.isArray(inventory), 'manual-scenarios.json must be an array');
assert.equal(inventory.length, 10, 'manual inventory must contain exactly 10 scenarios');

const ids = inventory.map((scenario) => scenario.id);
assert.equal(new Set(ids).size, ids.length, 'scenario IDs must be unique');
for (const scenario of inventory) {
  assert.match(scenario.id, /^[a-z][a-z0-9-]*$/, `invalid scenario id: ${scenario.id}`);
  assert.ok(scenario.title?.length > 0, 'scenario title required');
  assert.ok(scenario.expected?.length > 0, 'scenario expected result required');
  assert.ok(checklist.includes(scenario.id), `checklist missing scenario id: ${scenario.id}`);
}

assert.ok(harness.includes('manual-scenarios.json'), 'harness must read the canonical inventory');
assert.ok(!harness.includes('toast-open-task'), 'duplicate legacy scenario must not remain in harness');
assert.ok(
  !harness.includes('pre-listener-rejection"'),
  'legacy singular rejection scenario must not remain in harness',
);

const manifestPath = process.argv[2];
if (manifestPath) {
  const manifest = readJson(manifestPath);
  assert.ok(Array.isArray(manifest.scenarios), 'manifest scenarios must be an array');
  const manifestIds = manifest.scenarios.map((scenario) => scenario.id);
  assert.equal(
    new Set(manifestIds).size,
    manifestIds.length,
    'manifest scenario IDs must be unique',
  );
  assert.deepEqual(
    [...manifestIds].sort(),
    [...ids].sort(),
    'generated manifest IDs must exactly match the canonical inventory',
  );
  for (const scenario of manifest.scenarios) {
    assert.ok(['NOT_RUN', 'PASS', 'FAIL', 'PARTIAL'].includes(scenario.status), scenario.id);
    assert.equal(typeof scenario.expected, 'string', `${scenario.id} expected`);
    assert.ok('observed' in scenario, `${scenario.id} observed field`);
    assert.ok('evidence' in scenario, `${scenario.id} evidence field`);
  }
}

console.log(`manual scenario inventory OK: ${inventory.length} unique scenarios`);
