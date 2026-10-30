use tempfile::TempDir;
use todo_native_accounts::read_snapshot;
use todo_native_core::{ImportMode, ImportRequest, NewList, NewTask, TaskList, TodoStore};

fn create_list(store: &TodoStore, name: &str) -> TaskList {
    store
        .create_list(NewList {
            name: name.to_owned(),
            ..NewList::default()
        })
        .expect("list")
}

#[test]
fn rejected_duplicate_import_does_not_change_full_account_snapshot() {
    let dir = TempDir::new().expect("tempdir");
    let path = dir.path().join("account.sqlite3");
    let store = TodoStore::open(&path).expect("open store");
    store.sync_set_enabled(true).expect("sync enabled");
    let list = create_list(&store, "locked list");
    store
        .create_task(NewTask {
            title: "locked task".to_owned(),
            list_id: Some(list.id.clone()),
            ..NewTask::default()
        })
        .expect("task");

    let mut bundle = store.export_data().expect("export");
    let duplicate = bundle.lists[0].clone();
    bundle.lists.push(duplicate);
    let before = read_snapshot(&path).expect("snapshot before");
    let error = store
        .import_data(ImportRequest {
            bundle,
            mode: ImportMode::Replace,
        })
        .expect_err("duplicate ID must be rejected");
    assert!(
        error.to_string().contains("重复"),
        "unexpected error: {error}"
    );
    let after = read_snapshot(&path).expect("snapshot after");

    assert_eq!(
        before, after,
        "rejected import must not change rows, shadow, kv, outbox, cursor, device or schema"
    );
}
