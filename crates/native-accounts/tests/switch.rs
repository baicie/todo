use std::fs;

use tempfile::TempDir;
use todo_native_accounts::{
    AccountRegistry, DEFAULT_ACCOUNT_ID, PendingAccountSwitch, SwitchPhase,
    create_pending_cloud_account, ensure_active_account, finish_pending_switch, list_accounts,
    mark_account_verified, prepare_account_switch, read_snapshot, recover_pending_switch,
    request_account_switch, switch_status,
};
use todo_native_core::{CloudInitializeRequest, CloudMergeMode, CloudSnapshot, NewTask, TodoStore};

fn temp_root() -> (TempDir, std::path::PathBuf) {
    let dir = tempfile::tempdir().expect("tempdir");
    let root = dir.path().to_path_buf();
    (dir, root)
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
    let first = ensure_active_account(&root).expect("default account");
    add_task(&first.database_path, "account A");
    let second = create_pending_cloud_account(&root, "b@example.com", "https://b.example")
        .expect("pending account");
    add_task(
        &root
            .join("accounts")
            .join(&second.id)
            .join("shishi.sqlite3"),
        "account B",
    );
    (dir, root, second.id)
}

#[test]
fn switch_commits_only_after_restart_verification_and_keeps_both_databases() {
    let (_dir, root, target_id) = create_two_accounts();
    let prepared = prepare_account_switch(&root, &target_id).expect("prepare");
    assert_eq!(prepared.phase, Some(SwitchPhase::Prepared));
    assert_eq!(
        list_accounts(&root).expect("list").active_account_id,
        DEFAULT_ACCOUNT_ID
    );

    let requested =
        request_account_switch(&root, &target_id, prepared.generation.expect("generation"))
            .expect("request");
    assert_eq!(requested.phase, Some(SwitchPhase::RestartRequired));
    assert_eq!(
        list_accounts(&root).expect("list").active_account_id,
        DEFAULT_ACCOUNT_ID,
        "registry must not switch before restart verification"
    );

    let recovery = recover_pending_switch(&root).expect("startup recovery");
    assert!(recovery.target_committed);
    finish_pending_switch(&root).expect("finish switch");
    let active = ensure_active_account(&root).expect("target active");
    assert_eq!(active.account_id, target_id);
    let connection = rusqlite::Connection::open(&active.database_path).expect("target db");
    let title: String = connection
        .query_row("SELECT title FROM local_tasks LIMIT 1", [], |row| {
            row.get(0)
        })
        .expect("target task");
    assert_eq!(title, "account B");
    let source = rusqlite::Connection::open(root.join("accounts/default/shishi.sqlite3"))
        .expect("source db");
    let source_title: String = source
        .query_row("SELECT title FROM local_tasks LIMIT 1", [], |row| {
            row.get(0)
        })
        .expect("source task");
    assert_eq!(source_title, "account A");
}

#[test]
fn prepared_journal_is_discarded_when_restart_never_happened() {
    let (_dir, root, target_id) = create_two_accounts();
    prepare_account_switch(&root, &target_id).expect("prepare");
    let recovery = recover_pending_switch(&root).expect("startup");
    assert!(!recovery.target_committed);
    assert_eq!(
        list_accounts(&root).expect("list").active_account_id,
        DEFAULT_ACCOUNT_ID
    );
    assert!(switch_status(&root).expect("status").active);
}

#[test]
fn corrupt_target_rolls_back_to_source_without_creating_empty_target() {
    let (_dir, root, target_id) = create_two_accounts();
    let prepared = prepare_account_switch(&root, &target_id).expect("prepare");
    let target = root
        .join("accounts")
        .join(&target_id)
        .join("shishi.sqlite3");
    fs::write(&target, b"not a sqlite database").expect("corrupt target");
    request_account_switch(&root, &target_id, prepared.generation.expect("generation"))
        .expect("request");
    let recovery = recover_pending_switch(&root).expect("recovery");
    assert!(!recovery.target_committed);
    assert!(recovery.failure.is_some());
    let active = ensure_active_account(&root).expect("source restored");
    assert_eq!(active.account_id, DEFAULT_ACCOUNT_ID);
    assert!(active.database_path.is_file());
    assert_eq!(
        switch_status(&root).expect("status").phase,
        Some(SwitchPhase::Failed)
    );
}

#[test]
fn duplicate_request_is_idempotent() {
    let (_dir, root, target_id) = create_two_accounts();
    let prepared = prepare_account_switch(&root, &target_id).expect("prepare");
    let generation = prepared.generation.expect("generation");
    request_account_switch(&root, &target_id, generation).expect("first request");
    request_account_switch(&root, &target_id, generation).expect("duplicate request");
    assert_eq!(
        switch_status(&root).expect("status").phase,
        Some(SwitchPhase::RestartRequired)
    );
}

#[test]
fn same_email_on_different_api_servers_is_not_reused() {
    let (_dir, root) = temp_root();
    ensure_active_account(&root).expect("default");
    let first = create_pending_cloud_account(&root, "same@example.com", "https://one.example")
        .expect("first server");
    let second = create_pending_cloud_account(&root, "same@example.com", "https://two.example")
        .expect("second server");
    assert_ne!(
        first.id, second.id,
        "server identity must be part of account identity"
    );
    let repeat = create_pending_cloud_account(&root, "same@example.com", "https://one.example/")
        .expect("idempotent add");
    assert_eq!(first.id, repeat.id);
}

#[test]
fn account_databases_keep_independent_device_and_outbox_state() {
    let (_dir, root, target_id) = create_two_accounts();
    let first_registry = todo_native_accounts::AccountRegistry::load(&root).expect("registry");
    let a_db = first_registry
        .account(DEFAULT_ACCOUNT_ID)
        .expect("A")
        .id
        .clone();
    let a_path = root.join("accounts").join(&a_db).join("shishi.sqlite3");
    let b_path = root
        .join("accounts")
        .join(&target_id)
        .join("shishi.sqlite3");
    let a = read_snapshot(&a_path).expect("A snapshot");
    let b = read_snapshot(&b_path).expect("B snapshot");
    assert_ne!(a.device_id, b.device_id);
    assert_ne!(a.outbox_rows, b.outbox_rows);
    assert!(!a.outbox_rows.is_empty());
    assert!(!b.outbox_rows.is_empty());
}

fn initialize_empty_cloud(db: &std::path::Path, email: &str, api_url: &str) {
    let store = TodoStore::open(db).expect("target store");
    store
        .sync_initialize_cloud(CloudInitializeRequest {
            snapshot: CloudSnapshot {
                cursor: "0".to_owned(),
                lists: Vec::new(),
                tasks: Vec::new(),
                steps: Vec::new(),
                day_plans: Vec::new(),
            },
            mode: CloudMergeMode::Cloud,
            account_email: email.to_owned(),
            account_api_url: Some(api_url.to_owned()),
            session_id: None,
        })
        .expect("bind server identity");
}

#[test]
fn restart_recovery_is_idempotent_at_verifying_target_phase() {
    let (_dir, root, target_id) = create_two_accounts();
    let prepared = prepare_account_switch(&root, &target_id).expect("prepare");
    request_account_switch(&root, &target_id, prepared.generation.expect("generation"))
        .expect("request");
    let first = recover_pending_switch(&root).expect("first recovery");
    assert!(first.target_committed);
    let second = recover_pending_switch(&root).expect("second recovery");
    assert!(second.target_committed);
    finish_pending_switch(&root).expect("finish");
    assert_eq!(
        ensure_active_account(&root).expect("active").account_id,
        target_id
    );
}

#[test]
fn failed_journal_repairs_a_target_pointer_left_by_an_interrupted_rollback() {
    let (_dir, root, target_id) = create_two_accounts();
    let prepared = prepare_account_switch(&root, &target_id).expect("prepare");
    request_account_switch(&root, &target_id, prepared.generation.expect("generation"))
        .expect("request");
    recover_pending_switch(&root).expect("commit target");

    // Simulate a process death after FAILED was persisted but before the
    // registry restoration in rollback_pending_switch.
    let journal = PendingAccountSwitch {
        version: 1,
        phase: SwitchPhase::Failed,
        from_account_id: DEFAULT_ACCOUNT_ID.to_owned(),
        to_account_id: target_id.clone(),
        generation: 1,
        created_at: "2026-10-24T00:00:00Z".to_owned(),
        updated_at: "2026-10-24T00:00:00Z".to_owned(),
        error_code: Some("TARGET_INVALID".to_owned()),
    };
    fs::write(
        root.join("pending-account-switch.json"),
        serde_json::to_vec(&journal).expect("journal json"),
    )
    .expect("journal");
    let recovery = recover_pending_switch(&root).expect("repair");
    assert!(!recovery.target_committed);
    assert!(recovery.failure.is_some());
    assert_eq!(
        ensure_active_account(&root).expect("active").account_id,
        DEFAULT_ACCOUNT_ID
    );
}

#[test]
fn corrupt_switch_journal_fails_closed() {
    let (_dir, root, _) = create_two_accounts();
    fs::write(root.join("pending-account-switch.json"), b"{not valid json")
        .expect("corrupt journal");
    let error = recover_pending_switch(&root).expect_err("must block");
    assert!(matches!(
        error,
        todo_native_accounts::AccountError::InvalidRegistry(_)
    ));
}

#[test]
fn switching_back_to_a_restores_a_database_and_keeps_b_data() {
    let (_dir, root, target_id) = create_two_accounts();
    let prepared = prepare_account_switch(&root, &target_id).expect("prepare B");
    request_account_switch(&root, &target_id, prepared.generation.expect("generation"))
        .expect("request B");
    recover_pending_switch(&root).expect("recover B");
    finish_pending_switch(&root).expect("finish B");
    assert_eq!(
        ensure_active_account(&root).expect("B").account_id,
        target_id
    );

    let back = prepare_account_switch(&root, DEFAULT_ACCOUNT_ID).expect("prepare A");
    request_account_switch(
        &root,
        DEFAULT_ACCOUNT_ID,
        back.generation.expect("generation"),
    )
    .expect("request A");
    recover_pending_switch(&root).expect("recover A");
    finish_pending_switch(&root).expect("finish A");
    let active = ensure_active_account(&root).expect("A active");
    assert_eq!(active.account_id, DEFAULT_ACCOUNT_ID);
    let source = rusqlite::Connection::open(&active.database_path).expect("A db");
    let title: String = source
        .query_row("SELECT title FROM local_tasks LIMIT 1", [], |row| {
            row.get(0)
        })
        .expect("A task");
    assert_eq!(title, "account A");
    let b_db = root
        .join("accounts")
        .join(&target_id)
        .join("shishi.sqlite3");
    let b = rusqlite::Connection::open(b_db).expect("B db");
    let b_title: String = b
        .query_row("SELECT title FROM local_tasks LIMIT 1", [], |row| {
            row.get(0)
        })
        .expect("B task");
    assert_eq!(b_title, "account B");
}

#[test]
fn switching_back_to_a_cloud_bound_default_database_is_allowed() {
    let (_dir, root) = temp_root();
    let default = ensure_active_account(&root).expect("default");
    initialize_empty_cloud(&default.database_path, "a@example.com", "https://a.example");
    let target = create_pending_cloud_account(&root, "b@example.com", "https://b.example")
        .expect("pending B");
    let prepared = prepare_account_switch(&root, &target.id).expect("prepare B");
    request_account_switch(&root, &target.id, prepared.generation.expect("generation"))
        .expect("request B");
    recover_pending_switch(&root).expect("recover B");
    finish_pending_switch(&root).expect("finish B");
    ensure_active_account(&root).expect("B active");

    let back = prepare_account_switch(&root, DEFAULT_ACCOUNT_ID).expect("prepare default");
    request_account_switch(
        &root,
        DEFAULT_ACCOUNT_ID,
        back.generation.expect("generation"),
    )
    .expect("request default");
    recover_pending_switch(&root).expect("recover default");
    finish_pending_switch(&root).expect("finish default");
    let active = ensure_active_account(&root).expect("default active");
    assert_eq!(active.account_id, DEFAULT_ACCOUNT_ID);
    let snapshot = read_snapshot(&active.database_path).expect("snapshot");
    assert_eq!(snapshot.bound_account.as_deref(), Some("a@example.com"));
}

#[test]
fn cloud_server_identity_is_required_before_account_is_marked_verified() {
    let (_dir, root) = temp_root();
    ensure_active_account(&root).expect("default");
    let target =
        create_pending_cloud_account(&root, "verify@example.com", "https://verify.example")
            .expect("pending");
    let target_db = root
        .join("accounts")
        .join(&target.id)
        .join("shishi.sqlite3");
    initialize_empty_cloud(&target_db, "verify@example.com", "https://verify.example");
    let prepared = prepare_account_switch(&root, &target.id).expect("prepare");
    request_account_switch(&root, &target.id, prepared.generation.expect("generation"))
        .expect("request");
    recover_pending_switch(&root).expect("recover");
    finish_pending_switch(&root).expect("finish");
    ensure_active_account(&root).expect("active");
    let account = mark_account_verified(&root).expect("mark verified");
    assert!(!account.pending);
    let registry = AccountRegistry::load(&root).expect("registry");
    assert!(!registry.active().pending);
}

#[test]
fn target_bound_to_wrong_api_server_is_rejected_before_switch() {
    let (_dir, root) = temp_root();
    ensure_active_account(&root).expect("default");
    let target = create_pending_cloud_account(&root, "wrong@example.com", "https://right.example")
        .expect("pending");
    let target_db = root
        .join("accounts")
        .join(&target.id)
        .join("shishi.sqlite3");
    initialize_empty_cloud(&target_db, "wrong@example.com", "https://wrong.example");
    let error = prepare_account_switch(&root, &target.id).expect_err("must reject");
    assert!(matches!(
        error,
        todo_native_accounts::AccountError::VerificationMismatch(_)
    ));
}
