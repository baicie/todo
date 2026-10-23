use std::{path::PathBuf, sync::Arc};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager, State, WebviewWindow};
use todo_native_accounts::{
    AccountList, AccountSummary, SwitchStatus, create_pending_cloud_account, list_accounts,
    mark_account_verified, prepare_account_switch, request_account_switch, rollback_pending_switch,
    switch_status,
};
use todo_native_core::StoreError;

use crate::{
    db::AppState,
    lifecycle::{self, DesktopSettings, LifecycleState},
    reminders::ReminderAdapter,
    secure_tokens, security,
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageRequest {
    pub action: String,
    #[serde(default)]
    pub payload: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandError {
    pub code: String,
    pub message: String,
}

impl CommandError {
    fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_owned(),
            message: message.into(),
        }
    }

    fn from_store(error: StoreError) -> Self {
        Self {
            code: error.code().as_str().to_owned(),
            message: error.to_string(),
        }
    }

    fn reminder(message: impl Into<String>) -> Self {
        Self::new("REMINDER_ERROR", message)
    }

    fn account_switch(message: impl Into<String>) -> Self {
        Self::new("ACCOUNT_SWITCH", message)
    }
}

fn data_dir(app: &AppHandle) -> Result<PathBuf, CommandError> {
    app.path()
        .app_data_dir()
        .map_err(|error| CommandError::account_switch(format!("无法定位应用数据目录: {error}")))
}

fn ensure_runtime_active(state: &State<'_, AppState>) -> Result<(), CommandError> {
    if state.runtime.accepts_storage() {
        Ok(())
    } else {
        Err(CommandError::new(
            "ACCOUNT_SWITCH_IN_PROGRESS",
            "账号切换进行中，当前账号已停止接受写入",
        ))
    }
}

fn reminder_scope(account_id: &str, reminder_id: &str) -> String {
    format!("account:{account_id}:{reminder_id}")
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeAccountContextDto {
    pub account_id: String,
    pub kind: String,
    pub email: Option<String>,
    pub api_url: Option<String>,
    pub migrated_from_legacy: bool,
}

#[tauri::command]
pub fn native_account_context(state: State<'_, AppState>) -> NativeAccountContextDto {
    NativeAccountContextDto {
        account_id: state.account.account_id.clone(),
        kind: state.account.kind.as_str().to_owned(),
        email: state.account.email.clone(),
        api_url: state.account.api_url.clone(),
        migrated_from_legacy: state.account.migrated_from_legacy,
    }
}

#[tauri::command]
pub fn native_list_accounts(app: AppHandle) -> Result<AccountList, CommandError> {
    list_accounts(&data_dir(&app)?).map_err(|error| CommandError::account_switch(error.to_string()))
}

#[tauri::command]
pub fn native_create_account(
    app: AppHandle,
    state: State<'_, AppState>,
    email: String,
    api_url: String,
) -> Result<AccountSummary, CommandError> {
    ensure_runtime_active(&state)?;
    let _lease = state.runtime.enter_storage().ok_or_else(|| {
        CommandError::new("ACCOUNT_SWITCH_IN_PROGRESS", "账号切换进行中")
    })?;
    create_pending_cloud_account(&data_dir(&app)?, &email, &api_url)
        .map_err(|error| CommandError::account_switch(error.to_string()))
}

#[tauri::command]
pub fn native_prepare_account_switch(
    app: AppHandle,
    state: State<'_, AppState>,
    target_account_id: String,
) -> Result<SwitchStatus, CommandError> {
    ensure_runtime_active(&state)?;
    let status = prepare_account_switch(&data_dir(&app)?, &target_account_id)
        .map_err(|error| CommandError::account_switch(error.to_string()))?;
    if !state.runtime.begin_switch() {
        // Do not delete the journal here: a concurrent switch may have created
        // or already closed the same prepared journal. Leaving it intact keeps
        // the first switch recoverable; the caller can abort explicitly.
        return Err(CommandError::new(
            "ACCOUNT_SWITCH_IN_PROGRESS",
            "账号切换已经开始",
        ));
    }
    Ok(status)
}

#[tauri::command]
pub fn native_request_account_switch(
    app: AppHandle,
    state: State<'_, AppState>,
    target_account_id: String,
    generation: u64,
) -> Result<SwitchStatus, CommandError> {
    // `native_prepare_account_switch` closed the gate already. A direct request
    // (e.g. retry after a UI crash) may still need to close it here.
    if state.runtime.accepts_storage() && !state.runtime.begin_switch() {
        return Err(CommandError::new(
            "ACCOUNT_SWITCH_IN_PROGRESS",
            "账号切换已经开始",
        ));
    }
    // Cancel the old account's system notifications before the process exits.
    // A failure leaves the prepared journal in place and aborts the restart.
    if let Err(error) = cancel_current_account_reminders(&state) {
        state.runtime.reset_after_failure();
        return Err(error);
    }
    let status = match request_account_switch(
        &data_dir(&app)?,
        &target_account_id,
        generation,
    ) {
        Ok(status) => status,
        Err(error) => {
            state.runtime.reset_after_failure();
            return Err(CommandError::account_switch(error.to_string()));
        }
    };
    if let Err(error) = restart_after_switch(&app) {
        state.runtime.reset_after_failure();
        let _ = rollback_pending_switch(&data_dir(&app)?, "RESTART_UNAVAILABLE");
        return Err(error);
    }
    Ok(status)
}

#[tauri::command]
pub fn native_abort_account_switch(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    let result = todo_native_accounts::abort_prepared_switch(&data_dir(&app)?)
        .map_err(|error| CommandError::account_switch(error.to_string()));
    state.runtime.reset_after_failure();
    result
}

#[tauri::command]
pub fn native_account_switch_status(app: AppHandle) -> Result<SwitchStatus, CommandError> {
    switch_status(&data_dir(&app)?)
        .map_err(|error| CommandError::account_switch(error.to_string()))
}

#[tauri::command]
pub fn native_mark_account_verified(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<AccountSummary, CommandError> {
    if !state.runtime.accepts_storage() {
        return Err(CommandError::new(
            "ACCOUNT_SWITCH_IN_PROGRESS",
            "账号切换进行中",
        ));
    }
    let _lease = state.runtime.enter_storage().ok_or_else(|| {
        CommandError::new("ACCOUNT_SWITCH_IN_PROGRESS", "账号切换进行中")
    })?;
    mark_account_verified(&data_dir(&app)?)
        .map_err(|error| CommandError::account_switch(error.to_string()))
}

#[cfg(desktop)]
fn restart_after_switch(app: &AppHandle) -> Result<(), CommandError> {
    let handle = app.clone();
    std::thread::Builder::new()
        .name("shishi-account-switch-restart".to_owned())
        .spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(350));
            let env = handle.env();
            tauri::process::restart(&env);
        })
        .map(|_| ())
        .map_err(|error| CommandError::account_switch(format!("无法启动应用重启: {error}")))
}

#[cfg(mobile)]
fn restart_after_switch(_app: &AppHandle) -> Result<(), CommandError> {
    Err(CommandError::new(
        "RESTART_UNSUPPORTED",
        "当前移动端运行时无法冷重启应用，账号切换已回滚",
    ))
}

#[cfg(desktop)]
fn cancel_current_account_reminders(state: &State<'_, AppState>) -> Result<(), CommandError> {
    let prefix = format!("account:{}:", state.account.account_id);
    let entries = state
        .reminders
        .scheduled()
        .map_err(CommandError::reminder)?;
    let mut failures = Vec::new();
    for entry in entries {
        if entry.reminder_id.starts_with(&prefix) || !entry.reminder_id.starts_with("account:") {
            if let Err(error) = state.reminders.cancel(&entry.reminder_id) {
                failures.push(format!("{}: {error}", entry.reminder_id));
            }
        }
    }
    if !failures.is_empty() {
        return Err(CommandError::reminder(format!(
            "无法取消旧账号系统通知: {}",
            failures.join("; ")
        )));
    }
    let remaining = state
        .reminders
        .scheduled()
        .map_err(CommandError::reminder)?;
    let leftover = remaining
        .into_iter()
        .filter(|entry| {
            entry.reminder_id.starts_with(&prefix)
                || !entry.reminder_id.starts_with("account:")
        })
        .count();
    if leftover > 0 {
        return Err(CommandError::reminder(
            "旧账号系统通知仍有残留，已中止切换".to_owned(),
        ));
    }
    Ok(())
}

#[cfg(mobile)]
fn cancel_current_account_reminders(state: &State<'_, AppState>) -> Result<(), CommandError> {
    let prefix = format!("account:{}:", state.account.account_id);
    let entries = state
        .reminders
        .scheduled()
        .map_err(CommandError::reminder)?;
    for entry in entries {
        if entry.reminder_id.starts_with(&prefix) || !entry.reminder_id.starts_with("account:") {
            state
                .reminders
                .cancel(&entry.reminder_id)
                .map_err(CommandError::reminder)?;
        }
    }
    let remaining = state
        .reminders
        .scheduled()
        .map_err(CommandError::reminder)?;
    if remaining
        .iter()
        .any(|entry| entry.reminder_id.starts_with(&prefix) || !entry.reminder_id.starts_with("account:"))
    {
        return Err(CommandError::reminder(
            "旧账号系统通知仍有残留，已中止切换".to_owned(),
        ));
    }
    Ok(())
}

/// The single storage IPC entry point. It runs on Tauri's blocking pool so a
/// slow SQLite query never parks the async runtime or the WebView thread.
#[tauri::command]
pub async fn todo_storage(
    state: State<'_, AppState>,
    request: StorageRequest,
) -> Result<Value, CommandError> {
    security::validate_storage_action(&request.action)
        .map_err(|message| CommandError::new("UNSUPPORTED", message))?;
    // A sync fence clear is the one write that must remain possible while the
    // switch gate is closed; quiescing the old cloud session needs it.
    let _lease = if request.action == "sync_clear_session" {
        None
    } else {
        Some(
            state
                .runtime
                .enter_storage()
                .ok_or_else(|| {
                    CommandError::new(
                        "ACCOUNT_SWITCH_IN_PROGRESS",
                        "账号切换进行中，当前账号已停止接受写入",
                    )
                })?,
        )
    };
    let store = Arc::clone(&state.store);
    tauri::async_runtime::spawn_blocking(move || {
        todo_native_core::dispatch(&store, &request.action, request.payload)
    })
    .await
    .map_err(|error| CommandError::new("INTERNAL", format!("数据库任务异常: {error}")))?
    .map_err(CommandError::from_store)
}

#[tauri::command]
pub async fn schedule_reminder(
    state: State<'_, AppState>,
    reminder_id: String,
    fire_at_utc: String,
    title: String,
    body: Option<String>,
    exact: Option<bool>,
) -> Result<String, CommandError> {
    ensure_runtime_active(&state)?;
    let _lease = state.runtime.enter_storage().ok_or_else(|| {
        CommandError::new(
            "ACCOUNT_SWITCH_IN_PROGRESS",
            "账号切换进行中，当前账号已停止调度通知",
        )
    })?;
    ensure_reminder_permission(&state)?;
    state
        .reminders
        .schedule(
            &reminder_scope(&state.account.account_id, &reminder_id),
            &fire_at_utc,
            &title,
            body.as_deref().unwrap_or(""),
            exact.unwrap_or(false),
        )
        .map_err(CommandError::reminder)
}

#[tauri::command]
pub fn cancel_reminder(
    state: State<'_, AppState>,
    reminder_id: String,
) -> Result<(), CommandError> {
    ensure_runtime_active(&state)?;
    let _lease = state.runtime.enter_storage().ok_or_else(|| {
        CommandError::new(
            "ACCOUNT_SWITCH_IN_PROGRESS",
            "账号切换进行中，当前账号已停止调度通知",
        )
    })?;
    state
        .reminders
        .cancel(&reminder_scope(&state.account.account_id, &reminder_id))
        .map_err(CommandError::reminder)
}

/// Reconcile the platform queue against open SQLite tasks. The queue is the
/// source of truth for already-armed notifications; only changed or stale
/// entries are touched.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReminderReconcileReport {
    pub scheduled: u32,
    pub cancelled: u32,
    pub unchanged: u32,
    pub skipped_past: u32,
    pub outside_window: u32,
    pub capacity_exceeded: u32,
    pub permission_denied: u32,
    pub failed: Vec<String>,
}

fn same_instant(left: &str, right: &str) -> bool {
    match (
        chrono::DateTime::parse_from_rfc3339(left),
        chrono::DateTime::parse_from_rfc3339(right),
    ) {
        (Ok(left), Ok(right)) => left == right,
        _ => left == right,
    }
}

const DEFAULT_REMINDER_BODY: &str = "该完成这项任务了";

/// iOS may report its display fallback from older pending requests. Treat the
/// fallback as the empty raw body so legacy entries are not rebuilt forever.
fn body_matches(current_body: &str, raw_body: &str) -> bool {
    if raw_body.is_empty() {
        current_body.is_empty() || current_body == DEFAULT_REMINDER_BODY
    } else {
        current_body == raw_body
    }
}

/// Reconcile the system queue without any Tauri state. Keeping this pure makes
/// the repeated-reconcile/idempotency contract directly testable.
fn reconcile_reminder_queue(
    reminders: &dyn ReminderAdapter,
    tasks: &[todo_native_core::Task],
    account_id: &str,
) -> Result<ReminderReconcileReport, String> {
    let active: std::collections::HashSet<&str> =
        tasks.iter().map(|task| task.id.as_str()).collect();
    let prefix = format!("account:{account_id}:");
    let existing = reminders.scheduled()?;
    let mut report = ReminderReconcileReport::default();
    let mut existing_by_id: std::collections::HashMap<
        String,
        crate::reminders::ScheduledReminderInfo,
    > = std::collections::HashMap::new();

    for item in existing {
        if let Some(task_id) = item.reminder_id.strip_prefix(&prefix) {
            if active.contains(task_id) {
                existing_by_id.insert(task_id.to_owned(), item);
            } else {
                match reminders.cancel(&item.reminder_id) {
                    Ok(()) => report.cancelled += 1,
                    Err(error) => report
                        .failed
                        .push(format!("{}: cancel failed: {error}", item.reminder_id)),
                }
            }
        } else {
            // Notifications created by another account, or legacy untagged
            // entries from before account scoping, must never be interpreted as
            // the current account's tasks.
            match reminders.cancel(&item.reminder_id) {
                Ok(()) => report.cancelled += 1,
                Err(error) => report
                    .failed
                    .push(format!("{}: cancel failed: {error}", item.reminder_id)),
            }
        }
    }

    if reminders.permission() != "granted" {
        report.permission_denied =
            tasks.iter().filter(|task| task.remind_at.is_some()).count() as u32;
        return Ok(report);
    }

    for task in tasks {
        if let Some(fire_at) = &task.remind_at {
            // The raw note is the fingerprint body. Empty notes must stay
            // empty here even when a platform shows a localized fallback.
            let body = if task.note.trim().is_empty() {
                ""
            } else {
                task.note.as_str()
            };
            if let Some(current) = existing_by_id.get(&task.id)
                && same_instant(&current.fire_at_utc, fire_at)
                && current.title == task.title
                && body_matches(&current.body, body)
            {
                report.unchanged += 1;
                continue;
            }
            let scoped = format!("{prefix}{}", task.id);
            match reminders.schedule(&scoped, fire_at, &task.title, body, false) {
                Ok(mode) if mode == "scheduled" || mode == "exact" || mode == "inexact" => {
                    report.scheduled += 1;
                }
                Ok(mode) if mode == "past" || mode == "skipped-past" => {
                    let _ = reminders.cancel(&scoped);
                    report.skipped_past += 1;
                }
                Ok(mode) if mode == "outside-window" => {
                    let _ = reminders.cancel(&scoped);
                    report.outside_window += 1;
                }
                Ok(mode) if mode == "capacity-exceeded" => {
                    let _ = reminders.cancel(&scoped);
                    report.capacity_exceeded += 1;
                }
                Ok(mode) => report
                    .failed
                    .push(format!("{}: unknown mode {mode}", task.id)),
                Err(error) => {
                    let _ = reminders.cancel(&scoped);
                    report.failed.push(format!("{}: {error}", task.id));
                }
            }
        }
    }
    Ok(report)
}

#[tauri::command]
pub async fn reschedule_reminders(
    state: State<'_, AppState>,
) -> Result<ReminderReconcileReport, CommandError> {
    ensure_runtime_active(&state)?;
    let _lease = state.runtime.enter_storage().ok_or_else(|| {
        CommandError::new(
            "ACCOUNT_SWITCH_IN_PROGRESS",
            "账号切换进行中，当前账号已停止调度通知",
        )
    })?;
    let account_id = state.account.account_id.clone();
    let store = Arc::clone(&state.store);
    let reminders: Arc<dyn ReminderAdapter> = Arc::clone(&state.reminders);
    let tasks = tauri::async_runtime::spawn_blocking(move || store.upcoming_reminders())
        .await
        .map_err(|error| CommandError::new("INTERNAL", format!("提醒查询异常: {error}")))?
        .map_err(CommandError::from_store)?;
    reconcile_reminder_queue(reminders.as_ref(), &tasks, &account_id)
        .map_err(CommandError::reminder)
}

#[tauri::command]
pub fn reminder_permission(state: State<'_, AppState>) -> String {
    state.reminders.permission()
}

/// Explicitly prompts for notification permission. The existing
/// `schedule_reminder` command uses the same check before arming a reminder.
#[tauri::command]
pub fn request_reminder_permission(state: State<'_, AppState>) -> Result<String, CommandError> {
    state
        .reminders
        .request_permission()
        .map_err(CommandError::reminder)
}

#[tauri::command]
pub fn set_badge_count(window: WebviewWindow, count: i64) -> Result<(), CommandError> {
    let count = if count > 0 { Some(count) } else { None };
    window
        .set_badge_count(count)
        .map_err(|error| CommandError::new("BADGE_UNSUPPORTED", error.to_string()))
}

#[tauri::command]
pub async fn secure_token_get(
    app: AppHandle,
    state: State<'_, AppState>,
    key: String,
) -> Result<Option<String>, CommandError> {
    ensure_runtime_active(&state)?;
    let _lease = state.runtime.enter_storage().ok_or_else(|| {
        CommandError::new(
            "ACCOUNT_SWITCH_IN_PROGRESS",
            "账号切换进行中，当前账号已停止访问凭据",
        )
    })?;
    authorize_secure_key(&state, &key)?;
    tauri::async_runtime::spawn_blocking(move || secure_tokens::get(&app, &key))
        .await
        .map_err(|error| CommandError::new("SECURE_STORAGE", error.to_string()))?
        .map_err(|message| CommandError::new("SECURE_STORAGE", message))
}

#[tauri::command]
pub async fn secure_token_set(
    app: AppHandle,
    state: State<'_, AppState>,
    key: String,
    value: String,
) -> Result<(), CommandError> {
    ensure_runtime_active(&state)?;
    let _lease = state.runtime.enter_storage().ok_or_else(|| {
        CommandError::new(
            "ACCOUNT_SWITCH_IN_PROGRESS",
            "账号切换进行中，当前账号已停止访问凭据",
        )
    })?;
    authorize_secure_key(&state, &key)?;
    tauri::async_runtime::spawn_blocking(move || secure_tokens::set(&app, &key, &value))
        .await
        .map_err(|error| CommandError::new("SECURE_STORAGE", error.to_string()))?
        .map_err(|message| CommandError::new("SECURE_STORAGE", message))
}

#[tauri::command]
pub async fn secure_token_remove(
    app: AppHandle,
    state: State<'_, AppState>,
    key: String,
) -> Result<(), CommandError> {
    ensure_runtime_active(&state)?;
    let _lease = state.runtime.enter_storage().ok_or_else(|| {
        CommandError::new(
            "ACCOUNT_SWITCH_IN_PROGRESS",
            "账号切换进行中，当前账号已停止访问凭据",
        )
    })?;
    authorize_secure_key(&state, &key)?;
    tauri::async_runtime::spawn_blocking(move || secure_tokens::remove(&app, &key))
        .await
        .map_err(|error| CommandError::new("SECURE_STORAGE", error.to_string()))?
        .map_err(|message| CommandError::new("SECURE_STORAGE", message))
}

fn authorize_secure_key(state: &State<'_, AppState>, key: &str) -> Result<(), CommandError> {
    if is_refresh_key_for(&state.account.account_id, key) {
        return Ok(());
    }
    Err(CommandError::new(
        "CROSS_ACCOUNT_TOKEN",
        "不能访问其他账号的 Refresh Token",
    ))
}

fn is_refresh_key_for(account_id: &str, key: &str) -> bool {
    todo_native_accounts::refresh_token_key(account_id)
        .map(|expected| expected == key)
        .unwrap_or(false)
}

#[tauri::command]
pub fn get_desktop_settings(
    app: AppHandle,
    state: State<'_, LifecycleState>,
) -> Result<DesktopSettings, CommandError> {
    lifecycle::settings(&app, &state)
        .map_err(|message| CommandError::new("SETTINGS_ERROR", message))
}

#[tauri::command]
pub fn set_close_to_tray(
    state: State<'_, LifecycleState>,
    enabled: bool,
) -> Result<(), CommandError> {
    state
        .set_close_to_tray(enabled)
        .map_err(|message| CommandError::new("SETTINGS_ERROR", message))
}

#[tauri::command]
pub fn set_autostart(app: AppHandle, enabled: bool) -> Result<(), CommandError> {
    lifecycle::set_autostart(&app, enabled)
        .map_err(|message| CommandError::new("SETTINGS_ERROR", message))
}

fn ensure_reminder_permission(state: &State<'_, AppState>) -> Result<(), CommandError> {
    if state.reminders.permission() == "granted" {
        return Ok(());
    }
    let permission = state
        .reminders
        .request_permission()
        .map_err(CommandError::reminder)?;
    if permission == "granted" {
        Ok(())
    } else {
        Err(CommandError::new(
            "REMINDER_PERMISSION_DENIED",
            "系统通知权限未授予，无法预约提醒",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::reminders::ScheduledReminderInfo;
    use std::sync::{
        Mutex,
        atomic::{AtomicUsize, Ordering},
    };
    use todo_native_core::{Task, TaskStatus};

    #[derive(Default)]
    struct FakeReminderAdapter {
        entries: Mutex<Vec<ScheduledReminderInfo>>,
        schedule_calls: AtomicUsize,
        permission: String,
        cancel_failures: Mutex<std::collections::HashSet<String>>,
    }

    impl FakeReminderAdapter {
        fn granted() -> Self {
            Self {
                entries: Mutex::new(Vec::new()),
                schedule_calls: AtomicUsize::new(0),
                permission: "granted".to_owned(),
                cancel_failures: Mutex::new(std::collections::HashSet::new()),
            }
        }
    }

    impl ReminderAdapter for FakeReminderAdapter {
        fn schedule(
            &self,
            reminder_id: &str,
            fire_at_utc: &str,
            title: &str,
            body: &str,
            _exact: bool,
        ) -> Result<String, String> {
            self.schedule_calls.fetch_add(1, Ordering::SeqCst);
            let mut entries = self.entries.lock().expect("entries");
            entries.retain(|entry| entry.reminder_id != reminder_id);
            entries.push(ScheduledReminderInfo {
                reminder_id: reminder_id.to_owned(),
                fire_at_utc: fire_at_utc.to_owned(),
                title: title.to_owned(),
                body: body.to_owned(),
            });
            Ok("scheduled".to_owned())
        }

        fn cancel(&self, reminder_id: &str) -> Result<(), String> {
            if self
                .cancel_failures
                .lock()
                .expect("failures")
                .contains(reminder_id)
            {
                return Err("platform cancel failed".to_owned());
            }
            self.entries
                .lock()
                .expect("entries")
                .retain(|entry| entry.reminder_id != reminder_id);
            Ok(())
        }

        fn scheduled(&self) -> Result<Vec<ScheduledReminderInfo>, String> {
            Ok(self.entries.lock().expect("entries").clone())
        }

        fn permission(&self) -> String {
            self.permission.clone()
        }

        fn request_permission(&self) -> Result<String, String> {
            Ok(self.permission.clone())
        }
    }

    fn reminder_task(id: &str, note: &str) -> Task {
        Task {
            id: id.to_owned(),
            list_id: None,
            title: format!("task {id}"),
            note: note.to_owned(),
            tags: Vec::new(),
            status: TaskStatus::Open,
            important: false,
            due_on: None,
            remind_at: Some("2026-10-24T09:00:00Z".to_owned()),
            remind_timezone: None,
            rank: "a0".to_owned(),
            series_id: None,
            occurrence_key: None,
            recurrence: None,
            completed_at: None,
            created_at: "2026-10-23T00:00:00Z".to_owned(),
            updated_at: "2026-10-23T00:00:00Z".to_owned(),
            deleted_at: None,
        }
    }

    #[test]
    fn repeated_reconcile_does_not_reschedule_unchanged_empty_body_reminders() {
        assert!(same_instant(
            "2026-10-24T09:00:00Z",
            "2026-10-24T09:00:00+00:00"
        ));
        let adapter = FakeReminderAdapter::granted();
        let tasks = vec![reminder_task("a", ""), reminder_task("b", "note")];

        let first =
            reconcile_reminder_queue(&adapter, &tasks, "default").expect("first reconcile");
        assert_eq!(first.scheduled, 2);
        assert_eq!(first.unchanged, 0);
        assert_eq!(adapter.schedule_calls.load(Ordering::SeqCst), 2);

        let second =
            reconcile_reminder_queue(&adapter, &tasks, "default").expect("second reconcile");
        assert_eq!(second.scheduled, 0);
        assert_eq!(second.unchanged, 2);
        assert!(second.failed.is_empty());
        assert_eq!(
            adapter.schedule_calls.load(Ordering::SeqCst),
            2,
            "unchanged notifications must not be cancelled/recreated"
        );
        let entries = adapter.scheduled().expect("entries");
        assert!(
            entries
                .iter()
                .any(|entry| entry.reminder_id == "account:default:a" && entry.body.is_empty())
        );
    }

    #[test]
    fn ios_default_body_is_treated_as_empty_raw_body() {
        let adapter = FakeReminderAdapter::granted();
        adapter
            .entries
            .lock()
            .expect("entries")
            .push(ScheduledReminderInfo {
                reminder_id: "account:default:a".to_owned(),
                fire_at_utc: "2026-10-24T09:00:00Z".to_owned(),
                title: "task a".to_owned(),
                body: DEFAULT_REMINDER_BODY.to_owned(),
            });
        let report = reconcile_reminder_queue(&adapter, &[reminder_task("a", "")], "default")
            .expect("legacy iOS entry");
        assert_eq!(report.scheduled, 0);
        assert_eq!(report.unchanged, 1);
        assert_eq!(adapter.schedule_calls.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn changed_raw_body_is_the_only_body_fingerprint_change() {
        let adapter = FakeReminderAdapter::granted();
        let task = reminder_task("a", "note");
        reconcile_reminder_queue(&adapter, std::slice::from_ref(&task), "default").expect("first");
        let mut changed = task.clone();
        changed.note = "changed".to_owned();
        let report = reconcile_reminder_queue(&adapter, std::slice::from_ref(&changed), "default")
            .expect("second");
        assert_eq!(report.scheduled, 1);
        assert_eq!(report.unchanged, 0);
        assert_eq!(adapter.schedule_calls.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn refresh_tokens_are_bound_to_the_current_account() {
        let a = "01a1673d-1000-7000-8000-000000000001";
        let b = "01a1673d-1000-7000-8000-000000000002";
        assert!(is_refresh_key_for(
            a,
            &format!("cloud-refresh:{a}")
        ));
        assert!(!is_refresh_key_for(a, &format!("cloud-refresh:{b}")));
        assert!(!is_refresh_key_for(a, "refresh_token:v1"));
    }

    #[test]
    fn foreign_account_and_legacy_reminders_are_cancelled_before_scheduling() {
        let adapter = FakeReminderAdapter::granted();
        adapter
            .entries
            .lock()
            .expect("entries")
            .extend([
                ScheduledReminderInfo {
                    reminder_id: "account:other:a".to_owned(),
                    fire_at_utc: "2026-10-24T09:00:00Z".to_owned(),
                    title: "other".to_owned(),
                    body: String::new(),
                },
                ScheduledReminderInfo {
                    reminder_id: "account:default:stale".to_owned(),
                    fire_at_utc: "2026-10-24T09:00:00Z".to_owned(),
                    title: "stale".to_owned(),
                    body: String::new(),
                },
                ScheduledReminderInfo {
                    reminder_id: "legacy-raw-id".to_owned(),
                    fire_at_utc: "2026-10-24T09:00:00Z".to_owned(),
                    title: "legacy".to_owned(),
                    body: String::new(),
                },
            ]);
        let report = reconcile_reminder_queue(&adapter, &[reminder_task("a", "")], "default")
            .expect("reconcile");
        assert_eq!(report.cancelled, 3);
        assert_eq!(report.scheduled, 1);
        let entries = adapter.scheduled().expect("entries");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].reminder_id, "account:default:a");
    }

    #[test]
    fn startup_cleanup_removes_other_account_and_legacy_notifications() {
        let adapter = FakeReminderAdapter::granted();
        adapter
            .entries
            .lock()
            .expect("entries")
            .extend([
                ScheduledReminderInfo {
                    reminder_id: "account:a:task-a".to_owned(),
                    fire_at_utc: "2026-10-24T09:00:00Z".to_owned(),
                    title: "A".to_owned(),
                    body: String::new(),
                },
                ScheduledReminderInfo {
                    reminder_id: "account:b:task-b".to_owned(),
                    fire_at_utc: "2026-10-24T09:00:00Z".to_owned(),
                    title: "B".to_owned(),
                    body: String::new(),
                },
                ScheduledReminderInfo {
                    reminder_id: "legacy".to_owned(),
                    fire_at_utc: "2026-10-24T09:00:00Z".to_owned(),
                    title: "legacy".to_owned(),
                    body: String::new(),
                },
            ]);
        crate::reminders::cleanup_foreign_queue(&adapter, "b").expect("cleanup");
        let entries = adapter.scheduled().expect("entries");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].reminder_id, "account:b:task-b");
    }

    #[test]
    fn startup_cleanup_reports_platform_cancel_failure() {
        let adapter = FakeReminderAdapter::granted();
        adapter
            .entries
            .lock()
            .expect("entries")
            .push(ScheduledReminderInfo {
                reminder_id: "account:other:a".to_owned(),
                fire_at_utc: "2026-10-24T09:00:00Z".to_owned(),
                title: "other".to_owned(),
                body: String::new(),
            });
        adapter
            .cancel_failures
            .lock()
            .expect("failures")
            .insert("account:other:a".to_owned());
        assert!(
            crate::reminders::cleanup_foreign_queue(&adapter, "default").is_err(),
            "platform failure must not be reported as success"
        );
    }

    #[test]
    fn reminder_cancel_failure_is_reported_not_hidden() {
        let adapter = FakeReminderAdapter::granted();
        adapter
            .entries
            .lock()
            .expect("entries")
            .push(ScheduledReminderInfo {
                reminder_id: "account:other:a".to_owned(),
                fire_at_utc: "2026-10-24T09:00:00Z".to_owned(),
                title: "other".to_owned(),
                body: String::new(),
            });
        adapter
            .cancel_failures
            .lock()
            .expect("failures")
            .insert("account:other:a".to_owned());
        let report = reconcile_reminder_queue(&adapter, &[reminder_task("a", "")], "default")
            .expect("reconcile");
        assert_eq!(report.cancelled, 0);
        assert!(!report.failed.is_empty());
        assert!(
            adapter
                .scheduled()
                .expect("entries")
                .iter()
                .any(|entry| entry.reminder_id == "account:other:a")
        );
    }

    #[test]
    fn permission_denied_is_reported_and_does_not_claim_scheduled() {
        let adapter = FakeReminderAdapter {
            permission: "denied".to_owned(),
            ..FakeReminderAdapter::granted()
        };
        let report = reconcile_reminder_queue(&adapter, &[reminder_task("a", "")], "default")
            .expect("report");
        assert_eq!(report.permission_denied, 1);
        assert_eq!(report.scheduled, 0);
        assert_eq!(adapter.schedule_calls.load(Ordering::SeqCst), 0);
    }
}
