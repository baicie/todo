#![cfg(feature = "fault-injection")]

use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use tempfile::TempDir;
use todo_native_accounts::{
    AccountError, FaultAction, FaultEvent, FaultEvidence, FaultInjector, FaultPoint,
    MigrationPhase, abort_prepared_switch, create_pending_cloud_account, ensure_active_account,
    fault::{clear, install},
    finish_pending_switch, migration_state, prepare_account_switch, recover_pending_switch,
    request_account_switch, switch_status,
};
use todo_native_core::{NewTask, TodoStore};

static SERIAL: Mutex<()> = Mutex::new(());

fn temp_root() -> (TempDir, PathBuf) {
    let directory = tempfile::tempdir().expect("tempdir");
    let root = directory.path().to_path_buf();
    (directory, root)
}

#[derive(Default)]
struct Injector {
    point: Mutex<Option<FaultPoint>>,
    action: Mutex<Option<FaultAction>>,
    evidence: Mutex<Vec<String>>,
}

impl FaultInjector for Injector {
    fn decide(&self, event: &FaultEvent) -> Option<FaultAction> {
        (self.point.lock().expect("point").as_ref() == Some(&event.point))
            .then(|| self.action.lock().expect("action").clone())
            .flatten()
    }

    fn record(&self, evidence: &FaultEvidence) {
        self.evidence
            .lock()
            .expect("evidence")
            .push(format!("{}:{}", evidence.point, evidence.result));
    }
}

struct Armed(Arc<Injector>);

impl Armed {
    fn new(point: FaultPoint, action: FaultAction) -> Self {
        let injector = Arc::new(Injector::default());
        *injector.point.lock().expect("point") = Some(point);
        *injector.action.lock().expect("action") = Some(action);
        install(injector.clone()).expect("install fault injector");
        Self(injector)
    }

    fn records(&self, value: &str) -> bool {
        self.0
            .evidence
            .lock()
            .expect("evidence")
            .iter()
            .any(|item| item.contains(value))
    }
}

impl Drop for Armed {
    fn drop(&mut self) {
        clear();
    }
}

fn injected_error() -> FaultAction {
    FaultAction::Error {
        code: "SIMULATED_FAULT".to_owned(),
        message: "deterministic test fault".to_owned(),
    }
}

fn ensure_root(root: &Path) {
    ensure_active_account(root).expect("fresh default");
}

#[test]
fn fresh_installation_fault_points_are_recoverable() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    clear();

    let (_dir, root) = temp_root();
    let armed = Armed::new(FaultPoint::InstallationPrepared, injected_error());
    let error = ensure_active_account(&root).expect_err("injected before DB creation");
    assert!(
        matches!(error, AccountError::FaultInjected(_)),
        "unexpected migration error: {error}"
    );
    assert!(root.join("installation-state.json").is_file());
    assert!(armed.records("installation_prepared:error:SIMULATED_FAULT"));
    drop(armed);
    ensure_active_account(&root).expect("retry after PREPARED");
    assert!(!root.join("installation-state.json").exists());

    let (_dir2, root2) = temp_root();
    let armed = Armed::new(FaultPoint::InstallationDatabaseCreated, injected_error());
    let error = ensure_active_account(&root2).expect_err("injected after DB creation");
    assert!(
        matches!(error, AccountError::FaultInjected(_)),
        "unexpected migration error: {error}"
    );
    let database = root2.join("accounts/default/shishi.sqlite3");
    assert!(database.is_file());
    todo_native_accounts::read_snapshot(&database).expect("valid created database");
    drop(armed);
    let context = ensure_active_account(&root2).expect("retry after DB creation");
    assert_eq!(context.account_id, "default");
}

#[test]
fn migration_fault_points_do_not_delete_or_replace_source() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    clear();

    for (point, expected_phase, target_should_exist) in [
        (
            FaultPoint::MigrationBackupCreated,
            MigrationPhase::BackupCreated,
            false,
        ),
        (
            FaultPoint::MigrationCopyVerified,
            MigrationPhase::CopyVerified,
            true,
        ),
    ] {
        let (_dir, root) = temp_root();
        {
            let store = TodoStore::open(root.join("shishi.sqlite3")).expect("legacy store");
            store
                .create_task(NewTask {
                    title: "legacy fault task".to_owned(),
                    ..NewTask::default()
                })
                .expect("legacy task");
        }
        let source_before = todo_native_accounts::read_snapshot(&root.join("shishi.sqlite3"))
            .expect("source snapshot");
        let armed = Armed::new(point, injected_error());
        let error = ensure_active_account(&root).expect_err("injected migration point");
        assert!(
            matches!(error, AccountError::FaultInjected(_)),
            "unexpected migration error: {error}"
        );
        let state = migration_state(&root)
            .expect("migration state")
            .expect("state present");
        assert_eq!(state.phase, expected_phase);
        let source_after = todo_native_accounts::read_snapshot(&root.join("shishi.sqlite3"))
            .expect("source still present");
        assert_eq!(
            source_after.fingerprint, source_before.fingerprint,
            "migration fault must preserve source data"
        );
        let backup = state.backup_file.expect("backup recorded");
        assert!(root.join(backup).is_file());
        let target = root
            .join("accounts")
            .join(state.target_account_id.expect("target id"))
            .join("shishi.sqlite3");
        assert_eq!(target.is_file(), target_should_exist);
        assert!(armed.records(point.as_str()));
        drop(armed);
        ensure_active_account(&root).expect("resume migration after fault");
        assert_eq!(
            migration_state(&root)
                .expect("complete state")
                .expect("state present")
                .phase,
            MigrationPhase::Complete
        );
        let backup_count = std::fs::read_dir(root.join("migration-backups"))
            .expect("backup dir")
            .count();
        ensure_active_account(&root).expect("second restart");
        assert_eq!(
            std::fs::read_dir(root.join("migration-backups"))
                .expect("backup dir")
                .count(),
            backup_count,
            "migration retry must not duplicate backups"
        );
    }
}

#[test]
fn switch_journal_fault_points_are_deterministic_and_recoverable() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    clear();

    let (_dir, root) = temp_root();
    ensure_root(&root);
    let pending =
        create_pending_cloud_account(&root, "fault2@example.test", "https://fault.example")
            .expect("pending target");
    let armed = Armed::new(FaultPoint::SwitchPreparedPersisted, injected_error());
    let error = prepare_account_switch(&root, &pending.id).expect_err("injected prepared");
    assert!(
        matches!(error, AccountError::FaultInjected(_)),
        "unexpected migration error: {error}"
    );
    assert_eq!(
        switch_status(&root).expect("status").phase,
        Some(todo_native_accounts::SwitchPhase::Prepared)
    );
    assert!(armed.records("switch_prepared_persisted"));
    drop(armed);
    // A failed prepare leaves a PREPARED journal; startup recovery must discard
    // it rather than switching to the target.
    recover_pending_switch(&root).expect("discard prepared");
    assert!(switch_status(&root).expect("status").active);

    let pending =
        create_pending_cloud_account(&root, "fault3@example.test", "https://fault.example")
            .expect("pending target");
    let status = prepare_account_switch(&root, &pending.id).expect("prepare");
    let generation = status.generation.expect("generation");
    let armed = Armed::new(FaultPoint::SwitchRestartRequiredPersisted, injected_error());
    let error =
        request_account_switch(&root, &pending.id, generation).expect_err("injected request");
    assert!(
        matches!(error, AccountError::FaultInjected(_)),
        "unexpected migration error: {error}"
    );
    assert_eq!(
        switch_status(&root).expect("status").phase,
        Some(todo_native_accounts::SwitchPhase::RestartRequired)
    );
    assert!(armed.records("switch_restart_required_persisted"));
    drop(armed);
    let recovery = recover_pending_switch(&root).expect("recover restart required");
    assert!(recovery.target_committed);
    finish_pending_switch(&root).expect("finish target");
    assert_eq!(
        ensure_active_account(&root)
            .expect("target active")
            .account_id,
        pending.id
    );
}

#[test]
fn verifying_target_and_cleanup_faults_are_idempotent() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    clear();

    let (_dir, root) = temp_root();
    ensure_root(&root);
    let pending =
        create_pending_cloud_account(&root, "fault4@example.test", "https://fault.example")
            .expect("pending target");
    let status = prepare_account_switch(&root, &pending.id).expect("prepare");
    request_account_switch(&root, &pending.id, status.generation.expect("generation"))
        .expect("request");

    let armed = Armed::new(FaultPoint::SwitchVerifyingTargetPersisted, injected_error());
    let error = recover_pending_switch(&root).expect_err("injected verifying");
    assert!(
        matches!(error, AccountError::FaultInjected(_)),
        "unexpected migration error: {error}"
    );
    let journal = switch_status(&root).expect("status");
    assert_eq!(
        journal.phase,
        Some(todo_native_accounts::SwitchPhase::VerifyingTarget)
    );
    drop(armed);
    recover_pending_switch(&root).expect("recover verifying");
    finish_pending_switch(&root).expect("finish");

    // A cleanup failure leaves the journal intact; retry is idempotent.
    let (_dir2, root2) = temp_root();
    ensure_root(&root2);
    let pending =
        create_pending_cloud_account(&root2, "fault5@example.test", "https://fault.example")
            .expect("pending target");
    let status = prepare_account_switch(&root2, &pending.id).expect("prepare");
    request_account_switch(&root2, &pending.id, status.generation.expect("generation"))
        .expect("request");
    recover_pending_switch(&root2).expect("recover");
    let armed = Armed::new(FaultPoint::SwitchJournalBeforeCleanup, injected_error());
    let error = finish_pending_switch(&root2).expect_err("injected cleanup");
    assert!(
        matches!(error, AccountError::FaultInjected(_)),
        "unexpected migration error: {error}"
    );
    assert_eq!(
        switch_status(&root2).expect("status").phase,
        Some(todo_native_accounts::SwitchPhase::VerifyingTarget)
    );
    drop(armed);
    finish_pending_switch(&root2).expect("retry cleanup");
    assert!(switch_status(&root2).expect("active").active);
}

#[test]
fn abort_cleanup_fault_keeps_gate_closed_at_call_site() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    clear();
    let (_dir, root) = temp_root();
    ensure_root(&root);
    let pending =
        create_pending_cloud_account(&root, "fault6@example.test", "https://fault.example")
            .expect("pending target");
    prepare_account_switch(&root, &pending.id).expect("prepare");
    let armed = Armed::new(FaultPoint::SwitchJournalBeforeCleanup, injected_error());
    let error = abort_prepared_switch(&root).expect_err("injected abort cleanup");
    assert!(
        matches!(error, AccountError::FaultInjected(_)),
        "unexpected migration error: {error}"
    );
    assert_eq!(
        switch_status(&root).expect("status").phase,
        Some(todo_native_accounts::SwitchPhase::Prepared)
    );
    drop(armed);
    assert_eq!(
        abort_prepared_switch(&root).expect("retry abort"),
        todo_native_accounts::AbortSwitchOutcome::Aborted
    );
}

#[test]
fn registry_active_update_faults_resume_without_losing_switch() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    clear();
    for point in [
        FaultPoint::RegistryActiveBeforeUpdate,
        FaultPoint::RegistryActiveAfterUpdate,
    ] {
        let (_dir, root) = temp_root();
        ensure_root(&root);
        let pending =
            create_pending_cloud_account(&root, "fault7@example.test", "https://fault.example")
                .expect("pending target");
        let status = prepare_account_switch(&root, &pending.id).expect("prepare");
        request_account_switch(&root, &pending.id, status.generation.expect("generation"))
            .expect("request");
        let armed = Armed::new(point, injected_error());
        let error = recover_pending_switch(&root).expect_err("injected registry update");
        assert!(matches!(error, AccountError::FaultInjected(_)));
        let journal = switch_status(&root).expect("status");
        assert_eq!(
            journal.phase,
            Some(todo_native_accounts::SwitchPhase::VerifyingTarget)
        );
        drop(armed);
        recover_pending_switch(&root).expect("recover registry");
        finish_pending_switch(&root).expect("finish");
        assert_eq!(
            ensure_active_account(&root)
                .expect("target active")
                .account_id,
            pending.id
        );
    }
}
