mod commands;
mod db;
#[cfg(desktop)]
mod desktop_shell;
mod lifecycle;
mod reminders;
mod secure_tokens;
mod security;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();

    // Single-instance must be the first plugin registered.
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            desktop_shell::show_main_window(app);
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--autostart"]),
        ));

    #[cfg(mobile)]
    let builder = builder.plugin(tauri_plugin_shishi_reminder::init());

    let builder = builder
        .plugin(tauri_plugin_notification::init())
        .plugin(security::navigation_guard());

    builder
        .setup(|app| {
            let opened = db::open_app_store(app.handle()).map_err(std::io::Error::other)?;
            let account = opened.account;
            if account.migrated_from_legacy
                && account.kind == todo_native_accounts::AccountKind::Cloud
                && let Err(error) =
                    secure_tokens::migrate_legacy_refresh_token(app.handle(), &account.account_id)
            {
                eprintln!("shishi: legacy refresh token migration failed: {error}");
            }
            let reminders = reminders::create_adapter(app.handle().clone());
            if let Err(error) =
                reminders::cleanup_foreign_queue(reminders.as_ref(), &account.account_id)
            {
                eprintln!("shishi: stale reminder cleanup failed: {error}");
            }
            let lifecycle =
                lifecycle::LifecycleState::load(app.handle()).map_err(std::io::Error::other)?;
            app.manage(lifecycle);
            app.manage(db::AppState::new(opened.store, reminders, account));

            #[cfg(desktop)]
            {
                // Some Linux/headless sessions have no tray host. The app must
                // still be usable even when the tray enhancement fails.
                let tray_ready = match desktop_shell::setup(app.handle()) {
                    Ok(()) => true,
                    Err(error) => {
                        eprintln!("shishi: system tray initialization failed: {error}");
                        false
                    }
                };
                // Launching at login stays quiet only when a tray offers a way
                // back to the hidden window.
                if tray_ready && std::env::args().any(|argument| argument == "--autostart") {
                    desktop_shell::hide_main_window(app.handle());
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            #[cfg(desktop)]
            if window.label() == "main"
                && let tauri::WindowEvent::CloseRequested { api, .. } = event
            {
                let close_to_tray = window
                    .app_handle()
                    .try_state::<lifecycle::LifecycleState>()
                    .map(|state| state.close_to_tray())
                    .unwrap_or(false);
                if close_to_tray {
                    api.prevent_close();
                    let _ = window.hide();
                } else {
                    api.prevent_close();
                    window.app_handle().exit(0);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::todo_storage,
            commands::schedule_reminder,
            commands::cancel_reminder,
            commands::reschedule_reminders,
            commands::reminder_permission,
            commands::request_reminder_permission,
            commands::set_badge_count,
            commands::get_desktop_settings,
            commands::set_close_to_tray,
            commands::set_autostart,
            commands::native_account_context,
            commands::native_list_accounts,
            commands::native_create_account,
            commands::native_prepare_account_switch,
            commands::native_request_account_switch,
            commands::native_abort_account_switch,
            commands::native_restart_account_recovery,
            commands::native_account_switch_status,
            commands::native_verify_cloud_identity,
            commands::native_mark_account_verified,
            commands::secure_token_get,
            commands::secure_token_set,
            commands::secure_token_remove,
        ])
        .run(tauri::generate_context!())
        .expect("error while running the Shishi native application");
}
