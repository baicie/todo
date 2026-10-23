use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

use chrono::Utc;
use rusqlite::{Connection, backup::Backup};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    error::{AccountError, AccountResult},
    paths::{
        DEFAULT_ACCOUNT_ID, accounts_file, ensure_account_dir, ensure_data_root,
        legacy_database_path, migration_backups_dir, migration_state_file, sync_directory,
        sync_file, validate_account_id, validate_database_path, validate_legacy_source,
        validate_relative_path, write_json_atomic,
    },
    registry::{
        AccountKind, AccountRecord, AccountRegistry, ActiveAccountContext, normalize_email,
        valid_email,
    },
    snapshot::{DataSnapshot, VerificationSummary, kv_get, read_snapshot, table_exists},
};

pub const MIGRATION_STATE_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum MigrationPhase {
    NotStarted,
    BackupCreated,
    CopyVerified,
    RegistryCommitted,
    Complete,
    RequiresReview,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationState {
    pub version: u32,
    pub phase: MigrationPhase,
    pub source_file: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backup_file: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_account_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_file: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_fingerprint: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backup_fingerprint: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_fingerprint: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verified: Option<VerificationSummary>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub updated_at: String,
}

impl MigrationState {
    fn new() -> Self {
        Self {
            version: MIGRATION_STATE_VERSION,
            phase: MigrationPhase::NotStarted,
            source_file: "shishi.sqlite3".to_owned(),
            backup_file: None,
            target_account_id: None,
            target_file: None,
            source_fingerprint: None,
            backup_fingerprint: None,
            target_fingerprint: None,
            verified: None,
            reason: None,
            error: None,
            updated_at: timestamp(),
        }
    }

    pub fn load(root: &Path) -> AccountResult<Option<Self>> {
        let path = migration_state_file(root);
        if !path.exists() {
            return Ok(None);
        }
        let raw = fs::read(&path)?;
        let state: Self = serde_json::from_slice(&raw).map_err(|error| {
            AccountError::InvalidRegistry(format!("migration state is corrupt: {error}"))
        })?;
        if state.version != MIGRATION_STATE_VERSION {
            return Err(AccountError::InvalidRegistry(format!(
                "unsupported migration state version {}",
                state.version
            )));
        }
        validate_relative_path(&state.source_file)?;
        if let Some(path) = &state.backup_file {
            validate_relative_path(path)?;
        }
        if let Some(path) = &state.target_file {
            validate_relative_path(path)?;
        }
        Ok(Some(state))
    }

    fn save(&self, root: &Path) -> AccountResult<()> {
        write_json_atomic(&migration_state_file(root), self)
    }

    fn touch(&mut self, phase: MigrationPhase) {
        self.phase = phase;
        self.updated_at = timestamp();
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Ownership {
    Anonymous,
    Bound { email: String },
    Ambiguous { reason: String },
}

pub fn ensure_active_account(root: &Path) -> AccountResult<ActiveAccountContext> {
    let root = ensure_data_root(root)?;
    let legacy_source = legacy_database_path(&root);
    validate_legacy_source(&legacy_source)?;
    let state = MigrationState::load(&root)?;
    if let Some(state) = &state
        && state.phase == MigrationPhase::RequiresReview
    {
        return Err(AccountError::NeedsReview {
            reason: state
                .reason
                .clone()
                .unwrap_or_else(|| "legacy ownership is ambiguous".to_owned()),
            state_path: migration_state_file(&root),
        });
    }

    if accounts_file(&root).exists() {
        let mut registry = AccountRegistry::load(&root)?;
        let active = registry.active().clone();
        let target_dir = ensure_account_dir(&root, &active.id)?;
        let target = target_dir.join("shishi.sqlite3");
        validate_database_path(&target)?;
        let migrated_from_legacy = state.as_ref().is_some_and(|state| {
            state.phase == MigrationPhase::Complete
                && state.target_account_id.as_deref() == Some(active.id.as_str())
        });
        if target.is_file() {
            if let Some(account) = registry.account_mut(&active.id) {
                account.touch();
            }
            registry.save(&root)?;
            return ActiveAccountContext::new(&registry, &root, migrated_from_legacy);
        }
        if let Some(state) = state
            && state.phase != MigrationPhase::Complete
            && state.phase != MigrationPhase::RequiresReview
            && state.target_account_id.as_deref() == Some(active.id.as_str())
            && legacy_database_path(&root).is_file()
        {
            return resume_migration(&root, state);
        }
        return Err(AccountError::ActiveAccountMissing(active.id));
    }

    if !legacy_database_path(&root).is_file() {
        if let Some(state) = state {
            if state.phase == MigrationPhase::Complete {
                return Err(AccountError::InvalidRegistry(
                    "migration is complete but accounts.json is missing".to_owned(),
                ));
            }
            return resume_migration(&root, state);
        }
        let registry = AccountRegistry::new_with_default();
        registry.save(&root)?;
        ensure_account_dir(&root, DEFAULT_ACCOUNT_ID)?;
        return ActiveAccountContext::new(&registry, &root, false);
    }

    if let Some(state) = state {
        if state.phase == MigrationPhase::Complete {
            return Err(AccountError::InvalidRegistry(
                "migration is marked complete but accounts.json is missing".to_owned(),
            ));
        }
        return resume_migration(&root, state);
    }

    let ownership = classify_legacy_database(&legacy_database_path(&root))?;
    migrate_legacy_database(&root, ownership)
}

fn resume_migration(root: &Path, state: MigrationState) -> AccountResult<ActiveAccountContext> {
    let target_id = state.target_account_id.clone().ok_or_else(|| {
        AccountError::InvalidRegistry("migration state has no target account".to_owned())
    })?;
    validate_account_id(&target_id)?;
    let ownership = match state.phase {
        MigrationPhase::Failed | MigrationPhase::NotStarted => {
            classify_legacy_database(&legacy_database_path(root))?
        }
        _ if target_id == DEFAULT_ACCOUNT_ID => Ownership::Anonymous,
        _ => {
            let registry = AccountRegistry::load(root).ok();
            let email = registry
                .as_ref()
                .and_then(|registry| registry.account(&target_id))
                .and_then(|account| account.email.clone())
                .or_else(|| {
                    read_snapshot(&legacy_database_path(root))
                        .ok()
                        .and_then(|snapshot| snapshot.bound_account)
                });
            match email {
                Some(email) if valid_email(&email) => Ownership::Bound {
                    email: normalize_email(&email),
                },
                _ => classified_from_source(root)?,
            }
        }
    };
    run_migration(root, ownership, Some(state))
}

fn classified_from_source(root: &Path) -> AccountResult<Ownership> {
    classify_legacy_database(&legacy_database_path(root))
}

fn migrate_legacy_database(
    root: &Path,
    ownership: Ownership,
) -> AccountResult<ActiveAccountContext> {
    run_migration(root, ownership, None)
}

fn run_migration(
    root: &Path,
    ownership: Ownership,
    existing_state: Option<MigrationState>,
) -> AccountResult<ActiveAccountContext> {
    let mut state = existing_state.unwrap_or_else(MigrationState::new);
    if state.phase == MigrationPhase::RequiresReview {
        return Err(AccountError::NeedsReview {
            reason: state.reason.clone().unwrap_or_default(),
            state_path: migration_state_file(root),
        });
    }
    let source = legacy_database_path(root);
    if !source.is_file() {
        return Err(AccountError::ActiveAccountMissing(
            DEFAULT_ACCOUNT_ID.to_owned(),
        ));
    }

    let result = run_migration_inner(root, &source, ownership, &mut state);
    match result {
        Ok(context) => Ok(context),
        Err(AccountError::NeedsReview { .. }) => Err(AccountError::NeedsReview {
            reason: state.reason.clone().unwrap_or_default(),
            state_path: migration_state_file(root),
        }),
        Err(error) => {
            state.touch(MigrationPhase::Failed);
            state.error = Some(error.to_string());
            let _ = state.save(root);
            Err(AccountError::MigrationFailed(
                error.to_string(),
                migration_state_file(root),
            ))
        }
    }
}

fn run_migration_inner(
    root: &Path,
    source: &Path,
    ownership: Ownership,
    state: &mut MigrationState,
) -> AccountResult<ActiveAccountContext> {
    let source_snapshot = read_snapshot(source)?;
    let mut registry = if accounts_file(root).exists() {
        AccountRegistry::load(root)?
    } else {
        AccountRegistry::new_with_default()
    };

    if let Ownership::Ambiguous { reason } = &ownership {
        return preserve_ambiguous(root, source, reason.clone(), state);
    }

    let target_id = match &ownership {
        Ownership::Anonymous => DEFAULT_ACCOUNT_ID.to_owned(),
        Ownership::Bound { email } => {
            if let Some(existing) = registry.find_cloud_by_email(email) {
                existing.id.clone()
            } else if let Some(state_id) = &state.target_account_id {
                validate_account_id(state_id)?;
                state_id.clone()
            } else {
                let record = AccountRecord::cloud(email);
                let id = record.id.clone();
                registry.upsert(record)?;
                id
            }
        }
        Ownership::Ambiguous { .. } => unreachable!(),
    };
    validate_account_id(&target_id)?;
    match &ownership {
        Ownership::Bound { email } => {
            if let Some(existing) = registry.account(&target_id) {
                if existing.kind != AccountKind::Cloud
                    || existing.email.as_deref() != Some(normalize_email(email).as_str())
                {
                    return Err(AccountError::InvalidRegistry(format!(
                        "target account {target_id} does not match bound email"
                    )));
                }
            } else {
                registry.upsert(AccountRecord::cloud_with_id(&target_id, email))?;
            }
        }
        Ownership::Anonymous => {
            if target_id != DEFAULT_ACCOUNT_ID {
                return Err(AccountError::InvalidRegistry(
                    "anonymous migration must target default".to_owned(),
                ));
            }
        }
        Ownership::Ambiguous { .. } => unreachable!(),
    }
    state.target_account_id = Some(target_id.clone());
    state.target_file = Some(format!("accounts/{target_id}/shishi.sqlite3"));
    if state.phase == MigrationPhase::NotStarted {
        state.touch(MigrationPhase::NotStarted);
        state.save(root)?;
    }

    let source_snapshot = if source_snapshot.fingerprint.is_empty() {
        read_snapshot(source)?
    } else {
        source_snapshot
    };
    state.source_fingerprint = Some(source_snapshot.fingerprint.clone());

    let backup_path = ensure_backup(root, source, &source_snapshot, state)?;
    let backup_snapshot = read_snapshot(&backup_path)?;
    source_snapshot.assert_same(&backup_snapshot, "source/backup")?;
    state.backup_fingerprint = Some(backup_snapshot.fingerprint.clone());

    let target_dir = ensure_account_dir(root, &target_id)?;
    let target = target_dir.join("shishi.sqlite3");
    validate_database_path(&target)?;
    if target.exists() {
        match read_snapshot(&target) {
            Ok(snapshot) if snapshot.fingerprint == backup_snapshot.fingerprint => {}
            Ok(_) | Err(_) => {
                quarantine_invalid_target(root, &target)?;
            }
        }
    }
    if !target.is_file() {
        copy_database_from_backup(&backup_path, &target)?;
    }
    let target_snapshot = read_snapshot(&target)?;
    backup_snapshot.assert_same(&target_snapshot, "backup/target")?;
    state.target_fingerprint = Some(target_snapshot.fingerprint.clone());
    state.verified = Some(target_snapshot.summary());
    state.touch(MigrationPhase::CopyVerified);
    state.save(root)?;

    if registry.account(&target_id).is_none() {
        match &ownership {
            Ownership::Bound { email } => {
                registry.upsert(AccountRecord::cloud_with_id(&target_id, email))?
            }
            _ => {
                registry.ensure_default();
            }
        }
        if registry.account(&target_id).is_none() {
            return Err(AccountError::InvalidRegistry(format!(
                "migration target {target_id} is not in registry"
            )));
        }
    }
    registry.ensure_default();
    registry.set_active(&target_id)?;
    registry.save(root)?;
    state.touch(MigrationPhase::RegistryCommitted);
    state.save(root)?;

    let reloaded = AccountRegistry::load(root)?;
    if reloaded.active_account_id != target_id {
        return Err(AccountError::InvalidRegistry(
            "active account was not persisted".to_owned(),
        ));
    }
    if !target.is_file() {
        return Err(AccountError::ActiveAccountMissing(target_id));
    }
    let final_snapshot = read_snapshot(&target)?;
    backup_snapshot.assert_same(&final_snapshot, "final target")?;
    state.touch(MigrationPhase::Complete);
    state.error = None;
    state.save(root)?;
    let context = ActiveAccountContext::new(&reloaded, root, true)?;
    Ok(context)
}

fn preserve_ambiguous(
    root: &Path,
    source: &Path,
    reason: String,
    state: &mut MigrationState,
) -> AccountResult<ActiveAccountContext> {
    let source_snapshot = read_snapshot(source)?;
    let _backup = ensure_backup(root, source, &source_snapshot, state)?;
    state.reason = Some(reason.clone());
    state.touch(MigrationPhase::RequiresReview);
    state.save(root)?;
    Err(AccountError::NeedsReview {
        reason,
        state_path: migration_state_file(root),
    })
}

fn ensure_backup(
    root: &Path,
    source: &Path,
    source_snapshot: &DataSnapshot,
    state: &mut MigrationState,
) -> AccountResult<PathBuf> {
    if let Some(relative) = &state.backup_file {
        let path = root.join(relative);
        if path.is_file()
            && let Ok(snapshot) = read_snapshot(&path)
            && snapshot.fingerprint == source_snapshot.fingerprint
        {
            state.backup_fingerprint = Some(snapshot.fingerprint);
            return Ok(path);
        }
    }
    let directory = migration_backups_dir(root);
    fs::create_dir_all(&directory)?;
    let file_name = format!("{}-shishi.sqlite3", Utc::now().format("%Y%m%dT%H%M%S%.3fZ"));
    let relative = format!("migration-backups/{file_name}");
    let destination = root.join(&relative);
    let temp = directory.join(format!(".{file_name}.{}.tmp", Uuid::now_v7()));
    backup_database(source, &temp)?;
    sync_file(&temp)?;
    let snapshot = read_snapshot(&temp)?;
    source_snapshot.assert_same(&snapshot, "source/backup copy")?;
    if destination.exists() {
        return Err(AccountError::UnsafePath(format!(
            "backup destination already exists: {}",
            destination.display()
        )));
    }
    fs::rename(&temp, &destination)?;
    sync_file(&destination)?;
    sync_directory(&directory)?;
    state.backup_file = Some(relative);
    state.backup_fingerprint = Some(snapshot.fingerprint);
    state.touch(MigrationPhase::BackupCreated);
    state.save(root)?;
    Ok(destination)
}

fn copy_database_from_backup(backup: &Path, target: &Path) -> AccountResult<()> {
    let parent = target
        .parent()
        .ok_or_else(|| AccountError::UnsafePath(target.display().to_string()))?;
    fs::create_dir_all(parent)?;
    let temp = parent.join(format!(".{}.{}.tmp", "shishi.sqlite3", Uuid::now_v7()));
    backup_database(backup, &temp)?;
    sync_file(&temp)?;
    let snapshot = read_snapshot(&temp)?;
    let backup_snapshot = read_snapshot(backup)?;
    backup_snapshot.assert_same(&snapshot, "target copy")?;
    fs::rename(&temp, target)?;
    sync_file(target)?;
    sync_directory(parent)?;
    Ok(())
}

fn quarantine_invalid_target(root: &Path, target: &Path) -> AccountResult<()> {
    let directory = migration_backups_dir(root);
    fs::create_dir_all(&directory)?;
    let quarantine = directory.join(format!("quarantine-target-{}.sqlite3", Uuid::now_v7()));
    fs::rename(target, &quarantine)?;
    Ok(())
}

fn backup_database(source: &Path, destination: &Path) -> AccountResult<()> {
    if destination.exists() {
        fs::remove_file(destination)?;
    }
    let source_connection = Connection::open(source)?;
    source_connection.busy_timeout(Duration::from_secs(5))?;
    let mut destination_connection = Connection::open(destination)?;
    {
        let backup = Backup::new(&source_connection, &mut destination_connection)?;
        backup.run_to_completion(100, Duration::from_millis(5), None)?;
    }
    destination_connection.pragma_update(None, "synchronous", "FULL")?;
    destination_connection.close().map_err(|(_, error)| error)?;
    source_connection.close().map_err(|(_, error)| error)?;
    Ok(())
}

fn classify_legacy_database(path: &Path) -> AccountResult<Ownership> {
    let connection = Connection::open(path)?;
    connection.busy_timeout(Duration::from_secs(5))?;
    if !table_exists(&connection, "kv_state")? {
        return Ok(Ownership::Anonymous);
    }
    let bound = kv_get(&connection, "bound_account")?;
    let sync_enabled = kv_get(&connection, "sync_enabled")?;
    match bound {
        Some(bound) => {
            let email = normalize_email(&bound);
            if !valid_email(&email) {
                return Ok(Ownership::Ambiguous {
                    reason: format!("bound_account is not a valid email: {bound}"),
                });
            }
            let device = kv_get(&connection, "device_id")?;
            let Some(device) = device.filter(|value| !value.trim().is_empty()) else {
                return Ok(Ownership::Ambiguous {
                    reason: "bound account has no device_id".to_owned(),
                });
            };
            if table_exists(&connection, "outbox")? {
                let mut statement = connection.prepare("SELECT DISTINCT device_id FROM outbox")?;
                let devices = statement
                    .query_map([], |row| row.get::<_, String>(0))?
                    .collect::<Result<BTreeSet<_>, _>>()?;
                if devices.iter().any(|row_device| row_device != &device) {
                    return Ok(Ownership::Ambiguous {
                        reason: "outbox device_id does not match bound device_id".to_owned(),
                    });
                }
            }
            Ok(Ownership::Bound { email })
        }
        None => {
            if sync_enabled.as_deref() == Some("true") {
                Ok(Ownership::Ambiguous {
                    reason: "sync_enabled is true but bound_account is missing".to_owned(),
                })
            } else {
                Ok(Ownership::Anonymous)
            }
        }
    }
}

pub fn migration_state(root: &Path) -> AccountResult<Option<MigrationState>> {
    MigrationState::load(root)
}

fn timestamp() -> String {
    Utc::now().to_rfc3339()
}

#[allow(dead_code)]
fn bound_email_from_snapshot(path: &Path) -> AccountResult<Option<String>> {
    let snapshot = read_snapshot(path)?;
    Ok(snapshot.bound_account.map(|email| normalize_email(&email)))
}
