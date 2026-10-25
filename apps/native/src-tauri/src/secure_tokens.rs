//! Platform-backed refresh-token storage.
//!
//! Desktop uses the operating system credential store through `keyring`
//! (Windows Credential Manager, macOS Keychain, Linux Secret Service).
//! Mobile delegates to the local Tauri plugin: Android Keystore AES-256-GCM
//! with encrypted SharedPreferences, and iOS Security.framework Keychain.
//! Tokens are never written to localStorage or the SQLite database.
//!
//! The production credential service name is deliberately stable. RC2-D only
//! adds a QA namespace and an injectable backend behind the `native-qa` feature;
//! a production build has no way to select another backend at runtime.

use std::sync::Arc;

use tauri::AppHandle;
use todo_native_accounts::{LEGACY_REFRESH_TOKEN_KEY, fault_point, refresh_token_key};

#[cfg(desktop)]
#[cfg(not(feature = "native-qa"))]
const SERVICE: &str = "app.shishi.todo.secure-token";
#[cfg(desktop)]
#[cfg(feature = "native-qa")]
const SERVICE: &str = "app.shishi.todo.rc2d-qa.secure-token";

#[cfg(mobile)]
use tauri_plugin_shishi_reminder::ReminderExt;

#[cfg(feature = "native-qa")]
static QA_BACKEND: std::sync::OnceLock<std::sync::Mutex<Option<Arc<dyn CredentialBackend>>>> =
    std::sync::OnceLock::new();

/// The keyring-facing boundary. Policy (which key may be read) stays in the
/// command layer; this trait only performs the platform operation.
pub trait CredentialBackend: Send + Sync {
    fn get(&self, key: &str) -> Result<Option<String>, String>;
    fn set(&self, key: &str, value: &str) -> Result<(), String>;
    fn delete(&self, key: &str) -> Result<(), String>;
}

#[cfg(desktop)]
struct OsCredentialBackend {
    service: &'static str,
}

#[cfg(desktop)]
impl OsCredentialBackend {
    fn entry(&self, key: &str) -> Result<keyring::Entry, String> {
        validate_key(key)?;
        keyring::Entry::new(self.service, key).map_err(|error| error.to_string())
    }
}

#[cfg(desktop)]
impl CredentialBackend for OsCredentialBackend {
    fn get(&self, key: &str) -> Result<Option<String>, String> {
        match self.entry(key)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(error.to_string()),
        }
    }

    fn set(&self, key: &str, value: &str) -> Result<(), String> {
        self.entry(key)?
            .set_password(value)
            .map_err(|error| error.to_string())
    }

    fn delete(&self, key: &str) -> Result<(), String> {
        match self.entry(key)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(error.to_string()),
        }
    }
}

#[cfg(mobile)]
struct MobileCredentialBackend {
    app: AppHandle,
}

#[cfg(mobile)]
impl CredentialBackend for MobileCredentialBackend {
    fn get(&self, key: &str) -> Result<Option<String>, String> {
        validate_key(key)?;
        self.app.shishi_reminder().secure_token_get(key)
    }

    fn set(&self, key: &str, value: &str) -> Result<(), String> {
        validate_key(key)?;
        self.app.shishi_reminder().secure_token_set(key, value)
    }

    fn delete(&self, key: &str) -> Result<(), String> {
        validate_key(key)?;
        self.app.shishi_reminder().secure_token_remove(key)
    }
}

#[cfg(feature = "native-qa")]
/// Install a QA-only backend (memory/failing). No production build exports this.
pub fn install_qa_backend(backend: Arc<dyn CredentialBackend>) -> Result<(), String> {
    let slot = QA_BACKEND.get_or_init(|| std::sync::Mutex::new(None));
    let mut guard = slot
        .lock()
        .map_err(|_| "QA credential backend lock poisoned".to_owned())?;
    *guard = Some(backend);
    Ok(())
}

fn backend(app: &AppHandle) -> Arc<dyn CredentialBackend> {
    #[cfg(feature = "native-qa")]
    if let Some(slot) = QA_BACKEND.get()
        && let Ok(guard) = slot.lock()
        && let Some(backend) = guard.as_ref()
    {
        return Arc::clone(backend);
    }
    #[cfg(desktop)]
    {
        let _ = app;
        Arc::new(OsCredentialBackend { service: SERVICE })
    }
    #[cfg(mobile)]
    {
        Arc::new(MobileCredentialBackend { app: app.clone() })
    }
}

pub fn validate_key(key: &str) -> Result<(), String> {
    if key.trim().is_empty() || key.chars().count() > 256 {
        return Err("secure token key 无效".to_owned());
    }
    if !key
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || "._:-".contains(character))
    {
        return Err("secure token key 只允许 ASCII 字母、数字和 . _ : -".to_owned());
    }
    Ok(())
}

fn check_fault(point: todo_native_accounts::FaultPoint) -> Result<(), String> {
    fault_point(point, None, None, None).map_err(|error| error.to_string())
}

pub fn get(app: &AppHandle, key: &str) -> Result<Option<String>, String> {
    validate_key(key)?;
    check_fault(todo_native_accounts::FaultPoint::CredentialGet)?;
    backend(app).get(key)
}

pub fn set(app: &AppHandle, key: &str, value: &str) -> Result<(), String> {
    validate_key(key)?;
    check_fault(todo_native_accounts::FaultPoint::CredentialSet)?;
    backend(app).set(key, value)
}

pub fn remove(app: &AppHandle, key: &str) -> Result<(), String> {
    validate_key(key)?;
    check_fault(todo_native_accounts::FaultPoint::CredentialDelete)?;
    backend(app).delete(key)
}

fn migrate_with(backend: &dyn CredentialBackend, account_id: &str) -> Result<(), String> {
    let target_key = refresh_token_key(account_id).map_err(|error| error.to_string())?;
    // `refresh_token_key("default")` is the legacy key itself. This account
    // needs no migration, and deleting the target would delete the only copy.
    if target_key == LEGACY_REFRESH_TOKEN_KEY {
        return Ok(());
    }
    let Some(token) = backend.get(LEGACY_REFRESH_TOKEN_KEY)? else {
        return Ok(());
    };
    // The new value must be durable and readable before the old one is removed.
    backend.set(&target_key, &token)?;
    match backend.get(&target_key)? {
        Some(stored) if stored == token => {}
        Some(_) => {
            return Err("legacy refresh token readback mismatch; old token preserved".to_owned());
        }
        None => {
            return Err(
                "legacy refresh token write was not durable; old token preserved".to_owned(),
            );
        }
    }
    backend
        .delete(LEGACY_REFRESH_TOKEN_KEY)
        .map_err(|error| format!("new token saved, legacy token delete failed: {error}"))
}

/// Migrate the pre-account legacy refresh token only after the migration
/// engine has proven the old database is bound to this cloud account. The old
/// key is removed only after the account-scoped key is written and read back.
pub fn migrate_legacy_refresh_token(app: &AppHandle, account_id: &str) -> Result<(), String> {
    let backend = backend(app);
    check_fault(todo_native_accounts::FaultPoint::CredentialGet)?;
    migrate_with(backend.as_ref(), account_id)
}

#[cfg(test)]
mod tests {
    use std::{collections::HashMap, sync::Mutex};

    const ACCOUNT: &str = "01a1673d-1000-7000-8000-0000000000aa";
    const TARGET: &str = "cloud-refresh:01a1673d-1000-7000-8000-0000000000aa";

    use super::*;

    #[derive(Default)]
    struct MemoryBackend {
        values: Mutex<HashMap<String, String>>,
        fail_get: Mutex<bool>,
        fail_set: Mutex<bool>,
        fail_delete: Mutex<bool>,
    }

    impl CredentialBackend for MemoryBackend {
        fn get(&self, key: &str) -> Result<Option<String>, String> {
            if *self.fail_get.lock().expect("get flag") {
                return Err("simulated get failure".to_owned());
            }
            Ok(self.values.lock().expect("values").get(key).cloned())
        }

        fn set(&self, key: &str, value: &str) -> Result<(), String> {
            if *self.fail_set.lock().expect("set flag") {
                return Err("simulated set failure".to_owned());
            }
            self.values
                .lock()
                .expect("values")
                .insert(key.to_owned(), value.to_owned());
            Ok(())
        }

        fn delete(&self, key: &str) -> Result<(), String> {
            if *self.fail_delete.lock().expect("delete flag") {
                return Err("simulated delete failure".to_owned());
            }
            self.values.lock().expect("values").remove(key);
            Ok(())
        }
    }

    fn seeded() -> MemoryBackend {
        let backend = MemoryBackend::default();
        backend.values.lock().expect("values").insert(
            LEGACY_REFRESH_TOKEN_KEY.to_owned(),
            "legacy-token".to_owned(),
        );
        backend
    }

    #[test]
    fn token_keys_are_bounded_and_ascii() {
        assert!(validate_key("refresh_token:v1").is_ok());
        assert!(validate_key("").is_err());
        assert!(validate_key("包含中文").is_err());
    }

    #[test]
    fn refresh_keys_are_account_scoped() {
        let a = "01a1673d-1000-7000-8000-000000000001";
        let b = "01a1673d-1000-7000-8000-000000000002";
        assert_eq!(
            refresh_token_key("default").expect("default"),
            "cloud-refresh:default"
        );
        assert_ne!(
            refresh_token_key(a).expect("a"),
            refresh_token_key(b).expect("b")
        );
        assert!(refresh_token_key("../escape").is_err());
    }

    #[test]
    fn legacy_migration_writes_then_removes() {
        let backend = seeded();
        migrate_with(&backend, ACCOUNT).expect("migration");
        let values = backend.values.lock().expect("values");
        assert_eq!(values.get(TARGET).map(String::as_str), Some("legacy-token"));
        assert!(!values.contains_key(LEGACY_REFRESH_TOKEN_KEY));
    }

    #[test]
    fn set_failure_keeps_the_old_token() {
        let backend = seeded();
        *backend.fail_set.lock().expect("flag") = true;
        let error = migrate_with(&backend, ACCOUNT).expect_err("set failure");
        assert!(error.contains("simulated set failure"));
        let values = backend.values.lock().expect("values");
        assert_eq!(
            values.get(LEGACY_REFRESH_TOKEN_KEY).map(String::as_str),
            Some("legacy-token")
        );
        assert!(!values.contains_key(TARGET));
    }

    #[test]
    fn get_failure_never_deletes_anything() {
        let backend = seeded();
        *backend.fail_get.lock().expect("flag") = true;
        let error = migrate_with(&backend, ACCOUNT).expect_err("get failure");
        assert!(error.contains("simulated get failure"));
        let values = backend.values.lock().expect("values");
        assert_eq!(
            values.get(LEGACY_REFRESH_TOKEN_KEY).map(String::as_str),
            Some("legacy-token")
        );
        assert!(!values.contains_key(TARGET));
    }

    #[test]
    fn delete_failure_reports_but_keeps_the_new_token() {
        let backend = seeded();
        *backend.fail_delete.lock().expect("flag") = true;
        let error = migrate_with(&backend, ACCOUNT).expect_err("delete failure");
        assert!(error.contains("legacy token delete failed"));
        let values = backend.values.lock().expect("values");
        assert_eq!(values.get(TARGET).map(String::as_str), Some("legacy-token"));
        assert_eq!(
            values.get(LEGACY_REFRESH_TOKEN_KEY).map(String::as_str),
            Some("legacy-token"),
            "a failed delete must leave the old value for idempotent retry"
        );
    }

    #[test]
    fn crash_between_write_and_delete_is_idempotent() {
        let backend = seeded();
        backend.values.lock().expect("values").insert(
            "cloud-refresh:default".to_owned(),
            "legacy-token".to_owned(),
        );
        *backend.fail_delete.lock().expect("flag") = true;
        migrate_with(&backend, ACCOUNT).expect_err("simulated crash");
        *backend.fail_delete.lock().expect("flag") = false;
        migrate_with(&backend, ACCOUNT).expect("retry");
        let values = backend.values.lock().expect("values");
        assert_eq!(values.get(TARGET).map(String::as_str), Some("legacy-token"));
        assert!(!values.contains_key(LEGACY_REFRESH_TOKEN_KEY));
    }
}
