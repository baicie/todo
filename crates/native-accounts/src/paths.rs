use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Component, Path, PathBuf},
};

use serde::Serialize;
use uuid::Uuid;

use crate::error::{AccountError, AccountResult};

pub const DEFAULT_ACCOUNT_ID: &str = "default";
pub const DATABASE_FILE: &str = "shishi.sqlite3";
pub const LEGACY_REFRESH_TOKEN_KEY: &str = "cloud-refresh:default";

pub fn validate_account_id(id: &str) -> AccountResult<()> {
    if id == DEFAULT_ACCOUNT_ID {
        return Ok(());
    }
    let parsed = Uuid::parse_str(id).map_err(|_| AccountError::InvalidAccountId(id.to_owned()))?;
    if parsed.to_string() != id {
        return Err(AccountError::InvalidAccountId(id.to_owned()));
    }
    Ok(())
}

pub fn refresh_token_key(account_id: &str) -> AccountResult<String> {
    validate_account_id(account_id)?;
    Ok(format!("cloud-refresh:{account_id}"))
}

pub fn database_file_name(id: &str) -> AccountResult<&'static str> {
    validate_account_id(id)?;
    Ok(DATABASE_FILE)
}

pub fn account_dir(root: &Path, id: &str) -> AccountResult<PathBuf> {
    validate_account_id(id)?;
    Ok(root.join("accounts").join(id))
}

pub fn database_path(root: &Path, id: &str) -> AccountResult<PathBuf> {
    Ok(account_dir(root, id)?.join(database_file_name(id)?))
}

pub fn legacy_database_path(root: &Path) -> PathBuf {
    root.join(DATABASE_FILE)
}

pub fn accounts_file(root: &Path) -> PathBuf {
    root.join("accounts.json")
}

pub fn migration_state_file(root: &Path) -> PathBuf {
    root.join("migration-state.json")
}

pub fn migration_backups_dir(root: &Path) -> PathBuf {
    root.join("migration-backups")
}

pub fn ensure_data_root(root: &Path) -> AccountResult<PathBuf> {
    fs::create_dir_all(root)?;
    let canonical = root.canonicalize()?;
    for name in ["accounts", "migration-backups"] {
        let path = canonical.join(name);
        fs::create_dir_all(&path)?;
        let metadata = fs::symlink_metadata(&path)?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(AccountError::UnsafePath(format!(
                "state directory is not a real directory: {}",
                path.display()
            )));
        }
    }
    Ok(canonical)
}

/// Ensure an account directory exists and is a real directory inside the
/// accounts root, not a symlink and not a path escape.
pub fn ensure_account_dir(root: &Path, id: &str) -> AccountResult<PathBuf> {
    let root = ensure_data_root(root)?;
    let accounts_root = root.join("accounts");
    let dir = accounts_root.join(id);
    validate_account_id(id)?;
    match fs::symlink_metadata(&dir) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() {
                return Err(AccountError::UnsafePath(format!(
                    "account directory is a symlink: {}",
                    dir.display()
                )));
            }
            if !metadata.is_dir() {
                return Err(AccountError::UnsafePath(format!(
                    "account path is not a directory: {}",
                    dir.display()
                )));
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(&dir)?;
        }
        Err(error) => return Err(error.into()),
    }
    let canonical = dir.canonicalize()?;
    let canonical_root = accounts_root.canonicalize()?;
    if !canonical.starts_with(&canonical_root) {
        return Err(AccountError::UnsafePath(format!(
            "account directory escapes accounts root: {}",
            canonical.display()
        )));
    }
    Ok(canonical)
}

/// Reject a database path that is a symbolic link. Missing files are allowed
/// because callers may be about to create them.
pub fn validate_database_path(path: &Path) -> AccountResult<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(AccountError::UnsafePath(
            format!("database path is a symlink: {}", path.display()),
        )),
        Ok(metadata) if !metadata.is_file() => Err(AccountError::UnsafePath(format!(
            "database path is not a regular file: {}",
            path.display()
        ))),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

/// A legacy source must be a regular file, never a symlink. This keeps a
/// migration from copying an attacker-controlled path into the accounts tree.
pub fn validate_legacy_source(path: &Path) -> AccountResult<()> {
    validate_database_path(path)
}

pub fn validate_relative_path(path: &str) -> AccountResult<()> {
    let candidate = Path::new(path);
    if candidate.is_absolute() || path.is_empty() {
        return Err(AccountError::UnsafePath(path.to_owned()));
    }
    for component in candidate.components() {
        match component {
            Component::Normal(value) if !value.is_empty() => {}
            _ => return Err(AccountError::UnsafePath(path.to_owned())),
        }
    }
    Ok(())
}

/// Write JSON through a same-directory temporary file. The file is fsynced
/// before the atomic replace; on Unix the directory is fsynced afterwards.
pub fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> AccountResult<()> {
    let parent = path.parent().ok_or_else(|| {
        AccountError::UnsafePath(format!("path has no parent: {}", path.display()))
    })?;
    fs::create_dir_all(parent).map_err(|error| {
        std::io::Error::new(
            error.kind(),
            format!("create parent {}: {error}", parent.display()),
        )
    })?;
    let temp = parent.join(format!(
        ".{}.{}.tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("state"),
        Uuid::now_v7()
    ));
    let bytes = serde_json::to_vec_pretty(value)?;
    {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp)
            .map_err(|error| {
                std::io::Error::new(
                    error.kind(),
                    format!("open temp {}: {error}", temp.display()),
                )
            })?;
        file.write_all(&bytes).map_err(|error| {
            std::io::Error::new(
                error.kind(),
                format!("write temp {}: {error}", temp.display()),
            )
        })?;
        file.write_all(b"\n").map_err(|error| {
            std::io::Error::new(
                error.kind(),
                format!("write newline {}: {error}", temp.display()),
            )
        })?;
        file.sync_all().map_err(|error| {
            std::io::Error::new(
                error.kind(),
                format!("sync temp {}: {error}", temp.display()),
            )
        })?;
    }
    if let Err(error) = replace_file(&temp, path) {
        let _ = fs::remove_file(&temp);
        return Err(std::io::Error::new(
            error.kind(),
            format!("atomic replace {}: {error}", path.display()),
        )
        .into());
    }
    sync_dir(parent);
    Ok(())
}

/// Replace a file atomically where the platform supports it. Unix rename
/// replaces in one step; Windows uses ReplaceFileW, which preserves the old
/// file during replacement. A missing target on Windows is a first write.
pub fn replace_file(source: &Path, target: &Path) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::ReplaceFileW;

        if !target.exists() {
            return fs::rename(source, target);
        }
        let source_wide = source
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect::<Vec<u16>>();
        let target_wide = target
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect::<Vec<u16>>();
        if target.exists() {
            let replaced = unsafe {
                ReplaceFileW(
                    target_wide.as_ptr(),
                    source_wide.as_ptr(),
                    std::ptr::null(),
                    0,
                    std::ptr::null(),
                    std::ptr::null(),
                )
            };
            if replaced != 0 {
                return Ok(());
            }
            let replace_error = std::io::Error::last_os_error();
            // Some filesystems/AV filters reject ReplaceFileW. Fall back to a
            // recoverable two-step swap; a failed swap restores the old file.
            let backup = target.with_extension(format!("old-{}", Uuid::now_v7()));
            fs::rename(target, &backup)?;
            match fs::rename(source, target) {
                Ok(()) => {
                    let _ = fs::remove_file(&backup);
                    return Ok(());
                }
                Err(error) => {
                    let _ = fs::rename(&backup, target);
                    return Err(std::io::Error::new(
                        error.kind(),
                        format!("{replace_error}; fallback: {error}"),
                    ));
                }
            }
        }
        fs::rename(source, target)
    }
    #[cfg(not(windows))]
    {
        fs::rename(source, target)
    }
}

pub fn sync_file(path: &Path) -> AccountResult<()> {
    let file = OpenOptions::new().read(true).write(true).open(path)?;
    file.sync_all()?;
    Ok(())
}

pub fn sync_directory(path: &Path) -> AccountResult<()> {
    sync_dir(path);
    Ok(())
}

#[cfg(unix)]
fn sync_dir(path: &Path) {
    if let Ok(directory) = OpenOptions::new().read(true).open(path) {
        let _ = directory.sync_all();
    }
}

#[cfg(not(unix))]
fn sync_dir(_path: &Path) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_path_and_account_injection() {
        assert!(validate_account_id("default").is_ok());
        assert!(validate_account_id("../escape").is_err());
        assert!(validate_account_id("bad/id").is_err());
        assert!(validate_account_id("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa").is_ok());
        assert!(validate_relative_path("migration-backups/a.sqlite3").is_ok());
        assert!(validate_relative_path("../outside").is_err());
        assert!(validate_relative_path("/absolute").is_err());
        assert!(refresh_token_key("default").is_ok());
        assert!(refresh_token_key("cloud-refresh").is_err());
    }
}
