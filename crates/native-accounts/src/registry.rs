use std::{
    collections::HashSet,
    path::{Path, PathBuf},
};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    error::{AccountError, AccountResult},
    paths::{
        DEFAULT_ACCOUNT_ID, accounts_file, database_path, ensure_account_dir, validate_account_id,
        write_json_atomic,
    },
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AccountKind {
    Anonymous,
    Cloud,
}

impl AccountKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Anonymous => "anonymous",
            Self::Cloud => "cloud",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountRecord {
    pub id: String,
    pub kind: AccountKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_url: Option<String>,
    pub created_at: String,
    pub schema_version: u32,
    pub last_opened_at: String,
}

impl AccountRecord {
    pub fn anonymous() -> Self {
        let now = timestamp();
        Self {
            id: DEFAULT_ACCOUNT_ID.to_owned(),
            kind: AccountKind::Anonymous,
            email: None,
            api_url: None,
            created_at: now.clone(),
            schema_version: 1,
            last_opened_at: now,
        }
    }

    pub fn cloud(email: &str) -> Self {
        Self::cloud_with_id(&Uuid::now_v7().to_string(), email)
    }

    pub fn cloud_with_id(id: &str, email: &str) -> Self {
        let now = timestamp();
        Self {
            id: id.to_owned(),
            kind: AccountKind::Cloud,
            email: Some(normalize_email(email)),
            api_url: None,
            created_at: now.clone(),
            schema_version: 1,
            last_opened_at: now,
        }
    }

    pub fn touch(&mut self) {
        self.last_opened_at = timestamp();
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountRegistry {
    pub version: u32,
    pub active_account_id: String,
    pub accounts: Vec<AccountRecord>,
}

impl AccountRegistry {
    pub fn new_with_default() -> Self {
        Self {
            version: 1,
            active_account_id: DEFAULT_ACCOUNT_ID.to_owned(),
            accounts: vec![AccountRecord::anonymous()],
        }
    }

    pub fn load(root: &Path) -> AccountResult<Self> {
        let path = accounts_file(root);
        let raw = std::fs::read(&path)?;
        let registry: Self = serde_json::from_slice(&raw)?;
        registry.validate()?;
        Ok(registry)
    }

    pub fn save(&self, root: &Path) -> AccountResult<()> {
        self.validate()?;
        write_json_atomic(&accounts_file(root), self)
    }

    pub fn validate(&self) -> AccountResult<()> {
        if self.version != 1 {
            return Err(AccountError::InvalidRegistry(format!(
                "unsupported registry version {}",
                self.version
            )));
        }
        if self.accounts.is_empty() {
            return Err(AccountError::InvalidRegistry(
                "registry has no accounts".to_owned(),
            ));
        }
        let mut ids = HashSet::new();
        for account in &self.accounts {
            validate_account_id(&account.id)?;
            if !ids.insert(account.id.clone()) {
                return Err(AccountError::InvalidRegistry(format!(
                    "duplicate account id {}",
                    account.id
                )));
            }
            if account.schema_version == 0 {
                return Err(AccountError::InvalidRegistry(format!(
                    "account {} has zero schema version",
                    account.id
                )));
            }
            match account.kind {
                AccountKind::Anonymous => {
                    if account.id != DEFAULT_ACCOUNT_ID {
                        return Err(AccountError::InvalidRegistry(format!(
                            "anonymous account must be {}",
                            DEFAULT_ACCOUNT_ID
                        )));
                    }
                    if account.email.is_some() {
                        return Err(AccountError::InvalidRegistry(
                            "anonymous account must not contain email".to_owned(),
                        ));
                    }
                }
                AccountKind::Cloud => {
                    if account.id == DEFAULT_ACCOUNT_ID {
                        return Err(AccountError::InvalidRegistry(
                            "cloud account cannot use default id".to_owned(),
                        ));
                    }
                    let email = account
                        .email
                        .as_deref()
                        .filter(|email| valid_email(email))
                        .ok_or_else(|| {
                            AccountError::InvalidRegistry(format!(
                                "cloud account {} has invalid email",
                                account.id
                            ))
                        })?;
                    if email != normalize_email(email) {
                        return Err(AccountError::InvalidRegistry(format!(
                            "cloud account {} email is not normalized",
                            account.id
                        )));
                    }
                }
            }
        }
        if !ids.contains(&self.active_account_id) {
            return Err(AccountError::InvalidRegistry(format!(
                "active account {} is not registered",
                self.active_account_id
            )));
        }
        Ok(())
    }

    pub fn account(&self, id: &str) -> Option<&AccountRecord> {
        self.accounts.iter().find(|account| account.id == id)
    }

    pub fn account_mut(&mut self, id: &str) -> Option<&mut AccountRecord> {
        self.accounts.iter_mut().find(|account| account.id == id)
    }

    pub fn active(&self) -> &AccountRecord {
        self.account(&self.active_account_id)
            .expect("validated registry active account")
    }

    pub fn find_cloud_by_email(&self, email: &str) -> Option<&AccountRecord> {
        let normalized = normalize_email(email);
        self.accounts.iter().find(|account| {
            account.kind == AccountKind::Cloud
                && account.email.as_deref() == Some(normalized.as_str())
        })
    }

    pub fn ensure_default(&mut self) -> &AccountRecord {
        if self.account(DEFAULT_ACCOUNT_ID).is_none() {
            self.accounts.push(AccountRecord::anonymous());
        }
        self.account(DEFAULT_ACCOUNT_ID).expect("default account")
    }

    pub fn upsert(&mut self, record: AccountRecord) -> AccountResult<()> {
        validate_account_id(&record.id)?;
        if let Some(existing) = self.account_mut(&record.id) {
            *existing = record;
        } else {
            self.accounts.push(record);
        }
        Ok(())
    }

    pub fn set_active(&mut self, id: &str) -> AccountResult<()> {
        if self.account(id).is_none() {
            return Err(AccountError::InvalidRegistry(format!(
                "active account {} is not registered",
                id
            )));
        }
        self.active_account_id = id.to_owned();
        Ok(())
    }

    pub fn database_path(&self, root: &Path, id: &str) -> AccountResult<PathBuf> {
        if self.account(id).is_none() {
            return Err(AccountError::InvalidRegistry(format!(
                "account {} is not registered",
                id
            )));
        }
        database_path(root, id)
    }

    pub fn ensure_active_directory(&self, root: &Path) -> AccountResult<PathBuf> {
        ensure_account_dir(root, &self.active_account_id)
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveAccountContext {
    pub account_id: String,
    pub kind: AccountKind,
    pub email: Option<String>,
    pub database_path: PathBuf,
    pub migrated_from_legacy: bool,
}

impl ActiveAccountContext {
    pub fn new(
        registry: &AccountRegistry,
        root: &Path,
        migrated_from_legacy: bool,
    ) -> AccountResult<Self> {
        let active = registry.active();
        Ok(Self {
            account_id: active.id.clone(),
            kind: active.kind,
            email: active.email.clone(),
            database_path: registry.database_path(root, &active.id)?,
            migrated_from_legacy,
        })
    }
}

pub fn normalize_email(email: &str) -> String {
    email.trim().to_ascii_lowercase()
}

pub fn valid_email(email: &str) -> bool {
    let trimmed = email.trim();
    trimmed.len() <= 320
        && !trimmed.chars().any(char::is_whitespace)
        && trimmed.split('@').count() == 2
        && trimmed.split('@').all(|part| !part.is_empty())
}

pub fn timestamp() -> String {
    Utc::now().to_rfc3339()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn account_ids_are_opaque_and_emails_are_not_paths() {
        let record = AccountRecord::cloud("User@Example.com");
        assert_eq!(record.email.as_deref(), Some("user@example.com"));
        assert_ne!(record.id, "user@example.com");
        assert!(record.id.len() == 36);
        let mut registry = AccountRegistry::new_with_default();
        registry.upsert(record.clone()).expect("upsert");
        registry.set_active(&record.id).expect("active");
        registry.validate().expect("valid");
    }

    #[test]
    fn registry_with_missing_active_is_invalid() {
        let mut registry = AccountRegistry::new_with_default();
        registry.active_account_id = Uuid::now_v7().to_string();
        assert!(registry.validate().is_err());
    }
}
