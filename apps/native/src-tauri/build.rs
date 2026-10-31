//! Build script: embed the git commit this binary was built from (RC2-D.15).
//!
//! Why: the QA harness must prove it validated the intended source commit, not
//! just a binary with the right product name and mtime. The commit is embedded
//! as a compile-time string because the harness reads it back out of the
//! executable bytes (see `commands::qa_build_identity`): a metadata file beside
//! the binary can be edited without touching the artifact, an embedded string
//! cannot be changed without changing the executable sha256 the provenance
//! records as well.
//!
//! Precedence: `QA_BUILD_COMMIT` (set by scripts/qa/native/run-windows.ps1 for
//! -Build), then `QA_GIT_COMMIT` (existing harness environment convention),
//! then `git rev-parse HEAD`. When nothing resolves, `unknown` is embedded and
//! the harness reports the commit as unknown instead of guessing a match.
use std::process::Command;

const COMMIT_ENV: &str = "QA_BUILD_COMMIT";

/// A build commit as the harness accepts it: 7-40 hex characters.
fn normalized_commit(value: &str) -> Option<String> {
    let trimmed = value.trim().to_ascii_lowercase();
    let is_sha =
        (7..=40).contains(&trimmed.len()) && trimmed.bytes().all(|b| b.is_ascii_hexdigit());
    if is_sha { Some(trimmed) } else { None }
}

fn commit_from_env(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .and_then(|value| normalized_commit(&value))
}

fn commit_from_git() -> Option<String> {
    let output = Command::new("git")
        .args(["rev-parse", "HEAD"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    normalized_commit(&String::from_utf8_lossy(&output.stdout))
}

fn main() {
    println!("cargo:rerun-if-env-changed={COMMIT_ENV}");
    println!("cargo:rerun-if-env-changed=QA_GIT_COMMIT");
    let commit = commit_from_env(COMMIT_ENV)
        .or_else(|| commit_from_env("QA_GIT_COMMIT"))
        .or_else(commit_from_git)
        .unwrap_or_else(|| "unknown".to_owned());
    println!("cargo:rustc-env={COMMIT_ENV}={commit}");
    tauri_build::build()
}
