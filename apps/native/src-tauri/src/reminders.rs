use std::sync::Arc;

use tauri::AppHandle;

/// Explicit boundary for platform reminder schedulers.
///
/// Desktop uses an in-process timer queue plus the notification plugin.
/// Android/iOS use the local `tauri-plugin-shishi-reminder` bridge backed by
/// AlarmManager and UNUserNotificationCenter respectively.
pub trait ReminderAdapter: Send + Sync {
    fn schedule(
        &self,
        reminder_id: &str,
        fire_at_utc: &str,
        title: &str,
        body: &str,
        exact: bool,
    ) -> Result<(), String>;
    fn cancel(&self, reminder_id: &str) -> Result<(), String>;
    fn clear(&self) -> Result<(), String>;
    fn permission(&self) -> String;
    /// Requests runtime permission when the platform supports a prompt.
    fn request_permission(&self) -> Result<String, String>;
}

#[cfg(desktop)]
pub fn create_adapter(app: AppHandle) -> Arc<dyn ReminderAdapter> {
    Arc::new(DesktopTimerAdapter::new(app))
}

#[cfg(mobile)]
pub fn create_adapter(app: AppHandle) -> Arc<dyn ReminderAdapter> {
    Arc::new(MobileReminderAdapter::new(app))
}

// ---------------------------------------------------------------------------
// Desktop: in-process timer queue
// ---------------------------------------------------------------------------

#[cfg(desktop)]
use std::{
    collections::HashMap,
    sync::{Condvar, Mutex},
    time::Duration,
};

#[cfg(desktop)]
use chrono::{DateTime, Utc};
#[cfg(desktop)]
use tauri_plugin_notification::{NotificationExt, PermissionState};

#[cfg(desktop)]
struct QueuedReminder {
    fire_at: DateTime<Utc>,
    title: String,
    body: String,
}

#[cfg(desktop)]
struct SharedQueue {
    entries: Mutex<HashMap<String, QueuedReminder>>,
    wake: Condvar,
}

#[cfg(desktop)]
struct DesktopTimerAdapter {
    app: AppHandle,
    queue: Arc<SharedQueue>,
}

#[cfg(desktop)]
impl DesktopTimerAdapter {
    fn new(app: AppHandle) -> Self {
        let queue = Arc::new(SharedQueue {
            entries: Mutex::new(HashMap::new()),
            wake: Condvar::new(),
        });
        let worker_queue = Arc::clone(&queue);
        let worker_app = app.clone();
        let _ = std::thread::Builder::new()
            .name("shishi-reminder-timer".to_owned())
            .spawn(move || reminder_worker(worker_app, worker_queue));
        Self { app, queue }
    }
}

#[cfg(desktop)]
impl ReminderAdapter for DesktopTimerAdapter {
    fn schedule(
        &self,
        reminder_id: &str,
        fire_at_utc: &str,
        title: &str,
        body: &str,
        _exact: bool,
    ) -> Result<(), String> {
        if reminder_id.trim().is_empty() {
            return Err("reminderId 不能为空".to_owned());
        }
        let fire_at = DateTime::parse_from_rfc3339(fire_at_utc)
            .map_err(|_| "fireAtUtc 不是有效的 ISO-8601 时间".to_owned())?
            .with_timezone(&Utc);
        let mut entries = self
            .queue
            .entries
            .lock()
            .map_err(|_| "reminder queue is unavailable".to_owned())?;
        // Match the browser adapter: past reminders are ignored. A newly
        // scheduled reminder with the same id replaces the old one.
        if fire_at <= Utc::now() {
            entries.remove(reminder_id);
            self.queue.wake.notify_all();
            return Ok(());
        }
        entries.insert(
            reminder_id.to_owned(),
            QueuedReminder {
                fire_at,
                title: title.to_owned(),
                body: body.to_owned(),
            },
        );
        drop(entries);
        self.queue.wake.notify_all();
        Ok(())
    }

    fn cancel(&self, reminder_id: &str) -> Result<(), String> {
        let mut entries = self
            .queue
            .entries
            .lock()
            .map_err(|_| "reminder queue is unavailable".to_owned())?;
        entries.remove(reminder_id);
        drop(entries);
        self.queue.wake.notify_all();
        Ok(())
    }

    fn clear(&self) -> Result<(), String> {
        let mut entries = self
            .queue
            .entries
            .lock()
            .map_err(|_| "reminder queue is unavailable".to_owned())?;
        entries.clear();
        drop(entries);
        self.queue.wake.notify_all();
        Ok(())
    }

    fn permission(&self) -> String {
        permission_label(self.app.notification().permission_state())
    }

    fn request_permission(&self) -> Result<String, String> {
        match self.app.notification().request_permission() {
            Ok(state) => Ok(permission_label(Ok(state))),
            Err(error) => Err(error.to_string()),
        }
    }
}

#[cfg(desktop)]
fn permission_label(result: Result<PermissionState, tauri_plugin_notification::Error>) -> String {
    match result {
        Ok(PermissionState::Granted) => "granted",
        Ok(PermissionState::Denied) => "denied",
        Ok(PermissionState::Prompt | PermissionState::PromptWithRationale) => "prompt",
        Err(_) => "prompt",
    }
    .to_owned()
}

#[cfg(desktop)]
fn reminder_worker(app: AppHandle, queue: Arc<SharedQueue>) {
    loop {
        let due = wait_for_due(&queue);
        if let Some(reminder) = due {
            match app.notification().permission_state() {
                Ok(PermissionState::Granted) => {
                    let body = if reminder.body.trim().is_empty() {
                        "该完成这项任务了"
                    } else {
                        reminder.body.as_str()
                    };
                    if let Err(error) = app
                        .notification()
                        .builder()
                        .title(reminder.title)
                        .body(body)
                        .show()
                    {
                        eprintln!("shishi: desktop reminder notification failed: {error}");
                    }
                }
                Ok(
                    PermissionState::Denied
                    | PermissionState::Prompt
                    | PermissionState::PromptWithRationale,
                ) => {
                    eprintln!("shishi: reminder skipped because notifications are not permitted");
                }
                Err(error) => {
                    eprintln!("shishi: could not read notification permission: {error}");
                }
            }
        }
    }
}

/// Blocks the dedicated reminder thread until one queued item is due. The
/// condvar wakes it immediately on schedule/cancel even if the next reminder
/// is days away.
#[cfg(desktop)]
fn wait_for_due(queue: &SharedQueue) -> Option<QueuedReminder> {
    let mut entries = queue.entries.lock().ok()?;
    loop {
        let now = Utc::now();
        let due_id = entries
            .iter()
            .find(|(_, reminder)| reminder.fire_at <= now)
            .map(|(id, _)| id.clone());
        if let Some(id) = due_id {
            return entries.remove(&id);
        }
        let wait = entries
            .values()
            .map(|reminder| reminder.fire_at)
            .min()
            .map(|fire_at| {
                (fire_at - now)
                    .to_std()
                    .unwrap_or(Duration::from_millis(100))
            })
            .unwrap_or(Duration::from_secs(60))
            .min(Duration::from_secs(60));
        let (next_entries, _) = queue.wake.wait_timeout(entries, wait).ok()?;
        entries = next_entries;
    }
}

// ---------------------------------------------------------------------------
// Mobile: Tauri plugin bridge
// ---------------------------------------------------------------------------

#[cfg(mobile)]
use tauri_plugin_shishi_reminder::{ReminderExt, ScheduleRequest};

#[cfg(mobile)]
struct MobileReminderAdapter {
    app: AppHandle,
}

#[cfg(mobile)]
impl MobileReminderAdapter {
    fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

#[cfg(mobile)]
impl ReminderAdapter for MobileReminderAdapter {
    fn schedule(
        &self,
        reminder_id: &str,
        fire_at_utc: &str,
        title: &str,
        body: &str,
        exact: bool,
    ) -> Result<(), String> {
        let mode = self.app.shishi_reminder().schedule(&ScheduleRequest {
            reminder_id: reminder_id.to_owned(),
            fire_at_utc: fire_at_utc.to_owned(),
            title: title.to_owned(),
            body: body.to_owned(),
            exact,
        })?;
        if exact && mode != "exact" && mode != "scheduled" {
            eprintln!(
                "shishi: exact reminder {} degraded to mode={mode}",
                reminder_id
            );
        }
        if mode == "outside-window" {
            eprintln!(
                "shishi: reminder {} is outside the iOS 30-day scheduling window",
                reminder_id
            );
        }
        Ok(())
    }

    fn cancel(&self, reminder_id: &str) -> Result<(), String> {
        self.app.shishi_reminder().cancel(reminder_id)
    }

    fn clear(&self) -> Result<(), String> {
        self.app.shishi_reminder().clear()
    }

    fn permission(&self) -> String {
        self.app
            .shishi_reminder()
            .check_permission()
            .unwrap_or_else(|_| "prompt".to_owned())
    }

    fn request_permission(&self) -> Result<String, String> {
        self.app.shishi_reminder().request_permission()
    }
}
