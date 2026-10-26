#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateManualEvidence } from './manual-evidence.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const inventoryPath = join(here, 'manual-scenarios.json');
const checklistPath = join(here, 'manual-platform-acceptance.md');
const harnessPath = join(here, 'run-windows.ps1');

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));

export function validateInventory() {
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
  assert.ok(
    harness.includes('check-manual-scenarios.mjs'),
    'harness must run the evidence validator',
  );
  assert.ok(!harness.includes('toast-open-task'), 'duplicate legacy scenario must not remain');
  assert.ok(
    !harness.includes('pre-listener-rejection"'),
    'legacy singular rejection scenario must not remain in harness',
  );
  return { inventory, ids };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  if (args[0] === '--artifact-root') {
    const artifactRoot = args[1];
    const expectedHeadIndex = args.indexOf('--expected-head');
    const expectedHead = expectedHeadIndex >= 0 ? args[expectedHeadIndex + 1] : undefined;
    if (!artifactRoot) throw new Error('--artifact-root requires a path');
    const result = validateManualEvidence(artifactRoot, expectedHead);
    if (!result.ok) {
      console.error('manual evidence verification FAILED:');
      for (const error of result.errors) console.error(`- ${error}`);
      process.exit(1);
    }
    console.log(
      `manual evidence OK: ${result.manual.scenarios.length} scenarios, runId=${result.manual.runId}`,
    );
  } else {
    const { inventory } = validateInventory();
    const manifestPath = args[0];
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
        inventory.map((scenario) => scenario.id).sort(),
        'generated manifest IDs must exactly match the canonical inventory',
      );
    }
    console.log(`manual scenario inventory OK: ${inventory.length} unique scenarios`);
  }
}
