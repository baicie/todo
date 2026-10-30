//! QA-only fault injection configuration and isolated fixtures.
//!
//! This module is compiled only with the `native-qa` feature. It is armed by an
//! explicit process argument, never by an environment variable or a WebView
//! command. The build refuses to run unless the Tauri identifier is the QA
//! identifier, so a QA binary cannot accidentally write a production data root.
//!
//! # Evidence write boundary (threat model)
//!
//! `--rc2d-fault-config` names a JSON file supplied by whoever launches the QA
//! binary, so the `evidencePath` inside it is attacker-controlled input as far as
//! the evidence writer is concerned. The writer therefore treats the configured
//! path as a *directory root plus one file name*, never as a trusted path:
//!
//! 1. The final component is validated as a single inert file name (ASCII
//!    alphanumerics plus `.`, `-` and `_`, at most 128 bytes, no NUL, no Windows
//!    reserved device name). A name that cannot contain a separator cannot
//!    traverse, so `..` escapes are structurally impossible instead of being
//!    caught by a string comparison. `..` components in the root are rejected as
//!    well.
//! 2. The root (the configured path's parent) is created, canonicalized once and
//!    authorized *after* canonicalization. Authorization is fail-closed: the
//!    canonical root must not be inside the canonical Stable data root or the
//!    canonical Dev data root, and must be inside either the canonical QA app
//!    data directory or, when the configured path was RELATIVE, the canonical
//!    working directory tree. The file is then opened at
//!    `canonical_root.join(file_name)`, so a root that only looks
//!    approved lexically (the `..\..\app.shishi.todo` trick) is rejected on its
//!    resolved path, and an unauthorized location is refused instead of being
//!    redirected somewhere else.
//! 3. The opened handle is inspected rather than the path string: the evidence
//!    file is opened with `FILE_FLAG_OPEN_REPARSE_POINT`, which never follows a
//!    final symlink/junction, and the handle metadata must not carry
//!    `FILE_ATTRIBUTE_REPARSE_POINT` or the directory bit. That closes both the
//!    check-then-open (TOCTOU) window for the final component and the
//!    "junction planted in the evidence tree" redirect. Directories this module
//!    creates are re-inspected for reparse points right after creation, and a
//!    pre-existing junction above the root is neutralized by canonicalizing the
//!    root before authorization.
//! 4. Evidence is opened append-only (`create(true).append(true)`): an existing
//!    file is appended to and never truncated, and a directory sitting at the
//!    target is an error rather than something to write through.
//!
//! Every rejection is an error that names the offending path and the reason; the
//! writer never falls back to a different location.
//!
//! Residual risk, stated rather than hidden: for a RELATIVE evidence path the
//! approved set includes the process working directory tree, because the
//! documented QA automation passes a relative `artifacts/native-qa/...` path
//! (see `scripts/qa/native/fault-config.example.json`). Anything that can launch the
//! QA binary and write its config can therefore create or append files under the
//! working directory tree by choosing a relative path. An ABSOLUTE evidence path
//! is only accepted inside the QA app data directory, so
//! `scripts/qa/native/run-windows.ps1` (which rewrites `evidencePath` to
//! `%APPDATA%\app.shishi.todo.qa\evidence\fault-<runId>.jsonl`) keeps working while
//! an absolute artifact-tree path does not silently succeed. The writer cannot
//! reach the Stable or Dev data roots, cannot truncate existing evidence, and
//! cannot be redirected by a link at the final component. The A2.1 identifier
//! gate keeps this module out of every non-QA build.

use std::{
    collections::HashMap,
    ffi::OsStr,
    fs::{self, File, OpenOptions},
    io::{self, Seek, SeekFrom, Write},
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex},
};

use serde::Deserialize;
use tauri::{AppHandle, Manager};
use todo_native_accounts::{FaultAction, FaultEvent, FaultEvidence, FaultInjector, FaultPoint};

use crate::secure_tokens::{self, CredentialBackend};

/// A2.1: the only identifier allowed to arm fault injection and QA evidence.
const QA_IDENTIFIER: &str = "app.shishi.todo.qa";
/// Stable (production) data root name, a sibling of the QA data root.
const STABLE_DATA_ROOT_NAME: &str = "app.shishi.todo";
/// Dev data root name, a sibling of the QA data root.
const DEV_DATA_ROOT_NAME: &str = "app.shishi.todo.dev";
/// Longest accepted evidence file name, in bytes.
const MAX_EVIDENCE_FILE_NAME_BYTES: usize = 128;
/// `FILE_ATTRIBUTE_REPARSE_POINT`: the handle is a symlink/junction/mount point.
#[cfg(windows)]
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
/// `FILE_FLAG_OPEN_REPARSE_POINT`: open the link itself instead of its target.
#[cfg(windows)]
const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FaultConfig {
    evidence_path: PathBuf,
    #[serde(default)]
    rules: Vec<FaultRule>,
    #[serde(default)]
    credential_backend: CredentialBackendKind,
}

#[derive(Debug, Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "snake_case")]
enum CredentialBackendKind {
    #[default]
    Os,
    Memory,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct FaultRule {
    point: FaultPoint,
    action: Action,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Action {
    Error { code: String, message: String },
    Block { duration_ms: u64 },
    Terminate { exit_code: i32 },
}

impl From<Action> for FaultAction {
    fn from(action: Action) -> Self {
        match action {
            Action::Error { code, message } => Self::Error { code, message },
            Action::Block { duration_ms } => Self::Block { duration_ms },
            Action::Terminate { exit_code } => Self::Terminate { exit_code },
        }
    }
}

struct FileInjector {
    rules: Mutex<HashMap<FaultPoint, FaultAction>>,
    evidence: Mutex<File>,
}

impl FaultInjector for FileInjector {
    fn decide(&self, event: &FaultEvent) -> Option<FaultAction> {
        self.rules
            .lock()
            .ok()
            .and_then(|rules| rules.get(&event.point).cloned())
    }

    fn record(&self, evidence: &FaultEvidence) {
        if let Ok(mut file) = self.evidence.lock()
            && let Ok(line) = serde_json::to_string(evidence)
        {
            // Explicitly seek to EOF as well as opening with append: this is
            // robust against a sparse/preallocated evidence file left by a
            // previous Windows run, which otherwise can produce NUL records.
            let _ = file.seek(SeekFrom::End(0));
            let _ = writeln!(file, "{line}");
            let _ = file.flush();
            let _ = file.sync_data();
        }
    }
}

#[derive(Default)]
struct MemoryCredentialBackend {
    values: Mutex<HashMap<String, String>>,
}

impl CredentialBackend for MemoryCredentialBackend {
    fn get(&self, key: &str) -> Result<Option<String>, String> {
        Ok(self
            .values
            .lock()
            .map_err(|_| "QA credential store poisoned".to_owned())?
            .get(key)
            .cloned())
    }

    fn set(&self, key: &str, value: &str) -> Result<(), String> {
        self.values
            .lock()
            .map_err(|_| "QA credential store poisoned".to_owned())?
            .insert(key.to_owned(), value.to_owned());
        Ok(())
    }

    fn delete(&self, key: &str) -> Result<(), String> {
        self.values
            .lock()
            .map_err(|_| "QA credential store poisoned".to_owned())?
            .remove(key);
        Ok(())
    }
}

fn argument_value(name: &str) -> Option<PathBuf> {
    let args: Vec<String> = std::env::args().collect();
    args.windows(2)
        .find(|pair| pair[0] == name)
        .map(|pair| PathBuf::from(&pair[1]))
}

/// A2.1 gate. Kept as a pure function so the refusal is testable without a
/// running Tauri app; `initialize` always calls it with the identifier embedded
/// in the binary.
fn require_qa_identifier(identifier: &str) -> Result<(), String> {
    if identifier == QA_IDENTIFIER {
        Ok(())
    } else {
        Err(format!(
            "QA fault injection refused for non-QA identifier {identifier}; only {QA_IDENTIFIER} may arm --rc2d-fault-config"
        ))
    }
}

/// Canonical filesystem anchors an evidence path is authorized against.
#[derive(Debug)]
struct EvidenceRoots {
    /// Canonical QA app data directory (`%APPDATA%\app.shishi.todo.qa`).
    qa_app_data_dir: PathBuf,
    /// Canonical Stable (production) data root.
    stable_data_root: PathBuf,
    /// Canonical Dev data root.
    dev_data_root: PathBuf,
    /// Canonical process working directory, the base for relative evidence paths.
    working_dir: PathBuf,
}

/// A validated evidence request: a directory root plus one inert file name.
#[derive(Debug)]
struct EvidenceRequest {
    root: PathBuf,
    file_name: String,
}

/// Compares two path components, matching Windows filesystem semantics where
/// file names are case-insensitive.
#[cfg(windows)]
fn component_eq(left: Component<'_>, right: Component<'_>) -> bool {
    left.as_os_str()
        .to_string_lossy()
        .eq_ignore_ascii_case(&right.as_os_str().to_string_lossy())
}

#[cfg(not(windows))]
fn component_eq(left: Component<'_>, right: Component<'_>) -> bool {
    left == right
}

/// True when `candidate` is `root` or sits below it. Components are compared
/// instead of string prefixes so `app.shishi.todo.qa` never counts as being
/// inside `app.shishi.todo`.
fn path_contains(root: &Path, candidate: &Path) -> bool {
    let mut candidate_components = candidate.components();
    for root_component in root.components() {
        let Some(candidate_component) = candidate_components.next() else {
            return false;
        };
        if !component_eq(root_component, candidate_component) {
            return false;
        }
    }
    true
}

/// Resolves `path` as far as it exists on disk, then appends the missing tail
/// lexically, so anchors can be compared before the directories exist.
fn canonicalize_lenient(path: &Path) -> Result<PathBuf, String> {
    let mut missing = Vec::new();
    let mut current = path.to_path_buf();
    loop {
        match fs::canonicalize(&current) {
            Ok(mut resolved) => {
                for component in missing.iter().rev() {
                    resolved.push(component);
                }
                return Ok(resolved);
            }
            Err(error) => {
                let Some(name) = current.file_name().map(OsStr::to_os_string) else {
                    return Err(format!(
                        "unable to resolve {} against the filesystem: {error}",
                        path.display()
                    ));
                };
                missing.push(name);
                let Some(parent) = current.parent() else {
                    return Err(format!(
                        "unable to resolve {} against the filesystem: {error}",
                        path.display()
                    ));
                };
                current = parent.to_path_buf();
            }
        }
    }
}

/// Validates the final component of a configured evidence path as an inert file
/// name that cannot address anything except a direct child of the evidence root.
fn validate_evidence_file_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err(
            "QA evidence file name is empty; expected a single file name such as fault-evidence.jsonl"
                .to_owned(),
        );
    }
    if name.len() > MAX_EVIDENCE_FILE_NAME_BYTES {
        return Err(format!(
            "QA evidence file name {name:?} is {} bytes; at most {MAX_EVIDENCE_FILE_NAME_BYTES} bytes are allowed",
            name.len()
        ));
    }
    if matches!(name, "." | "..") {
        return Err(format!(
            "QA evidence file name {name:?} is a directory reference; expected a regular file name"
        ));
    }
    if name.contains('\0') {
        return Err("QA evidence file name must not contain a NUL character".to_owned());
    }
    if let Some(invalid) = name.chars().find(|character| {
        !(character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_'))
    }) {
        return Err(format!(
            "QA evidence file name {name:?} contains {invalid:?}; only ASCII letters, digits, '.', '-' and '_' are allowed"
        ));
    }
    if name.ends_with('.') || name.ends_with(' ') {
        return Err(format!(
            "QA evidence file name {name:?} must not end with '.' or a space"
        ));
    }
    const RESERVED_DEVICE_NAMES: [&str; 22] = [
        "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8",
        "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
    ];
    let stem = name.split('.').next().unwrap_or(name);
    if RESERVED_DEVICE_NAMES
        .iter()
        .any(|reserved| stem.eq_ignore_ascii_case(reserved))
    {
        return Err(format!(
            "QA evidence file name {name:?} uses the reserved Windows device name {stem:?}"
        ));
    }
    Ok(())
}

/// Splits a configured evidence path into an evidence directory root and a
/// validated single file name. Pure: it never touches the filesystem.
fn split_evidence_path(configured: &Path) -> Result<EvidenceRequest, String> {
    if configured.as_os_str().is_empty() {
        return Err(
            "QA evidence path is empty; expected a file path such as artifacts/native-qa/example/fault-evidence.jsonl"
                .to_owned(),
        );
    }
    // A trailing separator would make file_name() silently report the last
    // directory, and the evidence would land in a file named after it.
    let raw = configured.as_os_str().to_string_lossy();
    if raw.ends_with('/') || raw.ends_with('\\') {
        return Err(format!(
            "QA evidence path {raw} ends with a separator; name the evidence file explicitly"
        ));
    }
    let Some(file_name) = configured.file_name().and_then(OsStr::to_str) else {
        return Err(format!(
            "QA evidence path {} does not end in a file name; expected ...<directory>/<file>.jsonl",
            configured.display()
        ));
    };
    validate_evidence_file_name(file_name)?;
    let root = configured
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    if root
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return Err(format!(
            "QA evidence directory {} must not contain '..' components; name the evidence directory directly",
            root.display()
        ));
    }
    Ok(EvidenceRequest {
        root: root.to_path_buf(),
        file_name: file_name.to_owned(),
    })
}

/// Fail-closed authorization of an already canonicalized evidence root.
///
/// `relative` is true when the configured evidence path was relative, which
/// is the only case in which the working directory tree is an approved QA
/// location.
fn authorize_evidence_root(
    canonical_root: &Path,
    roots: &EvidenceRoots,
    relative: bool,
) -> Result<(), String> {
    for (label, protected) in [
        ("Stable", &roots.stable_data_root),
        ("Dev", &roots.dev_data_root),
    ] {
        if path_contains(protected, canonical_root) {
            return Err(format!(
                "QA evidence root {} is inside the {label} data root {}; QA evidence must never be written into another identifier's data",
                canonical_root.display(),
                protected.display()
            ));
        }
    }
    if path_contains(&roots.qa_app_data_dir, canonical_root) {
        return Ok(());
    }
    if relative && path_contains(&roots.working_dir, canonical_root) {
        return Ok(());
    }
    Err(format!(
        "QA evidence root {} is not an approved QA location; expected a directory inside the QA app data directory {}, or a relative evidence path inside the process working directory {}",
        canonical_root.display(),
        roots.qa_app_data_dir.display(),
        roots.working_dir.display()
    ))
}

/// Absolute directories that `create_dir_all` is about to create, shallowest first.
fn missing_components(path: &Path) -> Result<Vec<PathBuf>, String> {
    let mut missing: Vec<PathBuf> = Vec::new();
    let mut current = path.to_path_buf();
    while !current.exists() {
        missing.push(current.clone());
        let Some(parent) = current.parent() else {
            return Err(format!(
                "unable to locate an existing ancestor of QA evidence directory {}",
                path.display()
            ));
        };
        current = parent.to_path_buf();
    }
    missing.reverse();
    Ok(missing)
}

/// Refuses a directory this writer created when it is a reparse point, i.e. when
/// a junction or symlink redirects evidence writing somewhere else.
fn verify_created_directories(created: &[PathBuf]) -> Result<(), String> {
    for directory in created {
        let metadata = fs::symlink_metadata(directory).map_err(|error| {
            format!(
                "unable to inspect QA evidence directory {}: {error}",
                directory.display()
            )
        })?;
        if !metadata.is_dir() {
            return Err(format!(
                "QA evidence directory {} is not a directory",
                directory.display()
            ));
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
                return Err(format!(
                    "QA evidence directory {} is a reparse point (symlink/junction); refusing to write QA evidence through a redirect",
                    directory.display()
                ));
            }
        }
    }
    Ok(())
}

/// Refuses a target that already exists as a directory. The authoritative check
/// happens on the opened handle; this one only produces a clearer message.
fn reject_existing_directory(target: &Path) -> Result<(), String> {
    match fs::symlink_metadata(target) {
        Ok(metadata) if metadata.is_dir() => Err(format!(
            "QA evidence target {} already exists as a directory; QA evidence must be a regular file",
            target.display()
        )),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!(
            "unable to inspect QA evidence target {}: {error}",
            target.display()
        )),
    }
}

/// Verifies the OPENED handle instead of the path, so a link swapped in between
/// the checks and the open is still observed.
fn verify_opened_evidence(file: &File, target: &Path, canonical_root: &Path) -> Result<(), String> {
    let metadata = file.metadata().map_err(|error| {
        format!(
            "unable to inspect the opened QA evidence handle {}: {error}",
            target.display()
        )
    })?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(format!(
                "QA evidence target {} is a reparse point (symlink/junction); refusing to append through a redirect",
                target.display()
            ));
        }
    }
    if !metadata.is_file() {
        return Err(format!(
            "QA evidence target {} is not a regular file; refusing to append",
            target.display()
        ));
    }
    let canonical_target = fs::canonicalize(target).map_err(|error| {
        format!(
            "unable to canonicalize the QA evidence target {}: {error}",
            target.display()
        )
    })?;
    if !path_contains(canonical_root, &canonical_target) {
        return Err(format!(
            "QA evidence target {} resolves to {} which is outside the validated evidence root {}; refusing to append",
            target.display(),
            canonical_target.display(),
            canonical_root.display()
        ));
    }
    Ok(())
}

/// Opens the evidence file described by `configured` under `roots`, or fails.
fn open_evidence_in(configured: &Path, roots: &EvidenceRoots) -> Result<File, String> {
    let request = split_evidence_path(configured)?;
    // A relative configuration entry resolves against the process working
    // directory, exactly where the previous implementation put it; resolving it
    // against the canonical anchor keeps the location identical and makes it
    // explicit for the authorization below.
    let relative = request.root.is_relative();
    let requested_root = if relative {
        roots.working_dir.join(&request.root)
    } else {
        request.root.clone()
    };
    let created = missing_components(&requested_root)?;
    fs::create_dir_all(&requested_root).map_err(|error| {
        format!(
            "unable to create QA evidence directory {}: {error}",
            requested_root.display()
        )
    })?;
    verify_created_directories(&created)?;
    let canonical_root = fs::canonicalize(&requested_root).map_err(|error| {
        format!(
            "unable to canonicalize QA evidence directory {}: {error}",
            requested_root.display()
        )
    })?;
    authorize_evidence_root(&canonical_root, roots, relative)?;
    let target = canonical_root.join(&request.file_name);
    reject_existing_directory(&target)?;
    let mut options = OpenOptions::new();
    // Append-only: never truncate and never replace. Evidence written by an
    // earlier QA run must survive.
    options.create(true).append(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // Open the final component itself instead of following it, so a link
        // swapped in at any point is seen on the handle and refused.
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options.open(&target).map_err(|error| {
        format!(
            "unable to open QA evidence file {}: {error}",
            target.display()
        )
    })?;
    verify_opened_evidence(&file, &target, &canonical_root)?;
    Ok(file)
}

fn evidence_roots(app: &AppHandle) -> Result<EvidenceRoots, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|error| {
        format!("unable to resolve the QA app data directory for evidence authorization: {error}")
    })?;
    let data_parent = app_data_dir.parent().ok_or_else(|| {
        format!(
            "QA app data directory {} has no parent directory to derive the Stable/Dev data roots from",
            app_data_dir.display()
        )
    })?;
    let working_dir = std::env::current_dir().map_err(|error| {
        format!(
            "unable to read the current working directory for QA evidence authorization: {error}"
        )
    })?;
    Ok(EvidenceRoots {
        qa_app_data_dir: canonicalize_lenient(&app_data_dir)?,
        stable_data_root: canonicalize_lenient(&data_parent.join(STABLE_DATA_ROOT_NAME))?,
        dev_data_root: canonicalize_lenient(&data_parent.join(DEV_DATA_ROOT_NAME))?,
        working_dir: canonicalize_lenient(&working_dir)?,
    })
}

fn open_evidence(app: &AppHandle, path: &Path) -> Result<File, String> {
    let roots = evidence_roots(app)?;
    open_evidence_in(path, &roots)
}

pub fn initialize(app: &AppHandle) -> Result<(), String> {
    // A2.1: refuse any build whose embedded identifier is not the QA identifier,
    // before the fault config is even read.
    let identifier = app.config().identifier.clone();
    require_qa_identifier(&identifier)?;
    let Some(config_path) = argument_value("--rc2d-fault-config") else {
        return Ok(());
    };
    if !config_path.is_file() {
        return Err(format!(
            "QA fault config does not exist: {}",
            config_path.display()
        ));
    }
    let raw = fs::read(&config_path).map_err(|error| error.to_string())?;
    // Windows editors commonly write a UTF-8 BOM. serde_json rejects it, so
    // strip only the exact BOM prefix before parsing the QA config.
    let raw = raw
        .strip_prefix(&[0xef, 0xbb, 0xbf])
        .unwrap_or(raw.as_slice());
    let config: FaultConfig = serde_json::from_slice(raw).map_err(|error| error.to_string())?;
    let rules = config
        .rules
        .into_iter()
        .map(|rule| (rule.point, rule.action.into()))
        .collect();
    let injector = Arc::new(FileInjector {
        rules: Mutex::new(rules),
        evidence: Mutex::new(open_evidence(app, &config.evidence_path)?),
    });
    todo_native_accounts::fault::install(injector)
        .map_err(|error| format!("unable to install QA fault injector: {error}"))?;
    if matches!(config.credential_backend, CredentialBackendKind::Memory) {
        secure_tokens::install_qa_backend(Arc::new(MemoryCredentialBackend::default()))?;
    }
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&app_data).map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Builds an isolated fixture whose `appdata` directory stands in for
    /// `%APPDATA%`, so the Stable, Dev and QA roots are siblings exactly as they
    /// are on a real host. Every root is canonical, matching how production
    /// derives its anchors through `canonicalize_lenient`.
    fn fixture() -> (tempfile::TempDir, EvidenceRoots) {
        let directory = tempfile::tempdir().expect("tempdir");
        let base = fs::canonicalize(directory.path()).expect("canonical tempdir");
        let data_parent = base.join("appdata");
        fs::create_dir_all(&data_parent).expect("appdata");
        let roots = EvidenceRoots {
            qa_app_data_dir: data_parent.join(QA_IDENTIFIER),
            stable_data_root: data_parent.join(STABLE_DATA_ROOT_NAME),
            dev_data_root: data_parent.join(DEV_DATA_ROOT_NAME),
            working_dir: base.join("workdir"),
        };
        (directory, roots)
    }

    fn append(path: &Path, roots: &EvidenceRoots, line: &str) -> Result<(), String> {
        let mut file = open_evidence_in(path, roots)?;
        writeln!(file, "{line}").map_err(|error| error.to_string())?;
        file.flush().map_err(|error| error.to_string())
    }

    /// Fixture roots are canonical and therefore verbatim on Windows. `mklink`
    /// cannot consume verbatim paths, and `PathBuf::push` resolves a `..` against a
    /// verbatim base instead of keeping the component, so path-level fixtures
    /// are built from the plain form.
    fn plain(path: &Path) -> String {
        let text = path.display().to_string();
        text.strip_prefix(r"\\?\").unwrap_or(&text).to_owned()
    }

    // Case 1.
    #[test]
    fn evidence_path_inside_qa_evidence_root_is_accepted() {
        let (_directory, roots) = fixture();
        let target = roots
            .qa_app_data_dir
            .join("evidence")
            .join("fault-evidence.jsonl");
        append(&target, &roots, "{\"point\":\"QA\"}").expect("approved QA evidence path");
        assert_eq!(
            fs::read_to_string(&target).expect("evidence"),
            "{\"point\":\"QA\"}\n"
        );
    }

    // Case 2: the documented automation contract (see
    // scripts/qa/native/fault-config.example.json) is a relative path whose
    // parent tree does not exist yet. It must land in the same place as before.
    #[test]
    fn relative_evidence_path_lands_where_the_automation_expects() {
        let (_directory, roots) = fixture();
        let configured = Path::new("artifacts/native-qa/example/fault-evidence.jsonl");
        append(configured, &roots, "{\"point\":\"RELATIVE\"}").expect("relative automation path");
        let expected = roots
            .working_dir
            .join("artifacts/native-qa/example/fault-evidence.jsonl");
        assert_eq!(
            fs::read_to_string(&expected).expect("evidence"),
            "{\"point\":\"RELATIVE\"}\n"
        );
    }

    // Case 3.
    #[test]
    fn single_parent_component_is_rejected() {
        let (_directory, roots) = fixture();
        for configured in [
            "../fault-evidence.jsonl",
            "artifacts/../fault-evidence.jsonl",
        ] {
            let error = open_evidence_in(Path::new(configured), &roots)
                .expect_err("a '..' component must be rejected");
            assert!(error.contains("'..'"), "unexpected error: {error}");
        }
    }

    // Case 4.
    #[test]
    fn multi_level_parent_components_are_rejected() {
        let (_directory, roots) = fixture();
        let error = open_evidence_in(Path::new("../../../fault-evidence.jsonl"), &roots)
            .expect_err("multi-level '..' must be rejected");
        assert!(error.contains("'..'"), "unexpected error: {error}");
    }

    // Case 5: the lexical bypass from the defect report, where the root only
    // looks like the QA data directory before the '..' is resolved.
    #[test]
    fn parent_traversal_into_the_stable_root_is_rejected() {
        let (_directory, roots) = fixture();
        let bypass = PathBuf::from(plain(&roots.qa_app_data_dir))
            .join("..")
            .join(STABLE_DATA_ROOT_NAME)
            .join("fault-evidence.jsonl");
        assert!(
            bypass
                .components()
                .any(|component| matches!(component, Component::ParentDir)),
            "fixture must carry a '..' component: {}",
            bypass.display()
        );
        let error = open_evidence_in(&bypass, &roots)
            .expect_err("'..' into the Stable root must be rejected");
        assert!(error.contains("'..'"), "unexpected error: {error}");
        assert!(
            !roots.stable_data_root.join("fault-evidence.jsonl").exists(),
            "no evidence file may appear in the Stable data root"
        );
    }

    // Case 6.
    #[cfg(windows)]
    #[test]
    fn windows_case_variation_of_the_stable_root_is_rejected() {
        let (_directory, roots) = fixture();
        fs::create_dir_all(&roots.stable_data_root).expect("stable root");
        let data_parent = roots.stable_data_root.parent().expect("appdata");
        let configured = data_parent
            .join("App.Shishi.Todo")
            .join("evidence")
            .join("fault-evidence.jsonl");
        let error = open_evidence_in(&configured, &roots)
            .expect_err("a case variant of the Stable root must be rejected");
        assert!(error.contains("Stable"), "unexpected error: {error}");
        assert!(
            !configured.exists(),
            "case variant must not receive evidence"
        );
    }

    // Case 7.
    #[test]
    fn stable_data_root_is_rejected() {
        let (_directory, roots) = fixture();
        let target = roots
            .stable_data_root
            .join("evidence")
            .join("fault-evidence.jsonl");
        let error =
            open_evidence_in(&target, &roots).expect_err("the Stable data root must be rejected");
        assert!(error.contains("Stable"), "unexpected error: {error}");
        assert!(!target.exists(), "the Stable data root must stay untouched");
    }

    // Case 8.
    #[test]
    fn dev_data_root_is_rejected() {
        let (_directory, roots) = fixture();
        let target = roots
            .dev_data_root
            .join("evidence")
            .join("fault-evidence.jsonl");
        let error =
            open_evidence_in(&target, &roots).expect_err("the Dev data root must be rejected");
        assert!(error.contains("Dev"), "unexpected error: {error}");
        assert!(!target.exists(), "the Dev data root must stay untouched");
    }

    // Case 9.
    #[test]
    fn qa_app_data_root_is_accepted() {
        let (_directory, roots) = fixture();
        let target = roots.qa_app_data_dir.join("fault-evidence.jsonl");
        append(&target, &roots, "{\"point\":\"QA_ROOT\"}").expect("QA data root");
        assert!(target.is_file());
    }

    // Case 10: append semantics, never truncate.
    #[test]
    fn existing_evidence_file_is_appended_not_truncated() {
        let (_directory, roots) = fixture();
        let target = roots
            .qa_app_data_dir
            .join("evidence")
            .join("fault-evidence.jsonl");
        fs::create_dir_all(target.parent().expect("evidence dir")).expect("evidence dir");
        fs::write(&target, "{\"point\":\"FIRST\"}\n").expect("seed evidence");
        append(&target, &roots, "{\"point\":\"SECOND\"}").expect("append");
        let contents = fs::read_to_string(&target).expect("evidence");
        assert!(
            contents.starts_with("{\"point\":\"FIRST\"}\n"),
            "earlier bytes were lost: {contents:?}"
        );
        assert!(
            contents.contains("{\"point\":\"SECOND\"}"),
            "append is missing: {contents:?}"
        );
    }

    // Case 11: a symlink swapped in at the final component before the open.
    #[cfg(windows)]
    #[test]
    fn symlinked_evidence_target_is_rejected() {
        let (_directory, roots) = fixture();
        let evidence_dir = roots.qa_app_data_dir.join("evidence");
        fs::create_dir_all(&evidence_dir).expect("evidence dir");
        fs::create_dir_all(&roots.stable_data_root).expect("stable root");
        let outside = roots.stable_data_root.join("redirected.jsonl");
        fs::write(&outside, "production bytes\n").expect("seed outside");
        let link = evidence_dir.join("fault-evidence.jsonl");
        if let Err(error) = std::os::windows::fs::symlink_file(&outside, &link) {
            eprintln!(
                "BLOCKED symlinked_evidence_target_is_rejected: symlink fixture unavailable: {error}"
            );
            return;
        }
        let error = open_evidence_in(&link, &roots)
            .expect_err("a symlinked evidence target must be rejected");
        eprintln!("symlinked target rejected with: {error}");
        assert_eq!(
            fs::read_to_string(&outside).expect("outside"),
            "production bytes\n",
            "no write may follow the link"
        );
    }

    // Case 12: a junction standing in for the evidence root.
    #[cfg(windows)]
    #[test]
    fn junction_redirect_at_the_evidence_root_is_rejected() {
        let (_directory, roots) = fixture();
        let outside = roots.stable_data_root.join("redirect-target");
        fs::create_dir_all(&outside).expect("redirect target");
        fs::create_dir_all(&roots.qa_app_data_dir).expect("qa data dir");
        let junction = roots.qa_app_data_dir.join("evidence");
        let output = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(plain(&junction))
            .arg(plain(&outside))
            .output();
        match output {
            Ok(output) if output.status.success() => {}
            Ok(output) => {
                eprintln!(
                    "BLOCKED junction_redirect_at_the_evidence_root_is_rejected: mklink /J failed: {}",
                    String::from_utf8_lossy(&output.stderr).trim()
                );
                return;
            }
            Err(error) => {
                eprintln!(
                    "BLOCKED junction_redirect_at_the_evidence_root_is_rejected: mklink /J unavailable: {error}"
                );
                return;
            }
        }
        let target = junction.join("fault-evidence.jsonl");
        let error = open_evidence_in(&target, &roots)
            .expect_err("a junction evidence root must be rejected");
        eprintln!("junction evidence root rejected with: {error}");
        assert!(error.contains("Stable"), "unexpected error: {error}");
        assert!(
            !outside.join("fault-evidence.jsonl").exists(),
            "no evidence may be written through the junction"
        );
    }

    // Case 13: a directory outside every approved root.
    #[test]
    fn unauthorized_directory_is_rejected() {
        let (directory, roots) = fixture();
        let base = fs::canonicalize(directory.path()).expect("canonical tempdir");
        let target = base
            .join("outside")
            .join("evidence")
            .join("fault-evidence.jsonl");
        let error = open_evidence_in(&target, &roots)
            .expect_err("an unauthorized directory must be rejected");
        assert!(
            error.contains("not an approved QA location"),
            "unexpected error: {error}"
        );
        assert!(!target.exists(), "no evidence file may be created there");
    }

    // Case 14: a directory sitting at the evidence target.
    #[test]
    fn directory_at_the_evidence_target_is_rejected() {
        let (_directory, roots) = fixture();
        let target = roots
            .qa_app_data_dir
            .join("evidence")
            .join("fault-evidence.jsonl");
        fs::create_dir_all(&target).expect("directory at target");
        let error =
            open_evidence_in(&target, &roots).expect_err("a directory target must be rejected");
        assert!(error.contains("directory"), "unexpected error: {error}");
        assert!(target.is_dir(), "the existing directory must be preserved");
    }

    // Case 15: A2.1 stays in force. initialize() calls require_qa_identifier
    // with the identifier embedded in the binary before it reads any config.
    #[test]
    fn initialize_refuses_production_identifier() {
        for identifier in [
            "app.shishi.todo",
            "app.shishi.todo.dev",
            "app.shishi.todo.qa.poc",
            "",
        ] {
            let error =
                require_qa_identifier(identifier).expect_err("a non-QA identifier must be refused");
            assert!(
                error.contains("non-QA identifier"),
                "unexpected error: {error}"
            );
        }
        require_qa_identifier(QA_IDENTIFIER).expect("the QA identifier is accepted");
    }

    // Case 16: the A2.1 complement. Only the positive half is observable here:
    // lib.rs declares the qa module behind cfg(feature = "native-qa"), so a build
    // without the feature does not compile this file or any test in it. The
    // negative half is therefore NOT_RUN at runtime and verified by reading that
    // cfg gate instead.
    #[test]
    fn writer_is_compiled_out_without_the_native_qa_feature() {
        // The positive half: the writer entry point is present in this build and
        // accepts the documented example path. Without --features native-qa this
        // test does not exist at all, so the negative half stays NOT_RUN.
        let documented = split_evidence_path(Path::new(
            "artifacts/native-qa/example/fault-evidence.jsonl",
        ))
        .expect("the evidence writer is compiled in");
        assert_eq!(documented.file_name, "fault-evidence.jsonl");
        eprintln!(
            "NOT_RUN writer_is_compiled_out_without_the_native_qa_feature: the negative half needs a build without --features native-qa"
        );
    }

    // Case 17.
    #[test]
    fn invalid_evidence_paths_are_rejected() {
        let (_directory, roots) = fixture();
        let long_name = format!("artifacts/native-qa/example/{}.jsonl", "a".repeat(200));
        let cases = [
            PathBuf::new(),
            PathBuf::from("."),
            PathBuf::from("artifacts/native-qa/example/"),
            PathBuf::from("artifacts/native-qa/example/fault evidence.jsonl"),
            PathBuf::from("artifacts/native-qa/example/fault-\0-evidence.jsonl"),
            PathBuf::from(long_name),
        ];
        for configured in &cases {
            let error = open_evidence_in(configured, &roots)
                .expect_err("an invalid evidence path must be rejected");
            assert!(
                !error.is_empty(),
                "empty error for {}",
                configured.display()
            );
            eprintln!("rejected {}: {error}", configured.display());
        }
    }

    // Case 18.
    #[test]
    fn invalid_evidence_file_names_are_rejected() {
        for name in [
            "",
            ".",
            "..",
            "sub/fault-evidence.jsonl",
            "sub\\fault-evidence.jsonl",
            "fault-evidence.jsonl ",
            "fault-evidence.jsonl.",
            "nul.jsonl",
            "fault-\0-evidence.jsonl",
            "fault evidence.jsonl",
            "naive-\u{00e9}.jsonl",
        ] {
            assert!(
                validate_evidence_file_name(name).is_err(),
                "{name:?} must be rejected"
            );
        }
        let long = format!("{}.jsonl", "a".repeat(200));
        assert!(
            validate_evidence_file_name(&long).is_err(),
            "a {}-byte name must be rejected",
            long.len()
        );
        for name in ["fault-evidence.jsonl", "evidence-2024_09.01.jsonl"] {
            validate_evidence_file_name(name).expect("valid evidence file name");
        }
    }

    // Pure decision coverage, without a Tauri AppHandle or a filesystem.
    #[test]
    fn authorized_roots_are_decided_by_the_pure_policy() {
        let roots = EvidenceRoots {
            qa_app_data_dir: PathBuf::from("/appdata/app.shishi.todo.qa"),
            stable_data_root: PathBuf::from("/appdata/app.shishi.todo"),
            dev_data_root: PathBuf::from("/appdata/app.shishi.todo.dev"),
            working_dir: PathBuf::from("/work"),
        };
        authorize_evidence_root(
            Path::new("/appdata/app.shishi.todo.qa/evidence"),
            &roots,
            true,
        )
        .expect("QA app data directory");
        authorize_evidence_root(
            Path::new("/appdata/app.shishi.todo.qa/evidence"),
            &roots,
            false,
        )
        .expect("QA app data directory for an absolute path");
        authorize_evidence_root(Path::new("/work/artifacts/native-qa"), &roots, true)
            .expect("working directory tree for a relative path");
        // The working directory tree is only approved for a relative path.
        assert!(
            authorize_evidence_root(Path::new("/work/artifacts/native-qa"), &roots, false).is_err()
        );
        for relative in [true, false] {
            assert!(
                authorize_evidence_root(
                    Path::new("/appdata/app.shishi.todo/evidence"),
                    &roots,
                    relative
                )
                .is_err()
            );
            assert!(
                authorize_evidence_root(
                    Path::new("/appdata/app.shishi.todo.dev"),
                    &roots,
                    relative
                )
                .is_err()
            );
            assert!(authorize_evidence_root(Path::new("/etc/evidence"), &roots, relative).is_err());
            assert!(
                authorize_evidence_root(Path::new("/appdata/other"), &roots, relative).is_err()
            );
        }
        let split = split_evidence_path(Path::new("artifacts/native-qa/e.jsonl")).expect("split");
        assert_eq!(split.root, PathBuf::from("artifacts/native-qa"));
        assert_eq!(split.file_name, "e.jsonl");
        let bare = split_evidence_path(Path::new("e.jsonl")).expect("bare file name");
        assert_eq!(bare.root, PathBuf::from("."));
        assert_eq!(bare.file_name, "e.jsonl");
    }

    // Component-wise containment: a sibling with a shared prefix is not inside.
    #[test]
    fn path_contains_uses_components_not_string_prefixes() {
        assert!(path_contains(Path::new("/work"), Path::new("/work")));
        assert!(path_contains(Path::new("/work"), Path::new("/work/a/b")));
        assert!(!path_contains(Path::new("/work"), Path::new("/workshop")));
        assert!(!path_contains(
            Path::new("/appdata/app.shishi.todo"),
            Path::new("/appdata/app.shishi.todo.qa")
        ));
        assert!(!path_contains(Path::new("/work/a"), Path::new("/work")));
    }
}
