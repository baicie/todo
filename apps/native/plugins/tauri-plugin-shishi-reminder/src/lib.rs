//! Native mobile services for Android and iOS: system reminders and secure
//! token storage.
//!
//! The application calls this plugin from Rust through its `ReminderAdapter`
//! and `secure_tokens` bridge; no JavaScript API is exposed to the WebView.

use serde::{Deserialize, Serialize};
use tauri::{
    Runtime,
    plugin::{Builder, TauriPlugin},
};

#[cfg(mobile)]
use tauri::Manager;

#[cfg(mobile)]
mod mobile;

#[cfg(mobile)]
pub use mobile::{Reminder, ReminderExt};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleRequest {
    pub reminder_id: String,
    pub fire_at_utc: String,
    pub title: String,
    pub body: String,
    /// Opt-in only. Android falls back to inexact scheduling when the exact
    /// alarm permission is unavailable; iOS schedules exact local notifications.
    pub exact: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledReminder {
    pub reminder_id: String,
    pub fire_at_utc: String,
    pub title: String,
    pub body: String,
    pub exact: bool,
    pub mode: String,
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("shishi-reminder")
        .setup(|_app, _api| {
            #[cfg(mobile)]
            {
                let handle = mobile::register(&_api)?;
                _app.manage(Reminder::new(handle));
            }
            #[cfg(desktop)]
            {
                let _ = (_app, _api);
            }
            Ok(())
        })
        .build()
}
