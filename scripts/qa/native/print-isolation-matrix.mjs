#!/usr/bin/env node
/**
 * Prints the install / data / credential / notification isolation matrix that
 * a QA run relies on. Used by the acceptance report and by the operator before
 * installing, so the paths being claimed are derived from the configs rather
 * than retyped into a document.
 *
 * This is a static derivation: it reads the identity module and the configs. It
 * does not inspect a running system and cannot by itself prove an install is
 * isolated - that is what the install-time evidence is for.
 */
import { join } from 'node:path';
import {
  DEV_IDENTIFIER,
  PRODUCTION_DATA_ROOT_DIRNAME,
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

const appData = process.env.APPDATA ?? join('%APPDATA%');
const localAppData = process.env.LOCALAPPDATA ?? join('%LOCALAPPDATA%');
const installRoots = qaInstallRoots(localAppData);

const rows = [
  ['release candidate', QA_RELEASE_CANDIDATE, '-', '-'],
  ['product name', QA_PRODUCT_NAME, 'Shishi Dev', 'Shishi'],
  ['version', QA_PRODUCT_VERSION, '0.0.1-dev.1', '0.0.1-dev.1'],
  ['tauri identifier', QA_IDENTIFIER, DEV_IDENTIFIER, STABLE_IDENTIFIER],
  [
    'data root',
    join(appData, QA_DATA_ROOT_DIRNAME),
    join(appData, DEV_IDENTIFIER),
    join(appData, PRODUCTION_DATA_ROOT_DIRNAME),
  ],
  [
    'credential service',
    QA_CREDENTIAL_SERVICE,
    'app.shishi.todo.dev.secure-token',
    'app.shishi.todo.secure-token',
  ],
  ['Windows AUMID', QA_IDENTIFIER, DEV_IDENTIFIER, STABLE_IDENTIFIER],
  [
    'install directory',
    installRoots[0] ?? '-',
    join(localAppData, 'Shishi Dev'),
    join(localAppData, 'Shishi'),
  ],
  ['uninstall entry', QA_PRODUCT_NAME, 'Shishi Dev', 'Shishi'],
  ['start menu shortcut', qaStartMenuShortcut(appData) ?? '-', 'Shishi Dev.lnk', 'Shishi.lnk'],
];

const widths = [0, 0, 0, 0];
for (const row of rows)
  row.forEach((cell, i) => (widths[i] = Math.max(widths[i], String(cell).length)));
const line = (cells) => cells.map((cell, i) => String(cell).padEnd(widths[i])).join('  |  ');

console.log(line(['field', 'QA', 'Dev', 'Stable']));
console.log(widths.map((width) => '-'.repeat(width)).join('--+--'));
for (const row of rows) console.log(line(row));
