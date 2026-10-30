use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use tauri::{
    Manager, Runtime,
    plugin::{PluginApi, PluginHandle},
};

use crate::{ScheduleRequest, ScheduledReminder};

#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "app.shishi.todo.reminder";

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_shishi_reminder);

pub fn register<R: Runtime, C: DeserializeOwned>(
    api: &PluginApi<R, C>,
) -> Result<PluginHandle<R>, Box<dyn std::error::Error>> {
    #[cfg(target_os = "android")]
    let handle = api.register_android_plugin(PLUGIN_IDENTIFIER, "ReminderPlugin")?;
    #[cfg(target_os = "ios")]
    let handle = api.register_ios_plugin(init_plugin_shishi_reminder)?;
    Ok(handle)
}

/// A cloneable handle to the platform reminder plugin.
pub struct Reminder<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> Clone for Reminder<R> {
    fn clone(&self) -> Self {
        Self(self.0.clone())
    }
}

impl<R: Runtime> Reminder<R> {
    pub(crate) fn new(handle: PluginHandle<R>) -> Self {
        Self(handle)
    }

    pub fn schedule(&self, request: &ScheduleRequest) -> Result<String, String> {
        let response: Value = self
            .0
            .run_mobile_plugin("schedule", request)
            .map_err(|error| error.to_string())?;
        Ok(response
            .get("mode")
            .and_then(Value::as_str)
            .unwrap_or("inexact")
            .to_owned())
    }

    pub fn cancel(&self, reminder_id: &str) -> Result<(), String> {
        self.0
            .run_mobile_plugin::<Value>("cancel", json!({ "reminderId": reminder_id }))
            .map(|_| ())
            .map_err(|error| error.to_string())
    }

    /// Rebuilds platform alarms from the plugin's persistent queue.
    pub fn reschedule(&self) -> Result<u32, String> {
        let response: Value = self
            .0
            .run_mobile_plugin("reschedule", ())
            .map_err(|error| error.to_string())?;
        Ok(response
            .get("count")
            .and_then(Value::as_u64)
            .unwrap_or_default() as u32)
    }

    pub fn list(&self) -> Result<Vec<ScheduledReminder>, String> {
        self.0
            .run_mobile_plugin("list", ())
            .map_err(|error| error.to_string())
    }

    pub fn clear(&self) -> Result<(), String> {
        self.0
            .run_mobile_plugin::<Value>("clear", ())
            .map(|_| ())
            .map_err(|error| error.to_string())
    }

    pub fn check_permission(&self) -> Result<String, String> {
        let response: PermissionResponse = self
            .0
            .run_mobile_plugin("checkPermission", ())
            .map_err(|error| error.to_string())?;
        Ok(response.permission)
    }

    pub fn request_permission(&self) -> Result<String, String> {
        let response: PermissionResponse = self
            .0
            .run_mobile_plugin("requestPermission", ())
            .map_err(|error| error.to_string())?;
        Ok(response.permission)
    }

    pub fn secure_token_get(&self, key: &str) -> Result<Option<String>, String> {
        let response: SecureTokenValueResponse = self
            .0
            .run_mobile_plugin("secureTokenGet", json!({ "key": key }))
            .map_err(|error| error.to_string())?;
        Ok(response.value)
    }

    pub fn secure_token_set(&self, key: &str, value: &str) -> Result<(), String> {
        self.0
            .run_mobile_plugin::<Value>("secureTokenSet", json!({ "key": key, "value": value }))
            .map(|_| ())
            .map_err(|error| error.to_string())
    }

    pub fn secure_token_remove(&self, key: &str) -> Result<(), String> {
        self.0
            .run_mobile_plugin::<Value>("secureTokenRemove", json!({ "key": key }))
            .map(|_| ())
            .map_err(|error| error.to_string())
    }
}

#[derive(Debug, Deserialize)]
struct PermissionResponse {
    permission: String,
}

#[derive(Debug, Deserialize)]
struct SecureTokenValueResponse {
    #[serde(default)]
    value: Option<String>,
}

/// Extension trait used by the Tauri shell to retrieve the managed plugin.
pub trait ReminderExt<R: Runtime> {
    fn shishi_reminder(&self) -> Reminder<R>;
}

impl<R: Runtime, T: Manager<R>> ReminderExt<R> for T {
    fn shishi_reminder(&self) -> Reminder<R> {
        self.state::<Reminder<R>>().inner().clone()
    }
}
