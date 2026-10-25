#![cfg(feature = "fault-injection")]

use std::{
    path::PathBuf,
    process::{Command, ExitStatus},
    sync::Arc,
};

use tempfile::TempDir;
use todo_native_accounts::{
    DEFAULT_ACCOUNT_ID, FaultAction, FaultEvent, FaultInjector, FaultPoint, SwitchPhase,
    create_pending_cloud_account, ensure_active_account, fault::install, finish_pending_switch,
    prepare_account_switch, read_snapshot, recover_pending_switch, request_account_switch,
    switch_status,
};
use todo_native_core::{NewTask, TodoStore};

const CHILD_EXIT: i32 = 99;

struct TerminatingInjector {
    point: FaultPoint,
}

impl FaultInjector for TerminatingInjector {
    fn decide(&self, event: &FaultEvent) -> Option<FaultAction> {
        (event.point == self.point).then_some(FaultAction::Terminate {
            exit_code: CHILD_EXIT,
        })
    }

    fn record(&self, _evidence: &todo_native_accounts::FaultEvidence) {}
}

/// Child half: performs a real account operation with a process-terminating
/// injector armed at an exact persisted boundary.
#[test]
#[ignore = "launched by crash_fault_matrix tests"]
fn crash_child_exits_at_configured_fault() {
    let root = PathBuf::from(std::env::var_os("SHISHI_CRASH_ROOT").expect("root"));
    let target = std::env::var("SHISHI_CRASH_TARGET").expect("target");
    let operation = std::env::var("SHISHI_CRASH_OPERATION").expect("operation");
    let point = match std::env::var("SHISHI_CRASH_POINT").expect("point").as_str() {
        "prepared" => FaultPoint::SwitchPreparedPersisted,
        "restart_required" => FaultPoint::SwitchRestartRequiredPersisted,
        "verifying_target" => FaultPoint::SwitchVerifyingTargetPersisted,
        "registry_before" => FaultPoint::RegistryActiveBeforeUpdate,
        "registry_after" => FaultPoint::RegistryActiveAfterUpdate,
        "journal_cleanup" => FaultPoint::SwitchJournalBeforeCleanup,
        other => panic!("unknown crash point: {other}"),
    };
    install(Arc::new(TerminatingInjector { point })).expect("install injector");

    match operation.as_str() {
        "prepare" => {
            prepare_account_switch(&root, &target).expect("prepare");
        }
        "request" => {
            let generation: u64 = std::env::var("SHISHI_CRASH_GENERATION")
                .expect("generation")
                .parse()
                .expect("generation number");
            request_account_switch(&root, &target, generation).expect("request");
        }
        "recover" => {
            recover_pending_switch(&root).expect("recover");
        }
        "recover_finish" => {
            recover_pending_switch(&root).expect("recover");
            finish_pending_switch(&root).expect("finish");
        }
        other => panic!("unknown crash operation: {other}"),
    }
}

fn add_task(db: &std::path::Path, title: &str) {
    let store = TodoStore::open(db).expect("store");
    store.sync_set_enabled(true).expect("sync enabled");
    store
        .create_task(NewTask {
            title: title.to_owned(),
            ..NewTask::default()
        })
        .expect("task");
}

fn create_accounts() -> (TempDir, PathBuf, String) {
    let dir = tempfile::tempdir().expect("tempdir");
    let root = dir.path().to_path_buf();
    let source = ensure_active_account(&root).expect("source");
    add_task(&source.database_path, "source task");
    let target = create_pending_cloud_account(&root, "crash@example.com", "https://crash.example")
        .expect("target");
    add_task(
        &root
            .join("accounts")
            .join(&target.id)
            .join("shishi.sqlite3"),
        "target task",
    );
    (dir, root, target.id)
}

fn run_child(
    root: &std::path::Path,
    target: &str,
    operation: &str,
    point: &str,
    generation: Option<u64>,
) -> ExitStatus {
    let mut command = Command::new(std::env::current_exe().expect("current exe"));
    command
        .args([
            "--ignored",
            "--exact",
            "crash_child_exits_at_configured_fault",
        ])
        .env("SHISHI_CRASH_ROOT", root)
        .env("SHISHI_CRASH_TARGET", target)
        .env("SHISHI_CRASH_OPERATION", operation)
        .env("SHISHI_CRASH_POINT", point);
    if let Some(generation) = generation {
        command.env("SHISHI_CRASH_GENERATION", generation.to_string());
    }
    command.status().expect("run child")
}

fn snapshots(
    root: &std::path::Path,
    target: &str,
) -> (
    todo_native_accounts::DataSnapshot,
    todo_native_accounts::DataSnapshot,
) {
    let source = read_snapshot(&root.join("accounts/default/shishi.sqlite3")).expect("source snap");
    let target = read_snapshot(&root.join("accounts").join(target).join("shishi.sqlite3"))
        .expect("target snap");
    (source, target)
}

fn assert_exited_at_fault(status: ExitStatus) {
    assert_eq!(
        status.code(),
        Some(CHILD_EXIT),
        "child must terminate at the configured fault, not return an error"
    );
}

fn assert_source_still_active(root: &std::path::Path) -> todo_native_accounts::DataSnapshot {
    assert_eq!(
        switch_status(root).expect("status").phase,
        None,
        "prepared journal must be discarded"
    );
    let active = ensure_active_account(root).expect("source active");
    assert_eq!(active.account_id, DEFAULT_ACCOUNT_ID);
    read_snapshot(&active.database_path).expect("source snapshot")
}

#[test]
fn process_exit_after_prepared_persisted_discards_journal() {
    let (_dir, root, target) = create_accounts();
    let (source_before, target_before) = snapshots(&root, &target);
    let status = run_child(&root, &target, "prepare", "prepared", None);
    assert_exited_at_fault(status);
    assert_eq!(
        switch_status(&root).expect("status").phase,
        Some(SwitchPhase::Prepared)
    );

    let recovery = recover_pending_switch(&root).expect("recover prepared");
    assert!(!recovery.target_committed);
    let source_after = assert_source_still_active(&root);
    assert_eq!(source_after.fingerprint, source_before.fingerprint);
    assert_eq!(
        read_snapshot(&root.join("accounts").join(&target).join("shishi.sqlite3"))
            .expect("target after")
            .fingerprint,
        target_before.fingerprint
    );
}

#[test]
fn process_exit_after_restart_required_commits_target() {
    let (_dir, root, target) = create_accounts();
    let prepared = prepare_account_switch(&root, &target).expect("prepare");
    let (source_before, target_before) = snapshots(&root, &target);
    let status = run_child(
        &root,
        &target,
        "request",
        "restart_required",
        Some(prepared.generation.expect("generation")),
    );
    assert_exited_at_fault(status);
    assert_eq!(
        switch_status(&root).expect("status").phase,
        Some(SwitchPhase::RestartRequired)
    );

    let recovery = recover_pending_switch(&root).expect("recover restart");
    assert!(recovery.target_committed);
    finish_pending_switch(&root).expect("finish");
    let active = ensure_active_account(&root).expect("target active");
    assert_eq!(active.account_id, target);
    assert_eq!(
        read_snapshot(&active.database_path)
            .expect("target after")
            .fingerprint,
        target_before.fingerprint
    );
    assert_eq!(
        read_snapshot(&root.join("accounts/default/shishi.sqlite3"))
            .expect("source after")
            .fingerprint,
        source_before.fingerprint
    );
    assert_eq!(switch_status(&root).expect("status").phase, None);
}

#[test]
fn process_exit_at_verifying_target_retry_commits_target() {
    let (_dir, root, target) = create_accounts();
    let prepared = prepare_account_switch(&root, &target).expect("prepare");
    request_account_switch(&root, &target, prepared.generation.expect("generation"))
        .expect("request");
    let status = run_child(&root, &target, "recover", "verifying_target", None);
    assert_exited_at_fault(status);
    assert_eq!(
        switch_status(&root).expect("status").phase,
        Some(SwitchPhase::VerifyingTarget)
    );
    let recovery = recover_pending_switch(&root).expect("retry recover");
    assert!(recovery.target_committed);
    finish_pending_switch(&root).expect("finish");
    assert_eq!(
        ensure_active_account(&root)
            .expect("target active")
            .account_id,
        target
    );
}

#[test]
fn process_exit_before_registry_update_retry_commits_target() {
    let (_dir, root, target) = create_accounts();
    let prepared = prepare_account_switch(&root, &target).expect("prepare");
    request_account_switch(&root, &target, prepared.generation.expect("generation"))
        .expect("request");
    let status = run_child(&root, &target, "recover", "registry_before", None);
    assert_exited_at_fault(status);
    let journal = switch_status(&root).expect("status");
    assert_eq!(journal.phase, Some(SwitchPhase::VerifyingTarget));
    let recovery = recover_pending_switch(&root).expect("retry recover");
    assert!(recovery.target_committed);
    finish_pending_switch(&root).expect("finish");
    assert_eq!(
        ensure_active_account(&root)
            .expect("target active")
            .account_id,
        target
    );
}

#[test]
fn process_exit_after_registry_update_retry_is_idempotent() {
    let (_dir, root, target) = create_accounts();
    let prepared = prepare_account_switch(&root, &target).expect("prepare");
    request_account_switch(&root, &target, prepared.generation.expect("generation"))
        .expect("request");
    let status = run_child(&root, &target, "recover", "registry_after", None);
    assert_exited_at_fault(status);
    assert_eq!(
        switch_status(&root).expect("status").phase,
        Some(SwitchPhase::VerifyingTarget)
    );
    let recovery = recover_pending_switch(&root).expect("recover idempotent");
    assert!(recovery.target_committed);
    finish_pending_switch(&root).expect("finish");
    let second = recover_pending_switch(&root).expect("second recover");
    assert!(!second.target_committed);
    assert_eq!(
        ensure_active_account(&root)
            .expect("target active")
            .account_id,
        target
    );
}

#[test]
fn process_exit_before_journal_cleanup_retry_finishes() {
    let (_dir, root, target) = create_accounts();
    let prepared = prepare_account_switch(&root, &target).expect("prepare");
    request_account_switch(&root, &target, prepared.generation.expect("generation"))
        .expect("request");
    let status = run_child(&root, &target, "recover_finish", "journal_cleanup", None);
    assert_exited_at_fault(status);
    assert_eq!(
        switch_status(&root).expect("status").phase,
        Some(SwitchPhase::VerifyingTarget)
    );
    let recovery = recover_pending_switch(&root).expect("recover");
    assert!(recovery.target_committed);
    finish_pending_switch(&root).expect("finish");
    assert_eq!(
        ensure_active_account(&root)
            .expect("target active")
            .account_id,
        target
    );
    assert_eq!(switch_status(&root).expect("status").phase, None);
}
