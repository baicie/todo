use std::{
    fs,
    path::{Path, PathBuf},
    sync::Arc,
};

use tauri::{AppHandle, Manager};
use todo_native_core::TodoStore;

use crate::reminders::ReminderAdapter;

pub struct AppState {
    pub store: Arc<TodoStore>,
    pub reminders: Arc<dyn ReminderAdapter>,
}

impl AppState {
    pub fn new(store: TodoStore, reminders: Arc<dyn ReminderAdapter>) -> Self {
        Self {
            store: Arc::new(store),
            reminders,
        }
    }
}

/// Resolve the app-local database path. Account switching must use separate DB
/// files (a later feature); no path is supplied by the WebView.
pub fn open_app_store(app: &AppHandle) -> Result<TodoStore, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位应用数据目录: {error}"))?;
    fs::create_dir_all(&data_dir).map_err(|error| format!("无法创建应用数据目录: {error}"))?;
    let database_path = database_path(&data_dir);
    TodoStore::open(&database_path).map_err(|error| format!("无法打开本地数据库: {error}"))
}

fn database_path(data_dir: &Path) -> PathBuf {
    data_dir.join("shishi.sqlite3")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn database_file_is_inside_app_data_dir() {
        let path = database_path(Path::new("C:/data/shishi"));
        assert!(path.ends_with("shishi.sqlite3"));
    }
}
