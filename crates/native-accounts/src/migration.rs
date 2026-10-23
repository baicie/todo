use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

use chrono::Utc;
use rusqlite::{Connection, backup::Backup};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use uuid::Uuid;

use crate::{
    error::{AccountError, AccountResult},
    paths::{
        DEFAULT_ACCOUNT_ID, database_path, ensure_account_dir, ensure_data_root,
        installation_state_file, legacy_database_path, migration_backups_dir, migration_state_file,
        replace_journal_path, sync_directory, sync_file, validate_account_id,
        validate_database_path, validate_legacy_source, validate_relative_path, write_json_atomic,
    },
    registry::{
        AccountKind, AccountRecord, AccountRegistry, ActiveAccountContext, load_with_recovery,
        normalize_email, valid_email,
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
            if let Some(state) = recover_state_journal::<Self>(root, &path)? {
                state.validate()?;
                state.save(root)?;
                let _ = fs::remove_file(replace_journal_path(&path));
                return Ok(Some(state));
            }
            return Ok(None);
        }
        let raw = fs::read(&path)?;
        let state: Self = serde_json::from_slice(&raw).map_err(|error| {
            AccountError::InvalidRegistry(format!("migration state is corrupt: {error}"))
        })?;
        state.validate()?;
        Ok(Some(state))
    }

    fn validate(&self) -> AccountResult<()> {
        if self.version != MIGRATION_STATE_VERSION {
            return Err(AccountError::InvalidRegistry(format!(
                "unsupported migration state version {}",
                self.version
            )));
        }
        validate_relative_path(&self.source_file)?;
        if let Some(path) = &self.backup_file {
            validate_relative_path(path)?;
        }
        if let Some(path) = &self.target_file {
            validate_relative_path(path)?;
        }
        Ok(())
    }

    fn save(&self, root: &Path) -> AccountResult<()> {
        write_json_atomic(&migration_state_file(root), self)
    }

    fn touch(&mut self, phase: MigrationPhase) {
        self.phase = phase;
        self.updated_at = timestamp();
    }
}

pub const INSTALLATION_STATE_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum InstallationPhase {
    Prepared,
    DatabaseCreated,
    RegistryCommitted,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallationState {
    pub version: u32,
    pub phase: InstallationPhase,
    pub account_id: String,
    pub created_at: String,
    pub updated_at: String,
}

impl InstallationState {
    fn new() -> Self {
        let now = timestamp();
        Self {
            version: INSTALLATION_STATE_VERSION,
            phase: InstallationPhase::Prepared,
            account_id: DEFAULT_ACCOUNT_ID.to_owned(),
            created_at: now.clone(),
            updated_at: now,
        }
    }

    pub fn load(root: &Path) -> AccountResult<Option<Self>> {
        let path = installation_state_file(root);
        if !path.exists() {
            if let Some(state) = recover_state_journal::<Self>(root, &path)? {
                if state.version != INSTALLATION_STATE_VERSION
                    || state.account_id != DEFAULT_ACCOUNT_ID
                {
                    return Err(AccountError::InvalidRegistry(
                        "installation state is invalid".to_owned(),
                    ));
                }
                state.save(root)?;
                let _ = fs::remove_file(replace_journal_path(&path));
                return Ok(Some(state));
            }
            return Ok(None);
        }
        let raw = fs::read(&path)?;
        let state: Self = serde_json::from_slice(&raw).map_err(|error| {
            AccountError::InvalidRegistry(format!("installation state is corrupt: {error}"))
        })?;
        if state.version != INSTALLATION_STATE_VERSION || state.account_id != DEFAULT_ACCOUNT_ID {
            return Err(AccountError::InvalidRegistry(
                "installation state is invalid".to_owned(),
            ));
        }
        Ok(Some(state))
    }

    fn save(&self, root: &Path) -> AccountResult<()> {
        write_json_atomic(&installation_state_file(root), self)
    }

    fn touch(&mut self, phase: InstallationPhase) {
        self.phase = phase;
        self.updated_at = timestamp();
    }
}

/// Recover a JSON state file whose Windows fallback replacement was interrupted
/// after the target was moved aside. The temp/source is the intended new state;
/// the old backup is the fallback. Prefer the temp only if it parses.
fn recover_state_journal<T: DeserializeOwned>(
    root: &Path,
    target: &Path,
) -> AccountResult<Option<T>> {
    let journal = replace_journal_path(target);
    if !journal.exists() {
        return Ok(None);
    }
    if fs::symlink_metadata(&journal)?.file_type().is_symlink() {
        return Err(AccountError::UnsafePath(format!(
            "state replacement journal is a symlink: {}",
            journal.display()
        )));
    }
    let raw = fs::read_to_string(&journal).map_err(|error| {
        AccountError::InvalidRegistry(format!("state replacement journal is unreadable: {error}"))
    })?;
    let mut lines = raw.lines();
    let source = lines
        .next()
        .map(PathBuf::from)
        .ok_or_else(|| AccountError::InvalidRegistry("state journal has no source".to_owned()))?;
    let backup = lines
        .next()
        .map(PathBuf::from)
        .ok_or_else(|| AccountError::InvalidRegistry("state journal has no backup".to_owned()))?;
    let root_canonical = root.canonicalize()?;
    let mut existing = Vec::new();
    for candidate in [&source, &backup] {
        if !candidate.is_file() {
            continue;
        }
        let canonical = candidate.canonicalize().map_err(|error| {
            AccountError::InvalidRegistry(format!(
                "state journal candidate is unreadable: {} ({error})",
                candidate.display()
            ))
        })?;
        if !canonical.starts_with(&root_canonical) {
            return Err(AccountError::UnsafePath(format!(
                "state journal escapes data root: {}",
                candidate.display()
            )));
        }
        existing.push(candidate);
    }
    for candidate in existing {
        if let Ok(raw) = fs::read(candidate)
            && let Ok(state) = serde_json::from_slice::<T>(&raw)
        {
            return Ok(Some(state));
        }
    }
    Err(AccountError::InvalidRegistry(
        "state replacement journal candidates are missing or invalid".to_owned(),
    ))
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Ownership {
    Anonymous,
    Bound { email: String },
    Ambiguous { reason: String },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyReviewReport {
    pub reason: Option<String>,
    pub source_file: String,
    pub backup_file: Option<String>,
    pub source_fingerprint: Option<String>,
    pub backup_fingerprint: Option<String>,
    pub requires_manual_identity_verification: bool,
}

/// Read-only diagnosis for a legacy database blocked as REQUIRES_REVIEW.
/// This never writes registry/DB state and never offers a force-bind shortcut.
pub fn legacy_review_report(root: &Path) -> AccountResult<Option<LegacyReviewReport>> {
    let Some(state) = MigrationState::load(root)? else {
        return Ok(None);
    };
    if state.phase != MigrationPhase::RequiresReview {
        return Ok(None);
    }
    let source = legacy_database_path(root);
    let source_fingerprint = source
        .is_file()
        .then(|| read_snapshot(&source).map(|snapshot| snapshot.fingerprint))
        .transpose()?;
    let backup_fingerprint = state
        .backup_file
        .as_deref()
        .map(|relative| {
            let path = root.join(relative);
            read_snapshot(&path).map(|snapshot| snapshot.fingerprint)
        })
        .transpose()?;
    Ok(Some(LegacyReviewReport {
        reason: state.reason,
        source_file: state.source_file,
        backup_file: state.backup_file,
        source_fingerprint,
        backup_fingerprint,
        requires_manual_identity_verification: true,
    }))
}

pub fn ensure_active_account(root: &Path) -> AccountResult<ActiveAccountContext> {
    let root = ensure_data_root(root)?;
    let legacy_source = legacy_database_path(&root);
    validate_legacy_source(&legacy_source)?;
    let migration_state = MigrationState::load(&root)?;
    let installation = InstallationState::load(&root)?;
    let registry = load_with_recovery(&root)?;

    if let Some(installation) = installation {
        return resume_fresh_installation(&root, installation, registry);
    }

    let Some(mut registry) = registry else {
        if legacy_source.is_file() {
            if let Some(state) = migration_state {
                if state.phase == MigrationPhase::RequiresReview {
                    return Err(needs_review(&state, &root));
                }
                if state.phase == MigrationPhase::Complete {
                    return Err(AccountError::InvalidRegistry(
                        "migration is complete but accounts.json is missing".to_owned(),
                    ));
                }
                return resume_migration(&root, state, None);
            }
            let ownership = classify_legacy_database(&legacy_source)?;
            return migrate_legacy_database(&root, ownership);
        }

        if let Some(state) = migration_state {
            if state.phase == MigrationPhase::RequiresReview {
                return Err(needs_review(&state, &root));
            }
            if state.phase == MigrationPhase::Complete {
                return Err(AccountError::InvalidRegistry(
                    "migration is complete but accounts.json is missing".to_owned(),
                ));
            }
            return resume_migration(&root, state, None);
        }

        // An existing account database is evidence of a previous install
        // whose registry is missing. Never reinterpret it as a fresh install.
        let databases = account_database_files(&root)?;
        if !databases.is_empty() {
            return Err(AccountError::InvalidRegistry(format!(
                "accounts.json is missing but account databases exist: {databases:?}"
            )));
        }
        return initialize_fresh(&root);
    };

    let active = registry.active().clone();
    let target_dir = ensure_account_dir(&root, &active.id)?;
    let target = target_dir.join("shishi.sqlite3");
    validate_database_path(&target)?;

    match migration_state {
        None => {
            if !target.is_file() {
                return Err(AccountError::ActiveAccountMissing(active.id));
            }
            if let Some(account) = registry.account_mut(&active.id) {
                account.touch();
            }
            registry.save(&root)?;
            ActiveAccountContext::new(&registry, &root, false)
        }
        Some(state) if state.phase == MigrationPhase::RequiresReview => {
            Err(needs_review(&state, &root))
        }
        Some(state) if state.phase == MigrationPhase::Complete => {
            let migration_target = state.target_account_id.as_deref().ok_or_else(|| {
                AccountError::InvalidRegistry("COMPLETE migration has no target account".to_owned())
            })?;
            if active.id == migration_target {
                verify_complete_migration(&state, &registry, &target)?;
            } else {
                // RC2-B: after the user switches to another account, the
                // historical migration target is no longer active. It must
                // still exist and be structurally sound, but it must not
                // constrain which account is active.
                if !target.is_file() {
                    return Err(AccountError::ActiveAccountMissing(active.id.clone()));
                }
                crate::snapshot::verify_integrity(&target)?;
                let migration_target_dir = ensure_account_dir(&root, migration_target)?;
                let migration_target_db = migration_target_dir.join("shishi.sqlite3");
                validate_database_path(&migration_target_db)?;
                if !migration_target_db.is_file() {
                    return Err(AccountError::ActiveAccountMissing(
                        migration_target.to_owned(),
                    ));
                }
                crate::snapshot::verify_integrity(&migration_target_db)?;
            }
            let migrated = active.id == migration_target;
            if let Some(account) = registry.account_mut(&active.id) {
                account.touch();
            }
            registry.save(&root)?;
            ActiveAccountContext::new(&registry, &root, migrated)
        }
        Some(state) => {
            let state_target = state.target_account_id.as_deref().ok_or_else(|| {
                AccountError::InvalidRegistry(
                    "non-complete migration state has no target account".to_owned(),
                )
            })?;
            if active.id != DEFAULT_ACCOUNT_ID && active.id != state_target {
                return Err(AccountError::InvalidRegistry(format!(
                    "registry active account {} conflicts with migration target {}",
                    active.id, state_target
                )));
            }
            if !legacy_source.is_file() {
                return Err(AccountError::ActiveAccountMissing(state_target.to_owned()));
            }
            resume_migration(&root, state, Some(registry))
        }
    }
}

fn needs_review(state: &MigrationState, root: &Path) -> AccountError {
    AccountError::NeedsReview {
        reason: state
            .reason
            .clone()
            .unwrap_or_else(|| "legacy ownership is ambiguous".to_owned()),
        state_path: migration_state_file(root),
    }
}

fn verify_complete_migration(
    state: &MigrationState,
    registry: &AccountRegistry,
    target: &Path,
) -> AccountResult<()> {
    let target_id = state.target_account_id.as_deref().ok_or_else(|| {
        AccountError::InvalidRegistry("COMPLETE migration has no target account".to_owned())
    })?;
    if registry.active_account_id != target_id {
        return Err(AccountError::InvalidRegistry(
            "COMPLETE migration target does not match active account".to_owned(),
        ));
    }
    if !target.is_file() {
        return Err(AccountError::ActiveAccountMissing(target_id.to_owned()));
    }
    // The COMPLETE target is the live database. Its contents legitimately
    // change as the user works, so the migration-time fingerprint must not be
    // compared here. Only structural integrity can be checked on the fast
    // path; migration-time source/backup/target fingerprints are enforced by
    // non-COMPLETE recovery before this point.
    crate::snapshot::verify_integrity(target)?;
    Ok(())
}

fn initialize_fresh(root: &Path) -> AccountResult<ActiveAccountContext> {
    let state = InstallationState::new();
    state.save(root)?;
    resume_fresh_installation(root, state, None)
}

fn resume_fresh_installation(
    root: &Path,
    mut state: InstallationState,
    registry: Option<AccountRegistry>,
) -> AccountResult<ActiveAccountContext> {
    if MigrationState::load(root)?.is_some() {
        return Err(AccountError::InvalidRegistry(
            "installation marker conflicts with migration state".to_owned(),
        ));
    }
    if legacy_database_path(root).exists() {
        return Err(AccountError::InvalidRegistry(
            "installation marker conflicts with legacy database".to_owned(),
        ));
    }
    let registry = registry.unwrap_or_else(AccountRegistry::new_with_default);
    registry.validate()?;
    if registry.active_account_id != DEFAULT_ACCOUNT_ID {
        return Err(AccountError::InvalidRegistry(
            "installation marker requires the default active account".to_owned(),
        ));
    }
    let expected = database_path(root, DEFAULT_ACCOUNT_ID)?;
    for database in account_database_files(root)? {
        if database != expected {
            return Err(AccountError::InvalidRegistry(format!(
                "installation marker found an unexpected account database: {database:?}"
            )));
        }
    }

    ensure_fresh_database(root)?;
    if state.phase == InstallationPhase::Prepared {
        state.touch(InstallationPhase::DatabaseCreated);
        state.save(root)?;
    }
    if state.phase == InstallationPhase::DatabaseCreated {
        registry.save(root)?;
        state.touch(InstallationPhase::RegistryCommitted);
        state.save(root)?;
    }
    registry.save(root)?;
    validate_database_path(&expected)?;
    if !expected.is_file() {
        return Err(AccountError::ActiveAccountMissing(
            DEFAULT_ACCOUNT_ID.to_owned(),
        ));
    }
    // Re-read the registry before removing the marker; the marker must not
    // outlive an unverified registry/DB pair.
    let reloaded = AccountRegistry::load(root)?;
    if reloaded.active_account_id != DEFAULT_ACCOUNT_ID {
        return Err(AccountError::InvalidRegistry(
            "fresh registry did not persist the default account".to_owned(),
        ));
    }
    let marker = installation_state_file(root);
    match fs::remove_file(&marker) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    sync_directory(root)?;
    ActiveAccountContext::new(&reloaded, root, false)
}

fn ensure_fresh_database(root: &Path) -> AccountResult<()> {
    let directory = ensure_account_dir(root, DEFAULT_ACCOUNT_ID)?;
    let target = directory.join("shishi.sqlite3");
    validate_database_path(&target)?;
    if target.exists() {
        match read_snapshot(&target) {
            Ok(_) => return Ok(()),
            Err(_) => {
                let quarantine_dir = migration_backups_dir(root);
                fs::create_dir_all(&quarantine_dir)?;
                let quarantine = quarantine_dir
                    .join(format!("fresh-corrupt-database-{}.sqlite3", Uuid::now_v7()));
                fs::rename(&target, quarantine)?;
                sync_directory(&quarantine_dir)?;
            }
        }
    }
    let connection = Connection::open(&target)?;
    connection.execute_batch("PRAGMA journal_mode = WAL;")?;
    let integrity: String = connection.query_row("PRAGMA integrity_check", [], |row| row.get(0))?;
    if integrity != "ok" {
        return Err(AccountError::Integrity {
            path: target.clone(),
            detail: integrity,
        });
    }
    connection.close().map_err(|(_, error)| error)?;
    sync_file(&target)?;
    sync_directory(&directory)?;
    Ok(())
}

fn account_database_files(root: &Path) -> AccountResult<Vec<PathBuf>> {
    let accounts = root.join("accounts");
    let mut result = Vec::new();
    if !accounts.is_dir() {
        return Ok(result);
    }
    for entry in fs::read_dir(&accounts)? {
        let entry = entry?;
        let metadata = fs::symlink_metadata(entry.path())?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(AccountError::UnsafePath(format!(
                "unexpected account entry: {}",
                entry.path().display()
            )));
        }
        let database = entry.path().join("shishi.sqlite3");
        if database.exists() {
            result.push(database);
        }
    }
    Ok(result)
}

fn resume_migration(
    root: &Path,
    state: MigrationState,
    registry: Option<AccountRegistry>,
) -> AccountResult<ActiveAccountContext> {
    let target_id = state.target_account_id.clone().ok_or_else(|| {
        AccountError::InvalidRegistry("migration state has no target account".to_owned())
    })?;
    validate_account_id(&target_id)?;
    if let Some(registry) = &registry
        && registry.active_account_id != DEFAULT_ACCOUNT_ID
        && registry.active_account_id != target_id
    {
        return Err(AccountError::InvalidRegistry(format!(
            "registry active account {} conflicts with migration target {}",
            registry.active_account_id, target_id
        )));
    }
    let ownership = match state.phase {
        MigrationPhase::Failed | MigrationPhase::NotStarted => {
            classify_legacy_database(&legacy_database_path(root))?
        }
        _ if target_id == DEFAULT_ACCOUNT_ID => Ownership::Anonymous,
        _ => {
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
    let mut registry = load_with_recovery(root)?.unwrap_or_else(AccountRegistry::new_with_default);

    if let Ownership::Ambiguous { reason } = &ownership {
        return preserve_ambiguous(root, source, reason.clone(), state);
    }

    let target_id = match &ownership {
        Ownership::Anonymous => DEFAULT_ACCOUNT_ID.to_owned(),
        Ownership::Bound { email } => {
            if let Some(state_id) = &state.target_account_id {
                validate_account_id(state_id)?;
                state_id.clone()
            } else if let Some(existing) = registry.find_cloud_by_email(email) {
                existing.id.clone()
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
