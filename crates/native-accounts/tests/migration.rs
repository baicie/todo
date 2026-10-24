use std::{
    fs,
    path::{Path, PathBuf},
};

use rusqlite::{Connection, params};
use tempfile::TempDir;
use todo_native_accounts::{
    AccountError, AccountKind, AccountRecord, AccountRegistry, DEFAULT_ACCOUNT_ID, MigrationPhase,
    account_database_path, create_pending_cloud_account, ensure_account_dir, ensure_active_account,
    finish_pending_switch, migration_state, prepare_account_switch, read_snapshot,
    recover_pending_switch, refresh_token_key, request_account_switch,
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
        context.database_path.is_file(),
        "fresh database must exist before registry commit"
    );
    read_snapshot(&context.database_path).expect("fresh database integrity");
    assert!(context.database_path.parent().unwrap().is_dir());
    let registry = AccountRegistry::load(&root).expect("registry");
    assert_eq!(registry.active_account_id, DEFAULT_ACCOUNT_ID);
    assert!(!root.join("migration-state.json").exists());
    assert!(!root.join("installation-state.json").exists());
}

#[test]
fn registry_without_database_and_without_marker_is_not_fresh() {
    let (_dir, root) = temp_root();
    let registry = AccountRegistry::new_with_default();
    registry.save(&root).expect("registry");
    let error = ensure_active_account(&root).expect_err("must not create empty database");
    assert!(matches!(error, AccountError::ActiveAccountMissing(_)));
    assert!(!root.join("accounts/default/shishi.sqlite3").exists());
}

#[test]
fn recovered_old_registry_without_database_is_not_treated_as_fresh() {
    let (_dir, root) = temp_root();
    let registry = AccountRegistry::new_with_default();
    registry.save(&root).expect("registry");
    fs::copy(
        root.join("accounts.json"),
        root.join("accounts.json.old-no-db"),
    )
    .expect("old registry");
    fs::remove_file(root.join("accounts.json")).expect("remove registry");
    let error = ensure_active_account(&root).expect_err("must not create default");
    assert!(matches!(error, AccountError::ActiveAccountMissing(_)));
    assert!(!root.join("accounts/default/shishi.sqlite3").exists());
}

#[test]
fn installation_state_journal_recovers_marker_before_database_creation() {
    let (_dir, root) = temp_root();
    write_installation_marker(&root, "PREPARED");
    let source = root.join(".installation-state.json.test.tmp");
    fs::copy(root.join("installation-state.json"), &source).expect("state temp");
    let backup = root.join("installation-state.json.old-test");
    fs::copy(root.join("installation-state.json"), &backup).expect("state backup");
    fs::remove_file(root.join("installation-state.json")).expect("remove state");
    fs::write(
        root.join("installation-state.json.replace-journal"),
        format!("{}\n{}\n", source.display(), backup.display()),
    )
    .expect("journal");
    let context = ensure_active_account(&root).expect("recover marker journal");
    assert_eq!(context.account_id, DEFAULT_ACCOUNT_ID);
    assert!(context.database_path.is_file());
    assert!(root.join("accounts.json").is_file());
}

#[test]
fn fresh_marker_does_not_clear_an_existing_default_database() {
    let (_dir, root) = temp_root();
    let account_dir = root.join("accounts/default");
    fs::create_dir_all(&account_dir).expect("account dir");
    {
        let store = TodoStore::open(account_dir.join("shishi.sqlite3")).expect("existing store");
        store
            .create_task(NewTask {
                title: "keep existing".to_owned(),
                ..NewTask::default()
            })
            .expect("task");
    }
    write_installation_marker(&root, "PREPARED");
    let context = ensure_active_account(&root).expect("finish existing fresh install");
    assert!(context.database_path.is_file());
    let connection = Connection::open(&context.database_path).expect("read");
    let title: String = connection
        .query_row("SELECT title FROM local_tasks LIMIT 1", [], |row| {
            row.get(0)
        })
        .expect("existing task");
    assert_eq!(title, "keep existing");
}

#[test]
fn fresh_installation_is_idempotent_across_restarts() {
    let (_dir, root) = temp_root();
    let first = ensure_active_account(&root).expect("first install");
    let second = ensure_active_account(&root).expect("second start");
    assert_eq!(first.account_id, second.account_id);
    assert!(second.database_path.is_file());
    assert!(!first.migrated_from_legacy);
    assert!(!second.migrated_from_legacy);
    assert!(!root.join("installation-state.json").exists());
    let registry = AccountRegistry::load(&root).expect("registry");
    assert_eq!(registry.accounts.len(), 1);
}

#[test]
fn fresh_initialization_retries_after_database_creation_failure() {
    let (_dir, root) = temp_root();
    fs::create_dir_all(root.join("accounts")).expect("accounts");
    fs::write(root.join("accounts/default"), b"blocker").expect("blocker");
    write_installation_marker(&root, "PREPARED");
    let error = ensure_active_account(&root).expect_err("database cannot be created");
    assert!(matches!(
        error,
        AccountError::UnsafePath(_) | AccountError::Io(_)
    ));
    assert!(root.join("installation-state.json").exists());
    assert!(!root.join("accounts.json").exists());
    fs::remove_file(root.join("accounts/default")).expect("unblock");
    let context = ensure_active_account(&root).expect("retry fresh initialization");
    assert_eq!(context.account_id, DEFAULT_ACCOUNT_ID);
    assert!(context.database_path.is_file());
    assert!(!root.join("installation-state.json").exists());
}

#[test]
fn fresh_installation_recovers_from_prepared_marker() {
    let (_dir, root) = temp_root();
    write_installation_marker(&root, "PREPARED");
    let context = ensure_active_account(&root).expect("resume prepared install");
    assert_eq!(context.account_id, DEFAULT_ACCOUNT_ID);
    assert!(context.database_path.is_file());
    assert!(root.join("accounts.json").is_file());
    assert!(!root.join("installation-state.json").exists());
}

#[test]
fn fresh_installation_recovers_after_database_created_before_registry() {
    let (_dir, root) = temp_root();
    let account_dir = root.join("accounts/default");
    fs::create_dir_all(&account_dir).expect("account dir");
    Connection::open(account_dir.join("shishi.sqlite3")).expect("empty database");
    write_installation_marker(&root, "DATABASE_CREATED");
    let context = ensure_active_account(&root).expect("resume database-created install");
    assert_eq!(context.account_id, DEFAULT_ACCOUNT_ID);
    assert!(context.database_path.is_file());
    assert!(root.join("accounts.json").is_file());
    assert!(!root.join("installation-state.json").exists());
}

#[test]
fn fresh_installation_clears_marker_after_registry_commit() {
    let (_dir, root) = temp_root();
    ensure_active_account(&root).expect("fresh install");
    write_installation_marker(&root, "REGISTRY_COMMITTED");
    let context = ensure_active_account(&root).expect("resume registry-committed install");
    assert_eq!(context.account_id, DEFAULT_ACCOUNT_ID);
    assert!(!root.join("installation-state.json").exists());
}

#[test]
fn existing_default_database_without_registry_is_not_fresh() {
    let (_dir, root) = temp_root();
    let account_dir = root.join("accounts/default");
    fs::create_dir_all(&account_dir).expect("account dir");
    Connection::open(account_dir.join("shishi.sqlite3")).expect("existing database");
    let error = ensure_active_account(&root).expect_err("must not reinterpret as fresh");
    assert!(matches!(error, AccountError::InvalidRegistry(_)));
    assert!(!root.join("accounts.json").exists());
}

fn write_installation_marker(root: &Path, phase: &str) {
    let marker = serde_json::json!({
        "version": 1,
        "phase": phase,
        "accountId": DEFAULT_ACCOUNT_ID,
        "createdAt": "2026-01-01T00:00:00Z",
        "updatedAt": "2026-01-01T00:00:00Z",
    });
    fs::write(
        root.join("installation-state.json"),
        serde_json::to_vec(&marker).expect("marker json"),
    )
    .expect("marker");
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

    let restarted = ensure_active_account(&root).expect("bound restart");
    assert_eq!(restarted.account_id, context.account_id);
    assert_eq!(restarted.kind, AccountKind::Cloud);
    assert!(restarted.migrated_from_legacy);
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
    let review = todo_native_accounts::legacy_review_report(&root)
        .expect("report")
        .expect("review");
    assert!(review.requires_manual_identity_verification);
    assert!(review.reason.is_some());
    assert!(review.source_fingerprint.is_some());
    assert!(review.backup_fingerprint.is_some());
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
fn non_complete_migration_states_verify_target_and_rebuild_from_backup() {
    for phase in [
        "BACKUP_CREATED",
        "COPY_VERIFIED",
        "REGISTRY_COMMITTED",
        "FAILED",
    ] {
        let (_dir, root) = temp_root();
        {
            let store = create_legacy(&root);
            store
                .create_task(NewTask {
                    title: "must survive repair".to_owned(),
                    ..NewTask::default()
                })
                .expect("task");
        }
        let context = ensure_active_account(&root).expect("initial migration");
        let target = context.database_path.clone();
        {
            let connection = Connection::open(&target).expect("target write");
            connection
                .execute(
                    "UPDATE local_tasks SET title='corrupt-target' WHERE title='must survive repair'",
                    [],
                )
                .expect("corrupt target");
        }
        set_migration_phase(&root, phase);
        let recovered = ensure_active_account(&root).expect("recover non-complete migration");
        assert_eq!(recovered.account_id, DEFAULT_ACCOUNT_ID, "phase {phase}");
        assert!(recovered.migrated_from_legacy, "phase {phase}");
        let connection = Connection::open(&target).expect("target read");
        let title: String = connection
            .query_row("SELECT title FROM local_tasks LIMIT 1", [], |row| {
                row.get(0)
            })
            .expect("repaired title");
        assert_eq!(title, "must survive repair", "phase {phase}");
        assert_eq!(
            migration_state(&root)
                .expect("state")
                .expect("state exists")
                .phase,
            MigrationPhase::Complete
        );
    }
}

#[test]
fn non_complete_state_with_valid_target_still_reverifies_and_completes() {
    let (_dir, root) = temp_root();
    {
        let store = create_legacy(&root);
        store
            .create_task(NewTask {
                title: "valid target".to_owned(),
                ..NewTask::default()
            })
            .expect("task");
    }
    ensure_active_account(&root).expect("initial migration");
    set_migration_phase(&root, "REGISTRY_COMMITTED");
    let recovered = ensure_active_account(&root).expect("resume valid target");
    assert!(recovered.migrated_from_legacy);
    assert_eq!(
        migration_state(&root)
            .expect("state")
            .expect("state exists")
            .phase,
        MigrationPhase::Complete
    );
}

#[test]
fn complete_migration_with_corrupt_target_fails_closed() {
    let (_dir, root) = temp_root();
    {
        let store = create_legacy(&root);
        store
            .create_task(NewTask {
                title: "complete target".to_owned(),
                ..NewTask::default()
            })
            .expect("task");
    }
    let context = ensure_active_account(&root).expect("initial migration");
    let target = context.database_path.clone();
    fs::write(&target, b"not a sqlite database").expect("corrupt target file");

    let error = ensure_active_account(&root).expect_err("COMPLETE must fail closed");
    assert!(matches!(
        error,
        AccountError::Integrity { .. } | AccountError::Sqlite(_)
    ));
    assert!(root.join("shishi.sqlite3").is_file());
    assert!(context.database_path.is_file());
    let state = migration_state(&root)
        .expect("state")
        .expect("state exists");
    assert_eq!(state.phase, MigrationPhase::Complete);
    assert!(root.join(state.backup_file.expect("backup")).is_file());
}

#[test]
fn completed_migration_allows_switching_to_another_account_and_back() {
    let (_dir, root) = temp_root();
    {
        let store = create_legacy(&root);
        store
            .create_task(NewTask {
                title: "legacy account A".to_owned(),
                ..NewTask::default()
            })
            .expect("task");
    }
    let a = ensure_active_account(&root).expect("migrate A");
    assert_eq!(a.account_id, DEFAULT_ACCOUNT_ID);
    assert!(a.migrated_from_legacy);

    let b = create_pending_cloud_account(&root, "b@example.com", "https://b.example")
        .expect("pending B");
    let prepared = prepare_account_switch(&root, &b.id).expect("prepare B");
    request_account_switch(&root, &b.id, prepared.generation.expect("generation"))
        .expect("request B");
    recover_pending_switch(&root).expect("recover B");
    finish_pending_switch(&root).expect("finish B");
    let active_b = ensure_active_account(&root).expect("B active after COMPLETE migration");
    assert_eq!(active_b.account_id, b.id);
    assert!(!active_b.migrated_from_legacy);

    let back = prepare_account_switch(&root, DEFAULT_ACCOUNT_ID).expect("prepare A");
    request_account_switch(
        &root,
        DEFAULT_ACCOUNT_ID,
        back.generation.expect("generation"),
    )
    .expect("request A");
    recover_pending_switch(&root).expect("recover A");
    finish_pending_switch(&root).expect("finish A");
    let active_a = ensure_active_account(&root).expect("A active");
    assert_eq!(active_a.account_id, DEFAULT_ACCOUNT_ID);
    assert!(active_a.migrated_from_legacy);
}

#[test]
fn missing_active_database_after_switch_is_not_recreated_as_empty() {
    let (_dir, root) = temp_root();
    {
        let store = create_legacy(&root);
        store
            .create_task(NewTask {
                title: "A".to_owned(),
                ..NewTask::default()
            })
            .expect("task");
    }
    ensure_active_account(&root).expect("migrate A");
    let b = create_pending_cloud_account(&root, "b@example.com", "https://b.example")
        .expect("pending B");
    let prepared = prepare_account_switch(&root, &b.id).expect("prepare B");
    request_account_switch(&root, &b.id, prepared.generation.expect("generation"))
        .expect("request B");
    recover_pending_switch(&root).expect("recover B");
    finish_pending_switch(&root).expect("finish B");
    ensure_active_account(&root).expect("B active");
    let b_db = account_database_path(&root, &b.id).expect("B path");
    fs::remove_file(&b_db).expect("remove B");
    let error = ensure_active_account(&root).expect_err("must not recreate empty B");
    assert!(matches!(error, AccountError::ActiveAccountMissing(_)));
    assert!(!b_db.exists());
}

#[test]
fn complete_migration_allows_normal_post_migration_writes() {
    let (_dir, root) = temp_root();
    {
        let store = create_legacy(&root);
        store
            .create_task(NewTask {
                title: "live target".to_owned(),
                ..NewTask::default()
            })
            .expect("task");
    }
    let context = ensure_active_account(&root).expect("initial migration");
    let connection = Connection::open(&context.database_path).expect("live write");
    connection
        .execute(
            "UPDATE local_tasks SET title='written after migration' WHERE title='live target'",
            [],
        )
        .expect("normal app write");
    drop(connection);

    let restarted = ensure_active_account(&root).expect("live target must not be rejected");
    assert_eq!(restarted.account_id, DEFAULT_ACCOUNT_ID);
    assert!(restarted.migrated_from_legacy);
    let connection = Connection::open(&restarted.database_path).expect("target read");
    let title: String = connection
        .query_row("SELECT title FROM local_tasks LIMIT 1", [], |row| {
            row.get(0)
        })
        .expect("title");
    assert_eq!(title, "written after migration");
}

#[test]
fn snapshot_digest_detects_same_count_content_changes() {
    let (_dir, root) = temp_root();
    {
        let store = create_legacy(&root);
        store
            .create_task(NewTask {
                title: "same count".to_owned(),
                ..NewTask::default()
            })
            .expect("task");
    }
    let context = ensure_active_account(&root).expect("migration");
    let source = read_snapshot(&root.join("shishi.sqlite3")).expect("source");
    let target_before = read_snapshot(&context.database_path).expect("target before");
    source
        .assert_same(&target_before, "source/target before tamper")
        .expect("equal snapshots");

    let connection = Connection::open(&context.database_path).expect("target write");
    connection
        .execute(
            "UPDATE local_tasks SET title='same count changed' WHERE title='same count'",
            [],
        )
        .expect("change title");
    drop(connection);
    let target_after = read_snapshot(&context.database_path).expect("target after");
    assert_eq!(
        source.counts, target_after.counts,
        "row count must remain identical"
    );
    assert_ne!(source.fingerprint, target_after.fingerprint);
    assert!(source.assert_same(&target_after, "tampered").is_err());
}

#[test]
fn snapshot_digest_detects_note_reminder_and_step_changes() {
    let (_dir, root) = temp_root();
    {
        let store = create_legacy(&root);
        let task = store
            .create_task(NewTask {
                title: "content fields".to_owned(),
                note: Some("original note".to_owned()),
                ..NewTask::default()
            })
            .expect("task");
        store.create_step(&task.id, "original step").expect("step");
    }
    let context = ensure_active_account(&root).expect("migration");
    let source = read_snapshot(&root.join("shishi.sqlite3")).expect("source");
    let target_before = read_snapshot(&context.database_path).expect("target before");
    source
        .assert_same(&target_before, "source/target before")
        .expect("migration content equal");
    assert_eq!(source.device_id, target_before.device_id);
    assert_eq!(source.sync_cursor, target_before.sync_cursor);
    assert_eq!(source.client_seq, target_before.client_seq);
    assert_eq!(source.outbox_rows, target_before.outbox_rows);
    assert_eq!(source.shadow_rows, target_before.shadow_rows);

    let connection = Connection::open(&context.database_path).expect("target write");
    connection
        .execute(
            "UPDATE local_tasks SET note='changed note', remind_at='2030-01-01T09:00:00Z' WHERE title='content fields'",
            [],
        )
        .expect("change note/reminder");
    connection
        .execute(
            "UPDATE local_steps SET title='changed step' WHERE title='original step'",
            [],
        )
        .expect("change step");
    drop(connection);
    let target_after = read_snapshot(&context.database_path).expect("target after");
    assert_eq!(source.counts, target_after.counts);
    assert_ne!(source.fingerprint, target_after.fingerprint);
    assert_ne!(
        source.table_digests.get("local_tasks"),
        target_after.table_digests.get("local_tasks")
    );
    assert_ne!(
        source.table_digests.get("local_steps"),
        target_after.table_digests.get("local_steps")
    );
}

fn set_migration_phase(root: &Path, phase: &str) {
    let path = root.join("migration-state.json");
    let mut state: serde_json::Value =
        serde_json::from_slice(&fs::read(&path).expect("state read")).expect("state json");
    state["phase"] = serde_json::Value::String(phase.to_owned());
    fs::write(&path, serde_json::to_vec(&state).expect("state json")).expect("state write");
}

#[test]
fn migration_state_journal_recovers_complete_state_and_token_condition() {
    let (_dir, root) = temp_root();
    {
        let store = create_legacy(&root);
        store
            .create_task(NewTask {
                title: "journal migration".to_owned(),
                ..NewTask::default()
            })
            .expect("task");
    }
    ensure_active_account(&root).expect("initial migration");
    let source = root.join(".migration-state.json.test.tmp");
    let backup = root.join("migration-state.json.old-test");
    fs::copy(root.join("migration-state.json"), &source).expect("state temp");
    fs::copy(root.join("migration-state.json"), &backup).expect("state backup");
    fs::remove_file(root.join("migration-state.json")).expect("remove state");
    fs::write(
        root.join("migration-state.json.replace-journal"),
        format!("{}\n{}\n", source.display(), backup.display()),
    )
    .expect("journal");

    let recovered = ensure_active_account(&root).expect("recover state journal");
    assert_eq!(recovered.account_id, DEFAULT_ACCOUNT_ID);
    assert!(
        recovered.migrated_from_legacy,
        "recovered COMPLETE state must keep legacy token migration condition"
    );
    assert_eq!(
        migration_state(&root)
            .expect("state")
            .expect("state exists")
            .phase,
        MigrationPhase::Complete
    );
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
fn registry_fallback_old_file_is_recovered_without_reinitializing() {
    let (_dir, root) = temp_root();
    let context = ensure_active_account(&root).expect("fresh install");
    let target = context.database_path.clone();
    fs::copy(
        root.join("accounts.json"),
        root.join("accounts.json.old-test"),
    )
    .expect("old registry");
    fs::remove_file(root.join("accounts.json")).expect("remove registry");
    let recovered = ensure_active_account(&root).expect("recover old registry");
    assert_eq!(recovered.account_id, DEFAULT_ACCOUNT_ID);
    assert!(target.is_file());
    assert!(root.join("accounts.json").is_file());
}

#[test]
fn corrupt_registry_recovers_from_one_valid_old_copy() {
    let (_dir, root) = temp_root();
    let context = ensure_active_account(&root).expect("fresh install");
    let target = context.database_path.clone();
    fs::copy(
        root.join("accounts.json"),
        root.join("accounts.json.old-test"),
    )
    .expect("old registry");
    fs::write(root.join("accounts.json"), b"{corrupt").expect("corrupt target");
    let recovered = ensure_active_account(&root).expect("recover corrupt registry");
    assert_eq!(recovered.account_id, DEFAULT_ACCOUNT_ID);
    assert!(target.is_file());
    assert!(root.join("accounts.json").is_file());
}

#[test]
fn registry_replacement_journal_recovers_intended_temp_file() {
    let (_dir, root) = temp_root();
    let context = ensure_active_account(&root).expect("fresh install");
    let target = context.database_path.clone();
    let mut registry = AccountRegistry::load(&root).expect("registry");
    registry
        .upsert(AccountRecord::cloud("journal@example.com"))
        .expect("cloud account");
    let source = root.join(format!(".accounts.json.{}.tmp", "journal"));
    fs::write(
        &source,
        serde_json::to_vec(&registry).expect("registry json"),
    )
    .expect("temp registry");
    let backup = root.join("accounts.json.old-journal");
    fs::copy(root.join("accounts.json"), &backup).expect("old registry");
    fs::remove_file(root.join("accounts.json")).expect("remove target");
    let journal = root.join("accounts.json.replace-journal");
    fs::write(
        &journal,
        format!("{}\n{}\n", source.display(), backup.display()),
    )
    .expect("journal");

    let recovered = ensure_active_account(&root).expect("recover journal");
    assert_eq!(recovered.account_id, DEFAULT_ACCOUNT_ID);
    assert!(target.is_file());
    assert!(!journal.exists());
    let registry = AccountRegistry::load(&root).expect("recovered registry");
    assert_eq!(registry.accounts.len(), 2);
}

#[test]
fn conflicting_registry_fallback_artifacts_block_startup() {
    let (_dir, root) = temp_root();
    let context = ensure_active_account(&root).expect("fresh install");
    let target = context.database_path.clone();
    let mut registry = AccountRegistry::load(&root).expect("registry");
    let cloud = AccountRecord::cloud("conflict@example.com");
    registry.upsert(cloud.clone()).expect("cloud account");
    registry.set_active(&cloud.id).expect("active cloud");
    let temp = root.join(format!(".accounts.json.{}.tmp", "conflict"));
    fs::write(&temp, serde_json::to_vec(&registry).expect("temp json")).expect("temp registry");
    fs::copy(
        root.join("accounts.json"),
        root.join("accounts.json.old-test"),
    )
    .expect("old registry");
    fs::remove_file(root.join("accounts.json")).expect("remove registry");

    let error = ensure_active_account(&root).expect_err("conflicting artifacts must block");
    assert!(matches!(error, AccountError::InvalidRegistry(_)));
    assert!(target.is_file());
    assert!(!root.join("accounts.json").exists());
}

#[test]
fn account_database_without_registry_is_never_reinitialized() {
    let (_dir, root) = temp_root();
    let account = root.join("accounts/01a1673d-1000-7000-8000-000000000099");
    fs::create_dir_all(&account).expect("account dir");
    TodoStore::open(account.join("shishi.sqlite3")).expect("existing data");
    let error = ensure_active_account(&root).expect_err("must not create default registry");
    assert!(matches!(error, AccountError::InvalidRegistry(_)));
    assert!(!root.join("accounts.json").exists());
    assert!(!root.join("accounts/default/shishi.sqlite3").exists());
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
