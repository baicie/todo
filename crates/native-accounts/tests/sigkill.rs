use std::{fs, process::Command, thread, time::Duration};

use tempfile::TempDir;
use todo_native_accounts::{
    DEFAULT_ACCOUNT_ID, create_pending_cloud_account, ensure_active_account, finish_pending_switch,
    prepare_account_switch, recover_pending_switch, request_account_switch,
};

/// Child half of the process-kill test. It is ignored during a normal run and
/// launched explicitly by `process_kill_during_restart_window_is_recoverable`.
#[test]
#[ignore = "launched by the parent process-kill test"]
fn sigkill_child_waits_after_restart_request() {
    let root = std::env::var_os("SHISHI_SIGKILL_ROOT").expect("root");
    fs::write(std::path::Path::new(&root).join("child-ready"), b"ready").expect("ready");
    thread::sleep(Duration::from_secs(30));
}

#[test]
fn process_kill_during_restart_window_is_recoverable() {
    let (dir, root) = temp_root();
    ensure_active_account(&root).expect("default");
    let target = create_pending_cloud_account(&root, "kill@example.com", "https://kill.example")
        .expect("target");
    let prepared = prepare_account_switch(&root, &target.id).expect("prepare");
    request_account_switch(&root, &target.id, prepared.generation.expect("generation"))
        .expect("request");

    let ready = root.join("child-ready");
    let mut child = Command::new(std::env::current_exe().expect("current exe"))
        .args([
            "--ignored",
            "--exact",
            "sigkill_child_waits_after_restart_request",
        ])
        .env("SHISHI_SIGKILL_ROOT", &root)
        .spawn()
        .expect("spawn child");
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while !ready.exists() && std::time::Instant::now() < deadline {
        thread::sleep(Duration::from_millis(50));
    }
    assert!(ready.exists(), "child did not reach the restart window");
    child.kill().expect("kill child");
    let _ = child.wait();

    let recovery = recover_pending_switch(&root).expect("recover after SIGKILL");
    assert!(recovery.target_committed);
    finish_pending_switch(&root).expect("finish");
    let active = ensure_active_account(&root).expect("target active");
    assert_eq!(active.account_id, target.id);
    assert!(active.database_path.is_file());
    assert_ne!(active.account_id, DEFAULT_ACCOUNT_ID);
    drop(dir);
}

fn temp_root() -> (TempDir, std::path::PathBuf) {
    let dir = tempfile::tempdir().expect("tempdir");
    let root = dir.path().to_path_buf();
    (dir, root)
}
