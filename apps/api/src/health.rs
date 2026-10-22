use axum::{Json, Router, extract::State, http::StatusCode, routing::get};
use serde_json::{Value, json};

use crate::{db, state::AppState};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/healthz", get(liveness))
        .route("/readyz", get(readiness))
}

/// Liveness deliberately has no dependencies. It answers whether the process
/// can serve HTTP and is suitable for a container restart policy.
async fn liveness() -> (StatusCode, Json<Value>) {
    (
        StatusCode::OK,
        Json(json!({
            "status": "ok",
            "service": "todo-api",
            "version": env!("CARGO_PKG_VERSION")
        })),
    )
}

/// Readiness gates traffic on database connectivity, fully applied migrations,
/// and a valid mail provider configuration. It does not open a live SMTP
/// connection on every probe.
async fn readiness(State(state): State<AppState>) -> (StatusCode, Json<Value>) {
    let database_ok = sqlx::query_scalar::<_, i32>("SELECT 1")
        .fetch_one(&state.pool)
        .await
        .is_ok();
    let migrations_ok = if database_ok {
        match db::schema_is_current(&state.pool).await {
            Ok(current) => current,
            Err(_) => {
                tracing::warn!("readiness migration check failed");
                false
            }
        }
    } else {
        tracing::warn!("readiness database probe failed");
        false
    };
    let mail_ok = state.mailer.is_ready();

    let ready = database_ok && migrations_ok && mail_ok;
    let status = if ready {
        StatusCode::OK
    } else {
        state.metrics.record_readiness_failure();
        StatusCode::SERVICE_UNAVAILABLE
    };
    let body = if ready {
        json!({
            "status": "ready",
            "checks": {
                "database": "ok",
                "migrations": "ok",
                "mail": "ok"
            }
        })
    } else {
        json!({
            "code": "NOT_READY",
            "message": "The service is not ready to receive traffic",
            "status": "not_ready",
            "checks": {
                "database": if database_ok { "ok" } else { "failed" },
                "migrations": if migrations_ok { "ok" } else { "failed" },
                "mail": if mail_ok { "ok" } else { "failed" }
            }
        })
    };
    (status, Json(body))
}
