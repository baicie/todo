mod error;
pub mod fault;
mod migration;
mod paths;
mod registry;
mod snapshot;
mod switch;

pub use error::{AccountError, AccountResult};
pub use fault::{
    FaultAction, FaultEvent, FaultEvidence, FaultInjector, FaultPoint, point as fault_point,
};
pub use migration::{
    InstallationPhase, InstallationState, LegacyReviewReport, MigrationPhase, MigrationState,
    ensure_active_account, legacy_review_report, migration_state,
};
pub use paths::{
    DEFAULT_ACCOUNT_ID, LEGACY_REFRESH_TOKEN_KEY, account_dir, accounts_file,
    database_path as account_database_path, ensure_account_dir, ensure_data_root,
    installation_state_file, legacy_database_path, migration_backups_dir, migration_state_file,
    pending_account_switch_file, refresh_token_key, validate_account_id, validate_relative_path,
};
pub use registry::{
    AccountKind, AccountRecord, AccountRegistry, ActiveAccountContext, load_with_recovery,
    normalize_api_url, normalize_email, valid_email,
};
pub use snapshot::{DataSnapshot, VerificationSummary, read_snapshot, verify_integrity};
pub use switch::{
    AbortSwitchOutcome, AccountList, AccountSummary, PendingAccountSwitch, SwitchFailure,
    SwitchPhase, SwitchRecovery, SwitchStatus, abort_prepared_switch, create_pending_cloud_account,
    finish_pending_switch, list_accounts, mark_account_verified, prepare_account_switch,
    recover_pending_switch, request_account_switch, rollback_pending_switch, switch_status,
    verify_cloud_identity,
};
