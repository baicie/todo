#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const rootIndex = process.argv.indexOf('--artifact-root');
if (rootIndex < 0 || !process.argv[rootIndex + 1]) {
  console.error('usage: finalize-native-qa-evidence --artifact-root <dir>');
  process.exit(2);
}
const root = process.argv[rootIndex + 1];
const readJson = (name) =>
  JSON.parse(readFileSync(join(root, name), 'utf8').replace(/^\uFEFF/, ''));
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

const manifest = readJson('manifest.json');
const manual = readJson('manual-platform.json');
const platform = readJson('platform-results.json');
const files = walk(root)
  .map((file) => ({ path: relative(root, file).replaceAll('\\', '/'), file }))
  .filter(({ path: rel }) => rel !== 'manifest.json' && rel !== 'sha256sums.txt')
  .sort((a, b) => a.path.localeCompare(b.path));

platform.generatedAt = new Date().toISOString();
writeFileSync(join(root, 'platform-results.json'), JSON.stringify(platform, null, 2));

const evidence = {
  schemaVersion: 1,
  runId: manifest.runId,
  headSha: manifest.gitCommit,
  appExeSha256: manifest.appExeSha256,
  installerSha256: manifest.installerSha256 ?? null,
  generatedAt: new Date().toISOString(),
  scenarios: manual.scenarios.map((scenario) => ({
    id: scenario.id,
    status: scenario.status,
    evidence: scenario.evidence ?? [],
  })),
  files: files.map(({ path: rel }) => rel),
};
writeFileSync(join(root, 'evidence-index.json'), JSON.stringify(evidence, null, 2));

const sums = files.map(({ path: rel, file }) => `${sha256(file)}  ${rel}`);
writeFileSync(join(root, 'sha256sums.txt'), `${sums.join('\n')}\n`);

manifest.files = Array.from(
  new Set([...(manifest.files ?? []), ...files.map(({ path: rel }) => rel), 'sha256sums.txt']),
);
writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest, null, 2));

console.log(
  JSON.stringify(
    {
      ok: true,
      runId: manifest.runId,
      files: files.length,
      scenarios: manual.scenarios.length,
    },
    null,
    2,
  ),
);
