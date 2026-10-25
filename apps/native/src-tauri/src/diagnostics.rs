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
    migration_state_read_only, switch_status, verify_integrity,
};

use crate::{commands::CommandError, db::AppState};

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
}

fn data_dir(app: &AppHandle) -> Result<PathBuf, CommandError> {
    app.path()
        .app_data_dir()
        .map_err(|error| CommandError::new("DIAGNOSTICS", format!("无法定位应用数据目录: {error}")))
}

pub fn collect(root: &Path, active_account_id: &str) -> Result<RecoveryDiagnostics, String> {
    let registry = AccountRegistry::load(root).map_err(|error| error.to_string())?;
    let migration = migration_state_read_only(root).map_err(|error| error.to_string())?;
    let legacy_review = legacy_review_report(root).map_err(|error| error.to_string())?;
    let switch = switch_status(root).map_err(|error| error.to_string())?;
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
    })
}

#[tauri::command]
pub fn native_recovery_diagnostics(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<RecoveryDiagnostics, CommandError> {
    let root = data_dir(&app)?;
    collect(&root, &state.account.account_id)
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
    let diagnostics = collect(&root, &state.account.account_id)
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
        let report = collect(root, todo_native_accounts::DEFAULT_ACCOUNT_ID).expect("diagnostics");
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
        let report = collect(root, todo_native_accounts::DEFAULT_ACCOUNT_ID).expect("diagnostics");
        let json = serde_json::to_string(&report).expect("json");
        assert!(!json.contains("token"));
        assert!(!json.contains("@example.test"));
    }
}
