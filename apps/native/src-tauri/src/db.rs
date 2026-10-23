use std::{
    fs,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::Duration,
};

use tauri::{AppHandle, Manager};
use todo_native_accounts::{
    ActiveAccountContext, ensure_active_account, finish_pending_switch, recover_pending_switch,
    rollback_pending_switch,
};
use todo_native_core::TodoStore;

use crate::reminders::ReminderAdapter;

/// Once a switch is requested the old account's IPC surface must stop accepting
/// writes. The process is restarted shortly afterwards; this flag closes the
/// window between the request and process exit.
pub struct RuntimeGate {
    accepting: AtomicBool,
    in_flight: AtomicUsize,
}

pub struct StorageLease {
    gate: Arc<RuntimeGate>,
}

impl Drop for StorageLease {
    fn drop(&mut self) {
        self.gate.in_flight.fetch_sub(1, Ordering::SeqCst);
    }
}

impl RuntimeGate {
    pub fn active() -> Self {
        Self {
            accepting: AtomicBool::new(true),
            in_flight: AtomicUsize::new(0),
        }
    }

    pub fn accepts_storage(&self) -> bool {
        self.accepting.load(Ordering::SeqCst)
    }

    pub fn enter_storage(self: &Arc<Self>) -> Option<StorageLease> {
        if !self.accepts_storage() {
            return None;
        }
        self.in_flight.fetch_add(1, Ordering::SeqCst);
        if !self.accepts_storage() {
            self.in_flight.fetch_sub(1, Ordering::SeqCst);
            return None;
        }
        Some(StorageLease {
            gate: Arc::clone(self),
        })
    }

    /// Returns false if another switch already closed the gate. In-flight
    /// storage operations get a bounded drain window before restart; a
    /// genuinely hung operation cannot block the user indefinitely.
    pub fn begin_switch(&self) -> bool {
        if self
            .accepting
            .compare_exchange(true, false, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return false;
        }
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while self.in_flight.load(Ordering::SeqCst) > 0 && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        true
    }

    pub fn reset_after_failure(&self) {
        self.accepting.store(true, Ordering::SeqCst);
    }
}

pub struct AppState {
    pub store: Arc<TodoStore>,
    pub reminders: Arc<dyn ReminderAdapter>,
    pub account: ActiveAccountContext,
    pub runtime: Arc<RuntimeGate>,
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
            runtime: Arc::new(RuntimeGate::active()),
        }
    }
}

#[derive(Debug)]
pub struct OpenedStore {
    pub store: TodoStore,
    pub account: ActiveAccountContext,
}

/// Resolve the native active account and open exactly one SQLite connection.
///
/// The WebView never supplies a path. Pending account-switch journals are
/// verified before the target is opened; a failed target rolls back to the
/// previous active account instead of creating an empty database.
pub fn open_app_store(app: &AppHandle) -> Result<OpenedStore, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位应用数据目录: {error}"))?;
    open_store_at(&data_dir)
}

pub fn open_store_at(data_dir: &std::path::Path) -> Result<OpenedStore, String> {
    fs::create_dir_all(data_dir).map_err(|error| format!("无法创建应用数据目录: {error}"))?;
    let recovery =
        recover_pending_switch(data_dir).map_err(|error| format!("无法恢复账号切换: {error}"))?;
    let account = ensure_active_account(data_dir).map_err(|error| error.to_string())?;
    let target_committed = recovery.target_committed;
    let store = match TodoStore::open(&account.database_path) {
        Ok(store) => store,
        Err(error) if target_committed => {
            // The target passed the preflight but cannot be opened by the
            // application (schema/OS-level failure). Restore the source active
            // account and retry it; never create an empty target.
            let _failure = rollback_pending_switch(data_dir, "TARGET_OPEN_FAILED")
                .map_err(|rollback| format!("{error}; 回滚失败: {rollback}"))?;
            let recovered = ensure_active_account(data_dir).map_err(|error| error.to_string())?;
            let store = TodoStore::open(&recovered.database_path)
                .map_err(|error| format!("回滚后无法打开原账号数据库: {error}"))?;
            return Ok(OpenedStore {
                store,
                account: recovered,
            });
        }
        Err(error) => return Err(format!("无法打开本地数据库: {error}")),
    };
    if target_committed {
        finish_pending_switch(data_dir).map_err(|error| format!("无法完成账号切换: {error}"))?;
    }
    Ok(OpenedStore { store, account })
}

#[cfg(test)]
mod tests {
    use super::open_store_at;
    use todo_native_accounts::{
        DEFAULT_ACCOUNT_ID, SwitchPhase, create_pending_cloud_account, ensure_active_account,
        prepare_account_switch, request_account_switch, switch_status,
    };
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

        let opened = open_store_at(directory.path()).expect("open migrated");
        let store = opened.store;
        let account = opened.account;
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
    fn fresh_install_creates_database_before_returning_context() {
        let directory = tempfile::tempdir().expect("tempdir");
        let opened = open_store_at(directory.path()).expect("fresh install");
        let store = opened.store;
        let account = opened.account;
        assert_eq!(account.account_id, DEFAULT_ACCOUNT_ID);
        assert!(account.database_path.is_file());
        assert!(!directory.path().join("installation-state.json").exists());
        assert!(
            store
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
                .expect("tasks")
                .items
                .is_empty()
        );

        let restarted = open_store_at(directory.path())
            .expect("fresh restart")
            .account;
        assert_eq!(restarted.account_id, DEFAULT_ACCOUNT_ID);
    }

    #[test]
    fn startup_commits_verified_switch_and_opens_target() {
        let directory = tempfile::tempdir().expect("tempdir");
        ensure_active_account(directory.path()).expect("default");
        let target =
            create_pending_cloud_account(directory.path(), "b@example.com", "https://b.example")
                .expect("pending");
        let prepared =
            prepare_account_switch(directory.path(), &target.id).expect("prepare switch");
        request_account_switch(
            directory.path(),
            &target.id,
            prepared.generation.expect("generation"),
        )
        .expect("request switch");

        let opened = open_store_at(directory.path()).expect("restart target");
        assert_eq!(opened.account.account_id, target.id);
        assert!(opened.account.database_path.is_file());
        assert!(switch_status(directory.path()).expect("status").active);
    }

    #[test]
    fn startup_rolls_back_bad_target_and_keeps_source_usable() {
        let directory = tempfile::tempdir().expect("tempdir");
        ensure_active_account(directory.path()).expect("default");
        let target =
            create_pending_cloud_account(directory.path(), "b@example.com", "https://b.example")
                .expect("pending");
        let prepared =
            prepare_account_switch(directory.path(), &target.id).expect("prepare switch");
        let target_db = directory
            .path()
            .join("accounts")
            .join(&target.id)
            .join("shishi.sqlite3");
        std::fs::write(&target_db, b"broken").expect("break target");
        request_account_switch(
            directory.path(),
            &target.id,
            prepared.generation.expect("generation"),
        )
        .expect("request switch");

        let opened = open_store_at(directory.path()).expect("fallback source");
        assert_eq!(opened.account.account_id, DEFAULT_ACCOUNT_ID);
        assert!(opened.account.database_path.is_file());
        assert_eq!(
            switch_status(directory.path()).expect("status").phase,
            Some(SwitchPhase::Failed)
        );
    }

    #[test]
    fn runtime_gate_closes_once_and_can_be_reset_only_for_recovery() {
        let gate = super::RuntimeGate::active();
        assert!(gate.accepts_storage());
        assert!(gate.begin_switch());
        assert!(!gate.accepts_storage());
        assert!(!gate.begin_switch());
        gate.reset_after_failure();
        assert!(gate.accepts_storage());
    }

    #[test]
    fn runtime_gate_waits_for_bounded_storage_leases() {
        let gate = std::sync::Arc::new(super::RuntimeGate::active());
        let lease = gate.enter_storage().expect("storage lease");
        let gate_for_thread = std::sync::Arc::clone(&gate);
        let released = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let released_for_thread = std::sync::Arc::clone(&released);
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(40));
            released_for_thread.store(true, std::sync::atomic::Ordering::SeqCst);
            drop(lease);
            let _ = gate_for_thread;
        });
        assert!(gate.begin_switch());
        assert!(!gate.accepts_storage());
        assert!(released.load(std::sync::atomic::Ordering::SeqCst));
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
