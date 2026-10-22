use std::{
    fs,
    path::PathBuf,
    sync::{Mutex, MutexGuard},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Preferences {
    version: u32,
    #[serde(default)]
    close_to_tray: bool,
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            version: 1,
            // Closing the last window quits by default. Users can opt into
            // hide-to-tray through the new desktop settings commands.
            close_to_tray: false,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSettings {
    pub close_to_tray: bool,
    pub autostart_enabled: bool,
    pub autostart_supported: bool,
}

pub struct LifecycleState {
    preferences: Mutex<Preferences>,
    path: PathBuf,
}

impl LifecycleState {
    pub fn load(app: &AppHandle) -> Result<Self, String> {
        let config_dir = app
            .path()
            .app_config_dir()
            .map_err(|error| format!("无法定位应用配置目录: {error}"))?;
        fs::create_dir_all(&config_dir)
            .map_err(|error| format!("无法创建应用配置目录: {error}"))?;
        let path = config_dir.join("desktop-settings.json");
        let preferences = fs::read_to_string(&path)
            .ok()
            .and_then(|contents| serde_json::from_str::<Preferences>(&contents).ok())
            .unwrap_or_default();
        Ok(Self {
            preferences: Mutex::new(preferences),
            path,
        })
    }

    fn guard(&self) -> Result<MutexGuard<'_, Preferences>, String> {
        self.preferences
            .lock()
            .map_err(|_| "desktop settings lock was poisoned".to_owned())
    }

    pub fn close_to_tray(&self) -> bool {
        self.guard()
            .map(|preferences| preferences.close_to_tray)
            .unwrap_or(false)
    }

    pub fn set_close_to_tray(&self, enabled: bool) -> Result<(), String> {
        if !cfg!(desktop) {
            return Err("窗口关闭行为仅适用于桌面端".to_owned());
        }
        let mut preferences = self.guard()?;
        preferences.close_to_tray = enabled;
        let contents = serde_json::to_vec_pretty(&*preferences)
            .map_err(|error| format!("无法序列化桌面设置: {error}"))?;
        fs::write(&self.path, contents).map_err(|error| format!("无法保存桌面设置: {error}"))?;
        Ok(())
    }
}

pub fn settings(
    app: &AppHandle,
    state: &State<'_, LifecycleState>,
) -> Result<DesktopSettings, String> {
    Ok(DesktopSettings {
        close_to_tray: state.close_to_tray(),
        autostart_enabled: autostart_enabled(app).unwrap_or(false),
        autostart_supported: cfg!(desktop),
    })
}

#[cfg(desktop)]
pub fn autostart_enabled(app: &AppHandle) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt as AutostartExt;
    app.autolaunch()
        .is_enabled()
        .map_err(|error| error.to_string())
}

#[cfg(not(desktop))]
pub fn autostart_enabled(_app: &AppHandle) -> Result<bool, String> {
    Err("开机自启仅支持桌面端".to_owned())
}

#[cfg(desktop)]
pub fn set_autostart(app: &AppHandle, enabled: bool) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt as AutostartExt;
    let manager = app.autolaunch();
    if enabled {
        manager.enable().map_err(|error| error.to_string())
    } else {
        manager.disable().map_err(|error| error.to_string())
    }
}

#[cfg(not(desktop))]
pub fn set_autostart(_app: &AppHandle, _enabled: bool) -> Result<(), String> {
    Err("开机自启仅支持桌面端".to_owned())
}
