use axum::{
    Json, Router,
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{delete, get},
};
use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::FromRow;
use uuid::Uuid;

use crate::{auth::AuthUser, error::ApiResult, state::AppState};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/devices", get(list_devices))
        .route("/api/v1/devices/{device_id}", delete(delete_device))
}

#[derive(Debug, Serialize, FromRow)]
pub struct DeviceResponse {
    pub id: Uuid,
    pub name: String,
    pub platform: String,
    pub last_seen_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub current: bool,
}

async fn list_devices(
    State(state): State<AppState>,
    auth: AuthUser,
) -> ApiResult<Json<Vec<DeviceResponse>>> {
    let devices = sqlx::query_as::<_, DeviceResponse>(
        r#"
        SELECT id, name, platform, last_seen_at, created_at,
               (id = $2) AS current
        FROM devices
        WHERE user_id = $1 AND revoked_at IS NULL
        ORDER BY created_at, id
        "#,
    )
    .bind(auth.user_id)
    .bind(auth.device_id)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(devices))
}

async fn delete_device(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(device_id): Path<String>,
) -> ApiResult<impl IntoResponse> {
    let device_id = Uuid::parse_str(&device_id)
        .map_err(|_| crate::error::AppError::validation("device id must be a UUID"))?;

    let mut tx = state.pool.begin().await?;
    // Keep lock order consistent with sync: users -> account_sync_state ->
    // devices -> sessions/refresh_tokens.
    let user_exists: Option<(Uuid,)> =
        sqlx::query_as("SELECT id FROM users WHERE id = $1 AND deleted_at IS NULL FOR UPDATE")
            .bind(auth.user_id)
            .fetch_optional(&mut *tx)
            .await?;
    if user_exists.is_none() {
        tx.rollback().await?;
        return Err(crate::error::AppError::unauthorized());
    }

    let device: Option<(Uuid, Option<DateTime<Utc>>)> = sqlx::query_as(
        "SELECT id, revoked_at FROM devices WHERE user_id = $1 AND id = $2 FOR UPDATE",
    )
    .bind(auth.user_id)
    .bind(device_id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((_, revoked_at)) = device else {
        tx.rollback().await?;
        return Err(crate::error::AppError::NotFound {
            code: "DEVICE_NOT_FOUND",
            message: "Device not found".to_owned(),
        });
    };

    if revoked_at.is_none() {
        sqlx::query("UPDATE devices SET revoked_at = now() WHERE user_id = $1 AND id = $2")
            .bind(auth.user_id)
            .bind(device_id)
            .execute(&mut *tx)
            .await?;
        sqlx::query(
            "UPDATE sessions SET revoked_at = COALESCE(revoked_at, now()) \
             WHERE user_id = $1 AND device_id = $2",
        )
        .bind(auth.user_id)
        .bind(device_id)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "UPDATE refresh_tokens rt SET revoked_at = COALESCE(rt.revoked_at, now()) \
             FROM sessions s \
             WHERE rt.session_id = s.id AND s.user_id = $1 AND s.device_id = $2",
        )
        .bind(auth.user_id)
        .bind(device_id)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;

    Ok(StatusCode::NO_CONTENT)
}
