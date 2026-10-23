use std::{fs, sync::Arc};

use tauri::{AppHandle, Manager};
use todo_native_accounts::{ActiveAccountContext, ensure_active_account};
use todo_native_core::TodoStore;

use crate::reminders::ReminderAdapter;

pub struct AppState {
    pub store: Arc<TodoStore>,
    pub reminders: Arc<dyn ReminderAdapter>,
    pub account: ActiveAccountContext,
}

impl AppState {
    pub fn new(
        store: TodoStore,
        reminders: Arc<dyn ReminderAdapter>,
        account: ActiveAccountContext,
    ) -> Self {
        Self {
            store: Arc::new(store),
            reminders,
            account,
        }
    }
}

/// Resolve the native active account and open exactly one SQLite connection.
///
/// The WebView never supplies a path. The account registry is loaded or a
/// one-time legacy migration is completed before the store is opened. If the
/// legacy ownership is ambiguous, startup fails without creating an empty
/// database, so the source remains recoverable.
pub fn open_app_store(app: &AppHandle) -> Result<(TodoStore, ActiveAccountContext), String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位应用数据目录: {error}"))?;
    open_store_at(&data_dir)
}

pub fn open_store_at(
    data_dir: &std::path::Path,
) -> Result<(TodoStore, ActiveAccountContext), String> {
    fs::create_dir_all(data_dir).map_err(|error| format!("无法创建应用数据目录: {error}"))?;
    let account = ensure_active_account(data_dir).map_err(|error| error.to_string())?;
    let store = TodoStore::open(&account.database_path)
        .map_err(|error| format!("无法打开本地数据库: {error}"))?;
    Ok((store, account))
}

#[cfg(test)]
mod tests {
    use super::open_store_at;
    use todo_native_accounts::DEFAULT_ACCOUNT_ID;
    use todo_native_core::{NewTask, TaskQuery, TaskView, TodoStore};

    #[test]
    fn opens_migrated_anonymous_database_through_account_registry() {
        let directory = tempfile::tempdir().expect("tempdir");
        let legacy_path = directory.path().join("shishi.sqlite3");
        {
            let store = TodoStore::open(&legacy_path).expect("legacy store");
            store
                .create_task(NewTask {
                    title: "legacy native".to_owned(),
                    ..NewTask::default()
                })
                .expect("task");
        }

        let (store, account) = open_store_at(directory.path()).expect("open migrated");
        assert_eq!(account.account_id, DEFAULT_ACCOUNT_ID);
        assert!(account.database_path.is_file());
        assert!(legacy_path.is_file());
        let tasks = store
            .list_tasks(TaskQuery {
                view: TaskView::All,
                list_id: None,
                search: None,
                tags: Vec::new(),
                local_date: None,
                due_from: None,
                due_to: None,
                include_completed: false,
                limit: None,
            })
            .expect("tasks");
        assert_eq!(tasks.items.len(), 1);
        assert_eq!(tasks.items[0].title, "legacy native");
    }

    #[test]
    fn corrupt_registry_blocks_startup_without_empty_database() {
        let directory = tempfile::tempdir().expect("tempdir");
        std::fs::write(directory.path().join("accounts.json"), b"{bad").expect("registry");
        let error = open_store_at(directory.path()).expect_err("must fail");
        assert!(error.contains("registry") || error.contains("json"));
        assert!(
            !directory
                .path()
                .join("accounts/default/shishi.sqlite3")
                .exists()
        );
    }
}
