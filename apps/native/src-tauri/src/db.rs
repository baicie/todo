use std::{
    fs,
    sync::{
        Arc, Condvar, Mutex, MutexGuard,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
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
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SwitchRuntimePhase {
    Active,
    Draining,
    Preparing,
    Prepared,
    DrainFailed,
    RequestInProgress,
    RestartRequired,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GateError {
    SwitchInProgress,
    DrainTimeout,
    NotPrepared,
    NotAbortable,
    Poisoned,
}

struct RuntimeControl {
    phase: SwitchRuntimePhase,
}

pub struct RuntimeGate {
    accepting: AtomicBool,
    in_flight: AtomicUsize,
    control: Mutex<RuntimeControl>,
    drained: Condvar,
}

pub struct StorageLease {
    gate: Arc<RuntimeGate>,
}

impl Drop for StorageLease {
    fn drop(&mut self) {
        self.gate.in_flight.fetch_sub(1, Ordering::SeqCst);
        self.gate.drained.notify_all();
    }
}

/// Held across request-side reminder cancellation and journal advancement.
/// Unless explicitly committed, a failed request fails the gate closed: the
/// process must cold-restart to rebuild Cloud state and reminders.
pub struct SwitchRequestGuard<'a> {
    control: MutexGuard<'a, RuntimeControl>,
    completed: bool,
}

impl SwitchRequestGuard<'_> {
    pub fn mark_restart_required(&mut self) {
        self.control.phase = SwitchRuntimePhase::RestartRequired;
        self.completed = true;
    }

    pub fn mark_failed(&mut self) {
        self.control.phase = SwitchRuntimePhase::Failed;
        self.completed = true;
    }
}

impl Drop for SwitchRequestGuard<'_> {
    fn drop(&mut self) {
        if !self.completed && self.control.phase == SwitchRuntimePhase::RequestInProgress {
            // Once quiesce + request has begun, an in-place abort could leave a
            // disposed Cloud Controller with an open gate. Fail closed and let
            // the frontend cold-restart the process instead.
            self.control.phase = SwitchRuntimePhase::Failed;
        }
    }
}

/// Held while the journal is inspected/removed. Gate is reopened only through
/// `activate_after_abort`; dropping after an error keeps it closed.
pub struct SwitchAbortGuard<'a> {
    gate: &'a RuntimeGate,
    control: MutexGuard<'a, RuntimeControl>,
}

impl SwitchAbortGuard<'_> {
    pub fn activate_after_abort(mut self) {
        self.control.phase = SwitchRuntimePhase::Active;
        self.gate.accepting.store(true, Ordering::SeqCst);
    }

    pub fn fail_closed(mut self) {
        self.control.phase = SwitchRuntimePhase::Failed;
    }
}

impl RuntimeGate {
    pub fn active() -> Self {
        Self {
            accepting: AtomicBool::new(true),
            in_flight: AtomicUsize::new(0),
            control: Mutex::new(RuntimeControl {
                phase: SwitchRuntimePhase::Active,
            }),
            drained: Condvar::new(),
        }
    }

    pub fn accepts_storage(&self) -> bool {
        self.accepting.load(Ordering::SeqCst)
    }

    #[cfg(test)]
    pub fn phase(&self) -> SwitchRuntimePhase {
        self.control
            .lock()
            .map(|control| control.phase)
            .unwrap_or(SwitchRuntimePhase::Failed)
    }

    pub fn enter_storage(self: &Arc<Self>) -> Option<StorageLease> {
        if !self.accepts_storage() {
            return None;
        }
        self.in_flight.fetch_add(1, Ordering::SeqCst);
        if !self.accepts_storage() {
            self.in_flight.fetch_sub(1, Ordering::SeqCst);
            self.drained.notify_all();
            return None;
        }
        Some(StorageLease {
            gate: Arc::clone(self),
        })
    }

    /// Close the gate and wait for all entered local writes to leave. A timeout
    /// is a hard failure: it never advances the journal and never permits a
    /// restart. The caller must abort the prepared journal and call
    /// `activate_after_abort`, or cold-restart the application.
    pub fn begin_switch(&self) -> Result<(), GateError> {
        let mut control = self.control.lock().map_err(|_| GateError::Poisoned)?;
        if control.phase != SwitchRuntimePhase::Active {
            return Err(GateError::SwitchInProgress);
        }
        self.accepting.store(false, Ordering::SeqCst);
        control.phase = SwitchRuntimePhase::Draining;
        let deadline = Instant::now() + Duration::from_secs(2);
        while self.in_flight.load(Ordering::SeqCst) > 0 {
            let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                control.phase = SwitchRuntimePhase::DrainFailed;
                return Err(GateError::DrainTimeout);
            };
            let (next, wait) = self
                .drained
                .wait_timeout(control, remaining)
                .map_err(|_| GateError::Poisoned)?;
            control = next;
            if wait.timed_out() && self.in_flight.load(Ordering::SeqCst) > 0 {
                control.phase = SwitchRuntimePhase::DrainFailed;
                return Err(GateError::DrainTimeout);
            }
        }
        control.phase = SwitchRuntimePhase::Preparing;
        Ok(())
    }

    pub fn prepare_committed(&self) {
        if let Ok(mut control) = self.control.lock()
            && control.phase == SwitchRuntimePhase::Preparing
        {
            control.phase = SwitchRuntimePhase::Prepared;
        }
    }

    pub fn prepare_failed(&self) {
        if let Ok(mut control) = self.control.lock()
            && control.phase == SwitchRuntimePhase::Preparing
        {
            control.phase = SwitchRuntimePhase::DrainFailed;
        }
    }

    /// A request is only legal after the drain succeeded. The lock is held over
    /// notification cancellation and journal write, so abort cannot interleave.
    pub fn begin_request(&self) -> Result<SwitchRequestGuard<'_>, GateError> {
        let mut control = self.control.lock().map_err(|_| GateError::Poisoned)?;
        if control.phase != SwitchRuntimePhase::Prepared {
            return Err(match control.phase {
                SwitchRuntimePhase::Draining
                | SwitchRuntimePhase::Preparing
                | SwitchRuntimePhase::RequestInProgress => GateError::SwitchInProgress,
                _ => GateError::NotPrepared,
            });
        }
        control.phase = SwitchRuntimePhase::RequestInProgress;
        Ok(SwitchRequestGuard {
            control,
            completed: false,
        })
    }

    /// Only an active or still-prepared gate is abortable. In particular a
    /// RestartRequired/Failed journal can never be reopened in-place.
    pub fn begin_abort(&self) -> Result<SwitchAbortGuard<'_>, GateError> {
        let control = self.control.lock().map_err(|_| GateError::Poisoned)?;
        match control.phase {
            SwitchRuntimePhase::Active
            | SwitchRuntimePhase::Prepared
            | SwitchRuntimePhase::DrainFailed => {}
            switch_phase => {
                return Err(match switch_phase {
                    SwitchRuntimePhase::Draining
                    | SwitchRuntimePhase::Preparing
                    | SwitchRuntimePhase::RequestInProgress => GateError::SwitchInProgress,
                    _ => GateError::NotAbortable,
                });
            }
        };
        Ok(SwitchAbortGuard {
            gate: self,
            control,
        })
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
    fn startup_after_unrequested_switch_restores_source_with_outbox() {
        let directory = tempfile::tempdir().expect("tempdir");
        let default = ensure_active_account(directory.path()).expect("default");
        let source = TodoStore::open(&default.database_path).expect("source store");
        source.sync_set_enabled(true).expect("outbox");
        source
            .create_task(NewTask {
                title: "unsynced source".to_owned(),
                ..NewTask::default()
            })
            .expect("source task");
        drop(source);
        let before = todo_native_accounts::read_snapshot(&default.database_path).expect("before");
        let target =
            create_pending_cloud_account(directory.path(), "b@example.com", "https://b.example")
                .expect("pending");
        prepare_account_switch(directory.path(), &target.id).expect("prepared journal only");

        // This models the process restart after a request/journal failure that
        // quiesced Cloud but never reached RESTART_REQUIRED.
        let opened = open_store_at(directory.path()).expect("restart source");
        assert_eq!(opened.account.account_id, DEFAULT_ACCOUNT_ID);
        let after = todo_native_accounts::read_snapshot(&default.database_path).expect("after");
        assert_eq!(after, before, "source DB/outbox must be unchanged");
        assert_eq!(
            after.counts.get("outbox").copied(),
            Some(1),
            "unsynced outbox must survive recovery"
        );
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
    fn runtime_gate_closes_once_and_aborts_only_from_prepared() {
        let gate = super::RuntimeGate::active();
        assert!(gate.accepts_storage());
        assert!(gate.begin_switch().is_ok());
        assert!(!gate.accepts_storage());
        assert_eq!(gate.phase(), super::SwitchRuntimePhase::Preparing);
        assert!(gate.begin_switch().is_err());
        gate.prepare_committed();
        assert_eq!(gate.phase(), super::SwitchRuntimePhase::Prepared);
        let abort = gate.begin_abort().expect("abortable prepared gate");
        abort.activate_after_abort();
        assert!(gate.accepts_storage());
        assert_eq!(gate.phase(), super::SwitchRuntimePhase::Active);
    }

    #[test]
    fn runtime_gate_waits_for_bounded_storage_leases() {
        let gate = std::sync::Arc::new(super::RuntimeGate::active());
        let lease = gate.enter_storage().expect("storage lease");
        let released = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let released_for_thread = std::sync::Arc::clone(&released);
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(40));
            released_for_thread.store(true, std::sync::atomic::Ordering::SeqCst);
            drop(lease);
        });
        assert!(gate.begin_switch().is_ok());
        assert!(!gate.accepts_storage());
        assert!(released.load(std::sync::atomic::Ordering::SeqCst));
    }

    #[test]
    fn runtime_gate_drain_timeout_fails_closed_and_never_advances() {
        let gate = std::sync::Arc::new(super::RuntimeGate::active());
        let lease = gate.enter_storage().expect("blocking storage lease");
        let started = std::time::Instant::now();
        let error = gate.begin_switch().expect_err("drain must fail");
        assert_eq!(error, super::GateError::DrainTimeout);
        assert!(started.elapsed() >= std::time::Duration::from_millis(1_900));
        assert_eq!(gate.phase(), super::SwitchRuntimePhase::DrainFailed);
        assert!(!gate.accepts_storage());
        assert!(
            gate.enter_storage().is_none(),
            "new writes must be rejected immediately"
        );
        assert!(
            gate.begin_request().is_err(),
            "timeout must not become requestable"
        );
        // The old write is still valid inside the source account. Let it finish
        // and only then abort the prepared switch explicitly.
        drop(lease);
        let abort = gate.begin_abort().expect("drain failure is recoverable");
        abort.activate_after_abort();
        assert!(gate.accepts_storage());
        assert_eq!(gate.phase(), super::SwitchRuntimePhase::Active);
    }

    #[test]
    fn runtime_gate_timeout_keeps_source_transaction_and_outbox_consistent() {
        let directory = tempfile::tempdir().expect("tempdir");
        let db = directory.path().join("source.sqlite3");
        let store = std::sync::Arc::new(TodoStore::open(&db).expect("source store"));
        store.sync_set_enabled(true).expect("outbox");
        let gate = std::sync::Arc::new(super::RuntimeGate::active());
        let lease = gate.enter_storage().expect("lease");
        let store_for_writer = std::sync::Arc::clone(&store);

        let writer = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(2_100));
            store_for_writer
                .create_task(NewTask {
                    title: "slow source write".to_owned(),
                    ..NewTask::default()
                })
                .expect("source write");
            drop(lease);
        });

        let error = gate.begin_switch().expect_err("drain must time out");
        assert_eq!(error, super::GateError::DrainTimeout);
        writer.join().expect("writer");
        assert_eq!(
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
                .len(),
            1
        );
        let snapshot = todo_native_accounts::read_snapshot(&db).expect("snapshot");
        assert_eq!(snapshot.counts.get("outbox").copied(), Some(1));
        assert!(!gate.accepts_storage());
        assert!(
            gate.begin_request().is_err(),
            "no switch may proceed after timeout"
        );
        let abort = gate.begin_abort().expect("explicit abort only");
        abort.activate_after_abort();
        assert!(gate.accepts_storage());
    }

    #[test]
    fn request_failure_fails_closed_and_requires_cold_recovery() {
        let gate = super::RuntimeGate::active();
        gate.begin_switch().expect("drain");
        gate.prepare_committed();
        {
            let _request = gate.begin_request().expect("request guard");
            // Simulate reminder cancellation or journal write failure before
            // RESTART_REQUIRED. The request has already begun after quiesce, so
            // there is no safe in-place abort/rebind path.
        }
        assert_eq!(gate.phase(), super::SwitchRuntimePhase::Failed);
        assert!(!gate.accepts_storage());
        assert!(
            gate.begin_abort().is_err(),
            "failed request must not reopen the gate"
        );
    }

    #[test]
    fn request_and_abort_serialize_with_one_legal_winner() {
        let gate = std::sync::Arc::new(super::RuntimeGate::active());
        gate.begin_switch().expect("drain");
        gate.prepare_committed();
        let (request_ready_tx, request_ready_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let gate_for_request = std::sync::Arc::clone(&gate);
        let request_thread = std::thread::spawn(move || {
            let mut request = gate_for_request.begin_request().expect("request guard");
            request_ready_tx.send(()).expect("ready");
            release_rx.recv().expect("release");
            request.mark_restart_required();
        });
        request_ready_rx.recv().expect("request started");

        let gate_for_abort = std::sync::Arc::clone(&gate);
        let (abort_tx, abort_rx) = std::sync::mpsc::channel();
        let abort_thread = std::thread::spawn(move || {
            let result = gate_for_abort.begin_abort().map(|_| ());
            abort_tx.send(result).expect("abort result");
        });
        release_tx.send(()).expect("release request");
        request_thread.join().expect("request thread");
        let abort_error = abort_rx
            .recv()
            .expect("abort result")
            .expect_err("abort must lose");
        assert_eq!(abort_error, super::GateError::NotAbortable);
        abort_thread.join().expect("abort thread");
        assert_eq!(gate.phase(), super::SwitchRuntimePhase::RestartRequired);
        assert!(
            !gate.accepts_storage(),
            "abort must not reopen after request"
        );
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
