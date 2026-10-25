//! Deterministic fault points for account, migration and switch reliability.
//!
//! Production builds compile the calls to no-ops. The injector can only be
//! installed when `fault-injection` is enabled (QA/test builds); there is no
//! Tauri command or environment-variable switch that can arm it at runtime.

use std::{
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::{AccountError, AccountResult};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum FaultPoint {
    InstallationPrepared,
    InstallationDatabaseCreated,
    MigrationBackupCreated,
    MigrationCopyVerified,
    SwitchPreparedPersisted,
    SwitchRestartRequiredPersisted,
    SwitchVerifyingTargetPersisted,
    RegistryActiveBeforeUpdate,
    RegistryActiveAfterUpdate,
    TargetDatabaseBeforeOpen,
    TargetDatabaseAfterOpen,
    SwitchJournalBeforeCleanup,
    RegistryReplaceFallback,
    CredentialGet,
    CredentialSet,
    CredentialDelete,
    ReminderCancel,
    SqliteBusy,
}

impl FaultPoint {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::InstallationPrepared => "installation_prepared",
            Self::InstallationDatabaseCreated => "installation_database_created",
            Self::MigrationBackupCreated => "migration_backup_created",
            Self::MigrationCopyVerified => "migration_copy_verified",
            Self::SwitchPreparedPersisted => "switch_prepared_persisted",
            Self::SwitchRestartRequiredPersisted => "switch_restart_required_persisted",
            Self::SwitchVerifyingTargetPersisted => "switch_verifying_target_persisted",
            Self::RegistryActiveBeforeUpdate => "registry_active_before_update",
            Self::RegistryActiveAfterUpdate => "registry_active_after_update",
            Self::TargetDatabaseBeforeOpen => "target_database_before_open",
            Self::TargetDatabaseAfterOpen => "target_database_after_open",
            Self::SwitchJournalBeforeCleanup => "switch_journal_before_cleanup",
            Self::RegistryReplaceFallback => "registry_replace_fallback",
            Self::CredentialGet => "credential_get",
            Self::CredentialSet => "credential_set",
            Self::CredentialDelete => "credential_delete",
            Self::ReminderCancel => "reminder_cancel",
            Self::SqliteBusy => "sqlite_busy",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FaultAction {
    Error { code: String, message: String },
    Block { duration_ms: u64 },
    Terminate { exit_code: i32 },
}

#[derive(Debug, Clone)]
pub struct FaultEvent {
    pub event_id: String,
    pub point: FaultPoint,
    pub phase: Option<String>,
    pub account_id: Option<String>,
    pub detail: Option<String>,
    pub at: String,
}

impl FaultEvent {
    fn new(
        point: FaultPoint,
        phase: Option<&str>,
        account_id: Option<&str>,
        detail: Option<&str>,
    ) -> Self {
        Self {
            event_id: Uuid::now_v7().to_string(),
            point,
            phase: phase.map(str::to_owned),
            account_id: account_id.map(str::to_owned),
            detail: detail.map(str::to_owned),
            at: Utc::now().to_rfc3339(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FaultEvidence {
    pub event_id: String,
    pub point: &'static str,
    pub phase: Option<String>,
    pub account_id: Option<String>,
    pub at: String,
    pub result: String,
}

pub trait FaultInjector: Send + Sync {
    fn decide(&self, event: &FaultEvent) -> Option<FaultAction>;
    fn record(&self, evidence: &FaultEvidence);
}

static INJECTOR: OnceLock<Mutex<Option<Arc<dyn FaultInjector>>>> = OnceLock::new();

fn injector_slot() -> &'static Mutex<Option<Arc<dyn FaultInjector>>> {
    INJECTOR.get_or_init(|| Mutex::new(None))
}

/// Install an injector for the current process. Only available in test/QA
/// feature builds; production releases expose no way to call this.
#[cfg(any(test, feature = "fault-injection"))]
pub fn install(injector: Arc<dyn FaultInjector>) -> AccountResult<()> {
    let mut slot = injector_slot()
        .lock()
        .map_err(|_| AccountError::InvalidRegistry("fault injector lock poisoned".to_owned()))?;
    *slot = Some(injector);
    Ok(())
}

#[cfg(any(test, feature = "fault-injection"))]
pub fn clear() {
    if let Ok(mut slot) = injector_slot().lock() {
        *slot = None;
    }
}

/// Evaluate a fault point. In production this is a no-op because no injector
/// can be installed.
pub fn point(
    point: FaultPoint,
    phase: Option<&str>,
    account_id: Option<&str>,
    detail: Option<&str>,
) -> AccountResult<()> {
    let injector = {
        let Ok(slot) = injector_slot().lock() else {
            return Err(AccountError::InvalidRegistry(
                "fault injector lock poisoned".to_owned(),
            ));
        };
        slot.clone()
    };
    let Some(injector) = injector else {
        return Ok(());
    };
    let event = FaultEvent::new(point, phase, account_id, detail);
    match injector.decide(&event) {
        None => {
            injector.record(&FaultEvidence {
                event_id: event.event_id,
                point: point.as_str(),
                phase: event.phase,
                account_id: event.account_id,
                at: event.at,
                result: "passed".to_owned(),
            });
            Ok(())
        }
        Some(FaultAction::Error { code, message }) => {
            injector.record(&FaultEvidence {
                event_id: event.event_id,
                point: point.as_str(),
                phase: event.phase,
                account_id: event.account_id,
                at: event.at,
                result: format!("error:{code}"),
            });
            Err(AccountError::FaultInjected(format!("{code}: {message}")))
        }
        Some(FaultAction::Block { duration_ms }) => {
            injector.record(&FaultEvidence {
                event_id: event.event_id,
                point: point.as_str(),
                phase: event.phase,
                account_id: event.account_id,
                at: event.at,
                result: format!("blocked:{duration_ms}"),
            });
            std::thread::sleep(Duration::from_millis(duration_ms.min(30_000)));
            Ok(())
        }
        Some(FaultAction::Terminate { exit_code }) => {
            injector.record(&FaultEvidence {
                event_id: event.event_id,
                point: point.as_str(),
                phase: event.phase,
                account_id: event.account_id,
                at: event.at,
                result: format!("terminate:{exit_code}"),
            });
            std::process::exit(exit_code);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    #[derive(Default)]
    struct RecordingInjector {
        action: Mutex<Option<FaultAction>>,
        seen: Mutex<Vec<String>>,
    }

    impl FaultInjector for RecordingInjector {
        fn decide(&self, event: &FaultEvent) -> Option<FaultAction> {
            self.seen
                .lock()
                .expect("seen")
                .push(event.point.as_str().to_owned());
            self.action.lock().expect("action").clone()
        }

        fn record(&self, evidence: &FaultEvidence) {
            self.seen
                .lock()
                .expect("seen")
                .push(format!("evidence:{}", evidence.result));
        }
    }

    #[test]
    fn no_injector_is_a_noop() {
        clear();
        point(
            FaultPoint::SwitchPreparedPersisted,
            Some("PREPARED"),
            None,
            None,
        )
        .expect("noop");
    }

    #[test]
    fn injected_error_has_a_machine_readable_code() {
        let injector = Arc::new(RecordingInjector::default());
        *injector.action.lock().expect("action") = Some(FaultAction::Error {
            code: "SIMULATED_CRASH".to_owned(),
            message: "after PREPARED".to_owned(),
        });
        install(injector.clone()).expect("install");
        let error = point(
            FaultPoint::SwitchPreparedPersisted,
            Some("PREPARED"),
            None,
            None,
        )
        .expect_err("injected");
        assert!(matches!(error, AccountError::FaultInjected(_)));
        assert!(
            injector
                .seen
                .lock()
                .expect("seen")
                .iter()
                .any(|item| item == "evidence:error:SIMULATED_CRASH")
        );
        clear();
    }

    #[test]
    fn injected_block_is_bounded() {
        let injector = Arc::new(RecordingInjector::default());
        *injector.action.lock().expect("action") = Some(FaultAction::Block { duration_ms: 1 });
        install(injector).expect("install");
        let started = std::time::Instant::now();
        point(FaultPoint::RegistryActiveBeforeUpdate, None, None, None).expect("block");
        assert!(started.elapsed() >= Duration::from_millis(1));
        clear();
    }
}
