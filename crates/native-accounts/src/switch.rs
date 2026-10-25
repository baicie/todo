use std::{fs, path::Path};

use chrono::Utc;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    error::{AccountError, AccountResult},
    fault::{self, FaultPoint},
    paths::{
        DEFAULT_ACCOUNT_ID, database_path, ensure_account_dir, pending_account_switch_file,
        sync_directory, sync_file, validate_account_id, validate_database_path, write_json_atomic,
    },
    registry::{
        AccountKind, AccountRecord, AccountRegistry, load_with_recovery, normalize_api_url,
        normalize_email, valid_email,
    },
    snapshot::read_snapshot,
};

pub const SWITCH_STATE_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum SwitchPhase {
    Prepared,
    RestartRequired,
    VerifyingTarget,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingAccountSwitch {
    pub version: u32,
    pub phase: SwitchPhase,
    pub from_account_id: String,
    pub to_account_id: String,
    pub generation: u64,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
}

impl PendingAccountSwitch {
    fn load(root: &Path) -> AccountResult<Option<Self>> {
        let path = pending_account_switch_file(root);
        if !path.exists() {
            return Ok(None);
        }
        if fs::symlink_metadata(&path)?.file_type().is_symlink() {
            return Err(AccountError::UnsafePath(format!(
                "account switch journal is a symlink: {}",
                path.display()
            )));
        }
        let raw = fs::read(&path)?;
        let state: Self = serde_json::from_slice(&raw).map_err(|error| {
            AccountError::InvalidRegistry(format!("account switch journal is corrupt: {error}"))
        })?;
        state.validate()?;
        Ok(Some(state))
    }

    fn validate(&self) -> AccountResult<()> {
        if self.version != SWITCH_STATE_VERSION {
            return Err(AccountError::InvalidRegistry(
                "unsupported account switch journal version".to_owned(),
            ));
        }
        validate_account_id(&self.from_account_id)?;
        validate_account_id(&self.to_account_id)?;
        if self.from_account_id == self.to_account_id {
            return Err(AccountError::InvalidRegistry(
                "account switch source and target are equal".to_owned(),
            ));
        }
        Ok(())
    }

    fn save(&self, root: &Path) -> AccountResult<()> {
        self.validate()?;
        write_json_atomic(&pending_account_switch_file(root), self)
    }

    fn touch(&mut self, phase: SwitchPhase) {
        self.phase = phase;
        self.updated_at = timestamp();
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountSummary {
    pub id: String,
    pub kind: String,
    pub email: Option<String>,
    pub api_url: Option<String>,
    pub pending: bool,
    pub active: bool,
    pub last_opened_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountList {
    pub active_account_id: String,
    pub accounts: Vec<AccountSummary>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SwitchStatus {
    pub active: bool,
    pub from_account_id: Option<String>,
    pub to_account_id: Option<String>,
    pub generation: Option<u64>,
    pub phase: Option<SwitchPhase>,
    pub pending_outbox: i64,
    pub error_code: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SwitchFailure {
    pub from_account_id: String,
    pub to_account_id: String,
    pub error_code: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SwitchRecovery {
    /// The registry was committed to the target and the caller must open it,
    /// then call `finish_pending_switch` after the target store is usable.
    pub target_committed: bool,
    pub failure: Option<SwitchFailure>,
}

pub fn list_accounts(root: &Path) -> AccountResult<AccountList> {
    let registry = load_with_recovery(root)?
        .ok_or_else(|| AccountError::InvalidRegistry("accounts.json is missing".to_owned()))?;
    Ok(AccountList {
        active_account_id: registry.active_account_id.clone(),
        accounts: registry
            .accounts
            .iter()
            .map(|account| AccountSummary {
                id: account.id.clone(),
                kind: account.kind.as_str().to_owned(),
                email: account.email.clone(),
                api_url: account.api_url.clone(),
                pending: account.pending,
                active: account.id == registry.active_account_id,
                last_opened_at: account.last_opened_at.clone(),
            })
            .collect(),
    })
}

pub fn prepare_account_switch(root: &Path, target_id: &str) -> AccountResult<SwitchStatus> {
    validate_account_id(target_id)?;
    let registry = load_with_recovery(root)?
        .ok_or_else(|| AccountError::InvalidRegistry("accounts.json is missing".to_owned()))?;
    let from = registry.active_account_id.clone();
    if from == target_id {
        return Err(AccountError::InvalidRegistry(
            "target account is already active".to_owned(),
        ));
    }
    let target = registry.account(target_id).ok_or_else(|| {
        AccountError::InvalidRegistry(format!("target account {target_id} is not registered"))
    })?;
    verify_target_identity(root, target)?;

    if let Some(existing) = PendingAccountSwitch::load(root)? {
        if existing.to_account_id != target_id {
            return Err(AccountError::InvalidRegistry(
                "another account switch is already pending".to_owned(),
            ));
        }
        if existing.phase == SwitchPhase::Prepared || existing.phase == SwitchPhase::RestartRequired
        {
            return status_from_journal(root, Some(existing));
        }
    }

    let current_db = database_path(root, &from)?;
    let pending_outbox = pending_outbox_count(&current_db);

    let now = timestamp();
    let journal = PendingAccountSwitch {
        version: SWITCH_STATE_VERSION,
        phase: SwitchPhase::Prepared,
        from_account_id: from,
        to_account_id: target_id.to_owned(),
        generation: Utc::now().timestamp_millis() as u64,
        created_at: now.clone(),
        updated_at: now,
        error_code: None,
    };
    journal.save(root)?;
    fault::point(
        FaultPoint::SwitchPreparedPersisted,
        Some("PREPARED"),
        Some(&journal.to_account_id),
        Some("journal persisted"),
    )?;
    Ok(SwitchStatus {
        active: false,
        from_account_id: Some(journal.from_account_id),
        to_account_id: Some(journal.to_account_id),
        generation: Some(journal.generation),
        phase: Some(journal.phase),
        pending_outbox,
        error_code: None,
    })
}

pub fn request_account_switch(
    root: &Path,
    target_id: &str,
    generation: u64,
) -> AccountResult<SwitchStatus> {
    let mut journal = PendingAccountSwitch::load(root)?.ok_or_else(|| {
        AccountError::InvalidRegistry("no prepared account switch exists".to_owned())
    })?;
    if journal.to_account_id != target_id || journal.generation != generation {
        return Err(AccountError::InvalidRegistry(
            "account switch request does not match the prepared journal".to_owned(),
        ));
    }
    match journal.phase {
        SwitchPhase::Prepared => {
            journal.touch(SwitchPhase::RestartRequired);
            journal.save(root)?;
            fault::point(
                FaultPoint::SwitchRestartRequiredPersisted,
                Some("RESTART_REQUIRED"),
                Some(&journal.to_account_id),
                Some("journal persisted"),
            )?;
        }
        SwitchPhase::RestartRequired => {}
        _ => {
            return Err(AccountError::InvalidRegistry(
                "account switch is not in a requestable phase".to_owned(),
            ));
        }
    }
    status_from_journal(root, Some(journal))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AbortSwitchOutcome {
    Aborted,
    NoPreparedSwitch,
    NotPrepared(SwitchPhase),
}

/// Only a journal that is still PREPARED may be aborted. A request that already
/// advanced the journal must go through startup recovery or a dedicated
/// rollback; returning Ok for those phases would let IPC reopen the write gate
/// after the switch became irrevocable.
pub fn abort_prepared_switch(root: &Path) -> AccountResult<AbortSwitchOutcome> {
    match PendingAccountSwitch::load(root)? {
        None => Ok(AbortSwitchOutcome::NoPreparedSwitch),
        Some(journal) if journal.phase == SwitchPhase::Prepared => {
            remove_journal(root)?;
            Ok(AbortSwitchOutcome::Aborted)
        }
        Some(journal) => Ok(AbortSwitchOutcome::NotPrepared(journal.phase)),
    }
}

pub fn finish_pending_switch(root: &Path) -> AccountResult<()> {
    if let Some(journal) = PendingAccountSwitch::load(root)? {
        if journal.phase != SwitchPhase::VerifyingTarget {
            return Err(AccountError::InvalidRegistry(
                "pending switch is not ready to finish".to_owned(),
            ));
        }
        let registry = AccountRegistry::load(root)?;
        if registry.active_account_id != journal.to_account_id {
            return Err(AccountError::InvalidRegistry(
                "finish switch target does not match registry active account".to_owned(),
            ));
        }
        remove_journal(root)?;
    }
    Ok(())
}

/// Startup recovery. A `Prepared` journal was never requested, so it is
/// discarded. `RestartRequired`/`VerifyingTarget` must verify the target before
/// atomically committing the registry. A bad target restores the source and
/// records a recoverable failure; it never creates an empty target.
pub fn recover_pending_switch(root: &Path) -> AccountResult<SwitchRecovery> {
    let Some(mut journal) = PendingAccountSwitch::load(root)? else {
        return Ok(SwitchRecovery::default());
    };
    if journal.phase == SwitchPhase::Failed {
        // A crash can happen after the journal was marked FAILED but before the
        // registry was restored. Repair the active pointer before returning, so
        // a failed switch can never leave the target account active.
        let registry = load_with_recovery(root)?;
        if let Some(mut registry) = registry {
            if registry.active_account_id != journal.from_account_id
                && registry.active_account_id != journal.to_account_id
            {
                return Err(AccountError::InvalidRegistry(
                    "failed switch registry active account is neither source nor target".to_owned(),
                ));
            }
            if registry.active_account_id == journal.to_account_id {
                registry.active_account_id = journal.from_account_id.clone();
                registry.save(root)?;
            }
        }
        return Ok(SwitchRecovery {
            target_committed: false,
            failure: Some(SwitchFailure {
                from_account_id: journal.from_account_id,
                to_account_id: journal.to_account_id,
                error_code: journal
                    .error_code
                    .unwrap_or_else(|| "SWITCH_FAILED".to_owned()),
            }),
        });
    }
    if journal.phase == SwitchPhase::Prepared {
        remove_journal(root)?;
        return Ok(SwitchRecovery::default());
    }

    let mut registry = load_with_recovery(root)?.ok_or_else(|| {
        AccountError::InvalidRegistry("accounts.json is missing during account switch".to_owned())
    })?;
    if registry.active_account_id != journal.from_account_id
        && registry.active_account_id != journal.to_account_id
    {
        return Err(AccountError::InvalidRegistry(
            "registry active account is neither switch source nor target".to_owned(),
        ));
    }
    let target = registry
        .account(&journal.to_account_id)
        .cloned()
        .ok_or_else(|| {
            AccountError::InvalidRegistry("account switch target is not registered".to_owned())
        })?;
    if let Err(error) = verify_target_identity(root, &target) {
        let code = "TARGET_INVALID";
        // Persist FAILED before restoring the active pointer. If the process is
        // killed between these two writes, the next recovery sees FAILED and
        // repairs the registry instead of retrying a rejected target.
        journal.touch(SwitchPhase::Failed);
        journal.error_code = Some(code.to_owned());
        journal.save(root)?;
        if registry.active_account_id == journal.to_account_id {
            fault::point(
                FaultPoint::RegistryActiveBeforeUpdate,
                Some("FAILED"),
                Some(&journal.from_account_id),
                Some("restore source after target validation failure"),
            )?;
            registry.active_account_id = journal.from_account_id.clone();
            registry.save(root)?;
            fault::point(
                FaultPoint::RegistryActiveAfterUpdate,
                Some("FAILED"),
                Some(&journal.from_account_id),
                Some("source restored"),
            )?;
        }
        return Ok(SwitchRecovery {
            target_committed: false,
            failure: Some(SwitchFailure {
                from_account_id: journal.from_account_id,
                to_account_id: journal.to_account_id,
                error_code: format!("{code}: {error}"),
            }),
        });
    }
    if registry.active_account_id != journal.to_account_id {
        journal.touch(SwitchPhase::VerifyingTarget);
        journal.save(root)?;
        fault::point(
            FaultPoint::SwitchVerifyingTargetPersisted,
            Some("VERIFYING_TARGET"),
            Some(&journal.to_account_id),
            Some("journal persisted before registry update"),
        )?;
        fault::point(
            FaultPoint::RegistryActiveBeforeUpdate,
            Some("VERIFYING_TARGET"),
            Some(&journal.to_account_id),
            Some("commit verified target"),
        )?;
        registry.active_account_id = journal.to_account_id.clone();
        registry.save(root)?;
        fault::point(
            FaultPoint::RegistryActiveAfterUpdate,
            Some("VERIFYING_TARGET"),
            Some(&journal.to_account_id),
            Some("target committed"),
        )?;
    } else {
        journal.touch(SwitchPhase::VerifyingTarget);
        journal.save(root)?;
        fault::point(
            FaultPoint::SwitchVerifyingTargetPersisted,
            Some("VERIFYING_TARGET"),
            Some(&journal.to_account_id),
            Some("journal persisted; registry already target"),
        )?;
    }
    Ok(SwitchRecovery {
        target_committed: true,
        failure: None,
    })
}

pub fn rollback_pending_switch(root: &Path, error_code: &str) -> AccountResult<SwitchFailure> {
    let mut journal = PendingAccountSwitch::load(root)?
        .ok_or_else(|| AccountError::InvalidRegistry("no account switch is pending".to_owned()))?;
    let mut registry = AccountRegistry::load(root)?;
    // Persist FAILED first; recovery is then idempotent even if the process is
    // killed before the registry restoration below.
    journal.touch(SwitchPhase::Failed);
    journal.error_code = Some(error_code.to_owned());
    journal.save(root)?;
    if registry.active_account_id == journal.to_account_id {
        fault::point(
            FaultPoint::RegistryActiveBeforeUpdate,
            Some("FAILED"),
            Some(&journal.from_account_id),
            Some("rollback target to source"),
        )?;
        registry.active_account_id = journal.from_account_id.clone();
        registry.save(root)?;
        fault::point(
            FaultPoint::RegistryActiveAfterUpdate,
            Some("FAILED"),
            Some(&journal.from_account_id),
            Some("rollback source committed"),
        )?;
    }
    Ok(SwitchFailure {
        from_account_id: journal.from_account_id,
        to_account_id: journal.to_account_id,
        error_code: error_code.to_owned(),
    })
}

pub fn switch_status(root: &Path) -> AccountResult<SwitchStatus> {
    let journal = PendingAccountSwitch::load(root)?;
    status_from_journal(root, journal)
}

fn pending_outbox_count(path: &Path) -> i64 {
    if !path.is_file() {
        return 0;
    }
    Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .ok()
        .and_then(|connection| {
            connection
                .query_row(
                    "SELECT COUNT(*) FROM outbox WHERE sync_status = 'pending'",
                    [],
                    |row| row.get(0),
                )
                .ok()
        })
        .unwrap_or_default()
}

fn status_from_journal(
    root: &Path,
    journal: Option<PendingAccountSwitch>,
) -> AccountResult<SwitchStatus> {
    let registry = load_with_recovery(root)?;
    let from = registry
        .as_ref()
        .map(|registry| registry.active_account_id.clone());
    let current_db = registry
        .as_ref()
        .and_then(|registry| database_path(root, &registry.active_account_id).ok());
    let pending_outbox = current_db
        .filter(|path| path.is_file())
        .map(|path| pending_outbox_count(&path))
        .unwrap_or_default();
    match journal {
        Some(journal) => Ok(SwitchStatus {
            active: false,
            from_account_id: Some(journal.from_account_id),
            to_account_id: Some(journal.to_account_id),
            generation: Some(journal.generation),
            phase: Some(journal.phase),
            pending_outbox,
            error_code: journal.error_code,
        }),
        None => Ok(SwitchStatus {
            active: true,
            from_account_id: from,
            to_account_id: None,
            generation: None,
            phase: None,
            pending_outbox,
            error_code: None,
        }),
    }
}

/// Add a cloud account in pending state. The database is created empty and the
/// account cannot be used as a data owner for anonymous/local data until the
/// server identity is verified.
pub fn create_pending_cloud_account(
    root: &Path,
    email: &str,
    api_url: &str,
) -> AccountResult<AccountSummary> {
    let email = normalize_email(email);
    if !valid_email(&email) {
        return Err(AccountError::InvalidRegistry(
            "cloud account email is invalid".to_owned(),
        ));
    }
    if let Some(journal) = PendingAccountSwitch::load(root)?
        && journal.phase != SwitchPhase::Failed
    {
        return Err(AccountError::InvalidRegistry(
            "cannot add an account while a switch is pending".to_owned(),
        ));
    }
    let api_url = normalize_api_url(api_url)?;
    let mut registry = load_with_recovery(root)?
        .ok_or_else(|| AccountError::InvalidRegistry("accounts.json is missing".to_owned()))?;
    if let Some(existing) = registry.find_cloud_by_identity(&email, &api_url) {
        return Ok(summary_from_record(existing, &registry.active_account_id));
    }
    if let Some(existing) = registry.find_cloud_by_email(&email)
        && existing.api_url.is_none()
    {
        return Err(AccountError::InvalidRegistry(
            "an account with this email has no verified server identity".to_owned(),
        ));
    }
    let id = Uuid::now_v7().to_string();
    let record = AccountRecord::cloud_with_identity(&id, &email, &api_url, true)?;
    let directory = ensure_account_dir(root, &id)?;
    let target = directory.join("shishi.sqlite3");
    validate_database_path(&target)?;
    if target.exists() {
        let snapshot = read_snapshot(&target)?;
        if snapshot.bound_account.is_some() || snapshot.counts.values().any(|count| *count > 0) {
            return Err(AccountError::InvalidRegistry(
                "pending account database already contains data".to_owned(),
            ));
        }
    } else {
        let connection = Connection::open(&target)?;
        let integrity: String =
            connection.query_row("PRAGMA integrity_check", [], |row| row.get(0))?;
        if integrity != "ok" {
            return Err(AccountError::Integrity {
                path: target.clone(),
                detail: integrity,
            });
        }
        connection.close().map_err(|(_, error)| error)?;
        sync_file(&target)?;
        sync_directory(&directory)?;
    }
    registry.upsert(record)?;
    registry.save(root)?;
    let added = registry.account(&id).ok_or_else(|| {
        AccountError::InvalidRegistry("pending account was not persisted".to_owned())
    })?;
    Ok(summary_from_record(added, &registry.active_account_id))
}

/// Mark the current pending account verified after the cloud server accepted
/// its identity. The database must already be bound to the same email/API URL.
/// Validate a cloud identity against the registry's current active account.
/// This is intentionally independent of any account id supplied by a WebView.
/// Pending cloud accounts must match both their registered email and canonical
/// API server; anonymous/default accounts may still log in for the first time.
pub fn verify_cloud_identity(root: &Path, email: &str, api_url: &str) -> AccountResult<()> {
    let registry = AccountRegistry::load(root)?;
    let active = registry.active();
    if active.kind != AccountKind::Cloud {
        // The anonymous/default data space has no registry identity to check;
        // its database binding is validated by sync_initialize_cloud itself.
        return Ok(());
    }
    let expected_email = active.email.as_deref().ok_or_else(|| {
        AccountError::VerificationMismatch("cloud account has no registered email".to_owned())
    })?;
    if normalize_email(email) != normalize_email(expected_email) {
        return Err(AccountError::VerificationMismatch(
            "login email does not match the active account".to_owned(),
        ));
    }
    if let Some(expected_api_url) = active.api_url.as_deref()
        && normalize_api_url(api_url)? != expected_api_url
    {
        return Err(AccountError::VerificationMismatch(
            "login API server does not match the active account".to_owned(),
        ));
    }
    Ok(())
}

pub fn mark_account_verified(root: &Path) -> AccountResult<AccountSummary> {
    let mut registry = AccountRegistry::load(root)?;
    let active_id = registry.active_account_id.clone();
    let active = registry.active().clone();
    if !active.pending {
        // Verification is idempotent for legacy/already-bound accounts. Only a
        // pending account has an identity that must be promoted after cloud
        // initialization; do not hide a genuine mismatch in that flow.
        return Ok(summary_from_record(&active, &registry.active_account_id));
    }
    if active.kind != AccountKind::Cloud {
        return Err(AccountError::InvalidRegistry(
            "anonymous account cannot be marked verified".to_owned(),
        ));
    }
    let email = active
        .email
        .clone()
        .ok_or_else(|| AccountError::InvalidRegistry("cloud account has no email".to_owned()))?;
    let api_url = active
        .api_url
        .clone()
        .ok_or_else(|| AccountError::InvalidRegistry("cloud account has no api url".to_owned()))?;
    let snapshot = read_snapshot(&database_path(root, &active_id)?)?;
    if snapshot.bound_account.as_deref() != Some(email.as_str())
        || snapshot.bound_api_url.as_deref() != Some(api_url.as_str())
    {
        return Err(AccountError::VerificationMismatch(
            "cloud server identity is not bound in the active database".to_owned(),
        ));
    }
    if let Some(record) = registry.account_mut(&active_id) {
        record.pending = false;
        record.touch();
    }
    registry.save(root)?;
    let record = registry
        .account(&active_id)
        .ok_or_else(|| AccountError::InvalidRegistry("active account disappeared".to_owned()))?;
    Ok(summary_from_record(record, &registry.active_account_id))
}

fn verify_target_identity(root: &Path, target: &AccountRecord) -> AccountResult<()> {
    ensure_account_dir(root, &target.id)?;
    let path = database_path(root, &target.id)?;
    validate_database_path(&path)?;
    if !path.is_file() {
        return Err(AccountError::ActiveAccountMissing(target.id.clone()));
    }
    let snapshot = read_snapshot(&path)?;
    match target.kind {
        AccountKind::Anonymous => {
            if target.id != DEFAULT_ACCOUNT_ID {
                return Err(AccountError::VerificationMismatch(
                    "anonymous target is not the default account".to_owned(),
                ));
            }
            // The default data space may already be cloud-bound from RC2-A.
            // The explicit default account id is the ownership boundary; this
            // does not attribute its data to any other account.
        }
        AccountKind::Cloud => {
            let email = target.email.as_deref().ok_or_else(|| {
                AccountError::InvalidRegistry("cloud target has no email".to_owned())
            })?;
            if let Some(bound) = &snapshot.bound_account
                && normalize_email(bound) != normalize_email(email)
            {
                return Err(AccountError::VerificationMismatch(format!(
                    "target database is bound to a different account ({bound})"
                )));
            }
            if let Some(api_url) = &target.api_url {
                if let Some(bound_api) = &snapshot.bound_api_url
                    && normalize_api_url(bound_api)? != *api_url
                {
                    return Err(AccountError::VerificationMismatch(
                        "target database is bound to a different API server".to_owned(),
                    ));
                }
                if !target.pending {
                    if snapshot.bound_account.is_none() {
                        return Err(AccountError::VerificationMismatch(
                            "verified cloud target database has no account binding".to_owned(),
                        ));
                    }
                    if snapshot.bound_api_url.is_none() {
                        return Err(AccountError::VerificationMismatch(
                            "verified cloud target database has no API server binding".to_owned(),
                        ));
                    }
                }
            } else if !target.pending && snapshot.bound_account.is_none() {
                return Err(AccountError::VerificationMismatch(
                    "cloud target database has no account binding".to_owned(),
                ));
            } else if target.api_url.is_none() && snapshot.bound_api_url.is_some() {
                return Err(AccountError::VerificationMismatch(
                    "cloud target has a server-bound database but no registered server identity"
                        .to_owned(),
                ));
            }
        }
    }
    Ok(())
}

fn summary_from_record(record: &AccountRecord, active_id: &str) -> AccountSummary {
    AccountSummary {
        id: record.id.clone(),
        kind: record.kind.as_str().to_owned(),
        email: record.email.clone(),
        api_url: record.api_url.clone(),
        pending: record.pending,
        active: record.id == active_id,
        last_opened_at: record.last_opened_at.clone(),
    }
}

fn remove_journal(root: &Path) -> AccountResult<()> {
    fault::point(
        FaultPoint::SwitchJournalBeforeCleanup,
        None,
        None,
        Some("remove switch journal"),
    )?;
    match fs::remove_file(pending_account_switch_file(root)) {
        Ok(()) => {
            sync_directory(root)?;
            Ok(())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn timestamp() -> String {
    Utc::now().to_rfc3339()
}
