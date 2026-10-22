use axum::{
    extract::FromRequestParts,
    http::{header::AUTHORIZATION, request::Parts},
};
use chrono::{DateTime, Utc};
use sqlx::FromRow;
use uuid::Uuid;

use crate::{error::AppError, state::AppState};

#[derive(Debug, Clone, Copy)]
pub struct AuthUser {
    pub user_id: Uuid,
    pub session_id: Uuid,
    pub device_id: Uuid,
    pub issued_at: i64,
}

#[derive(Debug, FromRow)]
struct SessionRow {
    user_id: Uuid,
    device_id: Uuid,
    session_expires_at: DateTime<Utc>,
    session_revoked_at: Option<DateTime<Utc>>,
    user_deleted_at: Option<DateTime<Utc>>,
    device_revoked_at: Option<DateTime<Utc>>,
}

impl FromRequestParts<AppState> for AuthUser {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let header = parts
            .headers
            .get(AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .ok_or_else(AppError::unauthorized)?;
        let (scheme, token) = header.split_once(' ').ok_or_else(AppError::unauthorized)?;
        if !scheme.eq_ignore_ascii_case("bearer") || token.is_empty() {
            return Err(AppError::unauthorized());
        }

        // The token is the only source of identity. No client supplied user_id
        // is accepted by any route.
        let claims = state.jwt.decode_access(token)?;
        let row = sqlx::query_as::<_, SessionRow>(
            r#"
            SELECT s.user_id,
                   s.device_id,
                   s.expires_at AS session_expires_at,
                   s.revoked_at AS session_revoked_at,
                   u.deleted_at AS user_deleted_at,
                   d.revoked_at AS device_revoked_at
            FROM sessions s
            JOIN users u ON u.id = s.user_id
            JOIN devices d ON d.user_id = s.user_id AND d.id = s.device_id
            WHERE s.id = $1 AND s.user_id = $2
            "#,
        )
        .bind(claims.sid)
        .bind(claims.sub)
        .fetch_optional(&state.pool)
        .await?;

        let Some(row) = row else {
            return Err(AppError::unauthorized());
        };
        let now = Utc::now();
        if row.user_id != claims.sub
            || row.device_id != claims.did
            || row.session_expires_at <= now
            || row.session_revoked_at.is_some()
            || row.user_deleted_at.is_some()
            || row.device_revoked_at.is_some()
        {
            return Err(AppError::unauthorized());
        }

        Ok(Self {
            user_id: row.user_id,
            session_id: claims.sid,
            device_id: row.device_id,
            issued_at: claims.iat,
        })
    }
}
