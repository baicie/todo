#!/usr/bin/env node
/**
 * Generate a CycloneDX 1.5 SBOM for the JavaScript workspace.
 *
 * Usage: node scripts/ops/sbom.mjs [output]
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const output = resolve(process.argv[2] ?? 'artifacts/sbom.cdx.json');
const raw = execFileSync('pnpm', ['list', '-r', '--json', '--depth=Infinity'], {
  encoding: 'utf8',
  shell: process.platform === 'win32',
  maxBuffer: 32 * 1024 * 1024,
});
const projects = JSON.parse(raw);
const components = new Map();

function visit(dependencies) {
  for (const [name, info] of Object.entries(dependencies ?? {})) {
    if (!info || typeof info !== 'object') continue;
    const version = info.version ?? 'unknown';
    const key = `${name}@${version}`;
    if (!components.has(key)) {
      components.set(key, {
        'bom-ref': key,
        type: 'library',
        name,
        version,
        purl: `pkg:npm/${name.replace('/', '%2f')}@${version}`,
      });
    }
    visit(info.dependencies);
  }
}

for (const project of projects) visit(project.dependencies);

const bom = {
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    tools: [{ vendor: 'Shishi', name: 'shishi-sbom', version: '1.0.0' }],
  },
  components: [...components.values()].sort((a, b) => a['bom-ref'].localeCompare(b['bom-ref'])),
};

mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(bom, null, 2)}\n`, 'utf8');
console.log(`Wrote ${output} (${bom.components.length} components)`);
