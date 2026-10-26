#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const SELF_EXCLUDED = new Set(['manifest.json', 'sha256sums.txt']);

function readJson(root, name) {
  return JSON.parse(readFileSync(join(root, name), 'utf8').replace(/^\uFEFF/, ''));
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function walk(root) {
  const out = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function atomicWrite(path, content) {
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, content);
  renameSync(temp, path);
}

/**
 * Finalize an artifact root idempotently.
 *
 * 1. business results (manual/platform) are already written;
 * 2. evidence-index is written with a complete inventory (including itself);
 * 3. sha256sums covers every file except manifest.json and itself;
 * 4. manifest.files is updated last.
 *
 * The manifest and checksum file are explicit self-reference exclusions.
 */
export function finalizeEvidence(root) {
  const manifest = readJson(root, 'manifest.json');
  const manual = readJson(root, 'manual-platform.json');
  const platform = readJson(root, 'platform-results.json');
  const generatedAt = manifest.finishedAt ?? new Date().toISOString();

  platform.generatedAt = generatedAt;
  atomicWrite(join(root, 'platform-results.json'), JSON.stringify(platform, null, 2));

  const beforeIndex = walk(root)
    .map((file) => relative(root, file).replaceAll('\\', '/'))
    .filter((rel) => !SELF_EXCLUDED.has(rel))
    .sort();
  const inventory = Array.from(new Set([...beforeIndex, 'evidence-index.json'])).sort();
  const evidence = {
    schemaVersion: 1,
    runId: manifest.runId,
    headSha: manifest.gitCommit,
    appExeSha256: manifest.appExeSha256,
    installerSha256: manifest.installerSha256 ?? null,
    generatedAt,
    scenarios: manual.scenarios.map((scenario) => ({
      id: scenario.id,
      status: scenario.status,
      evidence: scenario.evidence ?? [],
    })),
    files: inventory,
  };
  atomicWrite(join(root, 'evidence-index.json'), JSON.stringify(evidence, null, 2));

  const hashFiles = walk(root)
    .map((file) => relative(root, file).replaceAll('\\', '/'))
    .filter((rel) => !SELF_EXCLUDED.has(rel))
    .sort();
  const sums = hashFiles.map((rel) => `${sha256(join(root, rel))}  ${rel}`);
  atomicWrite(join(root, 'sha256sums.txt'), `${sums.join('\n')}\n`);

  manifest.files = Array.from(new Set([...(manifest.files ?? []), ...hashFiles, 'sha256sums.txt']));
  atomicWrite(join(root, 'manifest.json'), JSON.stringify(manifest, null, 2));

  return { ok: true, runId: manifest.runId, inventory, files: hashFiles.length };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const rootIndex = process.argv.indexOf('--artifact-root');
  if (rootIndex < 0 || !process.argv[rootIndex + 1]) {
    console.error('usage: finalize-native-qa-evidence --artifact-root <dir>');
    process.exit(2);
  }
  const result = finalizeEvidence(process.argv[rootIndex + 1]);
  console.log(JSON.stringify(result, null, 2));
}
