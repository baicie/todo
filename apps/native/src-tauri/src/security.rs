//! Boundary checks for the WebView IPC surface.
//!
//! SQL, filesystem paths and shell commands are never accepted from the
//! frontend. The only storage entry point is the fixed `todo_storage` action
//! allowlist; everything else is an explicit native command.

use std::collections::HashSet;
use std::sync::OnceLock;

use tauri::{
    Runtime,
    plugin::{Builder, TauriPlugin},
};
use todo_native_core::action_names;

// Keep this in sync with `tauri.conf.json`. It is documentation for the
// policy compiled into the bundle and is asserted by the unit test below.
#[allow(dead_code)]
pub const APP_CSP: &str = "default-src 'self'; \
    script-src 'self'; \
    style-src 'self' 'unsafe-inline'; \
    img-src 'self' asset: data:; \
    font-src 'self' data:; \
    connect-src ipc: http://ipc.localhost https: wss: http://localhost:5173 ws://localhost:5173; \
    object-src 'none'; \
    base-uri 'self'; \
    frame-ancestors 'none'; \
    form-action 'none'";

fn allowed_actions() -> &'static HashSet<&'static str> {
    static ACTIONS: OnceLock<HashSet<&'static str>> = OnceLock::new();
    ACTIONS.get_or_init(|| action_names().iter().copied().collect())
}

/// Reject unknown actions before they reach the database layer.
pub fn validate_storage_action(action: &str) -> Result<(), String> {
    if allowed_actions().contains(action) {
        Ok(())
    } else {
        Err(format!("不允许的存储操作: {action}"))
    }
}

/// Keep the policy testable without spinning up a WebView.
pub fn is_allowed_navigation(url: &str) -> bool {
    let internal = url == "tauri://localhost"
        || url.starts_with("tauri://localhost/")
        || url == "http://tauri.localhost"
        || url.starts_with("http://tauri.localhost/")
        || url == "https://tauri.localhost"
        || url.starts_with("https://tauri.localhost/");
    let dev_server =
        cfg!(dev) && (url == "http://localhost:5173" || url.starts_with("http://localhost:5173/"));
    internal || dev_server
}

/// Install a process-wide navigation allowlist. External links must be opened
/// by the OS browser instead of navigating the application WebView.
pub fn navigation_guard<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("shishi-security")
        .on_navigation(|_, url| is_allowed_navigation(url.as_str()))
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_known_actions_are_allowed() {
        assert!(validate_storage_action("create_task").is_ok());
        assert!(validate_storage_action("initialize").is_ok());
        assert!(validate_storage_action("run_sql").is_err());
        assert!(validate_storage_action("").is_err());
    }

    #[test]
    fn external_navigation_is_rejected() {
        assert!(is_allowed_navigation("tauri://localhost/index.html"));
        assert_eq!(
            is_allowed_navigation("http://localhost:5173/"),
            cfg!(dev),
            "the Vite origin is only allowed in Tauri dev builds"
        );
        assert!(!is_allowed_navigation("https://evil.example/"));
        assert!(!is_allowed_navigation("javascript:alert(1)"));
        assert!(APP_CSP.contains("object-src 'none'"));
    }
}
