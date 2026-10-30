//! Read-only recovery diagnostics.
//!
//! This module never repairs, forces a binding, migrates, resets or rewrites
//! account state. Export is a redacted JSON snapshot for support and QA.

use std::{
    fs,
    path::{Path, PathBuf},
};

use chrono::Utc;
use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use todo_native_accounts::{
    AccountRegistry, MigrationPhase, legacy_review_report, migration_backups_dir,
    migration_state_read_only, switch_status_read_only, verify_integrity,
};

use crate::{
    commands::CommandError,
    db::AppState,
    notification_activation::{ActivationDiagnostic, NotificationActivationState},
};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticBackup {
    pub file: String,
    pub size_bytes: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticAccount {
    pub id: String,
    pub kind: String,
    pub active: bool,
    pub pending: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticMigration {
    pub phase: MigrationPhase,
    pub target_account_id: Option<String>,
    pub source_file: String,
    pub backup_file: Option<String>,
    pub has_error: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticLegacyReview {
    pub reason_code: &'static str,
    pub source_file: String,
    pub backup_file: Option<String>,
    pub requires_manual_identity_verification: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticSwitch {
    pub active: bool,
    pub phase: Option<String>,
    pub from_account_id: Option<String>,
    pub to_account_id: Option<String>,
    pub pending_outbox: i64,
}

/// The read-only bundle. Its `activation_diagnostics` section is read from the
/// bounded, redacted diagnostic window of the delivery state machine, so no task
/// title, task id, account id, session string, token or path can reach it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryDiagnostics {
    pub generated_at: String,
    pub app_version: String,
    pub policy: &'static str,
    pub force_bind_available: bool,
    pub active_account_id: String,
    pub active_database_file: String,
    pub active_database_integrity: String,
    pub legacy_source_present: bool,
    pub migration: Option<DiagnosticMigration>,
    pub legacy_review: Option<DiagnosticLegacyReview>,
    pub switch: Option<DiagnosticSwitch>,
    pub accounts: Vec<DiagnosticAccount>,
    pub backups: Vec<DiagnosticBackup>,
    pub conflict_reasons: Vec<String>,
    pub warnings: Vec<String>,
    pub activation_diagnostics: Vec<ActivationDiagnostic>,
}

/// Read the activation diagnostic window out of the managed delivery state. An
/// unregistered state simply reports no activation evidence.
pub fn activation_diagnostics(app: &AppHandle) -> Vec<ActivationDiagnostic> {
    app.try_state::<NotificationActivationState>()
        .map(|state| state.activation_diagnostics())
        .unwrap_or_default()
}

fn data_dir(app: &AppHandle) -> Result<PathBuf, CommandError> {
    app.path()
        .app_data_dir()
        .map_err(|error| CommandError::new("DIAGNOSTICS", format!("无法定位应用数据目录: {error}")))
}

pub fn collect(
    root: &Path,
    active_account_id: &str,
    activation_diagnostics: Vec<ActivationDiagnostic>,
) -> Result<RecoveryDiagnostics, String> {
    let registry = AccountRegistry::load(root).map_err(|error| error.to_string())?;
    let migration = migration_state_read_only(root).map_err(|error| error.to_string())?;
    let legacy_review = legacy_review_report(root).map_err(|error| error.to_string())?;
    let switch = switch_status_read_only(root).map_err(|error| error.to_string())?;
    let active = registry.active_account_id.clone();
    let accounts: Vec<DiagnosticAccount> = registry
        .accounts
        .iter()
        .map(|account| DiagnosticAccount {
            id: account.id.clone(),
            kind: account.kind.as_str().to_owned(),
            active: account.id == registry.active_account_id,
            pending: account.pending,
        })
        .collect();
    let database = todo_native_accounts::account_database_path(root, active_account_id)
        .map_err(|error| error.to_string())?;
    let integrity = if database.is_file() {
        match verify_integrity(&database) {
            Ok(()) => "ok".to_owned(),
            Err(error) => format!("failed: {error}"),
        }
    } else {
        "missing".to_owned()
    };
    let mut backups = Vec::new();
    let backup_root = migration_backups_dir(root);
    if let Ok(entries) = fs::read_dir(&backup_root) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() {
                let file = path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("unknown")
                    .to_owned();
                let size_bytes = entry.metadata().map(|metadata| metadata.len()).unwrap_or(0);
                backups.push(DiagnosticBackup { file, size_bytes });
            }
        }
    }
    backups.sort_by(|left, right| left.file.cmp(&right.file));

    let mut conflict_reasons = Vec::new();
    let migration = migration.map(|state| {
        if state.phase == MigrationPhase::RequiresReview {
            conflict_reasons.push("legacy_identity_requires_manual_review".to_owned());
        }
        if state.phase == MigrationPhase::Failed {
            conflict_reasons.push("legacy_migration_failed".to_owned());
        }
        DiagnosticMigration {
            phase: state.phase,
            target_account_id: state.target_account_id,
            source_file: state.source_file,
            backup_file: state.backup_file,
            has_error: state.error.is_some(),
        }
    });
    let legacy_review = legacy_review.map(|review| {
        conflict_reasons.push("legacy_identity_requires_manual_review".to_owned());
        DiagnosticLegacyReview {
            reason_code: "LEGACY_IDENTITY_AMBIGUOUS",
            source_file: review.source_file,
            backup_file: review.backup_file,
            requires_manual_identity_verification: review.requires_manual_identity_verification,
        }
    });
    if switch.phase == Some(todo_native_accounts::SwitchPhase::Failed) {
        conflict_reasons.push("switch_journal_failed".to_owned());
    }
    if integrity != "ok" {
        conflict_reasons.push("active_database_integrity_failed".to_owned());
    }
    let switch = DiagnosticSwitch {
        active: switch.active,
        phase: switch.phase.map(|phase| format!("{phase:?}")),
        from_account_id: switch.from_account_id,
        to_account_id: switch.to_account_id,
        pending_outbox: switch.pending_outbox,
    };
    let warnings = conflict_reasons.clone();

    Ok(RecoveryDiagnostics {
        generated_at: Utc::now().to_rfc3339(),
        app_version: env!("CARGO_PKG_VERSION").to_owned(),
        policy: "read-only; no force-bind; no repair",
        force_bind_available: false,
        active_account_id: active,
        active_database_file: database
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("shishi.sqlite3")
            .to_owned(),
        active_database_integrity: integrity,
        legacy_source_present: todo_native_accounts::legacy_database_path(root).is_file(),
        migration,
        legacy_review,
        switch: Some(switch),
        accounts,
        backups,
        conflict_reasons,
        warnings,
        activation_diagnostics,
    })
}

#[tauri::command]
pub fn native_recovery_diagnostics(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<RecoveryDiagnostics, CommandError> {
    let root = data_dir(&app)?;
    collect(
        &root,
        &state.account.account_id,
        activation_diagnostics(&app),
    )
    .map_err(|error| CommandError::new("DIAGNOSTICS", error))
}

/// Writes only a redacted snapshot under the app data root. The caller cannot
/// choose an arbitrary destination path.
#[tauri::command]
pub fn native_export_recovery_diagnostics(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, CommandError> {
    let root = data_dir(&app)?;
    let diagnostics = collect(
        &root,
        &state.account.account_id,
        activation_diagnostics(&app),
    )
    .map_err(|error| CommandError::new("DIAGNOSTICS", error))?;
    let directory = root.join("diagnostics");
    fs::create_dir_all(&directory)
        .map_err(|error| CommandError::new("DIAGNOSTICS", format!("创建诊断目录失败: {error}")))?;
    let file = directory.join(format!(
        "recovery-{}.json",
        Utc::now().format("%Y%m%dT%H%M%S%.3fZ")
    ));
    let bytes = serde_json::to_vec_pretty(&diagnostics)
        .map_err(|error| CommandError::new("DIAGNOSTICS", error.to_string()))?;
    fs::write(&file, bytes)
        .map_err(|error| CommandError::new("DIAGNOSTICS", format!("写入诊断包失败: {error}")))?;
    Ok(file.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diagnostics_are_read_only_and_contain_no_tokens_or_emails() {
        let directory = tempfile::tempdir().expect("tempdir");
        let root = directory.path();
        todo_native_accounts::ensure_active_account(root).expect("fresh install");
        let before = fs::read(root.join("accounts.json")).expect("registry");
        let report = collect(root, todo_native_accounts::DEFAULT_ACCOUNT_ID, Vec::new())
            .expect("diagnostics");
        let after = fs::read(root.join("accounts.json")).expect("registry after");
        assert_eq!(before, after, "diagnostics must not rewrite account state");
        assert_eq!(
            report.active_account_id,
            todo_native_accounts::DEFAULT_ACCOUNT_ID
        );
        assert_eq!(report.active_database_integrity, "ok");
        assert!(!report.force_bind_available);
        assert!(!report.legacy_source_present);
        todo_native_accounts::create_pending_cloud_account(
            root,
            "redacted@example.test",
            "https://example.test",
        )
        .expect("pending account");
        let pending = todo_native_accounts::create_pending_cloud_account(
            root,
            "pending@example.test",
            "https://example.test",
        )
        .expect("pending target");
        todo_native_accounts::prepare_account_switch(root, &pending.id).expect("prepared switch");
        let journal = fs::read(todo_native_accounts::pending_account_switch_file(root))
            .expect("journal before diagnostics");
        let report = collect(root, todo_native_accounts::DEFAULT_ACCOUNT_ID, Vec::new())
            .expect("diagnostics");
        let journal_after = fs::read(todo_native_accounts::pending_account_switch_file(root))
            .expect("journal after diagnostics");
        assert_eq!(
            journal, journal_after,
            "diagnostics must not repair switch state"
        );
        assert_eq!(
            report
                .switch
                .as_ref()
                .and_then(|status| status.phase.as_deref()),
            Some("Prepared")
        );
        let json = serde_json::to_string(&report).expect("json");
        assert!(!json.contains("token"));
        assert!(!json.contains("@example.test"));
    }

    #[test]
    fn diagnostics_bundle_carries_the_redacted_activation_section() {
        let directory = tempfile::tempdir().expect("tempdir");
        let root = directory.path();
        todo_native_accounts::ensure_active_account(root).expect("fresh install");
        let record = ActivationDiagnostic {
            activation_id: "1746000000000-7".to_owned(),
            notification_instance_id: Some("instance-7".to_owned()),
            event_type: "rejected",
            rejection_code: Some("ACTIVATION_EXPIRED_DURING_VALIDATION"),
            terminal_outcome: Some("rejected"),
            delivery_attempt: 1,
            session_correlation: "0d5f8f3b1c2a4e69".to_owned(),
            timestamp_millis: 301_000,
        };
        let report = collect(root, todo_native_accounts::DEFAULT_ACCOUNT_ID, vec![record])
            .expect("diagnostics");
        assert_eq!(report.activation_diagnostics.len(), 1);
        let value = serde_json::to_value(&report).expect("json");
        assert!(
            value.get("activationDiagnostics").is_some(),
            "the bundle must expose the activation section"
        );
        let json = serde_json::to_string(&report).expect("json");
        assert!(json.contains("ACTIVATION_EXPIRED_DURING_VALIDATION"));
        assert!(json.contains("0d5f8f3b1c2a4e69"));
        assert!(json.contains("instance-7"));
        // The activation section must not become a second data-leak channel.
        for forbidden in [
            "@example.test",
            "token",
            "refresh",
            "taskTitle",
            "accountId",
        ] {
            assert!(
                !json.contains(forbidden),
                "the bundle must not contain {forbidden}"
            );
        }
        let empty = collect(root, todo_native_accounts::DEFAULT_ACCOUNT_ID, Vec::new())
            .expect("diagnostics");
        assert!(empty.activation_diagnostics.is_empty());
    }
}
