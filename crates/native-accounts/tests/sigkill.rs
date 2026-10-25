use std::{fs, process::Command, thread, time::Duration};

use tempfile::TempDir;
use todo_native_accounts::{
    DEFAULT_ACCOUNT_ID, create_pending_cloud_account, ensure_active_account, finish_pending_switch,
    prepare_account_switch, read_snapshot, recover_pending_switch, request_account_switch,
    switch_status,
};
use todo_native_core::{NewTask, TodoStore};

/// Child half of the process-kill tests. It performs the requested account
/// operation, then blocks until the parent kills it. The ready file makes the
/// kill point deterministic; it is not a timing race.
#[test]
#[ignore = "launched by the parent process-kill tests"]
fn sigkill_child_executes_phase_and_waits() {
    let root = std::path::PathBuf::from(std::env::var_os("SHISHI_SIGKILL_ROOT").expect("root"));
    let target = std::env::var("SHISHI_SIGKILL_TARGET").expect("target");
    match std::env::var("SHISHI_SIGKILL_PHASE")
        .expect("phase")
        .as_str()
    {
        "prepared" => {
            prepare_account_switch(&root, &target).expect("prepare child");
        }
        "restart_required" => {
            let prepared = prepare_account_switch(&root, &target).expect("prepare child");
            request_account_switch(&root, &target, prepared.generation.expect("generation"))
                .expect("request child");
        }
        other => panic!("unknown child phase: {other}"),
    }
    fs::write(root.join("child-ready"), b"ready").expect("ready");
    thread::sleep(Duration::from_secs(30));
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

fn create_two_accounts() -> (TempDir, std::path::PathBuf, String) {
    let (dir, root) = temp_root();
    let first = ensure_active_account(&root).expect("default");
    add_task(&first.database_path, "source task");
    let target = create_pending_cloud_account(&root, "kill@example.com", "https://kill.example")
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

fn kill_child_at_phase(root: &std::path::Path, target: &str, phase: &str) {
    let ready = root.join("child-ready");
    let mut child = Command::new(std::env::current_exe().expect("current exe"))
        .args([
            "--ignored",
            "--exact",
            "sigkill_child_executes_phase_and_waits",
        ])
        .env("SHISHI_SIGKILL_ROOT", root)
        .env("SHISHI_SIGKILL_TARGET", target)
        .env("SHISHI_SIGKILL_PHASE", phase)
        .spawn()
        .expect("spawn child");
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while !ready.exists() && std::time::Instant::now() < deadline {
        thread::sleep(Duration::from_millis(50));
    }
    assert!(ready.exists(), "child did not reach phase {phase}");
    child.kill().expect("kill child");
    let _ = child.wait();
}

#[test]
fn process_kill_during_prepared_discards_prepared_journal() {
    let (dir, root, target_id) = create_two_accounts();
    let source_db = root.join("accounts/default/shishi.sqlite3");
    let target_db = root
        .join("accounts")
        .join(&target_id)
        .join("shishi.sqlite3");
    let source_before = read_snapshot(&source_db).expect("source snapshot");
    let target_before = read_snapshot(&target_db).expect("target snapshot");

    kill_child_at_phase(&root, &target_id, "prepared");
    let recovery = recover_pending_switch(&root).expect("recover PREPARED");
    assert!(!recovery.target_committed);
    assert_eq!(
        switch_status(&root).expect("status").phase,
        None,
        "PREPARED journal must be discarded after restart"
    );
    let active = ensure_active_account(&root).expect("source active");
    assert_eq!(active.account_id, DEFAULT_ACCOUNT_ID);
    assert!(active.database_path.is_file());
    assert_eq!(
        read_snapshot(&active.database_path)
            .expect("source after")
            .fingerprint,
        source_before.fingerprint
    );
    assert_eq!(
        read_snapshot(&target_db).expect("target after").fingerprint,
        target_before.fingerprint
    );
    drop(dir);
}

#[test]
fn process_kill_during_restart_window_is_recoverable() {
    let (dir, root, target_id) = create_two_accounts();
    let source_db = root.join("accounts/default/shishi.sqlite3");
    let target_db = root
        .join("accounts")
        .join(&target_id)
        .join("shishi.sqlite3");
    let source_before = read_snapshot(&source_db).expect("source snapshot");
    let target_before = read_snapshot(&target_db).expect("target snapshot");

    kill_child_at_phase(&root, &target_id, "restart_required");
    let recovery = recover_pending_switch(&root).expect("recover after SIGKILL");
    assert!(recovery.target_committed);
    finish_pending_switch(&root).expect("finish");
    let active = ensure_active_account(&root).expect("target active");
    assert_eq!(active.account_id, target_id);
    assert!(active.database_path.is_file());
    assert_ne!(active.account_id, DEFAULT_ACCOUNT_ID);
    assert_eq!(
        read_snapshot(&active.database_path)
            .expect("target after")
            .fingerprint,
        target_before.fingerprint
    );
    assert_eq!(
        read_snapshot(&source_db).expect("source after").fingerprint,
        source_before.fingerprint
    );
    let status = switch_status(&root).expect("status");
    assert!(status.active);
    assert_eq!(status.phase, None);
    assert_eq!(
        status.pending_outbox,
        target_before.outbox_rows.len() as i64,
        "switch must not drop or duplicate the target outbox"
    );
    drop(dir);
}

fn temp_root() -> (TempDir, std::path::PathBuf) {
    let dir = tempfile::tempdir().expect("tempdir");
    let root = dir.path().to_path_buf();
    (dir, root)
}
