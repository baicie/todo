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

/// Rebuild the platform queue from open tasks in SQLite. On desktop this arms
/// fresh timers; on Android/iOS it clears the plugin queue and schedules each
/// future reminder through the native platform bridge.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReminderReconcileReport {
    pub scheduled: u32,
    pub skipped_past: u32,
    pub outside_window: u32,
    pub capacity_exceeded: u32,
    pub failed: Vec<String>,
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
    let active: std::collections::HashSet<&str> =
        tasks.iter().map(|task| task.id.as_str()).collect();
    let existing = reminders.scheduled_ids().map_err(CommandError::reminder)?;
    let mut report = ReminderReconcileReport::default();
    for id in existing {
        if active.contains(id.as_str()) {
            continue;
        }
        match reminders.cancel(&id) {
            Ok(()) => {}
            Err(error) => report.failed.push(format!("{id}: cancel failed: {error}")),
        }
    }
    for task in tasks {
        if let Some(fire_at) = &task.remind_at {
            match reminders.schedule(&task.id, fire_at, &task.title, &task.note, false) {
                Ok(mode) if mode == "scheduled" || mode == "exact" || mode == "inexact" => {
                    report.scheduled += 1;
                }
                Ok(mode) if mode == "past" || mode == "skipped-past" => report.skipped_past += 1,
                Ok(mode) if mode == "outside-window" => report.outside_window += 1,
                Ok(mode) if mode == "capacity-exceeded" => report.capacity_exceeded += 1,
                Ok(mode) => report
                    .failed
                    .push(format!("{}: unknown mode {mode}", task.id)),
                Err(error) => report.failed.push(format!("{}: {error}", task.id)),
            }
        }
    }
    Ok(report)
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
