mod error;
mod migration;
mod paths;
mod registry;
mod snapshot;

pub use error::{AccountError, AccountResult};
pub use migration::{
    InstallationPhase, InstallationState, MigrationPhase, MigrationState, ensure_active_account,
    migration_state,
};
pub use paths::{
    DEFAULT_ACCOUNT_ID, LEGACY_REFRESH_TOKEN_KEY, account_dir, accounts_file,
    database_path as account_database_path, ensure_account_dir, ensure_data_root,
    installation_state_file, legacy_database_path, migration_backups_dir, migration_state_file,
    refresh_token_key, validate_account_id, validate_relative_path,
};
pub use registry::{
    AccountKind, AccountRecord, AccountRegistry, ActiveAccountContext, load_with_recovery,
    normalize_email, valid_email,
};
pub use snapshot::{DataSnapshot, VerificationSummary, read_snapshot, verify_integrity};
