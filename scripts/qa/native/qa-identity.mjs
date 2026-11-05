/**
 * The one place the QA build identity is defined.
 *
 * Why this file exists: `Shishi QA RC2D` / `1.0.0-rc2d` were copy-pasted into
 * the harness policy, the executable verifier, two PowerShell diagnostics and
 * the CI artifact name. Bumping the QA build for a new release candidate meant
 * editing all of them, and a missed one does not fail loudly - it silently makes
 * the harness reject the package it was just asked to validate, or accept a
 * stale one. Every consumer now imports this module, and
 * `qa-identity.test.mjs` pins the config, the derived values and the
 * absence of stale literals.
 *
 * The identifier is deliberately NOT derived from the product name:
 *   - `app.shishi.todo.qa` is the install/credential/AUMID namespace and must
 *     stay stable across QA builds, or every QA build would orphan the previous
 *     one's data and credentials.
 *   - The product name carries the human-readable release candidate and may
 *     change per build; it only affects the display name, the NSIS install
 *     directory and the uninstall entry.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(here, '..', '..', '..');
export const QA_CONFIG_PATH = join(REPO_ROOT, 'apps', 'native', 'src-tauri', 'tauri.qa.conf.json');
export const STABLE_CONFIG_PATH = join(REPO_ROOT, 'apps', 'native', 'src-tauri', 'tauri.conf.json');
export const DEV_CONFIG_PATH = join(
  REPO_ROOT,
  'apps',
  'native',
  'src-tauri',
  'tauri.dev.conf.json',
);

/** QA installs, credentials and notifications must never share these. */
export const QA_IDENTIFIER = 'app.shishi.todo.qa';
export const STABLE_IDENTIFIER = 'app.shishi.todo';
export const DEV_IDENTIFIER = 'app.shishi.todo.dev';

/**
 * Data roots are the Tauri identifier verbatim: `app.path().app_data_dir()` is
 * `%APPDATA%\<identifier>`. Kept as separate constants because the harness
 * compares them as directory names, not as identifiers.
 */
export const QA_DATA_ROOT_DIRNAME = QA_IDENTIFIER;
export const PRODUCTION_DATA_ROOT_DIRNAME = STABLE_IDENTIFIER;

/**
 * The QA credential namespace. It predates channel isolation and is NOT derived
 * from the identifier: existing QA refresh tokens live under this exact string
 * (`build_identity.rs::Channel::Qa`), so changing it would strand them. Pinned
 * by the Rust packaging contract and by `qa-identity.test.mjs`.
 */
export const QA_CREDENTIAL_SERVICE = 'app.shishi.todo.rc2d-qa.secure-token';

/**
 * Which release candidate this QA build validates. Update this, the config's
 * `version`, and `productName` together; the test asserts they agree.
 */
export const QA_RELEASE_CANDIDATE = 'V1.1-RC1';

function readConfig(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

const qaConfig = readConfig(QA_CONFIG_PATH);

/** `Shishi QA V1.1-RC1` - the NSIS display name, install directory and uninstall entry. */
export const QA_PRODUCT_NAME = qaConfig.productName;
/** Semantic version of the QA build, independent of the app's `0.0.1-dev.N`. */
export const QA_PRODUCT_VERSION = qaConfig.version;
/** The identifier baked into the binary; must equal QA_IDENTIFIER. */
export const QA_CONFIG_IDENTIFIER = qaConfig.identifier;

/** NSIS writes `%LOCALAPPDATA%\<productName>`, or `...\Programs\<productName>` in per-machine mode. */
export function qaInstallRoots(localAppData) {
  if (!localAppData) return [];
  return [join(localAppData, QA_PRODUCT_NAME), join(localAppData, 'Programs', QA_PRODUCT_NAME)];
}

/** The Start Menu shortcut the notification diagnostics look for. */
export function qaStartMenuShortcut(appData) {
  if (!appData) return null;
  return join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', `${QA_PRODUCT_NAME}.lnk`);
}

/**
 * CLI for the PowerShell probes, which cannot import an ES module:
 *   node scripts/qa/native/qa-identity.mjs --field productName
 * Prints one value and exits 0, so `$(...)` in PowerShell is the value itself.
 */
function runCli(argv) {
  const index = argv.indexOf('--field');
  if (index === -1) {
    process.stdout.write(
      JSON.stringify(
        {
          releaseCandidate: QA_RELEASE_CANDIDATE,
          productName: QA_PRODUCT_NAME,
          version: QA_PRODUCT_VERSION,
          identifier: QA_CONFIG_IDENTIFIER,
          credentialService: QA_CREDENTIAL_SERVICE,
        },
        null,
        2,
      ) + '\n',
    );
    return;
  }
  const field = argv[index + 1];
  const fields = {
    releaseCandidate: QA_RELEASE_CANDIDATE,
    productName: QA_PRODUCT_NAME,
    version: QA_PRODUCT_VERSION,
    identifier: QA_CONFIG_IDENTIFIER,
    credentialService: QA_CREDENTIAL_SERVICE,
  };
  if (!(field in fields)) {
    process.stderr.write(`unknown field ${JSON.stringify(field)}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(fields[field] + '\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runCli(process.argv.slice(2));
}
