use std::path::PathBuf;

#[derive(Debug, thiserror::Error)]
pub enum AccountError {
    #[error("account filesystem error: {0}")]
    Io(#[from] std::io::Error),
    #[error("account registry json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("account sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("invalid account registry: {0}")]
    InvalidRegistry(String),
    #[error("invalid account id: {0}")]
    InvalidAccountId(String),
    #[error("unsafe account path: {0}")]
    UnsafePath(String),
    #[error("active account {0} has no database and no legacy source")]
    ActiveAccountMissing(String),
    #[error("legacy database requires manual review: {reason}; state={state_path:?}")]
    NeedsReview { reason: String, state_path: PathBuf },
    #[error("database integrity check failed for {path:?}: {detail}")]
    Integrity { path: PathBuf, detail: String },
    #[error("legacy migration failed: {0}; state={1:?}")]
    MigrationFailed(String, PathBuf),
    #[error("database verification mismatch: {0}")]
    VerificationMismatch(String),
    #[error("injected fault: {0}")]
    FaultInjected(String),
}

pub type AccountResult<T> = Result<T, AccountError>;
