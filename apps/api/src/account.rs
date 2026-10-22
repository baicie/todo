use axum::{
    Json, Router,
    extract::State,
    http::{HeaderValue, StatusCode, header::SET_COOKIE},
    response::{IntoResponse, Response},
    routing::delete,
};
use chrono::{DateTime, Utc};
use serde_json::json;
use uuid::Uuid;

use crate::{auth::AuthUser, error::ApiResult, state::AppState};

pub fn router() -> Router<AppState> {
    Router::new().route("/api/v1/account", delete(delete_account))
}

async fn delete_account(State(state): State<AppState>, auth: AuthUser) -> ApiResult<Response> {
    // Account deletion is irreversible. Require a recently issued access token
    // (at most five minutes old) as the secondary verification signal.
    if auth.issued_at < Utc::now().timestamp() - 300 {
        return Err(crate::error::AppError::Forbidden {
            code: "REAUTH_REQUIRED",
            message: "Sign in again before deleting this account".to_owned(),
        });
    }
    let mut tx = state.pool.begin().await?;
    // Global lock order: users -> account_sync_state -> devices -> sessions ->
    // refresh_tokens. Sync only takes the first three, but the shared prefix is
    // what prevents races with account deletion.
    let user: Option<(Uuid, Option<DateTime<Utc>>)> =
        sqlx::query_as("SELECT id, deleted_at FROM users WHERE id = $1 FOR UPDATE")
            .bind(auth.user_id)
            .fetch_optional(&mut *tx)
            .await?;
    let Some((_, deleted_at)) = user else {
        tx.rollback().await?;
        return Err(crate::error::AppError::unauthorized());
    };
    if deleted_at.is_some() {
        tx.commit().await?;
        return Ok(StatusCode::ACCEPTED.into_response());
    }

    // Serialize against sync transactions, which acquire these same locks in
    // the same order.
    sqlx::query("SELECT user_id FROM account_sync_state WHERE user_id = $1 FOR UPDATE")
        .bind(auth.user_id)
        .execute(&mut *tx)
        .await?;

    sqlx::query("UPDATE users SET deleted_at = now() WHERE id = $1")
        .bind(auth.user_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE devices SET revoked_at = COALESCE(revoked_at, now()) WHERE user_id = $1")
        .bind(auth.user_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE sessions SET revoked_at = COALESCE(revoked_at, now()) WHERE user_id = $1")
        .bind(auth.user_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "UPDATE refresh_tokens rt SET revoked_at = COALESCE(rt.revoked_at, now()) \
         FROM sessions s WHERE rt.session_id = s.id AND s.user_id = $1",
    )
    .bind(auth.user_id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    let mut response = (
        StatusCode::ACCEPTED,
        Json(json!({"status": "deletion_scheduled"})),
    )
        .into_response();
    let clear = "todo_refresh=; HttpOnly; SameSite=Strict; Path=/api/v1/auth; Max-Age=0";
    response
        .headers_mut()
        .append(SET_COOKIE, HeaderValue::from_static(clear));
    Ok(response)
}
