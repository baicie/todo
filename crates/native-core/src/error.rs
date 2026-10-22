use serde::Serialize;
use thiserror::Error;

/// Stable error codes that the WebView can safely expose to the UI.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    ValidationFailed,
    NotFound,
    Conflict,
    InvalidDate,
    #[serde(rename = "DATABASE_ERROR")]
    Database,
    Unsupported,
    Internal,
}

impl ErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ValidationFailed => "VALIDATION_FAILED",
            Self::NotFound => "NOT_FOUND",
            Self::Conflict => "CONFLICT",
            Self::InvalidDate => "INVALID_DATE",
            Self::Database => "DATABASE_ERROR",
            Self::Unsupported => "UNSUPPORTED",
            Self::Internal => "INTERNAL",
        }
    }
}

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("validation failed: {0}")]
    Validation(String),
    #[error("not found: {0}")]
    NotFound(String),
    #[error("conflict: {0}")]
    Conflict(String),
    #[error("invalid date: {0}")]
    InvalidDate(String),
    #[error("unsupported: {0}")]
    Unsupported(String),
    #[error("database error: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("serialization error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("internal error: {0}")]
    Internal(String),
}

impl StoreError {
    pub fn code(&self) -> ErrorCode {
        match self {
            Self::Validation(_) => ErrorCode::ValidationFailed,
            Self::NotFound(_) => ErrorCode::NotFound,
            Self::Conflict(_) => ErrorCode::Conflict,
            Self::InvalidDate(_) => ErrorCode::InvalidDate,
            Self::Unsupported(_) => ErrorCode::Unsupported,
            Self::Database(_) | Self::Json(_) | Self::Internal(_) => ErrorCode::Database,
        }
    }
}

pub type StoreResult<T> = Result<T, StoreError>;
