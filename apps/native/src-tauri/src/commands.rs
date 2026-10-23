use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, State, WebviewWindow};
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
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeAccountContextDto {
    pub account_id: String,
    pub kind: String,
    pub email: Option<String>,
    pub migrated_from_legacy: bool,
}

#[tauri::command]
pub fn native_account_context(state: State<'_, AppState>) -> NativeAccountContextDto {
    NativeAccountContextDto {
        account_id: state.account.account_id.clone(),
        kind: state.account.kind.as_str().to_owned(),
        email: state.account.email.clone(),
        migrated_from_legacy: state.account.migrated_from_legacy,
    }
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
    ensure_reminder_permission(&state)?;
    state
        .reminders
        .schedule(
            &reminder_id,
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
    state
        .reminders
        .cancel(&reminder_id)
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
) -> Result<ReminderReconcileReport, String> {
    let active: std::collections::HashSet<&str> =
        tasks.iter().map(|task| task.id.as_str()).collect();
    let existing = reminders.scheduled()?;
    let mut report = ReminderReconcileReport::default();
    let existing_by_id: std::collections::HashMap<String, crate::reminders::ScheduledReminderInfo> =
        existing
            .into_iter()
            .map(|item| (item.reminder_id.clone(), item))
            .collect();

    for (id, _) in &existing_by_id {
        if !active.contains(id.as_str()) {
            match reminders.cancel(id) {
                Ok(()) => report.cancelled += 1,
                Err(error) => report.failed.push(format!("{id}: cancel failed: {error}")),
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
            match reminders.schedule(&task.id, fire_at, &task.title, body, false) {
                Ok(mode) if mode == "scheduled" || mode == "exact" || mode == "inexact" => {
                    report.scheduled += 1;
                }
                Ok(mode) if mode == "past" || mode == "skipped-past" => {
                    let _ = reminders.cancel(&task.id);
                    report.skipped_past += 1;
                }
                Ok(mode) if mode == "outside-window" => {
                    let _ = reminders.cancel(&task.id);
                    report.outside_window += 1;
                }
                Ok(mode) if mode == "capacity-exceeded" => {
                    let _ = reminders.cancel(&task.id);
                    report.capacity_exceeded += 1;
                }
                Ok(mode) => report
                    .failed
                    .push(format!("{}: unknown mode {mode}", task.id)),
                Err(error) => {
                    let _ = reminders.cancel(&task.id);
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
    let store = Arc::clone(&state.store);
    let reminders: Arc<dyn ReminderAdapter> = Arc::clone(&state.reminders);
    let tasks = tauri::async_runtime::spawn_blocking(move || store.upcoming_reminders())
        .await
        .map_err(|error| CommandError::new("INTERNAL", format!("提醒查询异常: {error}")))?
        .map_err(CommandError::from_store)?;
    reconcile_reminder_queue(reminders.as_ref(), &tasks).map_err(CommandError::reminder)
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
pub async fn secure_token_get(app: AppHandle, key: String) -> Result<Option<String>, CommandError> {
    tauri::async_runtime::spawn_blocking(move || secure_tokens::get(&app, &key))
        .await
        .map_err(|error| CommandError::new("SECURE_STORAGE", error.to_string()))?
        .map_err(|message| CommandError::new("SECURE_STORAGE", message))
}

#[tauri::command]
pub async fn secure_token_set(
    app: AppHandle,
    key: String,
    value: String,
) -> Result<(), CommandError> {
    tauri::async_runtime::spawn_blocking(move || secure_tokens::set(&app, &key, &value))
        .await
        .map_err(|error| CommandError::new("SECURE_STORAGE", error.to_string()))?
        .map_err(|message| CommandError::new("SECURE_STORAGE", message))
}

#[tauri::command]
pub async fn secure_token_remove(app: AppHandle, key: String) -> Result<(), CommandError> {
    tauri::async_runtime::spawn_blocking(move || secure_tokens::remove(&app, &key))
        .await
        .map_err(|error| CommandError::new("SECURE_STORAGE", error.to_string()))?
        .map_err(|message| CommandError::new("SECURE_STORAGE", message))
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
    }

    impl FakeReminderAdapter {
        fn granted() -> Self {
            Self {
                entries: Mutex::new(Vec::new()),
                schedule_calls: AtomicUsize::new(0),
                permission: "granted".to_owned(),
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

        let first = reconcile_reminder_queue(&adapter, &tasks).expect("first reconcile");
        assert_eq!(first.scheduled, 2);
        assert_eq!(first.unchanged, 0);
        assert_eq!(adapter.schedule_calls.load(Ordering::SeqCst), 2);

        let second = reconcile_reminder_queue(&adapter, &tasks).expect("second reconcile");
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
                .any(|entry| entry.reminder_id == "a" && entry.body.is_empty())
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
                reminder_id: "a".to_owned(),
                fire_at_utc: "2026-10-24T09:00:00Z".to_owned(),
                title: "task a".to_owned(),
                body: DEFAULT_REMINDER_BODY.to_owned(),
            });
        let report = reconcile_reminder_queue(&adapter, &[reminder_task("a", "")])
            .expect("legacy iOS entry");
        assert_eq!(report.scheduled, 0);
        assert_eq!(report.unchanged, 1);
        assert_eq!(adapter.schedule_calls.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn changed_raw_body_is_the_only_body_fingerprint_change() {
        let adapter = FakeReminderAdapter::granted();
        let task = reminder_task("a", "note");
        reconcile_reminder_queue(&adapter, std::slice::from_ref(&task)).expect("first");
        let mut changed = task.clone();
        changed.note = "changed".to_owned();
        let report =
            reconcile_reminder_queue(&adapter, std::slice::from_ref(&changed)).expect("second");
        assert_eq!(report.scheduled, 1);
        assert_eq!(report.unchanged, 0);
        assert_eq!(adapter.schedule_calls.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn permission_denied_is_reported_and_does_not_claim_scheduled() {
        let adapter = FakeReminderAdapter {
            permission: "denied".to_owned(),
            ..FakeReminderAdapter::granted()
        };
        let report = reconcile_reminder_queue(&adapter, &[reminder_task("a", "")]).expect("report");
        assert_eq!(report.permission_denied, 1);
        assert_eq!(report.scheduled, 0);
        assert_eq!(adapter.schedule_calls.load(Ordering::SeqCst), 0);
    }
}
