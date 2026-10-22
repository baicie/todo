use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde::Serialize;

pub type ApiResult<T> = Result<T, AppError>;

#[derive(Debug)]
pub enum AppError {
    BadRequest { code: &'static str, message: String },
    Unauthorized { code: &'static str, message: String },
    Forbidden { code: &'static str, message: String },
    NotFound { code: &'static str, message: String },
    Conflict { code: &'static str, message: String },
    TooManyRequests { code: &'static str, message: String },
    PayloadTooLarge,
    ServiceUnavailable { code: &'static str, message: String },
    RevisionConflict { current_revision: i64 },
    Internal(String),
}

#[derive(Debug, Serialize)]
pub struct ErrorBody {
    pub code: String,
    pub message: String,
}

impl AppError {
    pub fn validation(message: impl Into<String>) -> Self {
        Self::BadRequest {
            code: "VALIDATION_FAILED",
            message: message.into(),
        }
    }

    pub fn unauthorized() -> Self {
        Self::Unauthorized {
            code: "UNAUTHORIZED",
            message: "Authentication is required or the session is no longer valid".to_owned(),
        }
    }

    pub fn invalid_token() -> Self {
        Self::Unauthorized {
            code: "INVALID_TOKEN",
            message: "The access token is invalid or expired".to_owned(),
        }
    }

    pub fn not_found() -> Self {
        Self::NotFound {
            code: "NOT_FOUND",
            message: "The requested resource was not found".to_owned(),
        }
    }

    pub fn cursor_expired() -> Self {
        Self::Conflict {
            code: "CURSOR_EXPIRED",
            message: "The change cursor is older than the retained history; bootstrap is required"
                .to_owned(),
        }
    }

    pub fn sequence_mismatch(message: impl Into<String>) -> Self {
        Self::Conflict {
            code: "SEQUENCE_MISMATCH",
            message: message.into(),
        }
    }

    pub fn revision_conflict(current_revision: i64) -> Self {
        Self::RevisionConflict { current_revision }
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, code, message) = match self {
            Self::BadRequest { code, message } => (StatusCode::BAD_REQUEST, code, message),
            Self::Unauthorized { code, message } => (StatusCode::UNAUTHORIZED, code, message),
            Self::Forbidden { code, message } => (StatusCode::FORBIDDEN, code, message),
            Self::NotFound { code, message } => (StatusCode::NOT_FOUND, code, message),
            Self::Conflict { code, message } => (StatusCode::CONFLICT, code, message),
            Self::TooManyRequests { code, message } => {
                (StatusCode::TOO_MANY_REQUESTS, code, message)
            }
            Self::PayloadTooLarge => (
                StatusCode::PAYLOAD_TOO_LARGE,
                "PAYLOAD_TOO_LARGE",
                "The request body exceeds the configured limit".to_owned(),
            ),
            Self::ServiceUnavailable { code, message } => {
                (StatusCode::SERVICE_UNAVAILABLE, code, message)
            }
            Self::RevisionConflict { current_revision } => {
                return (
                    StatusCode::CONFLICT,
                    Json(serde_json::json!({
                        "code": "REVISION_CONFLICT",
                        "message": "The shared list revision changed; refresh and retry",
                        "current_revision": current_revision,
                    })),
                )
                    .into_response();
            }
            Self::Internal(_detail) => {
                // Never return or log request bodies, SQL values, credentials, or
                // provider responses. The request path/status is captured by the
                // structured HTTP trace instead.
                tracing::error!("internal API error");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "INTERNAL_ERROR",
                    "An internal error occurred".to_owned(),
                )
            }
        };

        (
            status,
            Json(ErrorBody {
                code: code.to_owned(),
                message,
            }),
        )
            .into_response()
    }
}

impl From<sqlx::Error> for AppError {
    fn from(error: sqlx::Error) -> Self {
        Self::Internal(format!("database operation failed: {error}"))
    }
}
