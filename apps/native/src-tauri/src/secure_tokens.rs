//! Platform-backed refresh-token storage.
//!
//! Desktop uses the operating system credential store through `keyring`
//! (Windows Credential Manager, macOS Keychain, Linux Secret Service).
//! Mobile delegates to the local Tauri plugin: Android Keystore AES-256-GCM
//! with encrypted SharedPreferences, and iOS Security.framework Keychain.
//! Tokens are never written to localStorage or the SQLite database.

use tauri::AppHandle;

#[cfg(desktop)]
const SERVICE: &str = "app.shishi.todo.secure-token";

#[cfg(mobile)]
use tauri_plugin_shishi_reminder::ReminderExt;

fn validate_key(key: &str) -> Result<(), String> {
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

#[cfg(desktop)]
fn entry(key: &str) -> Result<keyring::Entry, String> {
    validate_key(key)?;
    keyring::Entry::new(SERVICE, key).map_err(|error| error.to_string())
}

#[cfg(desktop)]
pub fn get(_app: &AppHandle, key: &str) -> Result<Option<String>, String> {
    match entry(key)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

#[cfg(desktop)]
pub fn set(_app: &AppHandle, key: &str, value: &str) -> Result<(), String> {
    entry(key)?
        .set_password(value)
        .map_err(|error| error.to_string())
}

#[cfg(desktop)]
pub fn remove(_app: &AppHandle, key: &str) -> Result<(), String> {
    match entry(key)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

#[cfg(mobile)]
pub fn get(app: &AppHandle, key: &str) -> Result<Option<String>, String> {
    validate_key(key)?;
    app.shishi_reminder().secure_token_get(key)
}

#[cfg(mobile)]
pub fn set(app: &AppHandle, key: &str, value: &str) -> Result<(), String> {
    validate_key(key)?;
    app.shishi_reminder().secure_token_set(key, value)
}

#[cfg(mobile)]
pub fn remove(app: &AppHandle, key: &str) -> Result<(), String> {
    validate_key(key)?;
    app.shishi_reminder().secure_token_remove(key)
}

#[cfg(test)]
mod tests {
    use super::validate_key;

    #[test]
    fn token_keys_are_bounded_and_ascii() {
        assert!(validate_key("refresh_token:v1").is_ok());
        assert!(validate_key("").is_err());
        assert!(validate_key("包含中文").is_err());
    }
}
