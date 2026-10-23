use std::{
    fs,
    path::{Path, PathBuf},
};

use rusqlite::{Connection, params};
use tempfile::TempDir;
use todo_native_accounts::{
    AccountError, AccountKind, AccountRegistry, DEFAULT_ACCOUNT_ID, MigrationPhase,
    account_database_path, ensure_account_dir, ensure_active_account, migration_state,
    read_snapshot, refresh_token_key,
};
use todo_native_core::{NewTask, TodoStore};

fn temp_root() -> (TempDir, PathBuf) {
    let dir = tempfile::tempdir().expect("tempdir");
    let root = dir.path().to_path_buf();
    (dir, root)
}

fn create_legacy(root: &Path) -> TodoStore {
    TodoStore::open(root.join("shishi.sqlite3")).expect("legacy store")
}

fn raw_connection(root: &Path) -> Connection {
    let connection = Connection::open(root.join("shishi.sqlite3")).expect("raw connection");
    connection
        .busy_timeout(std::time::Duration::from_secs(5))
        .expect("busy timeout");
    connection
}

fn set_kv(connection: &Connection, key: &str, value: &str) {
    connection
        .execute(
            "INSERT INTO kv_state (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )
        .expect("set kv");
}

fn assert_no_empty_default(root: &Path) {
    assert!(
        !root.join("accounts/default/shishi.sqlite3").exists(),
        "must not create an empty default database to hide data"
    );
}

#[test]
fn fresh_install_creates_only_default_account_metadata() {
    let (_dir, root) = temp_root();
    let context = ensure_active_account(&root).expect("fresh install");
    assert_eq!(context.account_id, DEFAULT_ACCOUNT_ID);
    assert_eq!(context.kind, AccountKind::Anonymous);
    assert!(!context.migrated_from_legacy);
    assert!(
        !context.database_path.exists(),
        "TodoStore creates the fresh DB"
    );
    assert!(context.database_path.parent().unwrap().is_dir());
    let registry = AccountRegistry::load(&root).expect("registry");
    assert_eq!(registry.active_account_id, DEFAULT_ACCOUNT_ID);
    assert!(!root.join("migration-state.json").exists());
}

#[test]
fn anonymous_legacy_database_migrates_losslessly() {
    let (_dir, root) = temp_root();
    {
        let store = create_legacy(&root);
        store
            .create_task(NewTask {
                title: "legacy task".to_owned(),
                note: Some("keep me".to_owned()),
                ..NewTask::default()
            })
            .expect("task");
    }
    let connection = raw_connection(&root);
    set_kv(&connection, "sync_cursor", "42");
    connection
        .execute(
            "INSERT INTO server_shadow (entity_type, entity_id, server_rev, payload_json)
             VALUES ('task', 'shadow-task', 7, '{\"title\":\"shadow\"}')",
            [],
        )
        .expect("shadow");
    drop(connection);

    let context = ensure_active_account(&root).expect("anonymous migration");
    assert_eq!(context.account_id, DEFAULT_ACCOUNT_ID);
    assert_eq!(context.kind, AccountKind::Anonymous);
    assert!(context.migrated_from_legacy);
    assert!(context.database_path.is_file());
    assert!(root.join("shishi.sqlite3").is_file(), "source is preserved");
    let registry = AccountRegistry::load(&root).expect("registry");
    assert_eq!(registry.active_account_id, DEFAULT_ACCOUNT_ID);
    assert_eq!(registry.active().kind, AccountKind::Anonymous);

    let state = migration_state(&root)
        .expect("state")
        .expect("state exists");
    assert_eq!(state.phase, MigrationPhase::Complete);
    assert!(
        root.join(state.backup_file.as_deref().expect("backup"))
            .is_file()
    );
    let source = read_snapshot(&root.join("shishi.sqlite3")).expect("source snapshot");
    let target = read_snapshot(&context.database_path).expect("target snapshot");
    source
        .assert_same(&target, "anonymous migration")
        .expect("same data");
    assert_eq!(target.counts.get("local_tasks"), Some(&1));
    assert!(target.device_id.is_some());
    assert_eq!(target.outbox_rows.len(), 1);
    assert_eq!(target.shadow_rows.len(), 1);
    assert_eq!(target.sync_cursor.as_deref(), Some("42"));
    assert_eq!(source.device_id, target.device_id);

    let backups_before = fs::read_dir(root.join("migration-backups"))
        .expect("backups")
        .count();
    let restarted = ensure_active_account(&root).expect("idempotent restart");
    assert_eq!(restarted.account_id, DEFAULT_ACCOUNT_ID);
    assert!(
        restarted.migrated_from_legacy,
        "the account still originates from the once-migrated legacy database"
    );
    let backups_after = fs::read_dir(root.join("migration-backups"))
        .expect("backups")
        .count();
    assert_eq!(
        backups_before, backups_after,
        "restart must not migrate again"
    );
    assert_eq!(
        refresh_token_key(DEFAULT_ACCOUNT_ID).expect("default key"),
        "cloud-refresh:default"
    );
    let other = uuid::Uuid::now_v7().to_string();
    assert_ne!(
        refresh_token_key(&other).expect("other key"),
        refresh_token_key(DEFAULT_ACCOUNT_ID).expect("default key")
    );
}

#[test]
fn bound_legacy_database_migrates_to_opaque_account_without_email_path() {
    let (_dir, root) = temp_root();
    {
        let store = create_legacy(&root);
        store
            .create_task(NewTask {
                title: "bound task".to_owned(),
                ..NewTask::default()
            })
            .expect("task");
        store.sync_set_enabled(true).expect("outbox");
        let device = store.get_device_id().expect("device");
        drop(store);
        let connection = raw_connection(&root);
        set_kv(&connection, "bound_account", "User@Example.com");
        set_kv(&connection, "sync_enabled", "true");
        set_kv(&connection, "device_id", &device);
    }

    let context = ensure_active_account(&root).expect("bound migration");
    assert_eq!(context.kind, AccountKind::Cloud);
    assert_eq!(context.email.as_deref(), Some("user@example.com"));
    assert_ne!(context.account_id, "user@example.com");
    assert!(!context.database_path.to_string_lossy().contains('@'));
    assert!(
        context.database_path.starts_with(
            root.canonicalize()
                .expect("canonical root")
                .join("accounts")
        )
    );
    let registry = AccountRegistry::load(&root).expect("registry");
    assert_eq!(registry.active_account_id, context.account_id);
    assert_eq!(registry.active().email.as_deref(), Some("user@example.com"));
    assert_eq!(
        refresh_token_key(&context.account_id).expect("token key"),
        format!("cloud-refresh:{}", context.account_id)
    );
    assert_eq!(
        context
            .database_path
            .parent()
            .unwrap()
            .file_name()
            .unwrap()
            .to_string_lossy(),
        context.account_id
    );
}

#[test]
fn ambiguous_ownership_preserves_source_and_blocks_empty_initialization() {
    let (_dir, root) = temp_root();
    {
        let store = create_legacy(&root);
        store
            .create_task(NewTask {
                title: "ambiguous".to_owned(),
                ..NewTask::default()
            })
            .expect("task");
        store.sync_set_enabled(true).expect("outbox");
        drop(store);
        let connection = raw_connection(&root);
        // sync_enabled without a bound account is not safe to attribute.
        set_kv(&connection, "sync_enabled", "true");
    }

    let error = ensure_active_account(&root).expect_err("must require review");
    match error {
        AccountError::NeedsReview { reason, .. } => assert!(reason.contains("bound_account")),
        other => panic!("unexpected error: {other}"),
    }
    assert!(root.join("shishi.sqlite3").is_file());
    assert!(!root.join("accounts.json").exists());
    assert_no_empty_default(&root);
    let state = migration_state(&root)
        .expect("state")
        .expect("state exists");
    assert_eq!(state.phase, MigrationPhase::RequiresReview);
    assert!(root.join(state.backup_file.expect("backup")).is_file());

    let second = ensure_active_account(&root).expect_err("still blocked");
    assert!(matches!(second, AccountError::NeedsReview { .. }));
}

#[test]
fn migration_resumes_after_interruption_and_does_not_repeat_cloud_ops() {
    let (_dir, root) = temp_root();
    {
        let store = create_legacy(&root);
        store
            .create_task(NewTask {
                title: "resume".to_owned(),
                ..NewTask::default()
            })
            .expect("task");
    }
    let first = ensure_active_account(&root).expect("first migration");
    let backup = migration_state(&root)
        .expect("state")
        .and_then(|state| state.backup_file)
        .expect("backup");
    assert!(root.join(&backup).is_file());
    let source_before = read_snapshot(&root.join("shishi.sqlite3")).expect("source");

    // Simulate a crash after BACKUP_CREATED and before registry/target commit.
    fs::remove_file(account_database_path(&root, &first.account_id).expect("target path"))
        .expect("remove target");
    fs::remove_file(root.join("accounts.json")).expect("remove registry");
    let mut state: serde_json::Value =
        serde_json::from_slice(&fs::read(root.join("migration-state.json")).expect("state read"))
            .expect("state json");
    state["phase"] = serde_json::Value::String("BACKUP_CREATED".to_owned());
    state["targetFingerprint"] = serde_json::Value::Null;
    state["verified"] = serde_json::Value::Null;
    fs::write(
        root.join("migration-state.json"),
        serde_json::to_vec_pretty(&state).expect("state encode"),
    )
    .expect("state write");

    let resumed = ensure_active_account(&root).expect("resume migration");
    assert_eq!(resumed.account_id, first.account_id);
    assert!(resumed.database_path.is_file());
    let source_after = read_snapshot(&root.join("shishi.sqlite3")).expect("source after");
    source_before
        .assert_same(&source_after, "source not mutated")
        .expect("source same");
    let target = read_snapshot(&resumed.database_path).expect("target");
    source_before
        .assert_same(&target, "resumed data")
        .expect("target same");
    assert_eq!(target.outbox_rows.len(), 1, "no new cloud op");
}

#[test]
fn uncheckpointed_wal_data_is_included_by_backup_migration() {
    let (_dir, root) = temp_root();
    {
        let store = create_legacy(&root);
        store
            .create_task(NewTask {
                title: "wal base".to_owned(),
                ..NewTask::default()
            })
            .expect("task");
    }
    let raw = raw_connection(&root);
    raw.pragma_update(None, "journal_mode", "WAL").expect("wal");
    raw.pragma_update(None, "wal_autocheckpoint", 0)
        .expect("autocheckpoint");
    raw.execute(
        "INSERT INTO kv_state (key, value) VALUES ('wal_probe', 'yes')",
        [],
    )
    .expect("wal write");
    assert!(
        root.join("shishi.sqlite3-wal").exists(),
        "test needs a live WAL"
    );

    let context = ensure_active_account(&root).expect("WAL migration");
    let target = Connection::open(&context.database_path).expect("target");
    let probe: String = target
        .query_row(
            "SELECT value FROM kv_state WHERE key='wal_probe'",
            [],
            |row| row.get(0),
        )
        .expect("probe");
    assert_eq!(probe, "yes");
    drop(raw);
}

#[test]
fn migration_failure_preserves_source_and_does_not_commit_registry() {
    let (_dir, root) = temp_root();
    {
        let store = create_legacy(&root);
        store
            .create_task(NewTask {
                title: "disk failure".to_owned(),
                ..NewTask::default()
            })
            .expect("task");
    }
    // Force the backup directory creation to fail without deleting source.
    fs::write(root.join("migration-backups"), b"not a directory").expect("blocker");
    let error = ensure_active_account(&root).expect_err("backup cannot be created");
    assert!(matches!(
        error,
        AccountError::Io(_) | AccountError::MigrationFailed(_, _)
    ));
    assert!(root.join("shishi.sqlite3").is_file());
    assert!(!root.join("accounts.json").exists());
    assert_no_empty_default(&root);
}

#[test]
fn failure_after_backup_keeps_backup_and_marks_state_failed() {
    let (_dir, root) = temp_root();
    {
        let store = create_legacy(&root);
        store
            .create_task(NewTask {
                title: "backup then fail".to_owned(),
                ..NewTask::default()
            })
            .expect("task");
    }
    fs::create_dir_all(root.join("accounts")).expect("accounts");
    // A file where the anonymous account directory should be makes target
    // creation fail after the backup has been created.
    fs::write(root.join("accounts/default"), b"blocker").expect("blocker");
    let error = ensure_active_account(&root).expect_err("target cannot be created");
    assert!(matches!(error, AccountError::MigrationFailed(_, _)));
    assert!(root.join("shishi.sqlite3").is_file());
    assert!(!root.join("accounts/default/shishi.sqlite3").exists());
    let state = migration_state(&root)
        .expect("state")
        .expect("state exists");
    assert_eq!(state.phase, MigrationPhase::Failed);
    assert!(root.join(state.backup_file.expect("backup")).is_file());

    fs::remove_file(root.join("accounts/default")).expect("unblock");
    let recovered = ensure_active_account(&root).expect("retry from backup");
    assert_eq!(recovered.account_id, DEFAULT_ACCOUNT_ID);
    assert!(recovered.database_path.is_file());
    assert!(root.join("shishi.sqlite3").is_file());
}

#[test]
fn corrupt_registry_and_missing_active_do_not_initialize_empty_data() {
    let (_dir, root) = temp_root();
    fs::create_dir_all(root.join("accounts")).expect("accounts dir");
    fs::write(root.join("accounts.json"), b"{not json").expect("corrupt registry");
    let error = ensure_active_account(&root).expect_err("corrupt registry");
    assert!(matches!(
        error,
        AccountError::Json(_) | AccountError::InvalidRegistry(_)
    ));
    assert_no_empty_default(&root);
    assert!(
        !root.join("accounts.json").exists()
            || fs::read(root.join("accounts.json")).expect("read") == b"{not json"
    );

    let (_dir2, root2) = temp_root();
    let missing = uuid::Uuid::now_v7().to_string();
    fs::create_dir_all(root2.join("accounts")).expect("dirs2");
    fs::write(
        root2.join("accounts.json"),
        serde_json::to_vec_pretty(&serde_json::json!({
            "version": 1,
            "activeAccountId": missing,
            "accounts": [{
                "id": "default",
                "kind": "anonymous",
                "createdAt": "2026-01-01T00:00:00Z",
                "schemaVersion": 1,
                "lastOpenedAt": "2026-01-01T00:00:00Z"
            }]
        }))
        .expect("json"),
    )
    .expect("write");
    let error = ensure_active_account(&root2).expect_err("missing active");
    assert!(matches!(error, AccountError::InvalidRegistry(_)));
    assert_no_empty_default(&root2);
}

#[test]
fn account_ids_map_to_distinct_paths_and_reject_escape() {
    let (_dir, root) = temp_root();
    let a = uuid::Uuid::now_v7().to_string();
    let b = uuid::Uuid::now_v7().to_string();
    assert_ne!(
        account_database_path(&root, &a).expect("a"),
        account_database_path(&root, &b).expect("b")
    );
    assert!(account_database_path(&root, "../escape").is_err());
    assert!(ensure_account_dir(&root, "../escape").is_err());
    assert!(refresh_token_key("../escape").is_err());
}

#[test]
fn legacy_source_symlink_is_rejected() {
    #[cfg(unix)]
    use std::os::unix::fs::symlink;
    #[cfg(windows)]
    use std::os::windows::fs::symlink_file as symlink;

    let (_dir, root) = temp_root();
    let outside = root.join("outside.sqlite3");
    {
        let store = TodoStore::open(&outside).expect("outside db");
        store
            .create_task(NewTask {
                title: "outside".to_owned(),
                ..NewTask::default()
            })
            .expect("task");
    }
    if symlink(&outside, root.join("shishi.sqlite3")).is_err() {
        return;
    }
    let error = ensure_active_account(&root).expect_err("symlink source must fail");
    assert!(matches!(error, AccountError::UnsafePath(_)));
    assert!(!root.join("accounts.json").exists());
}

#[test]
fn account_directory_symlink_is_rejected() {
    #[cfg(unix)]
    use std::os::unix::fs::symlink;
    #[cfg(windows)]
    use std::os::windows::fs::symlink_dir as symlink;

    let (_dir, root) = temp_root();
    let outside = root.join("outside");
    fs::create_dir_all(&outside).expect("outside");
    let accounts = root.join("accounts");
    fs::create_dir_all(&accounts).expect("accounts");
    let id = uuid::Uuid::now_v7().to_string();
    let link = accounts.join(&id);
    if symlink(&outside, &link).is_err() {
        // Windows without developer mode cannot create symlinks; skip.
        return;
    }
    let error = ensure_account_dir(&root, &id).expect_err("symlink must fail");
    assert!(matches!(error, AccountError::UnsafePath(_)));
}
